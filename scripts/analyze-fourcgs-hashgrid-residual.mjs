import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodeRans, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const POSITION_STEP = 0.0005;
const HALF_EXTENT = 2.5;
const GRID_BASE = 10001;
const BLOCK_SIZE = 256;
const HIERARCHY = [
  { level: 0, target: 5, left: 0, right: 10 },
  { level: 1, target: 2, left: 0, right: 5 },
  { level: 1, target: 7, left: 5, right: 10 },
  { level: 2, target: 1, left: 0, right: 2 },
  { level: 2, target: 3, left: 2, right: 5 },
  { level: 2, target: 6, left: 5, right: 7 },
  { level: 2, target: 8, left: 7, right: 10 },
  { level: 3, target: 4, left: 3, right: 5 },
  { level: 3, target: 9, left: 8, right: 10 },
];
const PROFILES = {
  compact: [
    { cellGrid: 1024, capacity: 256 },
    { cellGrid: 512, capacity: 512 },
    { cellGrid: 256, capacity: 1024 },
    { cellGrid: 128, capacity: 2048 },
    { cellGrid: 64, capacity: 4096 },
  ],
  balanced: [
    { cellGrid: 1024, capacity: 512 },
    { cellGrid: 512, capacity: 1024 },
    { cellGrid: 256, capacity: 2048 },
    { cellGrid: 128, capacity: 4096 },
    { cellGrid: 64, capacity: 8192 },
  ],
};

class ByteWriter {
  constructor(chunkBytes = 1 << 20) {
    this.chunkBytes = chunkBytes;
    this.chunks = [];
    this.chunk = Buffer.allocUnsafe(chunkBytes);
    this.offset = 0;
    this.length = 0;
  }

  byte(value) {
    if (this.offset === this.chunk.length) this.flush();
    this.chunk[this.offset++] = value & 0xff;
    this.length += 1;
  }

  uint(value) {
    let remaining = Math.trunc(value);
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error(`Invalid uint ${value}`);
    while (remaining >= 128) {
      this.byte((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.byte(remaining);
  }

  sint(value) {
    this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  uint40(value) {
    let remaining = value;
    for (let index = 0; index < 5; index += 1) {
      this.byte(remaining % 256);
      remaining = Math.floor(remaining / 256);
    }
  }

  flush() {
    if (this.offset) this.chunks.push(this.chunk.subarray(0, this.offset));
    this.chunk = Buffer.allocUnsafe(this.chunkBytes);
    this.offset = 0;
  }

  finish() {
    this.flush();
    return Buffer.concat(this.chunks, this.length);
  }
}

function robustCenter(segment) {
  const center = [];
  for (const component of ['x', 'y', 'z']) {
    const property = segment.propertyIndex.get(`xyz_bank_0_${component}`);
    const values = new Float32Array(segment.count);
    for (let local = 0; local < segment.count; local += 1) values[local] = halfToFloat(segment.rows[local * segment.propertyNames.length + property]);
    values.sort();
    center.push((values[Math.round((values.length - 1) * 0.005)] + values[Math.round((values.length - 1) * 0.995)]) / 2);
  }
  return center;
}

function positionIndices(segment) {
  return Array.from({ length: bankCount(segment, 'xyz_bank') }, (_, bank) => (
    ['x', 'y', 'z'].map((component) => segment.propertyIndex.get(`xyz_bank_${bank}_${component}`))
  ));
}

// #WDD-gpt 2026-08-15 - 哈希网格只预测整数目标，最终统计残差仍逐值恢复统一 0.5mm 格点。
function quantizedPositionBanks(segment, layout, segmentIndex, origin) {
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const indices = positionIndices(segment);
  const banks = indices.map(() => new Int32Array(active.length * 3));
  const stride = segment.propertyNames.length;
  let outside = 0;
  for (let row = 0; row < active.length; row += 1) {
    const source = inverse[active[row]] * stride;
    for (let bank = 0; bank < indices.length; bank += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = halfToFloat(segment.rows[source + indices[bank][axis]]);
        const quantized = Math.round((value - origin[axis]) / POSITION_STEP);
        banks[bank][row * 3 + axis] = quantized;
        if (quantized < 0 || quantized >= GRID_BASE) outside += 1;
      }
    }
  }
  return { banks, outside };
}

function blockRanges(active) {
  const ranges = [];
  let first = 0;
  while (first < active.length) {
    const block = Math.floor(active[first] / BLOCK_SIZE);
    let last = first + 1;
    while (last < active.length && Math.floor(active[last] / BLOCK_SIZE) === block) last += 1;
    ranges.push({ first, last });
    first = last;
  }
  return ranges;
}

function hashCell(x, y, z, capacity) {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0 & (capacity - 1);
}

function temporalPrediction(banks, task) {
  const count = banks[0].length / 3;
  const predicted = new Int32Array(count * 3);
  const target = banks[task.target];
  if (task.boundary) {
    predicted.set(banks[0]);
    return { predicted, target };
  }
  const denominator = task.right - task.left;
  for (let offset = 0; offset < predicted.length; offset += 1) {
    predicted[offset] = Math.round(((task.right - task.target) * banks[task.left][offset]
      + (task.target - task.left) * banks[task.right][offset]) / denominator);
  }
  return { predicted, target };
}

function applyBlockTranslation(predicted, target, active, parameters) {
  const ranges = blockRanges(active);
  for (const range of ranges) {
    const translation = [0, 0, 0];
    for (let row = range.first; row < range.last; row += 1) {
      for (let axis = 0; axis < 3; axis += 1) translation[axis] += target[row * 3 + axis] - predicted[row * 3 + axis];
    }
    for (let axis = 0; axis < 3; axis += 1) {
      translation[axis] = Math.round(translation[axis] / (range.last - range.first));
      parameters.sint(translation[axis]);
    }
    for (let row = range.first; row < range.last; row += 1) {
      for (let axis = 0; axis < 3; axis += 1) predicted[row * 3 + axis] += translation[axis];
    }
  }
  return ranges.length;
}

// #WDD-gpt 2026-08-15 - 多层哈希表逐级拟合前一级失败残差，碰撞桶取整数均值并将占用和值分流熵编码。
function applyHashGrid(predicted, target, levels, streams) {
  const count = target.length / 3;
  const residual = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 1) residual[offset] = target[offset] - predicted[offset];
  const levelMetrics = [];
  for (const level of levels) {
    const sums = new Float64Array(level.capacity * 3);
    const counts = new Uint32Array(level.capacity);
    for (let row = 0; row < count; row += 1) {
      const offset = row * 3;
      const bucket = hashCell(
        Math.floor(predicted[offset] / level.cellGrid),
        Math.floor(predicted[offset + 1] / level.cellGrid),
        Math.floor(predicted[offset + 2] / level.cellGrid),
        level.capacity,
      );
      counts[bucket] += 1;
      sums[bucket * 3] += residual[offset];
      sums[bucket * 3 + 1] += residual[offset + 1];
      sums[bucket * 3 + 2] += residual[offset + 2];
    }
    const corrections = new Int32Array(level.capacity * 3);
    const mask = Buffer.alloc(Math.ceil(level.capacity / 8));
    let used = 0;
    for (let bucket = 0; bucket < level.capacity; bucket += 1) {
      if (!counts[bucket]) continue;
      mask[bucket >>> 3] |= 1 << (bucket & 7);
      used += 1;
      for (let axis = 0; axis < 3; axis += 1) {
        const correction = Math.round(sums[bucket * 3 + axis] / counts[bucket]);
        corrections[bucket * 3 + axis] = correction;
        streams.gridValues[axis].sint(correction);
      }
    }
    for (const byte of mask) streams.gridMasks.byte(byte);
    let square = 0;
    let zero = 0;
    for (let row = 0; row < count; row += 1) {
      const offset = row * 3;
      const bucket = hashCell(
        Math.floor(predicted[offset] / level.cellGrid),
        Math.floor(predicted[offset + 1] / level.cellGrid),
        Math.floor(predicted[offset + 2] / level.cellGrid),
        level.capacity,
      );
      let vectorZero = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const correction = corrections[bucket * 3 + axis];
        predicted[offset + axis] += correction;
        residual[offset + axis] -= correction;
        square += residual[offset + axis] * residual[offset + axis];
        if (residual[offset + axis] !== 0) vectorZero = false;
      }
      if (vectorZero) zero += 1;
    }
    levelMetrics.push({
      cellMeters: level.cellGrid * POSITION_STEP,
      capacity: level.capacity,
      used,
      usedRatio: used / level.capacity,
      componentRmseMeters: Math.sqrt(square / (count * 3)) * POSITION_STEP,
      zeroRatio: zero / count,
    });
  }
  return { residual, levelMetrics };
}

function packedResidual(x, y, z) {
  const limit = 255;
  if (Math.abs(x) > limit || Math.abs(y) > limit || Math.abs(z) > limit) return -1;
  const base = limit * 2 + 1;
  return (x + limit) * base * base + (y + limit) * base + z + limit;
}

function unpackedResidual(key) {
  const limit = 255;
  const base = limit * 2 + 1;
  const x = Math.floor(key / (base * base));
  const remainder = key - x * base * base;
  const y = Math.floor(remainder / base);
  return [x - limit, y - limit, remainder - y * base - limit];
}

function residualDictionary(frames) {
  const counts = new Map();
  const zeroKey = packedResidual(0, 0, 0);
  for (const frame of frames) {
    for (let offset = 0; offset < frame.length; offset += 3) {
      const key = packedResidual(frame[offset], frame[offset + 1], frame[offset + 2]);
      if (key >= 0 && key !== zeroKey) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 254)
    .map(([key, count]) => ({ value: unpackedResidual(key), count }));
  return { entries, lookup: new Map(entries.map((entry, index) => [packedResidual(...entry.value), index + 1])) };
}

function writeResidualSymbol(x, y, z, dictionary, streams) {
  if (x === 0 && y === 0 && z === 0) {
    streams.symbols.byte(0);
    return;
  }
  const symbol = dictionary.lookup.get(packedResidual(x, y, z));
  if (symbol !== undefined) {
    streams.symbols.byte(symbol);
    return;
  }
  streams.symbols.byte(255);
  streams.escapes[0].sint(x);
  streams.escapes[1].sint(y);
  streams.escapes[2].sint(z);
}

function encodeStatisticalResiduals(frames, activeByFrame, dictionary, streams) {
  let observations = 0;
  let zeroVectors = 0;
  let escapes = 0;
  let squared = 0;
  let maximum = 0;
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex];
    const active = activeByFrame[frameIndex];
    for (const range of blockRanges(active)) {
      let nonzero = 0;
      for (let row = range.first; row < range.last; row += 1) {
        const offset = row * 3;
        if (frame[offset] !== 0 || frame[offset + 1] !== 0 || frame[offset + 2] !== 0) nonzero += 1;
      }
      if (nonzero === 0) {
        streams.modes.byte(0);
        zeroVectors += range.last - range.first;
        observations += range.last - range.first;
        continue;
      }
      const sparse = nonzero * 2 < range.last - range.first;
      streams.modes.byte(sparse ? 1 : 2);
      let previous = -1;
      if (sparse) streams.masks.uint(nonzero);
      for (let row = range.first; row < range.last; row += 1) {
        const offset = row * 3;
        const x = frame[offset];
        const y = frame[offset + 1];
        const z = frame[offset + 2];
        const isZero = x === 0 && y === 0 && z === 0;
        observations += 1;
        if (isZero) zeroVectors += 1;
        squared += x * x + y * y + z * z;
        maximum = Math.max(maximum, Math.abs(x), Math.abs(y), Math.abs(z));
        if (sparse && isZero) continue;
        if (sparse) {
          streams.masks.uint(row - range.first - previous - 1);
          previous = row - range.first;
        }
        if (!isZero && !dictionary.lookup.has(packedResidual(x, y, z))) escapes += 1;
        writeResidualSymbol(x, y, z, dictionary, streams);
      }
    }
  }
  return {
    observations,
    zeroRatio: zeroVectors / observations,
    escapeCount: escapes,
    escapeRatio: escapes / observations,
    componentRmseMeters: Math.sqrt(squared / (observations * 3)) * POSITION_STEP,
    maximumComponentGrid: maximum,
  };
}

function ransMetrics(writer) {
  const raw = writer.finish();
  const encoded = encodeRans(raw);
  return { rawBytes: raw.length, ransBytes: encoded.length };
}

function encodeResidualContext(frames, activeByFrame) {
  const streams = {
    modes: new ByteWriter(),
    masks: new ByteWriter(),
    symbols: new ByteWriter(),
    escapes: [new ByteWriter(), new ByteWriter(), new ByteWriter()],
  };
  const dictionary = residualDictionary(frames);
  const dictionaryWriter = new ByteWriter();
  dictionaryWriter.uint(dictionary.entries.length);
  for (const entry of dictionary.entries) for (const value of entry.value) dictionaryWriter.sint(value);
  const residualMetrics = encodeStatisticalResiduals(frames, activeByFrame, dictionary, streams);
  const encodedStreams = {
    dictionary: ransMetrics(dictionaryWriter),
    modes: ransMetrics(streams.modes),
    masks: ransMetrics(streams.masks),
    symbols: ransMetrics(streams.symbols),
    escapeX: ransMetrics(streams.escapes[0]),
    escapeY: ransMetrics(streams.escapes[1]),
    escapeZ: ransMetrics(streams.escapes[2]),
  };
  return {
    dictionaryEntries: dictionary.entries.length,
    mostCommon: dictionary.entries.slice(0, 16),
    residualMetrics,
    streams: encodedStreams,
    ransBytes: Object.values(encodedStreams).reduce((sum, stream) => sum + stream.ransBytes, 0),
  };
}

function activeMask(layout) {
  const bytes = Buffer.alloc(Math.ceil(layout.trackCount * layout.activeSlots.length / 8));
  for (let segmentIndex = 0; segmentIndex < layout.activeSlots.length; segmentIndex += 1) {
    for (const slot of layout.activeSlots[segmentIndex]) {
      const bit = segmentIndex * layout.trackCount + slot;
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bytes;
}

function birthPositions(positionSegments, layout) {
  const initialized = new Uint8Array(layout.trackCount);
  const codes = new Float64Array(layout.trackCount);
  for (let segmentIndex = 0; segmentIndex < positionSegments.length; segmentIndex += 1) {
    const active = layout.activeSlots[segmentIndex];
    const bank = positionSegments[segmentIndex][0];
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      if (initialized[slot]) continue;
      const offset = row * 3;
      codes[slot] = (bank[offset] * GRID_BASE + bank[offset + 1]) * GRID_BASE + bank[offset + 2];
      initialized[slot] = 1;
    }
  }
  const writer = new ByteWriter();
  for (let slot = 0; slot < layout.trackCount; slot += 1) writer.uint40(codes[slot]);
  return writer.finish();
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/hashgrid_residual_20260815/position_hashgrid.json');
  const profileName = process.argv[4] ?? 'compact';
  const levels = PROFILES[profileName];
  if (!levels) throw new Error(`Unknown hash-grid profile ${profileName}.`);
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  let sourceBytes = 0;
  for (const entry of entries) {
    const path = join(sourceDirectory, entry.name);
    segments.push(await readSegment(path));
    sourceBytes += (await stat(path)).size;
    console.log(JSON.stringify({ phase: 'load', file: entry.name }));
  }
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const center = robustCenter(segments[0]);
  const origin = center.map((value) => value - HALF_EXTENT);
  const layout = buildCroppedMortonLayout(segments, permanent, center, HALF_EXTENT);
  const positionSegments = [];
  let outside = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const result = quantizedPositionBanks(segments[segmentIndex], layout, segmentIndex, origin);
    positionSegments.push(result.banks);
    outside += result.outside;
    console.log(JSON.stringify({ phase: 'quantize', segment: basename(segments[segmentIndex].path), tracks: layout.activeSlots[segmentIndex].length }));
  }
  if (outside) throw new Error(`${outside} coordinates are outside the mixed-radix grid.`);

  const streams = {
    blockParameters: new ByteWriter(),
    gridMasks: new ByteWriter(),
    gridValues: [new ByteWriter(), new ByteWriter(), new ByteWriter()],
    modes: new ByteWriter(),
    masks: new ByteWriter(),
    symbols: new ByteWriter(),
    escapes: [new ByteWriter(), new ByteWriter(), new ByteWriter()],
  };
  const residualFrames = [];
  const activeByFrame = [];
  const contextByFrame = [];
  const gridMetrics = [];
  let blockFrames = 0;
  for (let segmentIndex = 0; segmentIndex < positionSegments.length; segmentIndex += 1) {
    const banks = positionSegments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const tasks = [{ boundary: true, target: 10, left: 0, right: 10 }, ...HIERARCHY];
    for (const task of tasks) {
      const { predicted, target } = temporalPrediction(banks, task);
      blockFrames += applyBlockTranslation(predicted, target, active, streams.blockParameters);
      const hashResult = applyHashGrid(predicted, target, levels, streams);
      residualFrames.push(hashResult.residual);
      activeByFrame.push(active);
      contextByFrame.push(task.boundary ? 'boundary' : `level${task.level}`);
      gridMetrics.push({ segment: segmentIndex, key: task.target, boundary: Boolean(task.boundary), levels: hashResult.levelMetrics });
      console.log(JSON.stringify({ phase: 'hash_grid', segment: segmentIndex, key: task.target, boundary: Boolean(task.boundary), final: hashResult.levelMetrics.at(-1) }));
    }
  }
  const dictionary = residualDictionary(residualFrames);
  const dictionaryWriter = new ByteWriter();
  dictionaryWriter.uint(dictionary.entries.length);
  for (const entry of dictionary.entries) for (const value of entry.value) dictionaryWriter.sint(value);
  const residualMetrics = encodeStatisticalResiduals(residualFrames, activeByFrame, dictionary, streams);
  const contextualResidual = {};
  for (const context of ['boundary', 'level0', 'level1', 'level2', 'level3']) {
    const indices = contextByFrame.map((value, index) => value === context ? index : -1).filter((index) => index >= 0);
    contextualResidual[context] = encodeResidualContext(
      indices.map((index) => residualFrames[index]),
      indices.map((index) => activeByFrame[index]),
    );
  }
  const encodedStreams = {
    activeMask: { rawBytes: activeMask(layout).length, ransBytes: encodeRans(activeMask(layout)).length },
    birthPosition40: (() => {
      const raw = birthPositions(positionSegments, layout);
      return { rawBytes: raw.length, ransBytes: encodeRans(raw).length };
    })(),
    dictionary: ransMetrics(dictionaryWriter),
    blockParameters: ransMetrics(streams.blockParameters),
    gridMasks: ransMetrics(streams.gridMasks),
    gridX: ransMetrics(streams.gridValues[0]),
    gridY: ransMetrics(streams.gridValues[1]),
    gridZ: ransMetrics(streams.gridValues[2]),
    modes: ransMetrics(streams.modes),
    masks: ransMetrics(streams.masks),
    symbols: ransMetrics(streams.symbols),
    escapeX: ransMetrics(streams.escapes[0]),
    escapeY: ransMetrics(streams.escapes[1]),
    escapeZ: ransMetrics(streams.escapes[2]),
  };
  const totalBytes = Object.values(encodedStreams).reduce((sum, stream) => sum + stream.ransBytes, 0);
  const predictedBytes = totalBytes - encodedStreams.activeMask.ransBytes - encodedStreams.birthPosition40.ransBytes;
  const sharedPredictorBytes = [
    encodedStreams.blockParameters,
    encodedStreams.gridMasks,
    encodedStreams.gridX,
    encodedStreams.gridY,
    encodedStreams.gridZ,
  ].reduce((sum, stream) => sum + stream.ransBytes, 0);
  const contextualResidualBytes = Object.values(contextualResidual).reduce((sum, context) => sum + context.ransBytes, 0);
  const contextualPredictedBytes = sharedPredictorBytes + contextualResidualBytes;
  const baseBytes = encodedStreams.activeMask.ransBytes + encodedStreams.birthPosition40.ransBytes;
  const contextualTotalBytes = baseBytes + contextualPredictedBytes;
  const report = {
    format: '4CGS hash-grid residual entropy probe v1',
    generatedAt: new Date().toISOString(),
    sourceDirectory,
    sourceBytes,
    sourceMegabytes: sourceBytes / 1e6,
    profileName,
    levels: levels.map((level) => ({ ...level, cellMeters: level.cellGrid * POSITION_STEP })),
    geometry: {
      positionStepMeters: POSITION_STEP,
      maximumEuclideanErrorMeters: Math.sqrt(3) * POSITION_STEP / 2,
      center,
      origin,
      outside,
    },
    tracks: {
      permanentTracks: layout.trackCount,
      activeSegmentInstances: layout.activeSlots.reduce((sum, active) => sum + active.length, 0),
      segmentTrackCounts: layout.activeSlots.map((active) => active.length),
      blockSize: BLOCK_SIZE,
      blockFrames,
    },
    temporal: {
      segments: segments.length,
      uniqueGlobalPositionKeys: 61,
      predictedKeys: residualFrames.length,
      observations: residualMetrics.observations,
      hierarchy: HIERARCHY,
    },
    dictionary: {
      entries: dictionary.entries.length,
      mostCommon: dictionary.entries.slice(0, 16),
    },
    residualMetrics,
    gridMetrics,
    streams: encodedStreams,
    contextualResidual,
    contextualResidualBytes,
    contextualPredictedBytes,
    contextualPredictedMegabytes: contextualPredictedBytes / 1e6,
    contextualTotalPositionBytes: contextualTotalBytes,
    contextualTotalPositionMegabytes: contextualTotalBytes / 1e6,
    contextualBitsPerPredictedPointKey: contextualPredictedBytes * 8 / residualMetrics.observations,
    predictedBytes,
    predictedMegabytes: predictedBytes / 1e6,
    totalPositionBytes: totalBytes,
    totalPositionMegabytes: totalBytes / 1e6,
    bitsPerPredictedPointKey: predictedBytes * 8 / residualMetrics.observations,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    phase: 'done',
    outputPath,
    profileName,
    totalPositionMegabytes: report.totalPositionMegabytes,
    contextualTotalPositionMegabytes: report.contextualTotalPositionMegabytes,
    predictedMegabytes: report.predictedMegabytes,
    contextualPredictedMegabytes: report.contextualPredictedMegabytes,
    bitsPerPredictedPointKey: report.bitsPerPredictedPointKey,
    residual: residualMetrics,
  }));
}

await main();
