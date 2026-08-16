#!/usr/bin/env node

import { copyFile, mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  bankCount,
  buildExactBoundaryPermanentTrackMaps,
  readSegment,
} from './probe-fourcgs-lossless-rate.mjs';
import {
  buildCroppedMortonLayout,
  encodePositions,
  floatToHalf,
  halfToFloat,
} from './fourcgs-prs-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const ATTRIBUTE = new Set(['position', 'scale', 'dc']);
const BASELINE_BYTES = {
  position: 22_849_261,
  scale: 21_384_657,
  dc: 10_104_720,
};

const halfTable = new Float32Array(65536);
for (let bits = 0; bits < halfTable.length; bits += 1) halfTable[bits] = halfToFloat(bits);

function parseArguments(argv) {
  const options = {
    source: '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16',
    manifest: '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_attribute_so3_hybrid.4cgs.json',
    attribute: 'position',
    tolerance: 0.001,
    output: null,
    writeMutatedDirectory: null,
    writeStream: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--source') options.source = argv[++index];
    else if (argument === '--manifest') options.manifest = argv[++index];
    else if (argument === '--attribute') options.attribute = argv[++index];
    else if (argument === '--tolerance') options.tolerance = Number(argv[++index]);
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--write-mutated-dir') options.writeMutatedDirectory = argv[++index];
    else if (argument === '--write-stream') options.writeStream = argv[++index];
    else throw new Error(`Unknown argument ${argument}`);
  }
  if (!ATTRIBUTE.has(options.attribute)) throw new Error(`Unsupported attribute ${options.attribute}`);
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0) throw new Error('Tolerance must be non-negative.');
  return options;
}

async function payloadOffset(path) {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const unix = header.subarray(0, bytesRead).indexOf(Buffer.from('end_header\n'));
    if (unix >= 0) return unix + 'end_header\n'.length;
    const windows = header.subarray(0, bytesRead).indexOf(Buffer.from('end_header\r\n'));
    if (windows >= 0) return windows + 'end_header\r\n'.length;
    throw new Error(`RAW4D header exceeds 1 MiB or is invalid: ${path}`);
  } finally {
    await handle.close();
  }
}

// #WDD-gpt 2026-08-15 - 仅把实验属性写入独立 RAW4D 副本，原始六段始终保持只读并可用于后续逐属性验收。
async function writeMutatedSegments(segments, directory) {
  await mkdir(directory, { recursive: true });
  for (const segment of segments) {
    const destination = join(directory, basename(segment.path));
    await copyFile(segment.path, destination);
    const offset = await payloadOffset(segment.path);
    const payload = Buffer.from(segment.rows.buffer, segment.rows.byteOffset, segment.rows.byteLength);
    const handle = await open(destination, 'r+');
    try {
      let written = 0;
      while (written < payload.length) {
        const result = await handle.write(payload, written, payload.length - written, offset + written);
        if (result.bytesWritten === 0) throw new Error(`Could not write mutated payload to ${destination}`);
        written += result.bytesWritten;
      }
    } finally {
      await handle.close();
    }
  }
}

async function segmentPaths(directory) {
  const entries = await readdir(directory);
  return entries
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]))
    .map((name) => join(directory, name));
}

function keyTimes(segment, banks, stride) {
  const match = SEGMENT_PATTERN.exec(basename(segment.path));
  if (!match) throw new Error(`Cannot derive segment timing from ${segment.path}`);
  const totalFrames = Number(match[2]) - Number(match[1]) + 1;
  return Array.from({ length: banks }, (_, bank) => Math.min(bank * stride, totalFrames - 1));
}

function propertyName(prefix, bank, component) {
  return component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`;
}

function vectorError(values, leftOffset, rightOffset, dimensions, metric) {
  if (metric === 'maximum-component') {
    let maximum = 0;
    for (let component = 0; component < dimensions; component += 1) {
      maximum = Math.max(maximum, Math.abs(values[leftOffset + component] - values[rightOffset + component]));
    }
    return maximum;
  }
  let squared = 0;
  for (let component = 0; component < dimensions; component += 1) {
    const difference = values[leftOffset + component] - values[rightOffset + component];
    squared += difference * difference;
  }
  return Math.sqrt(squared);
}

// #WDD-gpt 2026-08-15 - 对每个 Gaussian 的短折线独立做有界 RDP，端点间仍由现有运行时线性插值，不新增模型依赖。
function simplifyAttribute(segments, configuration, tolerance, finalDecoder) {
  const started = performance.now();
  let totalTracks = 0;
  let totalKeys = 0;
  let retainedKeys = 0;
  let staticTracks = 0;
  let twoKnotTracks = 0;
  let simplifiedTracks = 0;
  let maximumCurveError = 0;
  let maximumFinalError = 0;
  let squaredFinalError = 0;
  let finalValueCount = 0;
  let squaredFinalVectorError = 0;
  let finalVectorCount = 0;
  const perSegment = [];

  for (const segment of segments) {
    const banks = bankCount(segment, configuration.prefix);
    const times = keyTimes(segment, banks, configuration.stride);
    const dimensions = configuration.components.length;
    const stride = segment.propertyNames.length;
    const indices = Array.from({ length: banks }, (_, bank) => configuration.components.map((component) => {
      const index = segment.propertyIndex.get(propertyName(configuration.prefix, bank, component));
      if (index === undefined) throw new Error(`Missing ${propertyName(configuration.prefix, bank, component)} in ${segment.path}`);
      return index;
    }));
    const values = new Float64Array(banks * dimensions);
    const source = new Float64Array(banks * dimensions);
    const reconstructed = new Float64Array(banks * dimensions);
    const kept = new Uint8Array(banks);
    const leftStack = new Int8Array(banks * 2);
    const rightStack = new Int8Array(banks * 2);
    let segmentRetained = 0;
    let segmentSimplified = 0;

    for (let local = 0; local < segment.count; local += 1) {
      const rowBase = local * stride;
      for (let bank = 0; bank < banks; bank += 1) {
        for (let component = 0; component < dimensions; component += 1) {
          const value = halfTable[segment.rows[rowBase + indices[bank][component]]];
          values[bank * dimensions + component] = value;
          source[bank * dimensions + component] = value;
        }
      }
      kept.fill(0);
      kept[0] = 1;
      let isStatic = true;
      for (let bank = 1; bank < banks; bank += 1) {
        if (vectorError(values, 0, bank * dimensions, dimensions, configuration.metric) > tolerance) {
          isStatic = false;
          break;
        }
      }
      if (!isStatic) {
        kept[banks - 1] = 1;
        let stackSize = 1;
        leftStack[0] = 0;
        rightStack[0] = banks - 1;
        while (stackSize > 0) {
          stackSize -= 1;
          const left = leftStack[stackSize];
          const right = rightStack[stackSize];
          let maximum = -1;
          let split = -1;
          for (let bank = left + 1; bank < right; bank += 1) {
            const alpha = (times[bank] - times[left]) / (times[right] - times[left]);
            let error;
            if (configuration.metric === 'maximum-component') {
              error = 0;
              for (let component = 0; component < dimensions; component += 1) {
                const predicted = values[left * dimensions + component]
                  + (values[right * dimensions + component] - values[left * dimensions + component]) * alpha;
                error = Math.max(error, Math.abs(values[bank * dimensions + component] - predicted));
              }
            } else {
              let squared = 0;
              for (let component = 0; component < dimensions; component += 1) {
                const predicted = values[left * dimensions + component]
                  + (values[right * dimensions + component] - values[left * dimensions + component]) * alpha;
                const difference = values[bank * dimensions + component] - predicted;
                squared += difference * difference;
              }
              error = Math.sqrt(squared);
            }
            if (error > maximum) {
              maximum = error;
              split = bank;
            }
          }
          if (maximum > tolerance && split > left && split < right) {
            kept[split] = 1;
            leftStack[stackSize] = left;
            rightStack[stackSize] = split;
            stackSize += 1;
            leftStack[stackSize] = split;
            rightStack[stackSize] = right;
            stackSize += 1;
          }
        }
      }

      let count = 0;
      let left = 0;
      for (let bank = 0; bank < banks; bank += 1) {
        if (!kept[bank]) continue;
        count += 1;
        const right = bank;
        if (right === left) {
          for (let component = 0; component < dimensions; component += 1) {
            reconstructed[right * dimensions + component] = values[right * dimensions + component];
          }
        } else {
          for (let middle = left; middle <= right; middle += 1) {
            const alpha = (times[middle] - times[left]) / (times[right] - times[left]);
            for (let component = 0; component < dimensions; component += 1) {
              reconstructed[middle * dimensions + component] = values[left * dimensions + component]
                + (values[right * dimensions + component] - values[left * dimensions + component]) * alpha;
            }
          }
        }
        left = right;
      }
      if (count === 1) {
        for (let bank = 0; bank < banks; bank += 1) {
          for (let component = 0; component < dimensions; component += 1) {
            reconstructed[bank * dimensions + component] = values[component];
          }
        }
      }

      let trackCurveError = 0;
      for (let bank = 0; bank < banks; bank += 1) {
        const bankOffset = bank * dimensions;
        let vectorSquared = 0;
        let vectorMaximum = 0;
        let curveSquared = 0;
        let curveMaximum = 0;
        for (let component = 0; component < dimensions; component += 1) {
          const predictedBits = kept[bank]
            ? segment.rows[rowBase + indices[bank][component]]
            : floatToHalf(reconstructed[bankOffset + component]);
          segment.rows[rowBase + indices[bank][component]] = predictedBits;
          const stored = halfTable[predictedBits];
          const decoded = finalDecoder(stored, component);
          const curveDifference = stored - source[bankOffset + component];
          const difference = decoded - source[bankOffset + component];
          curveSquared += curveDifference * curveDifference;
          curveMaximum = Math.max(curveMaximum, Math.abs(curveDifference));
          vectorSquared += difference * difference;
          vectorMaximum = Math.max(vectorMaximum, Math.abs(difference));
          squaredFinalError += difference * difference;
          finalValueCount += 1;
        }
        const curveError = configuration.metric === 'maximum-component'
          ? curveMaximum
          : Math.sqrt(curveSquared);
        trackCurveError = Math.max(trackCurveError, curveError);
        maximumFinalError = Math.max(maximumFinalError, configuration.metric === 'maximum-component' ? vectorMaximum : Math.sqrt(vectorSquared));
        squaredFinalVectorError += vectorSquared;
        finalVectorCount += 1;
      }
      maximumCurveError = Math.max(maximumCurveError, trackCurveError);
      retainedKeys += count;
      segmentRetained += count;
      totalKeys += banks;
      totalTracks += 1;
      if (count === 1) staticTracks += 1;
      if (count <= 2) twoKnotTracks += 1;
      if (count < banks) {
        simplifiedTracks += 1;
        segmentSimplified += 1;
      }
    }
    perSegment.push({
      name: basename(segment.path),
      tracks: segment.count,
      banks,
      retainedKeys: segmentRetained,
      retainedFraction: segmentRetained / (segment.count * banks),
      simplifiedTracks: segmentSimplified,
    });
  }

  return {
    tolerance,
    totalTracks,
    totalKeys,
    retainedKeys,
    retainedFraction: retainedKeys / totalKeys,
    removedFraction: 1 - retainedKeys / totalKeys,
    meanKnots: retainedKeys / totalTracks,
    staticTracks,
    twoKnotTracks,
    simplifiedTracks,
    maximumCurveError,
    finalComponentRmse: Math.sqrt(squaredFinalError / finalValueCount),
    finalVectorRmse: Math.sqrt(squaredFinalVectorError / finalVectorCount),
    finalRmse: configuration.metric === 'euclidean'
      ? Math.sqrt(squaredFinalVectorError / finalVectorCount)
      : Math.sqrt(squaredFinalError / finalValueCount),
    maximumFinalError,
    elapsedSeconds: (performance.now() - started) / 1000,
    perSegment,
  };
}

async function main() {
  const options = parseArguments(process.argv);
  const started = performance.now();
  const paths = await segmentPaths(resolve(options.source));
  if (paths.length !== 6) throw new Error(`Expected six RAW4D segments, found ${paths.length}.`);
  const segments = [];
  for (const path of paths) segments.push(await readSegment(path));
  const summary = JSON.parse(await readFile(resolve(options.manifest), 'utf8'));
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, summary.crop.center, summary.crop.halfExtent);
  const configurations = {
    position: { prefix: 'xyz_bank', components: ['x', 'y', 'z'], stride: 3, metric: 'euclidean' },
    scale: { prefix: 'scale_bank', components: ['0', '1', '2'], stride: 10, metric: 'maximum-component' },
    dc: { prefix: 'f_dc_bank', components: ['0', '1', '2'], stride: 30, metric: 'maximum-component' },
  };
  let finalDecoder;
  if (options.attribute === 'position') {
    const origin = summary.crop.center.map((value) => value - summary.crop.halfExtent);
    const step = summary.prs.position.step;
    finalDecoder = (value, component) => halfTable[floatToHalf(origin[component] + Math.round((value - origin[component]) / step) * step)];
  } else if (options.attribute === 'scale') {
    finalDecoder = (value) => value;
  } else {
    const step = 2 ** -9;
    finalDecoder = (value) => halfTable[floatToHalf(Math.round(value / step) * step)];
  }
  const simplification = simplifyAttribute(
    segments,
    configurations[options.attribute],
    options.tolerance,
    finalDecoder,
  );

  let encoded;
  let codecMetrics;
  if (options.attribute === 'position') {
    const result = encodePositions(segments, layout, segments.map((segment) => bankCount(segment, 'xyz_bank')), {
      center: summary.crop.center,
      halfExtent: summary.crop.halfExtent,
      step: summary.prs.position.step,
      maximumError: summary.prs.position.maximumEuclideanError,
      cellSize: summary.prs.position.cellSize,
    });
    encoded = result.encoded;
    codecMetrics = result.metrics;
  } else {
    const configuration = configurations[options.attribute];
    const result = encodeTemporalAttribute(segments, layout, {
      prefix: configuration.prefix,
      components: configuration.components,
      bankCounts: segments.map((segment) => bankCount(segment, configuration.prefix)),
      exactHalf: options.attribute === 'scale',
      step: options.attribute === 'dc' ? 2 ** -9 : undefined,
    });
    encoded = result.encoded;
    codecMetrics = result.metrics;
  }
  const baselineBytes = BASELINE_BYTES[options.attribute];
  const streamPath = options.writeStream ? resolve(options.writeStream) : null;
  if (streamPath) await writeFile(streamPath, encoded);
  const mutatedDirectory = options.writeMutatedDirectory ? resolve(options.writeMutatedDirectory) : null;
  if (mutatedDirectory) await writeMutatedSegments(segments, mutatedDirectory);
  const report = {
    experiment: 'per-gaussian bounded polyline simplification in decoder-compatible dense temporal streams',
    source: resolve(options.source),
    attribute: options.attribute,
    tolerance: options.tolerance,
    gaussianInstances: segments.reduce((sum, segment) => sum + segment.count, 0),
    permanentTracks: layout.slotCount,
    prunedGaussians: 0,
    streamPath,
    mutatedDirectory,
    simplification,
    codec: codecMetrics,
    encodedBytes: encoded.length,
    baselineBytes,
    byteDelta: encoded.length - baselineBytes,
    reductionFraction: 1 - encoded.length / baselineBytes,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), serialized);
  process.stdout.write(serialized);
}

main().catch((error) => {
  console.error(error.stack ?? error);
  process.exitCode = 1;
});
