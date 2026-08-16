import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bankCount, buildPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, decodeRans, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  byte() {
    if (this.offset >= this.bytes.length) throw new Error('Unexpected end of H4XYZ stream.');
    return this.bytes[this.offset++];
  }

  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized H4XYZ varint.');
  }

  sint() {
    const value = this.uint();
    return value & 1 ? -(value + 1) / 2 : value / 2;
  }

  int16() {
    const value = this.byte() | (this.byte() << 8);
    return value & 0x8000 ? value - 0x10000 : value;
  }

  uint40() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 5; index += 1) {
      value += this.byte() * multiplier;
      multiplier *= 256;
    }
    return value;
  }

  done(name) {
    if (this.offset !== this.bytes.length) throw new Error(`Unused ${name} bytes: ${this.bytes.length - this.offset}`);
  }
}

function parseContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== 'H4XYZ001') throw new Error('Invalid H4XYZ magic.');
  const manifestBytes = bytes.readUInt32LE(8);
  const streamCount = bytes.readUInt16LE(12);
  const manifest = JSON.parse(bytes.subarray(16, 16 + manifestBytes).toString());
  if (manifest.streams.length !== streamCount) throw new Error('H4XYZ stream count mismatch.');
  let offset = 16 + manifestBytes;
  const streams = new Map();
  for (const stream of manifest.streams) {
    const encoded = bytes.subarray(offset, offset + stream.encodedBytes);
    if (encoded.length !== stream.encodedBytes) throw new Error(`Truncated H4XYZ stream ${stream.name}.`);
    const raw = decodeRans(encoded);
    if (raw.length !== stream.rawBytes) throw new Error(`H4XYZ raw byte mismatch for ${stream.name}.`);
    streams.set(stream.name, raw);
    offset += stream.encodedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unused H4XYZ container bytes: ${bytes.length - offset}`);
  return { manifest, streams };
}

function activeSlotsFromMask(mask, manifest) {
  return manifest.segmentTrackCounts.map((expected, segmentIndex) => {
    const active = [];
    for (let slot = 0; slot < manifest.trackCount; slot += 1) {
      const bit = segmentIndex * manifest.trackCount + slot;
      if (mask[bit >>> 3] & (1 << (bit & 7))) active.push(slot);
    }
    if (active.length !== expected) throw new Error(`Active Track count mismatch in Segment ${segmentIndex}: ${active.length} != ${expected}`);
    return Int32Array.from(active);
  });
}

function blockRanges(active, blockSize) {
  const ranges = [];
  let first = 0;
  while (first < active.length) {
    const block = Math.floor(active[first] / blockSize);
    let last = first + 1;
    while (last < active.length && Math.floor(active[last] / blockSize) === block) last += 1;
    ranges.push({ first, last });
    first = last;
  }
  return ranges;
}

function normalizedQuaternion(values) {
  const length = Math.hypot(...values);
  if (!Number.isFinite(length) || length < 1e-12) return [1, 0, 0, 0];
  let result = values.map((value) => value / length);
  if (result[0] < 0) result = result.map((value) => -value);
  return result;
}

function quaternionMatrix([w, x, y, z]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ];
}

function interpolateCoordinate(left, right, target, leftTime, rightTime) {
  return ((rightTime - target) * left + (target - leftTime) * right) / (rightTime - leftTime);
}

function readDictionary(bytes) {
  const reader = new ByteReader(bytes);
  const count = reader.uint();
  const entries = [[0, 0, 0]];
  for (let index = 0; index < count; index += 1) entries.push([reader.sint(), reader.sint(), reader.sint()]);
  reader.done('dictionary');
  return entries;
}

function readResidual(readers, dictionary, fixedByteSymbols, escapeSymbol) {
  const symbol = fixedByteSymbols ? readers.symbols.byte() : readers.symbols.uint();
  if (symbol === escapeSymbol) return [readers.escapeX.sint(), readers.escapeY.sint(), readers.escapeZ.sint()];
  const value = dictionary[symbol];
  if (!value) throw new Error(`Invalid H4XYZ residual symbol ${symbol}.`);
  return value;
}

function readMotionModel(method, active, range, manifest, parameters) {
  const name = manifest.motionNames[method];
  if (name === 'linear') return { name };
  if (name === 'translation') return { name, translation: [parameters.sint(), parameters.sint(), parameters.sint()] };
  if (name === 'se3' || name === 'sim3') {
    const quaternion = normalizedQuaternion([parameters.int16(), parameters.int16(), parameters.int16(), parameters.int16()].map((value) => value / 32767));
    const scale = name === 'sim3' ? 1 + parameters.sint() / manifest.matrixSubsteps : 1;
    const translation = [parameters.sint(), parameters.sint(), parameters.sint()];
    return { name, matrix: quaternionMatrix(quaternion).map((value) => value * scale), translation };
  }
  if (name === 'affine') {
    const matrix = Array.from({ length: 9 }, (_, index) => (index % 4 === 0 ? 1 : 0) + parameters.sint() / manifest.matrixSubsteps);
    const translation = [parameters.sint(), parameters.sint(), parameters.sint()];
    return { name, matrix, translation };
  }
  if (name === 'local4' || name === 'local8') {
    const nodeCount = name === 'local4' ? 4 : 8;
    const present = new Uint8Array(nodeCount);
    for (let row = range.first; row < range.last; row += 1) {
      const node = Math.min(nodeCount - 1, Math.floor((active[row] % manifest.blockSize) * nodeCount / manifest.blockSize));
      present[node] = 1;
    }
    const translations = Array.from({ length: nodeCount });
    for (let node = 0; node < nodeCount; node += 1) {
      if (present[node]) translations[node] = [parameters.sint(), parameters.sint(), parameters.sint()];
    }
    return { name, nodeCount, translations };
  }
  throw new Error(`Unsupported H4XYZ motion method ${method}.`);
}

function predictedPoint(model, source, activeSlot, manifest) {
  if (model.name === 'linear') return source;
  if (model.name === 'translation') return source.map((value, axis) => value + model.translation[axis] / manifest.motionSubsteps);
  if (model.name === 'local4' || model.name === 'local8') {
    const node = Math.min(model.nodeCount - 1, Math.floor((activeSlot % manifest.blockSize) * model.nodeCount / manifest.blockSize));
    return source.map((value, axis) => value + model.translations[node][axis] / manifest.motionSubsteps);
  }
  const transformed = transformPoint(model.matrix, source[0], source[1], source[2]);
  return transformed.map((value, axis) => value + model.translation[axis] / manifest.motionSubsteps);
}

function decodeBlock(active, range, sourceAt, destination, manifest, readers, dictionary) {
  const mode = readers.modes.byte();
  const method = Math.floor(mode / 3);
  const layout = mode % 3;
  const model = readMotionModel(method, active, range, manifest, readers.parameters);
  const pointCount = range.last - range.first;
  const residuals = new Int32Array(pointCount * 3);
  const fixedByteSymbols = manifest.dictionarySymbolCount <= 255;
  if (layout === 1) {
    const nonzero = readers.masks.uint();
    let point = -1;
    for (let index = 0; index < nonzero; index += 1) {
      point += readers.masks.uint() + 1;
      if (point >= pointCount) throw new Error('Sparse H4XYZ residual index exceeds block.');
      residuals.set(readResidual(readers, dictionary, fixedByteSymbols, manifest.dictionarySymbolCount), point * 3);
    }
  } else if (layout === 2) {
    for (let point = 0; point < pointCount; point += 1) {
      residuals.set(readResidual(readers, dictionary, fixedByteSymbols, manifest.dictionarySymbolCount), point * 3);
    }
  } else if (layout !== 0) {
    throw new Error(`Invalid H4XYZ residual layout ${layout}.`);
  }
  for (let row = range.first; row < range.last; row += 1) {
    const point = row - range.first;
    const predicted = predictedPoint(model, sourceAt(row), active[row], manifest);
    for (let axis = 0; axis < 3; axis += 1) destination[row * 3 + axis] = Math.round(predicted[axis]) + residuals[point * 3 + axis];
  }
}

// #WDD-gpt 2026-08-15 - 解码严格按 END_FRAME 后层级节点顺序执行，所有父帧均来自已解码整数格点以杜绝累计漂移。
function decodePositions(manifest, streams) {
  const activeSlots = activeSlotsFromMask(streams.get('activeMask'), manifest);
  const birthReader = new ByteReader(streams.get('birthPosition40'));
  const births = new Int32Array(manifest.trackCount * 3);
  for (let slot = 0; slot < manifest.trackCount; slot += 1) {
    const code = birthReader.uint40();
    const xy = Math.floor(code / manifest.gridBase);
    births[slot * 3 + 2] = code - xy * manifest.gridBase;
    births[slot * 3 + 1] = xy % manifest.gridBase;
    births[slot * 3] = Math.floor(xy / manifest.gridBase);
  }
  birthReader.done('birthPosition40');
  const dictionary = readDictionary(streams.get('dictionary'));
  const readers = {
    modes: new ByteReader(streams.get('modes')),
    masks: new ByteReader(streams.get('masks')),
    symbols: new ByteReader(streams.get('symbols')),
    escapeX: new ByteReader(streams.get('escapeX')),
    escapeY: new ByteReader(streams.get('escapeY')),
    escapeZ: new ByteReader(streams.get('escapeZ')),
    parameters: new ByteReader(streams.get('parameters')),
  };
  const initialized = new Uint8Array(manifest.trackCount);
  const endState = new Int32Array(manifest.trackCount * 3);
  const segments = [];
  for (let segmentIndex = 0; segmentIndex < activeSlots.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const banks = Array.from({ length: 11 }, () => new Int32Array(active.length * 3));
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      const sourceOffset = slot * 3;
      const targetOffset = row * 3;
      const source = initialized[slot] ? endState : births;
      banks[0][targetOffset] = source[sourceOffset];
      banks[0][targetOffset + 1] = source[sourceOffset + 1];
      banks[0][targetOffset + 2] = source[sourceOffset + 2];
    }
    const ranges = blockRanges(active, manifest.blockSize);
    for (const range of ranges) {
      decodeBlock(active, range, (row) => Array.from(banks[0].subarray(row * 3, row * 3 + 3)), banks[10], manifest, readers, dictionary);
    }
    for (const task of manifest.hierarchy) {
      for (const range of ranges) {
        decodeBlock(active, range, (row) => {
          const offset = row * 3;
          return [0, 1, 2].map((axis) => interpolateCoordinate(
            banks[task.left][offset + axis],
            banks[task.right][offset + axis],
            task.target,
            task.left,
            task.right,
          ));
        }, banks[task.target], manifest, readers, dictionary);
      }
    }
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      endState.set(banks[10].subarray(row * 3, row * 3 + 3), slot * 3);
      initialized[slot] = 1;
    }
    segments.push(banks);
    console.log(JSON.stringify({ phase: 'decode', segment: segmentIndex, tracks: active.length }));
  }
  for (const [name, reader] of Object.entries(readers)) reader.done(name);
  return { activeSlots, segments };
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

async function validate(decoded, manifest, sourceDirectory) {
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  const segments = [];
  for (const entry of entries) segments.push(await readSegment(join(sourceDirectory, entry.name)));
  const permanent = buildPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, robustCenter(segments[0]), manifest.geometry.halfExtentMeters);
  let observations = 0;
  let mismatchedGridComponents = 0;
  let maximumGridDifference = 0;
  let maximumComponentErrorMeters = 0;
  let maximumEuclideanErrorMeters = 0;
  let squaredMeters = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = decoded.activeSlots[segmentIndex];
    const expectedActive = layout.activeSlots[segmentIndex];
    if (active.length !== expectedActive.length || active.some((slot, index) => slot !== expectedActive[index])) {
      throw new Error(`Independent Active Track mismatch in Segment ${segmentIndex}.`);
    }
    const inverse = layout.slotToLocal[segmentIndex];
    for (let bank = 0; bank < bankCount(segment, 'xyz_bank'); bank += 1) {
      const properties = ['x', 'y', 'z'].map((axis) => segment.propertyIndex.get(`xyz_bank_${bank}_${axis}`));
      for (let row = 0; row < active.length; row += 1) {
        const local = inverse[active[row]];
        const sourceOffset = local * segment.propertyNames.length;
        let distanceSquare = 0;
        for (let axis = 0; axis < 3; axis += 1) {
          const original = halfToFloat(segment.rows[sourceOffset + properties[axis]]);
          const expectedQ = Math.round((original - manifest.geometry.origin[axis]) / manifest.geometry.positionStepMeters);
          const actualQ = decoded.segments[segmentIndex][bank][row * 3 + axis];
          const gridDifference = Math.abs(actualQ - expectedQ);
          if (gridDifference) mismatchedGridComponents += 1;
          maximumGridDifference = Math.max(maximumGridDifference, gridDifference);
          const decodedPosition = manifest.geometry.origin[axis] + actualQ * manifest.geometry.positionStepMeters;
          const error = Math.abs(decodedPosition - original);
          maximumComponentErrorMeters = Math.max(maximumComponentErrorMeters, error);
          distanceSquare += error * error;
          squaredMeters += error * error;
        }
        maximumEuclideanErrorMeters = Math.max(maximumEuclideanErrorMeters, Math.sqrt(distanceSquare));
        observations += 1;
      }
    }
    console.log(JSON.stringify({ phase: 'validate', segment: basename(segment.path) }));
  }
  return {
    observations,
    mismatchedGridComponents,
    maximumGridDifference,
    componentRmseMeters: Math.sqrt(squaredMeters / (observations * 3)),
    maximumComponentErrorMeters,
    maximumEuclideanErrorMeters,
    passedExactGrid: mismatchedGridComponents === 0,
    passedErrorBound: maximumEuclideanErrorMeters <= manifest.geometry.maximumEuclideanErrorMeters + 1e-12,
  };
}

async function main() {
  const inputPath = resolve(process.argv[2] ?? 'artifacts/hierarchical_entropy_20260815/position.h4xyz');
  const sourceDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/hierarchical_entropy_20260815/position_decode_validation.json');
  const { manifest, streams } = parseContainer(await readFile(inputPath));
  const decoded = decodePositions(manifest, streams);
  const validation = await validate(decoded, manifest, sourceDirectory);
  const report = { inputPath, sourceDirectory, manifest, validation };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ phase: 'done', outputPath, ...validation }));
  if (!validation.passedExactGrid || !validation.passedErrorBound) process.exitCode = 1;
}

await main();
