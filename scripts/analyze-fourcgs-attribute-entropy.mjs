import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bankCount, buildPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodeRans, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const BLOCK_SIZE = 256;
const HALF_EXTENT = 2.5;
const SMALL_LIMIT = 255;

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
    for (let local = 0; local < segment.count; local += 1) {
      values[local] = halfToFloat(segment.rows[local * segment.propertyNames.length + property]);
    }
    values.sort();
    const minimum = values[Math.round((values.length - 1) * 0.005)];
    const maximum = values[Math.round((values.length - 1) * 0.995)];
    center.push((minimum + maximum) / 2);
  }
  return center;
}

function packedSmall(x, y, z) {
  if (Math.abs(x) > SMALL_LIMIT || Math.abs(y) > SMALL_LIMIT || Math.abs(z) > SMALL_LIMIT) return -1;
  const base = SMALL_LIMIT * 2 + 1;
  return (x + SMALL_LIMIT) * base * base + (y + SMALL_LIMIT) * base + z + SMALL_LIMIT;
}

function unpackedSmall(key) {
  const base = SMALL_LIMIT * 2 + 1;
  const xCode = Math.floor(key / (base * base));
  const remainder = key - xCode * base * base;
  const yCode = Math.floor(remainder / base);
  return [xCode - SMALL_LIMIT, yCode - SMALL_LIMIT, remainder - yCode * base - SMALL_LIMIT];
}

function rans(writer) {
  const raw = writer.finish();
  return { rawBytes: raw.length, ransBytes: encodeRans(raw).length };
}

// #WDD-gpt 2026-08-15 - 受控有损属性使用三维量化残差字典，ESCAPE 的三个分量分流熵编码以避免混合分布。
function encodeTripleDictionary(values, observationCount, step) {
  const counts = new Map();
  let zero = 0;
  let squared = 0;
  let maximum = 0;
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * 3;
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    if (x === 0 && y === 0 && z === 0) zero += 1;
    squared += x * x + y * y + z * z;
    maximum = Math.max(maximum, Math.abs(x), Math.abs(y), Math.abs(z));
    const key = packedSmall(x, y, z);
    if (key >= 0) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const zeroKey = packedSmall(0, 0, 0);
  const entries = [...counts.entries()]
    .filter(([key]) => key !== zeroKey)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 254)
    .map(([key, count]) => ({ value: unpackedSmall(key), count }));
  const lookup = new Map(entries.map((entry, index) => [packedSmall(...entry.value), index + 1]));
  const symbols = new ByteWriter();
  const escapeX = new ByteWriter();
  const escapeY = new ByteWriter();
  const escapeZ = new ByteWriter();
  let escapes = 0;
  for (let observation = 0; observation < observationCount; observation += 1) {
    const offset = observation * 3;
    const x = values[offset];
    const y = values[offset + 1];
    const z = values[offset + 2];
    if (x === 0 && y === 0 && z === 0) {
      symbols.byte(0);
      continue;
    }
    const symbol = lookup.get(packedSmall(x, y, z));
    if (symbol !== undefined) {
      symbols.byte(symbol);
      continue;
    }
    symbols.byte(255);
    escapeX.sint(x);
    escapeY.sint(y);
    escapeZ.sint(z);
    escapes += 1;
  }
  const dictionary = new ByteWriter();
  dictionary.uint(entries.length);
  for (const entry of entries) for (const value of entry.value) dictionary.sint(value);
  const streams = {
    dictionary: rans(dictionary),
    symbols: rans(symbols),
    escapeX: rans(escapeX),
    escapeY: rans(escapeY),
    escapeZ: rans(escapeZ),
  };
  const ransBytes = Object.values(streams).reduce((sum, stream) => sum + stream.ransBytes, 0);
  return {
    step,
    observationCount,
    zeroRatio: zero / observationCount,
    quantizedComponentRmse: Math.sqrt(squared / (observationCount * 3)),
    parameterComponentRmse: Math.sqrt(squared / (observationCount * 3)) * step,
    maximumQuantizedComponent: maximum,
    dictionaryEntries: entries.length,
    dictionaryCoverage: (observationCount - escapes) / observationCount,
    escapeCount: escapes,
    streams,
    ransBytes,
    megabytes: ransBytes / 1e6,
    bitsPerVector: ransBytes * 8 / observationCount,
  };
}

function encodeScalarVarints(values, observationCount, step) {
  const writer = new ByteWriter();
  let zero = 0;
  let squared = 0;
  let maximum = 0;
  for (let index = 0; index < observationCount; index += 1) {
    const value = values[index];
    writer.sint(value);
    if (value === 0) zero += 1;
    squared += value * value;
    maximum = Math.max(maximum, Math.abs(value));
  }
  const stream = rans(writer);
  return {
    step,
    observationCount,
    zeroRatio: zero / observationCount,
    quantizedRmse: Math.sqrt(squared / observationCount),
    parameterRmse: Math.sqrt(squared / observationCount) * step,
    maximumQuantized: maximum,
    rawBytes: stream.rawBytes,
    ransBytes: stream.ransBytes,
    megabytes: stream.ransBytes / 1e6,
    bitsPerValue: stream.ransBytes * 8 / observationCount,
  };
}

function normalizedQuaternion(values) {
  let length = Math.hypot(values[0], values[1], values[2], values[3]);
  if (!Number.isFinite(length) || length < 1e-12) return [1, 0, 0, 0];
  let result = values.map((value) => value / length);
  if (result[0] < 0) result = result.map((value) => -value);
  return result;
}

function quaternionMultiply(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function quaternionTangent(from, to) {
  let target = to;
  const dot = from.reduce((sum, value, index) => sum + value * target[index], 0);
  if (dot < 0) target = target.map((value) => -value);
  let relative = quaternionMultiply([from[0], -from[1], -from[2], -from[3]], target);
  relative = normalizedQuaternion(relative);
  const sine = Math.hypot(relative[1], relative[2], relative[3]);
  if (sine < 1e-12) return [0, 0, 0];
  const angle = 2 * Math.atan2(sine, Math.max(0, relative[0]));
  return [relative[1] / sine * angle, relative[2] / sine * angle, relative[3] / sine * angle];
}

function quaternionAngle(a, b) {
  const dot = Math.min(1, Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0)));
  return 2 * Math.acos(dot);
}

function quaternionSlerp(a, b, amount) {
  let target = b;
  let dot = a.reduce((sum, value, index) => sum + value * target[index], 0);
  if (dot < 0) {
    target = target.map((value) => -value);
    dot = -dot;
  }
  if (dot > 0.9995) return normalizedQuaternion(a.map((value, index) => value + amount * (target[index] - value)));
  const angle = Math.acos(Math.min(1, dot));
  const sine = Math.sin(angle);
  const left = Math.sin((1 - amount) * angle) / sine;
  const right = Math.sin(amount * angle) / sine;
  return normalizedQuaternion(a.map((value, index) => left * value + right * target[index]));
}

function quaternionFromMatrix(matrix) {
  const trace = matrix[0] + matrix[4] + matrix[8];
  let quaternion;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    quaternion = [scale / 4, (matrix[7] - matrix[5]) / scale, (matrix[2] - matrix[6]) / scale, (matrix[3] - matrix[1]) / scale];
  } else if (matrix[0] > matrix[4] && matrix[0] > matrix[8]) {
    const scale = Math.sqrt(1 + matrix[0] - matrix[4] - matrix[8]) * 2;
    quaternion = [(matrix[7] - matrix[5]) / scale, scale / 4, (matrix[1] + matrix[3]) / scale, (matrix[2] + matrix[6]) / scale];
  } else if (matrix[4] > matrix[8]) {
    const scale = Math.sqrt(1 + matrix[4] - matrix[0] - matrix[8]) * 2;
    quaternion = [(matrix[2] - matrix[6]) / scale, (matrix[1] + matrix[3]) / scale, scale / 4, (matrix[5] + matrix[7]) / scale];
  } else {
    const scale = Math.sqrt(1 + matrix[8] - matrix[0] - matrix[4]) * 2;
    quaternion = [(matrix[3] - matrix[1]) / scale, (matrix[2] + matrix[6]) / scale, (matrix[5] + matrix[7]) / scale, scale / 4];
  }
  return normalizedQuaternion(quaternion);
}

function permutationParity(permutation) {
  let inversions = 0;
  for (let left = 0; left < permutation.length; left += 1) {
    for (let right = left + 1; right < permutation.length; right += 1) {
      if (permutation[left] > permutation[right]) inversions += 1;
    }
  }
  return inversions % 2 ? -1 : 1;
}

function cubeSymmetries() {
  const permutations = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const result = [];
  for (const permutation of permutations) {
    const parity = permutationParity(permutation);
    for (const signX of [-1, 1]) {
      for (const signY of [-1, 1]) {
        const signs = [signX, signY, parity * signX * signY];
        const matrix = new Array(9).fill(0);
        for (let column = 0; column < 3; column += 1) matrix[permutation[column] * 3 + column] = signs[column];
        result.push({ permutation, signs, quaternion: quaternionFromMatrix(matrix) });
      }
    }
  }
  return result;
}

const CUBE_SYMMETRIES = cubeSymmetries();

// #WDD-gpt 2026-08-15 - 在 24 个等价协方差表示中选择最连续的一项，同时重排 log-scale 并右乘 Rotation。
function equivalentCovarianceState(rotation, scale, reference) {
  let best;
  const sorted = reference ? undefined : [...scale].sort((a, b) => b - a);
  for (const symmetry of CUBE_SYMMETRIES) {
    const scaleX = scale[symmetry.permutation[0]];
    const scaleY = scale[symmetry.permutation[1]];
    const scaleZ = scale[symmetry.permutation[2]];
    const b = symmetry.quaternion;
    let w = rotation[0] * b[0] - rotation[1] * b[1] - rotation[2] * b[2] - rotation[3] * b[3];
    let x = rotation[0] * b[1] + rotation[1] * b[0] + rotation[2] * b[3] - rotation[3] * b[2];
    let y = rotation[0] * b[2] - rotation[1] * b[3] + rotation[2] * b[0] + rotation[3] * b[1];
    let z = rotation[0] * b[3] + rotation[1] * b[2] - rotation[2] * b[1] + rotation[3] * b[0];
    if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
    let cost;
    if (reference) {
      const scaleCost = (scaleX - reference.scale[0]) ** 2 + (scaleY - reference.scale[1]) ** 2 + (scaleZ - reference.scale[2]) ** 2;
      const dot = Math.min(1, Math.abs(reference.rotation[0] * w + reference.rotation[1] * x + reference.rotation[2] * y + reference.rotation[3] * z));
      const angle = 2 * Math.acos(dot);
      cost = scaleCost + angle * angle;
    } else {
      const sortCost = (scaleX - sorted[0]) ** 2 + (scaleY - sorted[1]) ** 2 + (scaleZ - sorted[2]) ** 2;
      cost = sortCost + (1 - Math.abs(w)) * 1e-6;
    }
    if (!best || cost < best.cost) best = { cost, rotation: [w, x, y, z], scale: [scaleX, scaleY, scaleZ] };
  }
  return best;
}

function quantizedTriples(values, step) {
  const result = new Int32Array(values.length);
  for (let index = 0; index < values.length; index += 1) result[index] = Math.round(values[index] / step);
  return result;
}

function jointNormalizedResiduals(segments, layout) {
  const segmentInstances = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const endpointRotation = new Float32Array(segmentInstances * 3);
  const internalRotation = new Float32Array(segmentInstances * 2 * 3);
  const internalScale = new Float32Array(segmentInstances * 2 * 3);
  const stateRotation = new Float32Array(layout.trackCount * 4);
  const stateScale = new Float32Array(layout.trackCount * 3);
  const initialized = new Uint8Array(layout.trackCount);
  let endpointObservation = 0;
  let internalObservation = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const rawStart = quaternionAt(segment, local, 0);
      const rawEnd = quaternionAt(segment, local, 1);
      const rawScales = Array.from({ length: 4 }, (_, bank) => propertyVectorAt(segment, local, 'scale_bank', bank, ['0', '1', '2']));
      let reference = initialized[slot]
        ? {
          rotation: Array.from(stateRotation.subarray(slot * 4, slot * 4 + 4)),
          scale: Array.from(stateScale.subarray(slot * 3, slot * 3 + 3)),
        }
        : undefined;
      const normalized = [];
      for (let bank = 0; bank < 4; bank += 1) {
        const rawRotation = quaternionSlerp(rawStart, rawEnd, bank / 3);
        const current = equivalentCovarianceState(rawRotation, rawScales[bank], reference);
        normalized.push(current);
        reference = current;
      }
      const endpointTangent = quaternionTangent(normalized[0].rotation, normalized[3].rotation);
      endpointRotation.set(endpointTangent, endpointObservation * 3);
      endpointObservation += 1;
      for (const target of [1, 2]) {
        const amount = target / 3;
        const predictedRotation = quaternionSlerp(normalized[0].rotation, normalized[3].rotation, amount);
        internalRotation.set(quaternionTangent(predictedRotation, normalized[target].rotation), internalObservation * 3);
        for (let axis = 0; axis < 3; axis += 1) {
          const predictedScale = (1 - amount) * normalized[0].scale[axis] + amount * normalized[3].scale[axis];
          internalScale[internalObservation * 3 + axis] = normalized[target].scale[axis] - predictedScale;
        }
        internalObservation += 1;
      }
      stateRotation.set(normalized[3].rotation, slot * 4);
      stateScale.set(normalized[3].scale, slot * 3);
      initialized[slot] = 1;
    }
    console.log(JSON.stringify({ phase: 'joint_axis_normalization', segment: segmentIndex }));
  }
  return {
    endpointRotation,
    endpointObservation,
    internalRotation,
    internalScale,
    internalObservation,
  };
}

function quaternionAt(segment, local, bank) {
  const base = local * segment.propertyNames.length;
  return normalizedQuaternion(['w', 'x', 'y', 'z'].map((component) => (
    halfToFloat(segment.rows[base + segment.propertyIndex.get(`rot_bank_${bank}_${component}`)])
  )));
}

function propertyVectorAt(segment, local, prefix, bank, components) {
  const base = local * segment.propertyNames.length;
  return components.map((component) => halfToFloat(
    segment.rows[base + segment.propertyIndex.get(`${prefix}_${bank}${component === '' ? '' : `_${component}`}`)],
  ));
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

function rotationSpanValues(segments, layout, stepRadians) {
  const observationCount = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const values = new Int32Array(observationCount * 3);
  const centered = new Int32Array(values.length);
  const centers = new ByteWriter();
  let observationOffset = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const inverse = layout.slotToLocal[segmentIndex];
    for (let row = 0; row < active.length; row += 1) {
      const local = inverse[active[row]];
      const tangent = quaternionTangent(quaternionAt(segment, local, 0), quaternionAt(segment, local, 1));
      for (let axis = 0; axis < 3; axis += 1) values[(observationOffset + row) * 3 + axis] = Math.round(tangent[axis] / stepRadians);
    }
    for (const range of blockRanges(active)) {
      const center = [0, 0, 0];
      for (let row = range.first; row < range.last; row += 1) {
        for (let axis = 0; axis < 3; axis += 1) center[axis] += values[(observationOffset + row) * 3 + axis];
      }
      for (let axis = 0; axis < 3; axis += 1) {
        center[axis] = Math.round(center[axis] / (range.last - range.first));
        centers.sint(center[axis]);
      }
      for (let row = range.first; row < range.last; row += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const offset = (observationOffset + row) * 3 + axis;
          centered[offset] = values[offset] - center[axis];
        }
      }
    }
    observationOffset += active.length;
  }
  const direct = encodeTripleDictionary(values, observationCount, stepRadians);
  const block = encodeTripleDictionary(centered, observationCount, stepRadians);
  const centerStream = rans(centers);
  block.blockCenterStream = centerStream;
  block.ransBytes += centerStream.ransBytes;
  block.megabytes = block.ransBytes / 1e6;
  block.bitsPerVector = block.ransBytes * 8 / observationCount;
  return { direct, block };
}

function boundaryRotationValues(segments, layout, stepRadians) {
  const capacity = layout.matches.reduce((sum, match) => sum + match.matchedCount, 0);
  const values = new Int32Array(capacity * 3);
  let observation = 0;
  let exact = 0;
  let maximumAngle = 0;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const previousInverse = layout.slotToLocal[segmentIndex - 1];
    const currentInverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const previousLocal = previousInverse[slot];
      if (previousLocal < 0) continue;
      const currentLocal = currentInverse[slot];
      const from = quaternionAt(previous, previousLocal, 1);
      const to = quaternionAt(current, currentLocal, 0);
      const tangent = quaternionTangent(from, to);
      const angle = Math.hypot(...tangent);
      maximumAngle = Math.max(maximumAngle, angle);
      if (angle < 1e-12) exact += 1;
      for (let axis = 0; axis < 3; axis += 1) values[observation * 3 + axis] = Math.round(tangent[axis] / stepRadians);
      observation += 1;
    }
  }
  return {
    exactRatio: exact / observation,
    maximumAngleDegrees: maximumAngle * 180 / Math.PI,
    codec: encodeTripleDictionary(values, observation, stepRadians),
  };
}

function temporalVectorResiduals(segments, layout, prefix, components, step) {
  const observationCount = layout.activeSlots.reduce((sum, active) => sum + active.length * 2, 0);
  const values = new Int32Array(observationCount * components.length);
  let observation = 0;
  let constantTracks = 0;
  let tracks = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const bankCountValue = bankCount(segment, prefix);
    if (bankCountValue !== 4) throw new Error(`Expected four ${prefix} banks in ${segment.path}`);
    const inverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const local = inverse[slot];
      const banks = Array.from({ length: 4 }, (_, bank) => propertyVectorAt(segment, local, prefix, bank, components));
      tracks += 1;
      if (banks.slice(1).every((bank) => bank.every((value, axis) => value === banks[0][axis]))) constantTracks += 1;
      for (const target of [1, 2]) {
        for (let axis = 0; axis < components.length; axis += 1) {
          const predicted = (3 - target) / 3 * banks[0][axis] + target / 3 * banks[3][axis];
          values[observation * components.length + axis] = Math.round((banks[target][axis] - predicted) / step);
        }
        observation += 1;
      }
    }
  }
  return { values, observationCount: observation, constantTrackRatio: constantTracks / tracks };
}

function boundaryVectorStats(segments, layout, prefix, components) {
  let observations = 0;
  let exact = 0;
  let squared = 0;
  let maximum = 0;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const previous = segments[segmentIndex - 1];
    const current = segments[segmentIndex];
    const previousBank = bankCount(previous, prefix) - 1;
    const previousInverse = layout.slotToLocal[segmentIndex - 1];
    const currentInverse = layout.slotToLocal[segmentIndex];
    for (const slot of layout.activeSlots[segmentIndex]) {
      const previousLocal = previousInverse[slot];
      if (previousLocal < 0) continue;
      const a = propertyVectorAt(previous, previousLocal, prefix, previousBank, components);
      const b = propertyVectorAt(current, currentInverse[slot], prefix, 0, components);
      let equal = true;
      for (let axis = 0; axis < components.length; axis += 1) {
        const difference = b[axis] - a[axis];
        if (difference !== 0) equal = false;
        squared += difference * difference;
        maximum = Math.max(maximum, Math.abs(difference));
        observations += 1;
      }
      if (equal) exact += 1;
    }
  }
  return {
    vectorCount: observations / components.length,
    exactVectorRatio: exact / (observations / components.length),
    componentRmse: Math.sqrt(squared / observations),
    maximumComponentDifference: maximum,
  };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/hierarchical_entropy_20260815/attribute_entropy.json');
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
  console.log(JSON.stringify({ phase: 'track_match' }));
  const permanent = buildPermanentTrackMaps(segments);
  const center = robustCenter(segments[0]);
  const layout = buildCroppedMortonLayout(segments, permanent, center, HALF_EXTENT);
  const jointResiduals = jointNormalizedResiduals(segments, layout);
  const normalizedRotation = {};
  for (const stepDegrees of [0.02, 0.05, 0.1]) {
    const stepRadians = stepDegrees * Math.PI / 180;
    normalizedRotation[`${stepDegrees}deg`] = {
      endpointSpan: encodeTripleDictionary(
        quantizedTriples(jointResiduals.endpointRotation, stepRadians),
        jointResiduals.endpointObservation,
        stepRadians,
      ),
      internalPrediction: encodeTripleDictionary(
        quantizedTriples(jointResiduals.internalRotation, stepRadians),
        jointResiduals.internalObservation,
        stepRadians,
      ),
    };
    console.log(JSON.stringify({ phase: 'normalized_rotation', stepDegrees }));
  }
  const normalizedScale = {};
  for (const step of [2 ** -11, 2 ** -10, 2 ** -9]) {
    normalizedScale[`2^${Math.round(Math.log2(step))}`] = encodeTripleDictionary(
      quantizedTriples(jointResiduals.internalScale, step),
      jointResiduals.internalObservation,
      step,
    );
    console.log(JSON.stringify({ phase: 'normalized_scale', step }));
  }
  const rotationStepsDegrees = [0.02, 0.05, 0.1];
  const rotation = {};
  for (const stepDegrees of rotationStepsDegrees) {
    const stepRadians = stepDegrees * Math.PI / 180;
    rotation[`${stepDegrees}deg`] = rotationSpanValues(segments, layout, stepRadians);
    console.log(JSON.stringify({ phase: 'rotation_span', stepDegrees }));
  }
  const boundaryRotation = boundaryRotationValues(segments, layout, 0.05 * Math.PI / 180);
  console.log(JSON.stringify({ phase: 'rotation_boundary' }));

  const scale = {};
  for (const step of [2 ** -11, 2 ** -10, 2 ** -9]) {
    const residuals = temporalVectorResiduals(segments, layout, 'scale_bank', ['0', '1', '2'], step);
    scale[`2^${Math.round(Math.log2(step))}`] = {
      constantTrackRatio: residuals.constantTrackRatio,
      codec: encodeTripleDictionary(residuals.values, residuals.observationCount, step),
    };
    console.log(JSON.stringify({ phase: 'scale', step }));
  }
  const scaleBoundary = boundaryVectorStats(segments, layout, 'scale_bank', ['0', '1', '2']);

  const opacity = {};
  for (const step of [2 ** -9, 2 ** -8, 2 ** -7]) {
    const residuals = temporalVectorResiduals(segments, layout, 'opacity_bank', [''], step);
    opacity[`2^${Math.round(Math.log2(step))}`] = {
      constantTrackRatio: residuals.constantTrackRatio,
      codec: encodeScalarVarints(residuals.values, residuals.observationCount, step),
    };
    console.log(JSON.stringify({ phase: 'opacity', step }));
  }
  const opacityBoundary = boundaryVectorStats(segments, layout, 'opacity_bank', ['']);

  const report = {
    format: '4CGS controlled attribute entropy experiment v1',
    generatedAt: new Date().toISOString(),
    sourceDirectory,
    sourceBytes,
    tracks: {
      permanentTracks: layout.trackCount,
      activeSegmentInstances: layout.activeSlots.reduce((sum, active) => sum + active.length, 0),
      segmentTrackCounts: layout.activeSlots.map((active) => active.length),
      boundaryMatches: layout.matches,
      blockSize: BLOCK_SIZE,
    },
    sourceBanks: {
      rotation: segments.map((segment) => bankCount(segment, 'rot_bank')),
      scale: segments.map((segment) => bankCount(segment, 'scale_bank')),
      opacity: segments.map((segment) => bankCount(segment, 'opacity_bank')),
    },
    rotation: {
      interpretation: 'SO(3) tangent of each segment endpoint pair; source has two rotation banks per segment.',
      span: rotation,
      sharedBoundaryAt005Degrees: boundaryRotation,
      covarianceEquivalent24Way: normalizedRotation,
    },
    scale: {
      interpretation: 'Source scale_bank values are already log-scale parameters; two internal banks use endpoint linear prediction.',
      internal: scale,
      sharedBoundary: scaleBoundary,
      covarianceEquivalent24Way: normalizedScale,
    },
    opacity: {
      interpretation: 'Source opacity_bank values are logits; two internal banks use endpoint linear prediction.',
      internal: opacity,
      sharedBoundary: opacityBoundary,
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ phase: 'done', outputPath }));
}

await main();
