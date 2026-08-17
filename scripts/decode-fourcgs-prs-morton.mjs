import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import {
  bankCount,
  buildExactBoundaryPermanentTrackMaps,
  buildPermanentTrackMaps,
  readSegment,
} from './probe-fourcgs-lossless-rate.mjs';
import {
  buildCroppedMortonLayout,
  decodePositions,
  decodeRotations,
  decodeScales,
  floatToHalf,
  halfToFloat,
  sha256,
} from './fourcgs-prs-codec.mjs';
import { decodeMixRq, decodeMixRqWindows } from './fourcgs-mixrq-codec.mjs';
import { decodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';
import { decodeTemporalRq } from './fourcgs-temporal-rq-codec.mjs';
import { decodeOpacityHybrid } from './fourcgs-opacity-hybrid-codec.mjs';
import { decodeTemporalAttribute, decodeTemporalAttributeStreams } from './fourcgs-temporal-attribute-codec.mjs';
import { decodeSo3Rotations, decodeSo3RotationStreams } from './fourcgs-so3-temporal-codec.mjs';
import { decodeV21StructuredStream, decodeV22StructuredParts, isV21StructuredStream } from './fourcgs-v21-lossless-codec.mjs';
import {
  createFourCgsCanonicalRaw4D,
  fourCgsDecodedPropertyNames,
} from '../src/features/gaussian/formats/fourcgs/FourCgsRaw4D.ts';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.(?:raw4d|ply4)$/i;

function unshuffle16(shuffled) {
  if (shuffled.length % 2 !== 0) throw new Error('FP16 byte unshuffle requires an even byte count.');
  const raw = Buffer.allocUnsafe(shuffled.length);
  const values = shuffled.length / 2;
  for (let index = 0; index < values; index += 1) {
    raw[index * 2] = shuffled[index];
    raw[index * 2 + 1] = shuffled[values + index];
  }
  return raw;
}

async function readContainer(bytes, options = {}) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported PRS Morton 4CGS file.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  const streamMilliseconds = {};
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const streamStarted = performance.now();
    const stored = bytes.subarray(offset, offset + entry.storedBytes);
    const storedSha256 = sha256(stored);
    if (stored.length !== entry.storedBytes || storedSha256 !== entry.storedSha256) {
      throw new Error(`Stored stream validation failed: ${entry.name}`);
    }
    let raw;
    if (entry.compression === 'deflate') raw = inflateSync(stored);
    else if (entry.compression === 'brotli') raw = brotliDecompressSync(stored);
    else if (entry.compression === 'brotli-shuffle16') raw = unshuffle16(brotliDecompressSync(stored));
    else raw = stored;
    const rawSha256 = raw === stored ? storedSha256 : sha256(raw);
    if (raw.length !== entry.rawBytes || rawSha256 !== entry.rawSha256) {
      throw new Error(`Raw stream validation failed: ${entry.name}`);
    }
    // #WDD-gpt 2026-08-16 - V2.1 先由浏览器兼容 WASM 路径还原成 V2 内层流，后续属性解码和质量校验保持不变。
    if (isV21StructuredStream(raw) && !(options.preserveStructured && ['prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc'].includes(entry.name))) {
      raw = await decodeV21StructuredStream(entry.name, raw, manifest);
      if (entry.v21DecodedBytes !== undefined && (raw.length !== entry.v21DecodedBytes || sha256(raw) !== entry.v21DecodedSha256)) {
        throw new Error(`V2.1 reconstructed stream validation failed: ${entry.name}`);
      }
    }
    streams.set(entry.name, raw);
    streamMilliseconds[entry.name] = performance.now() - streamStarted;
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected trailing 4CGS bytes: ${bytes.length - offset}`);
  return { manifest, streams, streamMilliseconds };
}

function propertyNames(segment) {
  return fourCgsDecodedPropertyNames(segment);
}

function activeLayout(manifest, rawMask) {
  const activeSlots = [];
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const slots = new Int32Array(manifest.segments[segmentIndex].gaussianCount);
    let activeCount = 0;
    for (let slot = 0; slot < manifest.slotCount; slot += 1) {
      const bit = segmentIndex * manifest.slotCount + slot;
      if ((rawMask[bit >>> 3] & (1 << (bit & 7))) !== 0) slots[activeCount++] = slot;
    }
    if (activeCount !== slots.length) {
      throw new Error(`Active Gaussian count mismatch for segment ${segmentIndex}.`);
    }
    activeSlots.push(slots);
  }
  return activeSlots;
}

function decodeTemporalStream(raw, manifest, activeSlots, namesBySegment, rows, indices, mode = 'xor') {
  const values = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const state = new Uint16Array(manifest.slotCount);
  const initialized = new Uint8Array(manifest.slotCount);
  let source = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const rowStride = indices[segmentIndex].size;
    const slots = activeSlots[segmentIndex];
    for (const name of namesBySegment[segmentIndex]) {
      const property = indices[segmentIndex].get(name);
      if (property === undefined) throw new Error(`Missing output property ${name}.`);
      for (let row = 0; row < slots.length; row += 1) {
        const slot = slots[row];
        const coded = values[source++];
        let value = coded;
        if (initialized[slot]) {
          if (mode === 'xor') value = coded ^ state[slot];
          else if (mode === 'delta') value = (state[slot] + (coded < 0x8000 ? coded : coded - 0x10000)) & 0xffff;
          else if (mode === 'zigzag') value = (state[slot] + (coded & 1 ? -(coded + 1) / 2 : coded / 2)) & 0xffff;
          else throw new Error(`Unsupported temporal decode mode ${mode}.`);
        }
        state[slot] = value;
        initialized[slot] = 1;
        rowValues[row * rowStride + property] = value;
      }
    }
  }
  if (source !== values.length) throw new Error(`Unused temporal values: ${values.length - source}`);
}

function decodeMixRqTrack(raw, manifest, activeSlots, prefix, components, bankKey, rows, indices) {
  const magic = raw.subarray(0, 8).toString('ascii');
  let decoded;
  if (magic === 'MIXWIN01') {
    const windows = decodeMixRqWindows(raw);
    if (windows.length !== manifest.segments.length) throw new Error(`MixRQ window count mismatch: ${windows.length}`);
    const totalValues = windows.reduce((sum, window) => sum + window.bits.length, 0);
    const bits = new Uint16Array(totalValues);
    let offset = 0;
    for (const window of windows) {
      bits.set(window.bits, offset);
      offset += window.bits.length;
    }
    decoded = {
      bits,
      metrics: {
        observationCount: windows.reduce((sum, window) => sum + window.metrics.observationCount, 0),
        dimensions: windows[0]?.metrics.dimensions ?? 0,
        maximumError: Math.max(...windows.map((window) => window.metrics.maximumError)),
        appliedExceptions: windows.reduce((sum, window) => sum + window.metrics.appliedExceptions, 0),
        windows: windows.map((window) => window.metrics),
      },
    };
  } else {
    // #WDD-gpt 2026-08-16 - 离线验收与 Web Worker 共用 V2.5 Opacity 混合流语义，保证解码位流一致。
    decoded = magic === 'OPHYB001'
      ? decodeOpacityHybrid(raw)
      : (magic === 'TMRQ0001'
          ? decodeTemporalRq(raw, activeSlots)
          : (magic === 'MIXSC001' ? decodeScalarRq(raw) : decodeMixRq(raw)));
  }
  const dimensions = manifest.segments[0].bankCounts[bankKey] * components.length;
  const observationCount = activeSlots.reduce((sum, slots) => sum + slots.length, 0);
  if (decoded.metrics.dimensions !== dimensions || decoded.metrics.observationCount !== observationCount) {
    throw new Error(`MixRQ ${prefix} layout mismatch.`);
  }
  let observation = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const segment = manifest.segments[segmentIndex];
    if (segment.bankCounts[bankKey] * components.length !== dimensions) {
      throw new Error(`MixRQ ${prefix} dimensions changed in segment ${segmentIndex}.`);
    }
    const names = Array.from({ length: segment.bankCounts[bankKey] }, (_, bank) => (
      components.map((component) => component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`)
    )).flat();
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        rowValues[row * stride + indices[segmentIndex].get(names[dimension])] = decoded.bits[observation * dimensions + dimension];
      }
      observation += 1;
    }
  }
  return decoded.metrics;
}

function decodeSharedSh(raw, manifest, activeSlots, rows, indices) {
  const magic = raw.subarray(0, 8).toString('ascii');
  if (magic !== 'C5T1SH01' && magic !== 'C5T2SH01') throw new Error('Unsupported shared SH trajectory stream.');
  const slotCount = raw.readUInt32LE(8);
  const instanceCount = raw.readUInt32LE(12);
  const segmentCount = raw.readUInt16LE(16);
  const dimensions = raw.readUInt8(18);
  const levels = raw.readUInt8(19);
  const baseBytes = raw.readUInt32LE(20);
  const maskBytes = raw.readUInt32LE(24);
  const labelBytes = raw.readUInt32LE(28);
  const headerBytes = magic === 'C5T2SH01' ? 40 : 32;
  const exceptionMaskBytes = magic === 'C5T2SH01' ? raw.readUInt32LE(32) : 0;
  const exceptionValueBytes = magic === 'C5T2SH01' ? raw.readUInt32LE(36) : 0;
  if (slotCount !== manifest.slotCount || segmentCount !== manifest.segments.length || dimensions !== 45
    || levels < 1 || levels > 32 || (magic === 'C5T1SH01' && levels !== 5)
    || baseBytes !== 45 * 2 + levels * 256 * 45 * 2) {
    throw new Error('Shared CoReSH-5R metadata mismatch.');
  }
  const baseOffset = headerBytes;
  const mean = new Float32Array(45);
  for (let dimension = 0; dimension < 45; dimension += 1) mean[dimension] = halfToFloat(raw.readUInt16LE(baseOffset + dimension * 2));
  const codebookOffset = baseOffset + 45 * 2;
  const codebooks = new Float32Array(levels * 256 * 45);
  for (let index = 0; index < codebooks.length; index += 1) codebooks[index] = halfToFloat(raw.readUInt16LE(codebookOffset + index * 2));
  const maskOffset = baseOffset + baseBytes;
  const labelOffset = maskOffset + maskBytes;
  const exceptionMaskOffset = labelOffset + labelBytes;
  const exceptionValueOffset = exceptionMaskOffset + exceptionMaskBytes;
  const updateMask = inflateSync(raw.subarray(maskOffset, labelOffset));
  const updates = inflateSync(raw.subarray(labelOffset, exceptionMaskOffset));
  const exceptionMask = magic === 'C5T2SH01'
    ? inflateSync(raw.subarray(exceptionMaskOffset, exceptionValueOffset))
    : new Uint8Array(Math.ceil(instanceCount / 8));
  const exceptionValues = magic === 'C5T2SH01'
    ? inflateSync(raw.subarray(exceptionValueOffset, exceptionValueOffset + exceptionValueBytes))
    : new Uint8Array(0);
  if (updateMask.length !== Math.ceil(instanceCount / 8) || updates.length % levels !== 0
    || exceptionMask.length !== Math.ceil(instanceCount / 8) || exceptionValues.length % (45 * 2) !== 0
    || exceptionValueOffset + exceptionValueBytes !== raw.length) {
    throw new Error('Shared SH compressed payload length mismatch.');
  }
  const state = new Uint8Array(slotCount * levels);
  const initialized = new Uint8Array(slotCount);
  let instance = 0;
  let updateOffset = 0;
  let exceptionOffset = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const rowValues = rows[segmentIndex];
    const rowStride = indices[segmentIndex].size;
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const stateOffset = slot * levels;
      if ((updateMask[instance >>> 3] & (1 << (instance & 7))) !== 0) {
        state.set(updates.subarray(updateOffset, updateOffset + levels), stateOffset);
        initialized[slot] = 1;
        updateOffset += levels;
      }
      if (!initialized[slot]) throw new Error(`Missing SH initialization for Track ID ${slot}.`);
      for (let dimension = 0; dimension < 45; dimension += 1) {
        let value = mean[dimension];
        for (let level = 0; level < levels; level += 1) value += codebooks[(level * 256 + state[stateOffset + level]) * 45 + dimension];
        rowValues[row * rowStride + indices[segmentIndex].get(`f_rest_${dimension}`)] = floatToHalf(value);
      }
      if (exceptionMask[instance >>> 3] & (1 << (instance & 7))) {
        for (let dimension = 0; dimension < 45; dimension += 1) {
          rowValues[row * rowStride + indices[segmentIndex].get(`f_rest_${dimension}`)]
            = exceptionValues[exceptionOffset] | (exceptionValues[exceptionOffset + 1] << 8);
          exceptionOffset += 2;
        }
      }
      instance += 1;
    }
  }
  if (instance !== instanceCount || updateOffset !== updates.length || exceptionOffset !== exceptionValues.length) {
    throw new Error('Shared SH trajectory decode length mismatch.');
  }
  return { instanceCount, updateCount: updateOffset / levels, exceptionCount: exceptionOffset / (45 * 2) };
}

function normalizedQuaternion(values) {
  const length = Math.hypot(...values);
  return length > 0 && Number.isFinite(length) ? values.map((value) => value / length) : [1, 0, 0, 0];
}

function quaternionAngleDegrees(a, b) {
  const normalizedA = normalizedQuaternion(a);
  const normalizedB = normalizedQuaternion(b);
  const dot = Math.min(1, Math.abs(normalizedA.reduce((sum, value, index) => sum + value * normalizedB[index], 0)));
  return 2 * Math.acos(dot) * 180 / Math.PI;
}

function validateDecoded(sources, sourceLayout, manifest, activeSlots, rows, indices) {
  let positionSquare = 0;
  let positionCount = 0;
  let positionMaximum = 0;
  let rotationSquare = 0;
  let rotationCount = 0;
  let rotationMaximum = 0;
  let scaleSquare = 0;
  let scaleCount = 0;
  let scaleMaximum = 0;
  let colorDcSquare = 0;
  let colorDcCount = 0;
  let colorDcMaximum = 0;
  let opacitySquare = 0;
  let opacityCount = 0;
  let opacityMaximum = 0;
  let opacityBitExactTemporalValues = 0;
  let opacityBitExactValues = 0;
  let checkedBitExactValues = 0;
  for (let segmentIndex = 0; segmentIndex < sources.length; segmentIndex += 1) {
    const source = sources[segmentIndex];
    const decoded = rows[segmentIndex];
    const decodedStride = indices[segmentIndex].size;
    const inverse = sourceLayout.slotToLocal[segmentIndex];
    for (let row = 0; row < activeSlots[segmentIndex].length; row += 1) {
      const slot = activeSlots[segmentIndex][row];
      const local = inverse[slot];
      const sourceBase = local * source.propertyNames.length;
      const decodedBase = row * decodedStride;
      for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.position; bank += 1) {
        const sourcePosition = ['x', 'y', 'z'].map((component) => halfToFloat(source.rows[sourceBase + source.propertyIndex.get(`xyz_bank_${bank}_${component}`)]));
        const decodedPosition = ['x', 'y', 'z'].map((component) => halfToFloat(decoded[decodedBase + indices[segmentIndex].get(`xyz_bank_${bank}_${component}`)]));
        const error = Math.hypot(...sourcePosition.map((value, axis) => value - decodedPosition[axis]));
        positionSquare += error * error;
        positionMaximum = Math.max(positionMaximum, error);
        positionCount += 1;
      }
      for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.rotation; bank += 1) {
        const sourceRotation = ['w', 'x', 'y', 'z'].map((component) => halfToFloat(source.rows[sourceBase + source.propertyIndex.get(`rot_bank_${bank}_${component}`)]));
        const decodedRotation = ['w', 'x', 'y', 'z'].map((component) => halfToFloat(decoded[decodedBase + indices[segmentIndex].get(`rot_bank_${bank}_${component}`)]));
        const error = quaternionAngleDegrees(sourceRotation, decodedRotation);
        rotationSquare += error * error;
        rotationMaximum = Math.max(rotationMaximum, error);
        rotationCount += 1;
      }
      for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.scale; bank += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const name = `scale_bank_${bank}_${axis}`;
          const sourceValue = halfToFloat(source.rows[sourceBase + source.propertyIndex.get(name)]);
          const decodedValue = halfToFloat(decoded[decodedBase + indices[segmentIndex].get(name)]);
          const error = Math.abs(sourceValue - decodedValue);
          scaleSquare += error * error;
          scaleMaximum = Math.max(scaleMaximum, error);
          scaleCount += 1;
        }
      }
      for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.colorDc; bank += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const name = `f_dc_bank_${bank}_${axis}`;
          const sourceValue = halfToFloat(source.rows[sourceBase + source.propertyIndex.get(name)]);
          const decodedValue = halfToFloat(decoded[decodedBase + indices[segmentIndex].get(name)]);
          const error = Math.abs(sourceValue - decodedValue);
          colorDcSquare += error * error;
          colorDcMaximum = Math.max(colorDcMaximum, error);
          colorDcCount += 1;
        }
      }
      for (let bank = 0; bank < manifest.segments[segmentIndex].bankCounts.opacity; bank += 1) {
        const name = `opacity_bank_${bank}`;
        const sourceBits = source.rows[sourceBase + source.propertyIndex.get(name)];
        const decodedBits = decoded[decodedBase + indices[segmentIndex].get(name)];
        const exactOpacityBank = bank === 0
          ? manifest.compressionV25?.opacityPolicy?.baseBank?.bitExactFp16
          : manifest.compressionV25?.opacityPolicy?.temporalBanks?.bitExactFp16;
        if (exactOpacityBank) {
          if (decodedBits !== sourceBits) throw new Error(`V2.5 Opacity temporal bank mismatch at segment ${segmentIndex}, Track ID ${slot}, ${name}.`);
          opacityBitExactValues += 1;
          if (bank > 0) opacityBitExactTemporalValues += 1;
        }
        // #WDD-gpt 2026-08-16 - V2.5 验收显式统计三个逐位无损 Opacity 时间 bank，不再只报告四 bank 合并 RMSE。
        const sourceLogit = halfToFloat(sourceBits);
        const decodedLogit = halfToFloat(decodedBits);
        const sourceAlpha = sourceLogit >= 0 ? 1 / (1 + Math.exp(-sourceLogit)) : Math.exp(sourceLogit) / (1 + Math.exp(sourceLogit));
        const decodedAlpha = decodedLogit >= 0 ? 1 / (1 + Math.exp(-decodedLogit)) : Math.exp(decodedLogit) / (1 + Math.exp(decodedLogit));
        const error = Math.abs(sourceAlpha - decodedAlpha);
        opacitySquare += error * error;
        opacityMaximum = Math.max(opacityMaximum, error);
        opacityCount += 1;
      }
      for (const [name, decodedProperty] of indices[segmentIndex]) {
        if (name.startsWith('xyz_bank_') || name.startsWith('rot_bank_') || name.startsWith('scale_bank_') || name.startsWith('f_rest_')) continue;
        if ((manifest.mintMixRq?.selected?.colorDc || manifest.mesongsTemporal?.selected?.colorDc || manifest.temporalAttributes?.selected?.colorDc) && name.startsWith('f_dc_bank_')) continue;
        if ((manifest.mintMixRq?.selected?.opacity || manifest.mesongsTemporal?.selected?.opacity) && name.startsWith('opacity_bank_')) continue;
        const sourceProperty = source.propertyIndex.get(name);
        if (decoded[decodedBase + decodedProperty] !== source.rows[sourceBase + sourceProperty]) {
          throw new Error(`Lossless property mismatch at segment ${segmentIndex}, Track ID ${slot}, ${name}.`);
        }
        checkedBitExactValues += 1;
      }
    }
  }
  if (positionMaximum > manifest.prs.position.maximumEuclideanError) throw new Error(`Position error bound violated: ${positionMaximum}`);
  if (rotationMaximum > manifest.prs.rotation.maximumAngleDegrees) throw new Error(`Rotation error bound violated: ${rotationMaximum}`);
  if (scaleMaximum > manifest.prs.scale.maximumLogError) throw new Error(`Scale error bound violated: ${scaleMaximum}`);
  if (manifest.mintMixRq?.selected?.colorDc && colorDcMaximum > manifest.mintMixRq.colorDc.maximumAllowedError) {
    throw new Error(`Color DC error bound violated: ${colorDcMaximum}`);
  }
  if (manifest.mintMixRq?.selected?.opacity && opacityMaximum > manifest.mintMixRq.opacity.maximumAllowedError) {
    throw new Error(`Opacity alpha error bound violated: ${opacityMaximum}`);
  }
  if (manifest.mesongsTemporal?.selected?.colorDc && colorDcMaximum > manifest.mesongsTemporal.colorDc.maximumAllowedError) {
    throw new Error(`Color DC temporal error bound violated: ${colorDcMaximum}`);
  }
  if (manifest.temporalAttributes?.selected?.colorDc && colorDcMaximum > manifest.temporalAttributes.colorDc.measuredMaximumError + 1e-12) {
    throw new Error(`Color DC attribute error bound violated: ${colorDcMaximum}`);
  }
  if (manifest.mesongsTemporal?.selected?.opacity && opacityMaximum > manifest.mesongsTemporal.opacity.maximumAllowedError) {
    throw new Error(`Opacity temporal alpha error bound violated: ${opacityMaximum}`);
  }
  return {
    checkedBitExactValues,
    position: { observationCount: positionCount, rmse: Math.sqrt(positionSquare / positionCount), maximumEuclideanError: positionMaximum },
    rotation: { observationCount: rotationCount, angularRmseDegrees: Math.sqrt(rotationSquare / rotationCount), maximumAngleDegrees: rotationMaximum },
    scale: { valueCount: scaleCount, rmse: Math.sqrt(scaleSquare / scaleCount), maximumLogError: scaleMaximum },
    colorDc: { valueCount: colorDcCount, rmse: Math.sqrt(colorDcSquare / colorDcCount), maximumError: colorDcMaximum },
    opacityAlpha: {
      valueCount: opacityCount,
      rmse: Math.sqrt(opacitySquare / opacityCount),
      maximumError: opacityMaximum,
      bitExactValues: opacityBitExactValues,
      bitExactTemporalValues: opacityBitExactTemporalValues,
    },
  };
}

function runV24DecodeWorker(task, stream, manifest, activeSlots, rows) {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(new URL('./fourcgs-v24-decode-worker.mjs', import.meta.url), {
      workerData: {
        task,
        manifest,
        activeSlots,
        rowBuffers: rows.map((row) => row.buffer),
        stream,
      },
    });
    worker.once('message', resolveWorker);
    worker.once('error', rejectWorker);
    worker.once('exit', (code) => {
      if (code !== 0) rejectWorker(new Error(`V2.4 ${task} Worker exited with code ${code}.`));
    });
  });
}

async function main() {
  const positionalArguments = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
  const sourcePath = resolve(positionalArguments[0] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_prs_morton.4cgs');
  const outputDirectory = resolve(positionalArguments[1] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_prs_morton_decoded');
  const fastDecode = process.argv.includes('--fast');
  let parallelDecode = fastDecode && !process.argv.includes('--single-thread');
  const sourceDirectory = resolve(positionalArguments[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const started = performance.now();
  const phaseMilliseconds = {};
  let phaseStarted = started;
  const finishPhase = (name) => {
    const now = performance.now();
    phaseMilliseconds[name] = now - phaseStarted;
    phaseStarted = now;
  };
  const { manifest, streams, streamMilliseconds } = await readContainer(await readFile(sourcePath), { preserveStructured: fastDecode });
  const activeLayoutStarted = performance.now();
  const activeSlots = activeLayout(manifest, streams.get('active_masks'));
  phaseMilliseconds.containerStreams = streamMilliseconds;
  phaseMilliseconds.activeLayout = performance.now() - activeLayoutStarted;
  parallelDecode = parallelDecode
    && streams.has('prs_position') && isV21StructuredStream(streams.get('prs_position'))
    && ['so3_rotation', 'tattr_scale', 'tattr_dc'].every((name) => streams.has(name) && isV21StructuredStream(streams.get(name)));
  finishPhase('containerAndOuterStreams');
  const directStructured = new Map();
  if (fastDecode && !parallelDecode) {
    // #WDD-gpt 2026-08-16 - xzwasm 复用单一 WASM 内存，三个外层必须串行展开，属性行重建再并行。
    for (const name of ['so3_rotation', 'tattr_scale', 'tattr_dc']) {
      if (streams.has(name) && isV21StructuredStream(streams.get(name))) {
        directStructured.set(name, await decodeV22StructuredParts(name, streams.get(name)));
      }
    }
  }
  finishPhase('directStructuredParts');
  const sources = [];
  let sourceLayout = null;
  if (!fastDecode) {
    const entries = (await readdir(sourceDirectory))
      .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
      .filter((entry) => entry.match)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    for (const entry of entries) sources.push(await readSegment(join(sourceDirectory, entry.name)));
    // #WDD-gpt 2026-08-15 - 与编码端一致，以边界精确 Position 建永久 Track，SH/DC 仅处理重复位置消歧。
    let permanent = buildExactBoundaryPermanentTrackMaps(sources);
    if (permanent.trackCount !== manifest.sourcePermanentTrackCount) {
      const legacyPermanent = buildPermanentTrackMaps(sources);
      if (legacyPermanent.trackCount === manifest.sourcePermanentTrackCount) permanent = legacyPermanent;
    }
    sourceLayout = buildCroppedMortonLayout(sources, permanent, manifest.crop.center, manifest.crop.halfExtent);
    if (sourceLayout.slotCount !== manifest.slotCount) {
      throw new Error(`Permanent Track ID layout mismatch: source ${sourceLayout.slotCount}, manifest ${manifest.slotCount}, permanent ${permanent.trackCount}, matches ${permanent.matches.map((match) => match.matchedCount)}, dropped ${sourceLayout.droppedTrackCount}, center ${manifest.crop.center}, halfExtent ${manifest.crop.halfExtent}.`);
    }
    for (let segmentIndex = 0; segmentIndex < activeSlots.length; segmentIndex += 1) {
      if (!activeSlots[segmentIndex].every((slot, index) => slot === sourceLayout.activeSlots[segmentIndex][index])) {
        throw new Error(`Active Track ID ordering mismatch in segment ${segmentIndex}.`);
      }
    }
  }
  finishPhase('sourceValidationSetup');
  const names = manifest.segments.map(propertyNames);
  const indices = names.map((items) => new Map(items.map((name, index) => [name, index])));
  const rows = manifest.segments.map((segment, index) => {
    const values = segment.gaussianCount * names[index].length;
    return parallelDecode ? new Uint16Array(new SharedArrayBuffer(values * 2)) : new Uint16Array(values);
  });
  let prsDecode;
  let mixRqDecode;
  let shDecode;
  if (parallelDecode) {
    // #WDD-gpt 2026-08-16 - 四条高成本属性在独立 Worker 中写共享行缓冲，主线程同时完成 Opacity、生命周期和 SH。
    const parallelStarted = performance.now();
    const workers = [
      runV24DecodeWorker('position', streams.get('prs_position'), manifest, activeSlots, rows),
      runV24DecodeWorker('rotation', streams.get('so3_rotation'), manifest, activeSlots, rows),
      runV24DecodeWorker('scale', streams.get('tattr_scale'), manifest, activeSlots, rows),
      runV24DecodeWorker('dc', streams.get('tattr_dc'), manifest, activeSlots, rows),
    ];
    mixRqDecode = {};
    let mainStarted = performance.now();
    const opacityStreamName = ['tmrq_opacity', 'mixsc_opacity', 'mixrq_opacity'].find((name) => streams.has(name));
    if (opacityStreamName) {
      mixRqDecode.opacity = decodeMixRqTrack(streams.get(opacityStreamName), manifest, activeSlots, 'opacity_bank', [''], 'opacity', rows, indices);
    } else {
      decodeTemporalStream(
        streams.get('opacity_bank:value'), manifest, activeSlots,
        manifest.segments.map((segment) => Array.from({ length: segment.bankCounts.opacity }, (_, bank) => `opacity_bank_${bank}`)),
        rows, indices,
      );
    }
    phaseMilliseconds.mainOpacity = performance.now() - mainStarted;
    mainStarted = performance.now();
    decodeTemporalStream(streams.get('lifetime_mu'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_mu']), rows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor');
    decodeTemporalStream(streams.get('lifetime_w'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_w']), rows, indices, manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor');
    phaseMilliseconds.mainLifetimes = performance.now() - mainStarted;
    mainStarted = performance.now();
    shDecode = decodeSharedSh(streams.get('coresh5r_shared'), manifest, activeSlots, rows, indices);
    phaseMilliseconds.mainSharedSh = performance.now() - mainStarted;
    const workerResults = await Promise.all(workers);
    prsDecode = { position: null, rotation: null, scale: null };
    for (const result of workerResults) {
      phaseMilliseconds[`${result.task}Worker`] = result.elapsedMilliseconds;
      phaseMilliseconds[`${result.task}Prepare`] = result.prepareMilliseconds;
      if (result.task === 'position') prsDecode.position = result.metrics;
      else if (result.task === 'rotation') prsDecode.rotation = result.metrics;
      else if (result.task === 'scale') prsDecode.scale = result.metrics;
      else mixRqDecode.colorDc = result.metrics;
    }
    phaseMilliseconds.parallelDecodeWall = performance.now() - parallelStarted;
    phaseStarted = performance.now();
  } else {
  prsDecode = {
    position: decodePositions(streams.get('prs_position'), manifest, activeSlots, rows, indices),
  };
  finishPhase('position');
  prsDecode.rotation = streams.has('so3_rotation')
      ? (directStructured.has('so3_rotation')
        ? decodeSo3RotationStreams(directStructured.get('so3_rotation').metadata, directStructured.get('so3_rotation').streams, manifest, activeSlots, rows, indices)
        : decodeSo3Rotations(streams.get('so3_rotation'), manifest, activeSlots, rows, indices))
      : decodeRotations(streams.get('prs_rotation'), manifest, activeSlots, rows, indices);
  prsDecode.scale = null;
  finishPhase('rotation');
  // #WDD-gpt 2026-08-15 - 解码端按清单接受量化 rANS 或更小的 FP16 无损 Scale 流，禁止隐式猜测格式。
  if (streams.has('tattr_scale')) {
    const direct = directStructured.get('tattr_scale');
    prsDecode.scale = direct
      ? decodeTemporalAttributeStreams(direct.metadata, direct.streams, manifest, activeSlots, rows, indices)
      : decodeTemporalAttribute(streams.get('tattr_scale'), manifest, activeSlots, rows, indices);
  } else if (streams.has('tmrq_scale') || streams.has('mixsc_scale') || streams.has('mixrq_scale')) {
    prsDecode.scale = decodeMixRqTrack(streams.get('tmrq_scale') ?? streams.get('mixsc_scale') ?? streams.get('mixrq_scale'), manifest, activeSlots, 'scale_bank', ['0', '1', '2'], 'scale', rows, indices);
  } else if (streams.has('prs_scale')) {
    prsDecode.scale = decodeScales(streams.get('prs_scale'), manifest, activeSlots, rows, indices);
  } else {
    for (const component of ['0', '1', '2']) {
      const namesBySegment = manifest.segments.map((segment) => Array.from(
        { length: segment.bankCounts.scale },
        (_, bank) => `scale_bank_${bank}_${component}`,
      ));
      decodeTemporalStream(
        streams.get(`scale_bank:${component}`),
        manifest,
        activeSlots,
        namesBySegment,
        rows,
        indices,
        manifest.losslessEntropy?.temporalModes?.scale ?? 'xor',
      );
    }
    prsDecode.scale = { mode: 'lossless-fp16-temporal-xor-deflate', appliedExceptions: 0 };
  }
  finishPhase('scale');
  mixRqDecode = {};
  for (const [prefix, components, bankKey, streamNames] of [
    ['f_dc_bank', ['0', '1', '2'], 'colorDc', ['tattr_dc', 'tmrq_dc', 'mixsc_dc', 'mixrq_dc']],
    ['opacity_bank', [''], 'opacity', ['tmrq_opacity', 'mixsc_opacity', 'mixrq_opacity']],
  ]) {
    const streamName = streamNames.find((name) => streams.has(name));
    if (streamName) {
      const direct = directStructured.get(streamName);
      mixRqDecode[bankKey] = streamName.startsWith('tattr_')
        ? (direct
          ? decodeTemporalAttributeStreams(direct.metadata, direct.streams, manifest, activeSlots, rows, indices)
          : decodeTemporalAttribute(streams.get(streamName), manifest, activeSlots, rows, indices))
        : decodeMixRqTrack(streams.get(streamName), manifest, activeSlots, prefix, components, bankKey, rows, indices);
      continue;
    }
    for (const component of components) {
      const namesBySegment = manifest.segments.map((segment) => Array.from(
        { length: segment.bankCounts[bankKey] },
        (_, bank) => component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`,
      ));
      decodeTemporalStream(streams.get(`${prefix}:${component || 'value'}`), manifest, activeSlots, namesBySegment, rows, indices);
    }
  }
  finishPhase('dcAndOpacity');
  decodeTemporalStream(
    streams.get('lifetime_mu'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_mu']), rows, indices,
    manifest.losslessEntropy?.temporalModes?.lifetime_mu ?? 'xor',
  );
  decodeTemporalStream(
    streams.get('lifetime_w'), manifest, activeSlots, manifest.segments.map(() => ['lifetime_w']), rows, indices,
    manifest.losslessEntropy?.temporalModes?.lifetime_w ?? 'xor',
  );
  finishPhase('lifetimes');
  shDecode = decodeSharedSh(streams.get('coresh5r_shared'), manifest, activeSlots, rows, indices);
  finishPhase('sharedSh');
  }
  // #WDD-gpt 2026-08-16 - V2.4 产品解码不再读取原始 RAW4D；逐属性源对照只保留在显式的离线验收路径。
  const validation = fastDecode ? null : validateDecoded(sources, sourceLayout, manifest, activeSlots, rows, indices);
  finishPhase('sourceValidation');
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const segment = manifest.segments[segmentIndex];
    const outputPath = join(outputDirectory, `${segment.name}.decoded.raw4d`);
    const output = createFourCgsCanonicalRaw4D(segment, names[segmentIndex], rows[segmentIndex]);
    await writeFile(outputPath, output);
    outputs.push({ path: outputPath, bytes: output.length, bytesM: output.length / 1_000_000, gaussianCount: segment.gaussianCount });
  }
  finishPhase('writeRaw4d');
  const elapsedMilliseconds = performance.now() - started;
  const report = {
    sourcePath,
    outputDirectory,
    containerChecksumsValidated: true,
    decodeMode: fastDecode ? 'v24-self-contained-fast' : 'validation',
    permanentTrackLayoutValidated: fastDecode ? 'from-container-active-mask' : true,
    cropLayoutValidated: fastDecode ? 'not-required-at-runtime' : true,
    prsDecode,
    mixRqDecode,
    shDecode,
    validation,
    outputs,
    phaseMilliseconds,
    elapsedMilliseconds,
  };
  await writeFile(`${sourcePath}.decode.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

// #WDD-gpt 2026-08-15 - 独立 JS 解码器校验容器、永久 Track ID、P/R/S 硬误差和其余属性位级一致性后再生成前端 RAW4D。
// #WDD-gpt 2026-08-15 - 解码 Braindance 风格 MixRQ Scale/DC/Opacity，并在独立位流重建后复核各属性硬误差上限。
await main();
