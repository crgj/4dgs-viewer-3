import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodeRans, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const POSITION_STEP = 0.0005;
const HALF_EXTENT = 2.5;
const BLOCK_SIZE = 256;
const HASH_LEVELS = [
  { cellGrid: 1024, capacity: 256 },
  { cellGrid: 512, capacity: 512 },
  { cellGrid: 256, capacity: 1024 },
  { cellGrid: 128, capacity: 2048 },
  { cellGrid: 64, capacity: 4096 },
];
const ATTRIBUTE_PROFILES = [
  { name: 'scale', prefix: 'scale_bank', components: ['0', '1', '2'], step: 2 ** -10, family: 'controlled' },
  { name: 'opacity', prefix: 'opacity_bank', components: [''], step: 2 ** -8, family: 'controlled' },
  { name: 'dc', prefix: 'f_dc_bank', components: ['0', '1', '2'], step: 2 ** -9, family: 'controlled' },
  { name: 'scaleFp16Exact', prefix: 'scale_bank', components: ['0', '1', '2'], exactHalf: true, family: 'exactFp16' },
  { name: 'opacityFp16Exact', prefix: 'opacity_bank', components: [''], exactHalf: true, family: 'exactFp16' },
  { name: 'dcFp16Exact', prefix: 'f_dc_bank', components: ['0', '1', '2'], exactHalf: true, family: 'exactFp16' },
];

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
    while (remaining >= 128) {
      this.byte((remaining % 128) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    this.byte(remaining);
  }

  sint(value) {
    this.uint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  ushort(value) {
    this.byte(value);
    this.byte(value >>> 8);
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

function ransMetrics(writer) {
  const raw = writer.finish();
  return { rawBytes: raw.length, ransBytes: encodeRans(raw).length };
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
  return ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & (capacity - 1);
}

function positionBankZero(segment, layout, segmentIndex, origin) {
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const properties = ['x', 'y', 'z'].map((axis) => segment.propertyIndex.get(`xyz_bank_0_${axis}`));
  const values = new Int32Array(active.length * 3);
  for (let row = 0; row < active.length; row += 1) {
    const source = inverse[active[row]] * segment.propertyNames.length;
    for (let axis = 0; axis < 3; axis += 1) {
      values[row * 3 + axis] = Math.round((halfToFloat(segment.rows[source + properties[axis]]) - origin[axis]) / POSITION_STEP);
    }
  }
  return values;
}

function orderedHalf(bits) {
  return bits & 0x8000 ? (~bits & 0xffff) : (bits ^ 0x8000);
}

function quantizedAttributeBanks(segment, layout, segmentIndex, profile) {
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const count = bankCount(segment, profile.prefix);
  const properties = Array.from({ length: count }, (_, bank) => profile.components.map((component) => (
    segment.propertyIndex.get(`${profile.prefix}_${bank}${component === '' ? '' : `_${component}`}`)
  )));
  return properties.map((indices) => {
    const values = new Int32Array(active.length * profile.components.length);
    for (let row = 0; row < active.length; row += 1) {
      const source = layout.slotToLocal[segmentIndex][active[row]] * segment.propertyNames.length;
      for (let component = 0; component < indices.length; component += 1) {
        const bits = segment.rows[source + indices[component]];
        values[row * indices.length + component] = profile.exactHalf ? orderedHalf(bits) : Math.round(halfToFloat(bits) / profile.step);
      }
    }
    return values;
  });
}

function subset(values, rows, dimensions) {
  const result = new Int32Array(rows.length * dimensions);
  for (let index = 0; index < rows.length; index += 1) {
    for (let component = 0; component < dimensions; component += 1) result[index * dimensions + component] = values[rows[index] * dimensions + component];
  }
  return result;
}

function subsetPositions(values, rows) {
  return subset(values, rows, 3);
}

function difference(target, predicted) {
  const residual = new Int32Array(target.length);
  for (let index = 0; index < target.length; index += 1) residual[index] = target[index] - predicted[index];
  return residual;
}

function interpolated(left, right, numerator, denominator) {
  const result = new Int32Array(left.length);
  for (let index = 0; index < left.length; index += 1) result[index] = Math.round(((denominator - numerator) * left[index] + numerator * right[index]) / denominator);
  return result;
}

// #WDD-gpt 2026-08-15 - 属性基准只在永久 Track 出生时写一次，跨段对应点复用上一段已解码端点并单独修复极少边界差异。
function buildAttributeFrames(segments, layout, positions, profile) {
  const dimensions = profile.components.length;
  const initialized = new Uint8Array(layout.trackCount);
  const endState = new Int32Array(layout.trackCount * dimensions);
  const birthState = new Int32Array(layout.trackCount * dimensions);
  const frames = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const active = layout.activeSlots[segmentIndex];
    const banks = quantizedAttributeBanks(segments[segmentIndex], layout, segmentIndex, profile);
    const continuedRows = [];
    const continuedSlots = [];
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      if (!initialized[slot]) {
        for (let component = 0; component < dimensions; component += 1) birthState[slot * dimensions + component] = banks[0][row * dimensions + component];
      } else {
        continuedRows.push(row);
        continuedSlots.push(slot);
      }
    }
    if (continuedRows.length) {
      const target = subset(banks[0], continuedRows, dimensions);
      const predicted = new Int32Array(target.length);
      for (let index = 0; index < continuedSlots.length; index += 1) {
        const slot = continuedSlots[index];
        for (let component = 0; component < dimensions; component += 1) predicted[index * dimensions + component] = endState[slot * dimensions + component];
      }
      frames.push({
        context: 'sharedBoundaryRepair',
        segmentIndex,
        key: 0,
        active: Int32Array.from(continuedSlots),
        positions: subsetPositions(positions[segmentIndex], continuedRows),
        residual: difference(target, predicted),
      });
    }
    const endpoint = banks.length - 1;
    frames.push({
      context: 'endpoint',
      segmentIndex,
      key: endpoint,
      active,
      positions: positions[segmentIndex],
      residual: difference(banks[endpoint], banks[0]),
    });
    for (let bank = 1; bank < endpoint; bank += 1) {
      frames.push({
        context: 'internal',
        segmentIndex,
        key: bank,
        active,
        positions: positions[segmentIndex],
        residual: difference(banks[bank], interpolated(banks[0], banks[endpoint], bank, endpoint)),
      });
    }
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      for (let component = 0; component < dimensions; component += 1) endState[slot * dimensions + component] = banks[endpoint][row * dimensions + component];
      initialized[slot] = 1;
    }
  }
  return { birthState, frames };
}

function applyBlockMean(frame, dimensions, writer) {
  for (const range of blockRanges(frame.active)) {
    const correction = new Int32Array(dimensions);
    for (let row = range.first; row < range.last; row += 1) {
      for (let component = 0; component < dimensions; component += 1) correction[component] += frame.residual[row * dimensions + component];
    }
    for (let component = 0; component < dimensions; component += 1) {
      correction[component] = Math.round(correction[component] / (range.last - range.first));
      writer.sint(correction[component]);
    }
    for (let row = range.first; row < range.last; row += 1) {
      for (let component = 0; component < dimensions; component += 1) frame.residual[row * dimensions + component] -= correction[component];
    }
  }
}

// #WDD-gpt 2026-08-15 - Scale、Opacity、DC 共用同一空间哈希预测器，网格只存每个碰撞桶的量化残差均值。
function applyHashGrid(frame, dimensions, streams) {
  for (const level of HASH_LEVELS) {
    const sums = new Float64Array(level.capacity * dimensions);
    const counts = new Uint32Array(level.capacity);
    for (let row = 0; row < frame.active.length; row += 1) {
      const position = row * 3;
      const bucket = hashCell(
        Math.floor(frame.positions[position] / level.cellGrid),
        Math.floor(frame.positions[position + 1] / level.cellGrid),
        Math.floor(frame.positions[position + 2] / level.cellGrid),
        level.capacity,
      );
      counts[bucket] += 1;
      for (let component = 0; component < dimensions; component += 1) sums[bucket * dimensions + component] += frame.residual[row * dimensions + component];
    }
    const corrections = new Int32Array(level.capacity * dimensions);
    const mask = Buffer.alloc(Math.ceil(level.capacity / 8));
    for (let bucket = 0; bucket < level.capacity; bucket += 1) {
      if (!counts[bucket]) continue;
      mask[bucket >>> 3] |= 1 << (bucket & 7);
      for (let component = 0; component < dimensions; component += 1) {
        const value = Math.round(sums[bucket * dimensions + component] / counts[bucket]);
        corrections[bucket * dimensions + component] = value;
        streams.gridValues[component].sint(value);
      }
    }
    for (const byte of mask) streams.gridMasks.byte(byte);
    for (let row = 0; row < frame.active.length; row += 1) {
      const position = row * 3;
      const bucket = hashCell(
        Math.floor(frame.positions[position] / level.cellGrid),
        Math.floor(frame.positions[position + 1] / level.cellGrid),
        Math.floor(frame.positions[position + 2] / level.cellGrid),
        level.capacity,
      );
      for (let component = 0; component < dimensions; component += 1) frame.residual[row * dimensions + component] -= corrections[bucket * dimensions + component];
    }
  }
}

function packedTriple(x, y, z) {
  const limit = 255;
  if (Math.abs(x) > limit || Math.abs(y) > limit || Math.abs(z) > limit) return -1;
  const base = limit * 2 + 1;
  return (x + limit) * base * base + (y + limit) * base + z + limit;
}

function unpackedTriple(key) {
  const limit = 255;
  const base = limit * 2 + 1;
  const x = Math.floor(key / (base * base));
  const remainder = key - x * base * base;
  const y = Math.floor(remainder / base);
  return [x - limit, y - limit, remainder - y * base - limit];
}

function tripleDictionary(frames) {
  const counts = new Map();
  const zero = packedTriple(0, 0, 0);
  for (const frame of frames) {
    for (let offset = 0; offset < frame.residual.length; offset += 3) {
      const key = packedTriple(frame.residual[offset], frame.residual[offset + 1], frame.residual[offset + 2]);
      if (key >= 0 && key !== zero) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 254).map(([key]) => unpackedTriple(key));
  return { entries, lookup: new Map(entries.map((entry, index) => [packedTriple(...entry), index + 1])) };
}

function encodeContext(frames, dimensions) {
  const modes = new ByteWriter();
  const masks = new ByteWriter();
  const values = Array.from({ length: dimensions }, () => new ByteWriter());
  const symbols = dimensions === 3 ? new ByteWriter() : undefined;
  const escapes = dimensions === 3 ? Array.from({ length: 3 }, () => new ByteWriter()) : undefined;
  const dictionary = dimensions === 3 ? tripleDictionary(frames) : undefined;
  let observations = 0;
  let zeros = 0;
  let squared = 0;
  for (const frame of frames) {
    for (const range of blockRanges(frame.active)) {
      let nonzero = 0;
      for (let row = range.first; row < range.last; row += 1) {
        let zero = true;
        for (let component = 0; component < dimensions; component += 1) zero &&= frame.residual[row * dimensions + component] === 0;
        if (!zero) nonzero += 1;
      }
      if (!nonzero) {
        modes.byte(0);
        observations += range.last - range.first;
        zeros += range.last - range.first;
        continue;
      }
      const sparse = nonzero * 2 < range.last - range.first;
      modes.byte(sparse ? 1 : 2);
      if (sparse) masks.uint(nonzero);
      let previous = -1;
      for (let row = range.first; row < range.last; row += 1) {
        const offset = row * dimensions;
        let zero = true;
        for (let component = 0; component < dimensions; component += 1) {
          const value = frame.residual[offset + component];
          zero &&= value === 0;
          squared += value * value;
        }
        observations += 1;
        if (zero) zeros += 1;
        if (sparse && zero) continue;
        if (sparse) {
          masks.uint(row - range.first - previous - 1);
          previous = row - range.first;
        }
        if (dimensions === 1) {
          values[0].sint(frame.residual[offset]);
        } else {
          const x = frame.residual[offset];
          const y = frame.residual[offset + 1];
          const z = frame.residual[offset + 2];
          if (zero) symbols.byte(0);
          else {
            const symbol = dictionary.lookup.get(packedTriple(x, y, z));
            if (symbol !== undefined) symbols.byte(symbol);
            else {
              symbols.byte(255);
              escapes[0].sint(x); escapes[1].sint(y); escapes[2].sint(z);
            }
          }
        }
      }
    }
  }
  const streams = { modes: ransMetrics(modes), masks: ransMetrics(masks) };
  if (dimensions === 1) streams.values = ransMetrics(values[0]);
  else {
    const dictionaryWriter = new ByteWriter();
    dictionaryWriter.uint(dictionary.entries.length);
    for (const entry of dictionary.entries) for (const value of entry) dictionaryWriter.sint(value);
    streams.dictionary = ransMetrics(dictionaryWriter);
    streams.symbols = ransMetrics(symbols);
    streams.escapeX = ransMetrics(escapes[0]);
    streams.escapeY = ransMetrics(escapes[1]);
    streams.escapeZ = ransMetrics(escapes[2]);
  }
  return {
    observations,
    zeroRatio: zeros / observations,
    quantizedComponentRmse: Math.sqrt(squared / (observations * dimensions)),
    streams,
    ransBytes: Object.values(streams).reduce((sum, stream) => sum + stream.ransBytes, 0),
  };
}

function compressAttribute(framesResult, profile, layout) {
  const dimensions = profile.components.length;
  // #WDD-gpt 2026-08-15 - 每种属性同时测最简单的分量分流时间残差，只有哈希预测确实省字节时才承担其网格开销。
  const directContexts = {};
  for (const context of ['sharedBoundaryRepair', 'endpoint', 'internal']) {
    const writers = Array.from({ length: dimensions }, () => new ByteWriter());
    for (const frame of framesResult.frames.filter((candidate) => candidate.context === context)) {
      for (let offset = 0; offset < frame.residual.length; offset += dimensions) {
        for (let component = 0; component < dimensions; component += 1) writers[component].sint(frame.residual[offset + component]);
      }
    }
    directContexts[context] = writers.map((writer) => ransMetrics(writer));
  }
  const predictorStreams = {
    blockParameters: new ByteWriter(),
    gridMasks: new ByteWriter(),
    gridValues: Array.from({ length: dimensions }, () => new ByteWriter()),
  };
  for (const frame of framesResult.frames) {
    applyBlockMean(frame, dimensions, predictorStreams.blockParameters);
    applyHashGrid(frame, dimensions, predictorStreams);
  }
  const birthWriter = new ByteWriter();
  for (const value of framesResult.birthState) {
    if (profile.exactHalf) birthWriter.ushort(value);
    else birthWriter.sint(value);
  }
  const streams = {
    birth: ransMetrics(birthWriter),
    blockParameters: ransMetrics(predictorStreams.blockParameters),
    gridMasks: ransMetrics(predictorStreams.gridMasks),
  };
  for (let component = 0; component < dimensions; component += 1) streams[`grid${component}`] = ransMetrics(predictorStreams.gridValues[component]);
  const contexts = {};
  for (const context of ['sharedBoundaryRepair', 'endpoint', 'internal']) {
    contexts[context] = encodeContext(framesResult.frames.filter((frame) => frame.context === context), dimensions);
  }
  const contextBytes = Object.values(contexts).reduce((sum, context) => sum + context.ransBytes, 0);
  const predictorBytes = Object.entries(streams).filter(([name]) => name !== 'birth').reduce((sum, [, stream]) => sum + stream.ransBytes, 0);
  const totalBytes = streams.birth.ransBytes + predictorBytes + contextBytes;
  const directTemporalBytes = streams.birth.ransBytes + Object.values(directContexts).flat().reduce((sum, stream) => sum + stream.ransBytes, 0);
  return {
    profile,
    tracks: layout.trackCount,
    frames: framesResult.frames.length,
    streams,
    contexts,
    contextBytes,
    predictorBytes,
    totalBytes,
    totalMegabytes: totalBytes / 1e6,
    directContexts,
    directTemporalBytes,
    directTemporalMegabytes: directTemporalBytes / 1e6,
    maximumComponentQuantizationError: profile.exactHalf ? 0 : profile.step / 2,
  };
}

function lifetimeStream(segments, layout) {
  const state = new Uint16Array(layout.trackCount * 2);
  const initialized = new Uint8Array(layout.trackCount);
  const mask = new ByteWriter();
  const values = new ByteWriter();
  let observations = 0;
  let updates = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    const indices = ['lifetime_mu', 'lifetime_w'].map((name) => segment.propertyIndex.get(name));
    for (const slot of active) {
      const local = inverse[slot];
      const source = local * segment.propertyNames.length;
      const current = indices.map((index) => segment.rows[source + index]);
      const changed = !initialized[slot] || current[0] !== state[slot * 2] || current[1] !== state[slot * 2 + 1];
      mask.byte(changed ? 1 : 0);
      if (changed) {
        values.ushort(current[0]); values.ushort(current[1]);
        state[slot * 2] = current[0]; state[slot * 2 + 1] = current[1];
        initialized[slot] = 1;
        updates += 1;
      }
      observations += 1;
    }
  }
  const streams = { mask: ransMetrics(mask), values: ransMetrics(values) };
  return { observations, updates, updateRatio: updates / observations, streams, totalBytes: streams.mask.ransBytes + streams.values.ransBytes };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/hashgrid_residual_20260815/attribute_hashgrid.json');
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
  const positions = segments.map((segment, segmentIndex) => positionBankZero(segment, layout, segmentIndex, origin));
  const attributes = {};
  for (const profile of ATTRIBUTE_PROFILES) {
    const frames = buildAttributeFrames(segments, layout, positions, profile);
    attributes[profile.name] = compressAttribute(frames, profile, layout);
    console.log(JSON.stringify({ phase: 'attribute', name: profile.name, totalMegabytes: attributes[profile.name].totalMegabytes }));
  }
  const lifetime = lifetimeStream(segments, layout);
  const totals = Object.fromEntries(['controlled', 'exactFp16'].map((family) => [family, (
    Object.values(attributes).filter((attribute) => attribute.profile.family === family).reduce((sum, attribute) => sum + attribute.totalBytes, 0)
      + lifetime.totalBytes
  )]));
  const report = {
    format: '4CGS hash-grid attribute residual probe v1',
    generatedAt: new Date().toISOString(),
    sourceDirectory,
    sourceBytes,
    sourceMegabytes: sourceBytes / 1e6,
    tracks: {
      permanentTracks: layout.trackCount,
      activeSegmentInstances: layout.activeSlots.reduce((sum, active) => sum + active.length, 0),
      matches: layout.matches,
    },
    hashLevels: HASH_LEVELS.map((level) => ({ ...level, cellMeters: level.cellGrid * POSITION_STEP })),
    attributes,
    lifetime,
    totals: Object.fromEntries(Object.entries(totals).map(([family, bytes]) => [family, { bytes, megabytes: bytes / 1e6 }])),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ phase: 'done', outputPath, totals: report.totals }));
}

await main();
