import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { bankCount, buildPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodeRans, halfToFloat } from './fourcgs-prs-codec.mjs';

const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const POSITION_STEP = 0.0005;
const HALF_EXTENT = 2.5;
const GRID_BASE = 10001;
const BLOCK_SIZE = 256;
const MOTION_SUBSTEPS = 16;
const MATRIX_SUBSTEPS = 4096;
const DICTIONARY_SYMBOL_COUNTS = [255, 1023];
const SMALL_RESIDUAL_LIMIT = 255;
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

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  byte(value) {
    this.bytes.push(value & 0xff);
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

  int16(value) {
    this.byte(value);
    this.byte(value >> 8);
  }

  uint40(value) {
    let remaining = value;
    for (let byteIndex = 0; byteIndex < 5; byteIndex += 1) {
      this.byte(remaining % 256);
      remaining = Math.floor(remaining / 256);
    }
  }

  finish() {
    return Buffer.from(this.bytes);
  }
}

function varintBytes(value) {
  let remaining = Math.trunc(value);
  let bytes = 1;
  while (remaining >= 128) {
    remaining = Math.floor(remaining / 128);
    bytes += 1;
  }
  return bytes;
}

function signedVarintBytes(value) {
  return varintBytes(value >= 0 ? value * 2 : -value * 2 - 1);
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

function packedSmallResidual(x, y, z) {
  if (Math.abs(x) > SMALL_RESIDUAL_LIMIT || Math.abs(y) > SMALL_RESIDUAL_LIMIT || Math.abs(z) > SMALL_RESIDUAL_LIMIT) return -1;
  const base = SMALL_RESIDUAL_LIMIT * 2 + 1;
  return (x + SMALL_RESIDUAL_LIMIT) * base * base + (y + SMALL_RESIDUAL_LIMIT) * base + z + SMALL_RESIDUAL_LIMIT;
}

function unpackedSmallResidual(key) {
  const base = SMALL_RESIDUAL_LIMIT * 2 + 1;
  const xCode = Math.floor(key / (base * base));
  const remainder = key - xCode * base * base;
  const yCode = Math.floor(remainder / base);
  return [xCode - SMALL_RESIDUAL_LIMIT, yCode - SMALL_RESIDUAL_LIMIT, remainder - yCode * base - SMALL_RESIDUAL_LIMIT];
}

class ResidualStats {
  constructor(name) {
    this.name = name;
    this.observations = 0;
    this.zero = 0;
    this.componentSquareSum = 0;
    this.maximumLinf = 0;
    this.maximumL2 = 0;
    this.smallCounts = new Map();
  }

  add(x, y, z) {
    this.observations += 1;
    if (x === 0 && y === 0 && z === 0) this.zero += 1;
    this.componentSquareSum += x * x + y * y + z * z;
    this.maximumLinf = Math.max(this.maximumLinf, Math.abs(x), Math.abs(y), Math.abs(z));
    this.maximumL2 = Math.max(this.maximumL2, Math.hypot(x, y, z));
    const key = packedSmallResidual(x, y, z);
    if (key >= 0) this.smallCounts.set(key, (this.smallCounts.get(key) ?? 0) + 1);
  }

  addArray(values) {
    for (let offset = 0; offset < values.length; offset += 3) this.add(values[offset], values[offset + 1], values[offset + 2]);
  }

  dictionary(symbolCount = 255, includeZero = false) {
    const zeroKey = packedSmallResidual(0, 0, 0);
    return [...this.smallCounts.entries()]
      .filter(([key]) => includeZero || key !== zeroKey)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, includeZero ? symbolCount : symbolCount - 1)
      .map(([key, count]) => ({ value: unpackedSmallResidual(key), count }));
  }

  summary() {
    return {
      name: this.name,
      observations: this.observations,
      zeroRatio: this.observations ? this.zero / this.observations : 0,
      componentRmseGrid: this.observations ? Math.sqrt(this.componentSquareSum / (this.observations * 3)) : 0,
      componentRmseMeters: this.observations ? Math.sqrt(this.componentSquareSum / (this.observations * 3)) * POSITION_STEP : 0,
      maximumLinfGrid: this.maximumLinf,
      maximumL2Grid: this.maximumL2,
      smallDictionaryCoverage: this.observations
        ? this.dictionary(255, true).reduce((sum, entry) => sum + entry.count, 0) / this.observations
        : 0,
      mostCommon: this.dictionary(255, true).slice(0, 16),
    };
  }
}

function positionIndices(segment) {
  return Array.from({ length: bankCount(segment, 'xyz_bank') }, (_, bank) => (
    ['x', 'y', 'z'].map((component) => segment.propertyIndex.get(`xyz_bank_${bank}_${component}`))
  ));
}

// #WDD-gpt 2026-08-15 - 所有 Position 先落在统一 0.5mm 整数格点，后续残差只负责无损恢复该整数目标。
function quantizedPositionBanks(segment, layout, segmentIndex, origin) {
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const indices = positionIndices(segment);
  const stride = segment.propertyNames.length;
  const banks = indices.map(() => new Int32Array(active.length * 3));
  let outsideGrid = 0;
  for (let row = 0; row < active.length; row += 1) {
    const local = inverse[active[row]];
    const sourceBase = local * stride;
    for (let bank = 0; bank < indices.length; bank += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = halfToFloat(segment.rows[sourceBase + indices[bank][axis]]);
        const quantized = Math.round((value - origin[axis]) / POSITION_STEP);
        banks[bank][row * 3 + axis] = quantized;
        if (quantized < 0 || quantized >= GRID_BASE) outsideGrid += 1;
      }
    }
  }
  return { banks, outsideGrid };
}

function blockRanges(active) {
  const ranges = [];
  let first = 0;
  while (first < active.length) {
    const block = Math.floor(active[first] / BLOCK_SIZE);
    let last = first + 1;
    while (last < active.length && Math.floor(active[last] / BLOCK_SIZE) === block) last += 1;
    ranges.push({ block, first, last });
    first = last;
  }
  return ranges;
}

function interpolateCoordinate(left, right, target, leftTime, rightTime) {
  return ((rightTime - target) * left + (target - leftTime) * right) / (rightTime - leftTime);
}

function normalizedQuaternion(values) {
  let length = Math.hypot(values[0], values[1], values[2], values[3]);
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

function rotatePoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ];
}

// #WDD-gpt 2026-08-15 - 使用 Horn 四元数拟合块级刚体修正，再量化模型参数；整数残差仍保证坐标格点精确重建。
function fitSe3(source, target) {
  const count = target.length / 3;
  if (count < 3) return { quaternionCodes: [32767, 0, 0, 0], quaternion: [1, 0, 0, 0], translationCodes: [0, 0, 0] };
  const sourceCenter = [0, 0, 0];
  const targetCenter = [0, 0, 0];
  for (let offset = 0; offset < target.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      sourceCenter[axis] += source[offset + axis];
      targetCenter[axis] += target[offset + axis];
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    sourceCenter[axis] /= count;
    targetCenter[axis] /= count;
  }
  const covariance = new Float64Array(9);
  for (let offset = 0; offset < target.length; offset += 3) {
    const sx = source[offset] - sourceCenter[0];
    const sy = source[offset + 1] - sourceCenter[1];
    const sz = source[offset + 2] - sourceCenter[2];
    const tx = target[offset] - targetCenter[0];
    const ty = target[offset + 1] - targetCenter[1];
    const tz = target[offset + 2] - targetCenter[2];
    covariance[0] += sx * tx; covariance[1] += sx * ty; covariance[2] += sx * tz;
    covariance[3] += sy * tx; covariance[4] += sy * ty; covariance[5] += sy * tz;
    covariance[6] += sz * tx; covariance[7] += sz * ty; covariance[8] += sz * tz;
  }
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = covariance;
  const trace = sxx + syy + szz;
  const horn = [
    trace, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ];
  let quaternion = [1, 0, 0, 0];
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = [0, 0, 0, 0];
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) next[row] += horn[row * 4 + column] * quaternion[column];
    }
    quaternion = normalizedQuaternion(next);
  }
  const quaternionCodes = quaternion.map((value) => Math.max(-32767, Math.min(32767, Math.round(value * 32767))));
  quaternion = normalizedQuaternion(quaternionCodes.map((value) => value / 32767));
  const matrix = quaternionMatrix(quaternion);
  const rotatedCenter = rotatePoint(matrix, sourceCenter[0], sourceCenter[1], sourceCenter[2]);
  const translationCodes = targetCenter.map((value, axis) => Math.round((value - rotatedCenter[axis]) * MOTION_SUBSTEPS));
  return { quaternionCodes, quaternion, translationCodes };
}

function centersOf(source, target) {
  const count = target.length / 3;
  const sourceCenter = [0, 0, 0];
  const targetCenter = [0, 0, 0];
  for (let offset = 0; offset < target.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      sourceCenter[axis] += source[offset + axis];
      targetCenter[axis] += target[offset + axis];
    }
  }
  for (let axis = 0; axis < 3; axis += 1) {
    sourceCenter[axis] /= count;
    targetCenter[axis] /= count;
  }
  return { sourceCenter, targetCenter };
}

function fitSim3(source, target, se3Model) {
  const { sourceCenter, targetCenter } = centersOf(source, target);
  const rotation = quaternionMatrix(se3Model.quaternion);
  let numerator = 0;
  let denominator = 0;
  for (let offset = 0; offset < target.length; offset += 3) {
    const sx = source[offset] - sourceCenter[0];
    const sy = source[offset + 1] - sourceCenter[1];
    const sz = source[offset + 2] - sourceCenter[2];
    const rotated = rotatePoint(rotation, sx, sy, sz);
    numerator += rotated[0] * (target[offset] - targetCenter[0]);
    numerator += rotated[1] * (target[offset + 1] - targetCenter[1]);
    numerator += rotated[2] * (target[offset + 2] - targetCenter[2]);
    denominator += sx * sx + sy * sy + sz * sz;
  }
  const fittedScale = denominator > 1e-9 ? numerator / denominator : 1;
  const scaleCode = Math.max(-MATRIX_SUBSTEPS, Math.min(MATRIX_SUBSTEPS * 3, Math.round((fittedScale - 1) * MATRIX_SUBSTEPS)));
  const scale = 1 + scaleCode / MATRIX_SUBSTEPS;
  const rotatedCenter = rotatePoint(rotation, sourceCenter[0], sourceCenter[1], sourceCenter[2]);
  const translationCodes = targetCenter.map((value, axis) => Math.round((value - scale * rotatedCenter[axis]) * MOTION_SUBSTEPS));
  return { quaternionCodes: se3Model.quaternionCodes, quaternion: se3Model.quaternion, scaleCode, scale, translationCodes };
}

function inverseMatrix3(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const cofactorA = e * i - f * h;
  const cofactorB = c * h - b * i;
  const cofactorC = b * f - c * e;
  const determinant = a * cofactorA + d * cofactorB + g * cofactorC;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return undefined;
  const reciprocal = 1 / determinant;
  return [
    cofactorA * reciprocal, (c * h - b * i) * reciprocal, (b * f - c * e) * reciprocal,
    (f * g - d * i) * reciprocal, (a * i - c * g) * reciprocal, (c * d - a * f) * reciprocal,
    (d * h - e * g) * reciprocal, (b * g - a * h) * reciprocal, (a * e - b * d) * reciprocal,
  ];
}

function fitAffine(source, target) {
  const { sourceCenter, targetCenter } = centersOf(source, target);
  const sourceCovariance = new Float64Array(9);
  const crossCovariance = new Float64Array(9);
  for (let offset = 0; offset < target.length; offset += 3) {
    const sourceDelta = [source[offset] - sourceCenter[0], source[offset + 1] - sourceCenter[1], source[offset + 2] - sourceCenter[2]];
    const targetDelta = [target[offset] - targetCenter[0], target[offset + 1] - targetCenter[1], target[offset + 2] - targetCenter[2]];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        sourceCovariance[row * 3 + column] += sourceDelta[row] * sourceDelta[column];
        crossCovariance[row * 3 + column] += targetDelta[row] * sourceDelta[column];
      }
    }
  }
  const inverse = inverseMatrix3(sourceCovariance);
  const fitted = new Float64Array(9);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let value = row === column ? 1 : 0;
      if (inverse) {
        value = 0;
        for (let inner = 0; inner < 3; inner += 1) value += crossCovariance[row * 3 + inner] * inverse[inner * 3 + column];
      }
      fitted[row * 3 + column] = value;
    }
  }
  const matrixCodes = Array.from(fitted, (value, index) => {
    const identity = index % 4 === 0 ? 1 : 0;
    return Math.max(-MATRIX_SUBSTEPS * 4, Math.min(MATRIX_SUBSTEPS * 4, Math.round((value - identity) * MATRIX_SUBSTEPS)));
  });
  const matrix = matrixCodes.map((value, index) => (index % 4 === 0 ? 1 : 0) + value / MATRIX_SUBSTEPS);
  const transformedCenter = rotatePoint(matrix, sourceCenter[0], sourceCenter[1], sourceCenter[2]);
  const translationCodes = targetCenter.map((value, axis) => Math.round((value - transformedCenter[axis]) * MOTION_SUBSTEPS));
  return { matrixCodes, matrix, translationCodes };
}

function translatedResiduals(source, target, translationCodes) {
  const residuals = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      residuals[offset + axis] = target[offset + axis] - Math.round(source[offset + axis] + translationCodes[axis] / MOTION_SUBSTEPS);
    }
  }
  return residuals;
}

function localTranslationModel(source, target, active, first, nodeCount) {
  const sums = Array.from({ length: nodeCount }, () => [0, 0, 0, 0]);
  for (let point = 0; point < target.length / 3; point += 1) {
    const node = Math.min(nodeCount - 1, Math.floor((active[first + point] % BLOCK_SIZE) * nodeCount / BLOCK_SIZE));
    const sum = sums[node];
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += target[point * 3 + axis] - source[point * 3 + axis];
    sum[3] += 1;
  }
  const translationCodes = sums.map((sum) => sum[3]
    ? [0, 1, 2].map((axis) => Math.round(sum[axis] / sum[3] * MOTION_SUBSTEPS))
    : undefined);
  const residuals = new Int32Array(target.length);
  for (let point = 0; point < target.length / 3; point += 1) {
    const node = Math.min(nodeCount - 1, Math.floor((active[first + point] % BLOCK_SIZE) * nodeCount / BLOCK_SIZE));
    const translation = translationCodes[node];
    for (let axis = 0; axis < 3; axis += 1) {
      residuals[point * 3 + axis] = target[point * 3 + axis] - Math.round(source[point * 3 + axis] + translation[axis] / MOTION_SUBSTEPS);
    }
  }
  return { residuals, translationCodes };
}

function residualVariants(banks, task, active, first, last) {
  const count = last - first;
  const source = new Float64Array(count * 3);
  const target = new Int32Array(count * 3);
  const linear = new Int32Array(count * 3);
  for (let row = first; row < last; row += 1) {
    const destination = (row - first) * 3;
    const sourceOffset = row * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const predicted = interpolateCoordinate(
        banks[task.left][sourceOffset + axis],
        banks[task.right][sourceOffset + axis],
        task.target,
        task.left,
        task.right,
      );
      const actual = banks[task.target][sourceOffset + axis];
      source[destination + axis] = predicted;
      target[destination + axis] = actual;
      linear[destination + axis] = actual - Math.round(predicted);
    }
  }
  return motionVariantsFromPrepared(source, target, linear, active, first);
}

function motionVariantsFromPrepared(source, target, linear, active, first) {
  const count = target.length / 3;
  const translationCodes = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    let sum = 0;
    for (let offset = axis; offset < target.length; offset += 3) sum += target[offset] - source[offset];
    translationCodes[axis] = Math.round(sum / count * MOTION_SUBSTEPS);
  }
  const translation = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      translation[offset + axis] = target[offset + axis] - Math.round(source[offset + axis] + translationCodes[axis] / MOTION_SUBSTEPS);
    }
  }
  const se3Model = fitSe3(source, target);
  const matrix = quaternionMatrix(se3Model.quaternion);
  const se3 = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 3) {
    const rotated = rotatePoint(matrix, source[offset], source[offset + 1], source[offset + 2]);
    for (let axis = 0; axis < 3; axis += 1) {
      const predicted = rotated[axis] + se3Model.translationCodes[axis] / MOTION_SUBSTEPS;
      se3[offset + axis] = target[offset + axis] - Math.round(predicted);
    }
  }
  const sim3Model = fitSim3(source, target, se3Model);
  const sim3Matrix = quaternionMatrix(sim3Model.quaternion).map((value) => value * sim3Model.scale);
  const sim3 = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 3) {
    const transformed = rotatePoint(sim3Matrix, source[offset], source[offset + 1], source[offset + 2]);
    for (let axis = 0; axis < 3; axis += 1) sim3[offset + axis] = target[offset + axis] - Math.round(transformed[axis] + sim3Model.translationCodes[axis] / MOTION_SUBSTEPS);
  }
  const affineModel = fitAffine(source, target);
  const affine = new Int32Array(target.length);
  for (let offset = 0; offset < target.length; offset += 3) {
    const transformed = rotatePoint(affineModel.matrix, source[offset], source[offset + 1], source[offset + 2]);
    for (let axis = 0; axis < 3; axis += 1) affine[offset + axis] = target[offset + axis] - Math.round(transformed[axis] + affineModel.translationCodes[axis] / MOTION_SUBSTEPS);
  }
  const local4Model = localTranslationModel(source, target, active, first, 4);
  const local8Model = localTranslationModel(source, target, active, first, 8);
  return {
    linear,
    translation,
    se3,
    sim3,
    affine,
    local4: local4Model.residuals,
    local8: local8Model.residuals,
    translationCodes,
    se3Model,
    sim3Model,
    affineModel,
    local4Model,
    local8Model,
  };
}

// #WDD-gpt 2026-08-15 - Segment 结束边界从已解码起点做块运动预测，避免遗漏六个 END_FRAME 的真实码率。
function boundaryTransitionVariants(banks, active, first, last) {
  const count = last - first;
  const source = new Float64Array(count * 3);
  const target = new Int32Array(count * 3);
  const linear = new Int32Array(count * 3);
  for (let row = first; row < last; row += 1) {
    const destination = (row - first) * 3;
    const sourceOffset = row * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      source[destination + axis] = banks[0][sourceOffset + axis];
      target[destination + axis] = banks[10][sourceOffset + axis];
      linear[destination + axis] = target[destination + axis] - source[destination + axis];
    }
  }
  return motionVariantsFromPrepared(source, target, linear, active, first);
}

function genericTripleCost(x, y, z) {
  if (x === 0 && y === 0 && z === 0) return 0;
  if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 7) return 1;
  return 1 + signedVarintBytes(x) + signedVarintBytes(y) + signedVarintBytes(z);
}

function genericBlockCost(residuals) {
  let nonzero = 0;
  let dense = 0;
  let sparse = 1;
  let previous = -1;
  for (let offset = 0; offset < residuals.length; offset += 3) {
    const x = residuals[offset];
    const y = residuals[offset + 1];
    const z = residuals[offset + 2];
    const cost = genericTripleCost(x, y, z);
    dense += cost || 1;
    if (cost) {
      const point = offset / 3;
      sparse += varintBytes(point - previous - 1) + cost;
      previous = point;
      nonzero += 1;
    }
  }
  if (nonzero === 0) return { bytes: 0, layout: 'zero' };
  sparse += varintBytes(nonzero);
  return sparse < dense ? { bytes: sparse, layout: 'sparse' } : { bytes: dense, layout: 'dense' };
}

function motionParameterBytes(variant) {
  if (variant.name === 'linear') return 0;
  if (variant.name === 'translation') return variant.translationCodes.reduce((sum, value) => sum + signedVarintBytes(value), 0);
  if (variant.name === 'se3') return 8 + variant.se3Model.translationCodes.reduce((sum, value) => sum + signedVarintBytes(value), 0);
  if (variant.name === 'sim3') {
    return 8 + signedVarintBytes(variant.sim3Model.scaleCode)
      + variant.sim3Model.translationCodes.reduce((sum, value) => sum + signedVarintBytes(value), 0);
  }
  if (variant.name === 'affine') {
    return variant.affineModel.matrixCodes.reduce((sum, value) => sum + signedVarintBytes(value), 0)
      + variant.affineModel.translationCodes.reduce((sum, value) => sum + signedVarintBytes(value), 0);
  }
  const model = variant.name === 'local4' ? variant.local4Model : variant.local8Model;
  return model.translationCodes.reduce((sum, translation) => (
    sum + (translation ? translation.reduce((inner, value) => inner + signedVarintBytes(value), 0) : 0)
  ), 0);
}

const MOTION_NAMES = ['linear', 'translation', 'se3', 'sim3', 'affine', 'local4', 'local8'];

function motionCandidates(variants) {
  return MOTION_NAMES.map((name) => ({
    name,
    residuals: variants[name],
    translationCodes: variants.translationCodes,
    se3Model: variants.se3Model,
    sim3Model: variants.sim3Model,
    affineModel: variants.affineModel,
    local4Model: variants.local4Model,
    local8Model: variants.local8Model,
  }));
}

function provisionalChoice(variants) {
  const candidates = motionCandidates(variants);
  for (const candidate of candidates) {
    candidate.residualCost = genericBlockCost(candidate.residuals);
    candidate.bytes = 1 + candidate.residualCost.bytes + motionParameterBytes(candidate);
  }
  candidates.sort((a, b) => a.bytes - b.bytes || MOTION_NAMES.indexOf(a.name) - MOTION_NAMES.indexOf(b.name));
  return candidates[0];
}

function dictionaryLookup(stats, symbolCount) {
  const entries = stats.dictionary(symbolCount, false);
  const lookup = new Map();
  entries.forEach((entry, index) => lookup.set(packedSmallResidual(...entry.value), index + 1));
  return { entries, lookup, symbolCount, escapeSymbol: symbolCount, fixedByteSymbols: symbolCount <= 255 };
}

function residualSymbolBytes(symbol, dictionary) {
  return dictionary.fixedByteSymbols ? 1 : varintBytes(symbol);
}

function exactTripleCost(x, y, z, dictionary) {
  if (x === 0 && y === 0 && z === 0) return 1;
  const symbol = dictionary.lookup.get(packedSmallResidual(x, y, z));
  if (symbol !== undefined) return residualSymbolBytes(symbol, dictionary);
  return residualSymbolBytes(dictionary.escapeSymbol, dictionary) + signedVarintBytes(x) + signedVarintBytes(y) + signedVarintBytes(z);
}

function exactBlockCost(residuals, dictionary) {
  let nonzero = 0;
  let dense = 0;
  let sparse = 0;
  let previous = -1;
  for (let offset = 0; offset < residuals.length; offset += 3) {
    const x = residuals[offset];
    const y = residuals[offset + 1];
    const z = residuals[offset + 2];
    dense += exactTripleCost(x, y, z, dictionary);
    if (x !== 0 || y !== 0 || z !== 0) {
      const point = offset / 3;
      sparse += varintBytes(point - previous - 1) + exactTripleCost(x, y, z, dictionary);
      previous = point;
      nonzero += 1;
    }
  }
  if (nonzero === 0) return { bytes: 0, layout: 'zero', nonzero };
  sparse += varintBytes(nonzero);
  return sparse < dense ? { bytes: sparse, layout: 'sparse', nonzero } : { bytes: dense, layout: 'dense', nonzero };
}

function exactChoice(variants, dictionary) {
  const candidates = motionCandidates(variants);
  for (const candidate of candidates) {
    candidate.residualCost = exactBlockCost(candidate.residuals, dictionary);
    candidate.bytes = 1 + candidate.residualCost.bytes + motionParameterBytes(candidate);
  }
  candidates.sort((a, b) => a.bytes - b.bytes || MOTION_NAMES.indexOf(a.name) - MOTION_NAMES.indexOf(b.name));
  return candidates[0];
}

function writeMotionParameters(writer, choice) {
  if (choice.name === 'translation') {
    for (const value of choice.translationCodes) writer.sint(value);
  } else if (choice.name === 'se3') {
    for (const value of choice.se3Model.quaternionCodes) writer.int16(value);
    for (const value of choice.se3Model.translationCodes) writer.sint(value);
  } else if (choice.name === 'sim3') {
    for (const value of choice.sim3Model.quaternionCodes) writer.int16(value);
    writer.sint(choice.sim3Model.scaleCode);
    for (const value of choice.sim3Model.translationCodes) writer.sint(value);
  } else if (choice.name === 'affine') {
    for (const value of choice.affineModel.matrixCodes) writer.sint(value);
    for (const value of choice.affineModel.translationCodes) writer.sint(value);
  } else if (choice.name === 'local4' || choice.name === 'local8') {
    const model = choice.name === 'local4' ? choice.local4Model : choice.local8Model;
    for (const translation of model.translationCodes) {
      if (!translation) continue;
      for (const value of translation) writer.sint(value);
    }
  }
}

function writeResiduals(choice, dictionary, masks, symbols, escapes) {
  const { residuals } = choice;
  const layout = choice.residualCost.layout;
  if (layout === 'zero') return;
  if (layout === 'sparse') {
    masks.uint(choice.residualCost.nonzero);
    let previous = -1;
    for (let offset = 0; offset < residuals.length; offset += 3) {
      const x = residuals[offset];
      const y = residuals[offset + 1];
      const z = residuals[offset + 2];
      if (x === 0 && y === 0 && z === 0) continue;
      const point = offset / 3;
      masks.uint(point - previous - 1);
      writeResidualSymbol(x, y, z, dictionary, symbols, escapes);
      previous = point;
    }
    return;
  }
  for (let offset = 0; offset < residuals.length; offset += 3) {
    writeResidualSymbol(residuals[offset], residuals[offset + 1], residuals[offset + 2], dictionary, symbols, escapes);
  }
}

function writeResidualSymbol(x, y, z, dictionary, symbols, escapes) {
  if (x === 0 && y === 0 && z === 0) {
    if (dictionary.fixedByteSymbols) symbols.byte(0);
    else symbols.uint(0);
    return;
  }
  const symbol = dictionary.lookup.get(packedSmallResidual(x, y, z));
  if (symbol !== undefined) {
    if (dictionary.fixedByteSymbols) symbols.byte(symbol);
    else symbols.uint(symbol);
    return;
  }
  if (dictionary.fixedByteSymbols) symbols.byte(dictionary.escapeSymbol);
  else symbols.uint(dictionary.escapeSymbol);
  escapes[0].sint(x);
  escapes[1].sint(y);
  escapes[2].sint(z);
}

function modeCode(choice) {
  const method = MOTION_NAMES.indexOf(choice.name);
  const layout = { zero: 0, sparse: 1, dense: 2 }[choice.residualCost.layout];
  return method * 3 + layout;
}

function compressedStream(writer) {
  const raw = writer.finish();
  const compressed = encodeRans(raw);
  return { rawBytes: raw.length, ransBytes: compressed.length, encoded: compressed };
}

function streamMetrics(streams) {
  return Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, {
    rawBytes: stream.rawBytes,
    ransBytes: stream.ransBytes,
  }]));
}

function encodingMetrics(encoding) {
  return { ...encoding, streams: streamMetrics(encoding.streams) };
}

function activeMask(layout) {
  const bytes = new Uint8Array(Math.ceil(layout.trackCount * layout.activeSlots.length / 8));
  for (let segmentIndex = 0; segmentIndex < layout.activeSlots.length; segmentIndex += 1) {
    for (const slot of layout.activeSlots[segmentIndex]) {
      const bit = segmentIndex * layout.trackCount + slot;
      bytes[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bytes;
}

function birthPositionStream(positionSegments, layout) {
  const writer = new ByteWriter();
  const initialized = new Uint8Array(layout.trackCount);
  const birthCodes = new Float64Array(layout.trackCount);
  for (let segmentIndex = 0; segmentIndex < positionSegments.length; segmentIndex += 1) {
    const active = layout.activeSlots[segmentIndex];
    const firstBank = positionSegments[segmentIndex][0];
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      if (initialized[slot]) continue;
      const offset = row * 3;
      birthCodes[slot] = (firstBank[offset] * GRID_BASE + firstBank[offset + 1]) * GRID_BASE + firstBank[offset + 2];
      initialized[slot] = 1;
    }
  }
  for (let slot = 0; slot < layout.trackCount; slot += 1) {
    if (!initialized[slot]) throw new Error(`Missing birth Position for Track ${slot}.`);
    writer.uint40(birthCodes[slot]);
  }
  return writer.finish();
}

// #WDD-gpt 2026-08-15 - 写出可独立解码的 Position 研究容器，包含 Active Mask、40-bit 出生坐标和全部预测残差流。
function buildPositionContainer(positionSegments, layout, geometry, encoding) {
  const maskRaw = Buffer.from(activeMask(layout));
  const birthRaw = birthPositionStream(positionSegments, layout);
  const streams = [
    { name: 'activeMask', rawBytes: maskRaw.length, encoded: encodeRans(maskRaw) },
    { name: 'birthPosition40', rawBytes: birthRaw.length, encoded: encodeRans(birthRaw) },
    ...Object.entries(encoding.streams).map(([name, stream]) => ({ name, rawBytes: stream.rawBytes, encoded: stream.encoded })),
  ];
  const manifest = {
    format: 'H4XYZ',
    version: 1,
    geometry,
    trackCount: layout.trackCount,
    segmentTrackCounts: layout.activeSlots.map((active) => active.length),
    blockSize: BLOCK_SIZE,
    gridBase: GRID_BASE,
    motionSubsteps: MOTION_SUBSTEPS,
    matrixSubsteps: MATRIX_SUBSTEPS,
    motionNames: MOTION_NAMES,
    hierarchy: HIERARCHY,
    dictionarySymbolCount: encoding.symbolCount,
    streams: streams.map((stream) => ({ name: stream.name, rawBytes: stream.rawBytes, encodedBytes: stream.encoded.length })),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.alloc(16);
  header.write('H4XYZ001', 0, 'ascii');
  header.writeUInt32LE(manifestBytes.length, 8);
  header.writeUInt16LE(streams.length, 12);
  return { bytes: Buffer.concat([header, manifestBytes, ...streams.map((stream) => stream.encoded)]), manifest };
}

function encodeSelectedPositionResiduals(positionSegments, layout, dictionary) {
  const modes = new ByteWriter();
  const masks = new ByteWriter();
  const symbols = new ByteWriter();
  const escapes = [new ByteWriter(), new ByteWriter(), new ByteWriter()];
  const parameters = new ByteWriter();
  const modeCounts = {};
  let observations = 0;
  let blockFrames = 0;
  for (let segmentIndex = 0; segmentIndex < positionSegments.length; segmentIndex += 1) {
    const banks = positionSegments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const ranges = blockRanges(active);
    for (const range of ranges) {
      const variants = boundaryTransitionVariants(banks, active, range.first, range.last);
      const choice = exactChoice(variants, dictionary);
      const label = `boundary_${choice.name}_${choice.residualCost.layout}`;
      modeCounts[label] = (modeCounts[label] ?? 0) + 1;
      modes.byte(modeCode(choice));
      writeMotionParameters(parameters, choice);
      writeResiduals(choice, dictionary, masks, symbols, escapes);
      observations += range.last - range.first;
      blockFrames += 1;
    }
    for (const task of HIERARCHY) {
      for (const range of ranges) {
        const variants = residualVariants(banks, task, active, range.first, range.last);
        const choice = exactChoice(variants, dictionary);
        const label = `${choice.name}_${choice.residualCost.layout}`;
        modeCounts[label] = (modeCounts[label] ?? 0) + 1;
        modes.byte(modeCode(choice));
        writeMotionParameters(parameters, choice);
        writeResiduals(choice, dictionary, masks, symbols, escapes);
        observations += range.last - range.first;
        blockFrames += 1;
      }
    }
  }
  const dictionaryWriter = new ByteWriter();
  dictionaryWriter.uint(dictionary.entries.length);
  for (const entry of dictionary.entries) {
    for (const value of entry.value) dictionaryWriter.sint(value);
  }
  const streams = {
    dictionary: compressedStream(dictionaryWriter),
    modes: compressedStream(modes),
    masks: compressedStream(masks),
    symbols: compressedStream(symbols),
    escapeX: compressedStream(escapes[0]),
    escapeY: compressedStream(escapes[1]),
    escapeZ: compressedStream(escapes[2]),
    parameters: compressedStream(parameters),
  };
  const ransBytes = Object.values(streams).reduce((sum, stream) => sum + stream.ransBytes, 0);
  return {
    observations,
    blockFrames,
    modeCounts,
    streams,
    ransBytes,
    bitsPerGaussianKeyframe: ransBytes * 8 / observations,
  };
}

async function main() {
  const sourceDirectory = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/hierarchical_entropy_20260815/xyz_entropy.json');
  const payloadPath = resolve(process.argv[4] ?? 'artifacts/hierarchical_entropy_20260815/position.h4xyz');
  const entries = (await readdir(sourceDirectory))
    .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  if (entries.length !== 6) throw new Error(`Expected six RAW4D segments, found ${entries.length}.`);
  const segments = [];
  let sourceBytes = 0;
  for (const entry of entries) {
    const path = join(sourceDirectory, entry.name);
    segments.push(await readSegment(path));
    sourceBytes += (await stat(path)).size;
    console.log(JSON.stringify({ phase: 'load', file: entry.name }));
  }
  const positionBankCounts = segments.map((segment) => bankCount(segment, 'xyz_bank'));
  if (!positionBankCounts.every((count) => count === 11)) throw new Error(`Expected 11 Position banks per segment: ${positionBankCounts.join(',')}`);
  console.log(JSON.stringify({ phase: 'track_match', message: 'building permanent Track IDs' }));
  const permanent = buildPermanentTrackMaps(segments);
  const center = robustCenter(segments[0]);
  const origin = center.map((value) => value - HALF_EXTENT);
  console.log(JSON.stringify({ phase: 'morton_layout', center, halfExtent: HALF_EXTENT }));
  const layout = buildCroppedMortonLayout(segments, permanent, center, HALF_EXTENT);
  const positionSegments = [];
  let outsideGridValues = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const quantized = quantizedPositionBanks(segments[segmentIndex], layout, segmentIndex, origin);
    positionSegments.push(quantized.banks);
    outsideGridValues += quantized.outsideGrid;
    console.log(JSON.stringify({
      phase: 'quantize',
      segment: basename(segments[segmentIndex].path),
      tracks: layout.activeSlots[segmentIndex].length,
      outsideGridValues: quantized.outsideGrid,
    }));
  }
  if (outsideGridValues !== 0) throw new Error(`${outsideGridValues} Position values do not fit the 10001^3 mixed-radix grid.`);

  const linearStats = new ResidualStats('hierarchical_linear');
  const translationStats = new ResidualStats('block_translation');
  const se3Stats = new ResidualStats('block_se3');
  const sim3Stats = new ResidualStats('block_sim3');
  const affineStats = new ResidualStats('block_affine');
  const local4Stats = new ResidualStats('block_local4_translation');
  const local8Stats = new ResidualStats('block_local8_translation');
  const boundaryLinearStats = new ResidualStats('segment_boundary_linear');
  const boundarySelectedStats = new ResidualStats('segment_boundary_selected');
  const selectedStats = new ResidualStats('provisional_selected');
  const provisionalModes = {};
  for (let segmentIndex = 0; segmentIndex < positionSegments.length; segmentIndex += 1) {
    const banks = positionSegments[segmentIndex];
    const active = layout.activeSlots[segmentIndex];
    const ranges = blockRanges(active);
    for (const range of ranges) {
      const variants = boundaryTransitionVariants(banks, active, range.first, range.last);
      boundaryLinearStats.addArray(variants.linear);
      const choice = provisionalChoice(variants);
      boundarySelectedStats.addArray(choice.residuals);
      selectedStats.addArray(choice.residuals);
      const label = `boundary_${choice.name}`;
      provisionalModes[label] = (provisionalModes[label] ?? 0) + 1;
    }
    console.log(JSON.stringify({ phase: 'xyz_pass1_boundary', segment: segmentIndex }));
    for (const task of HIERARCHY) {
      for (const range of ranges) {
        const variants = residualVariants(banks, task, active, range.first, range.last);
        linearStats.addArray(variants.linear);
        translationStats.addArray(variants.translation);
        se3Stats.addArray(variants.se3);
        sim3Stats.addArray(variants.sim3);
        affineStats.addArray(variants.affine);
        local4Stats.addArray(variants.local4);
        local8Stats.addArray(variants.local8);
        const choice = provisionalChoice(variants);
        selectedStats.addArray(choice.residuals);
        provisionalModes[choice.name] = (provisionalModes[choice.name] ?? 0) + 1;
      }
      console.log(JSON.stringify({ phase: 'xyz_pass1', segment: segmentIndex, level: task.level, key: task.target }));
    }
  }
  const selectedEncodings = [];
  for (const symbolCount of DICTIONARY_SYMBOL_COUNTS) {
    const dictionary = dictionaryLookup(selectedStats, symbolCount);
    console.log(JSON.stringify({ phase: 'xyz_rans', dictionaryEntries: dictionary.entries.length, symbolCount }));
    selectedEncodings.push({ symbolCount, ...encodeSelectedPositionResiduals(positionSegments, layout, dictionary) });
  }
  selectedEncodings.sort((a, b) => a.ransBytes - b.ransBytes);
  const selectedEncoding = selectedEncodings[0];
  const firstFrameTracks = layout.activeSlots[0].length;
  const birthTracks = layout.trackCount;
  const absolutePositionBytes = birthTracks * 5;
  const activeSegmentInstances = layout.activeSlots.reduce((sum, active) => sum + active.length, 0);
  const geometry = {
    positionStepMeters: POSITION_STEP,
    maximumPerAxisErrorMeters: POSITION_STEP / 2,
    maximumEuclideanErrorMeters: Math.sqrt(3) * POSITION_STEP / 2,
    center,
    origin,
    halfExtentMeters: HALF_EXTENT,
    mixedRadixBase: GRID_BASE,
    mixedRadixBits: 40,
    outsideGridValues,
  };
  const container = buildPositionContainer(positionSegments, layout, geometry, selectedEncoding);
  const report = {
    format: '4CGS hierarchical entropy experiment v1',
    generatedAt: new Date().toISOString(),
    sourceDirectory,
    sourceBytes,
    sourceMegabytes: sourceBytes / 1e6,
    geometry,
    tracks: {
      firstFrameTracks,
      permanentTracks: layout.trackCount,
      activeSegmentInstances,
      segmentTrackCounts: layout.activeSlots.map((active) => active.length),
      fixedBlockSize: BLOCK_SIZE,
      permanentBlocks: Math.ceil(layout.trackCount / BLOCK_SIZE),
      boundaryMatches: layout.matches,
      absoluteBirthPositionBytes: absolutePositionBytes,
      absoluteBirthPositionMegabytes: absolutePositionBytes / 1e6,
    },
    temporal: {
      segments: segments.length,
      sourcePositionBanksPerSegment: positionBankCounts,
      uniqueGlobalPositionKeys: segments.length * 10 + 1,
      predictedInteriorKeysPerSegment: HIERARCHY.length,
      predictedEndFramesPerSegment: 1,
      maximumDependencyDepth: 4,
      hierarchy: HIERARCHY,
    },
    residuals: {
      linear: linearStats.summary(),
      translation: translationStats.summary(),
      se3: se3Stats.summary(),
      sim3: sim3Stats.summary(),
      affine: affineStats.summary(),
      local4: local4Stats.summary(),
      local8: local8Stats.summary(),
      boundaryLinear: boundaryLinearStats.summary(),
      boundarySelected: boundarySelectedStats.summary(),
      provisionalSelected: selectedStats.summary(),
      provisionalModes,
    },
    exactResidualCodec: encodingMetrics(selectedEncoding),
    exactResidualCodecCandidates: selectedEncodings.map(encodingMetrics),
    predictedXyzMegabytes: selectedEncoding.ransBytes / 1e6,
    birthPlusPredictedXyzMegabytes: (absolutePositionBytes + selectedEncoding.ransBytes) / 1e6,
    positionContainer: {
      path: payloadPath,
      bytes: container.bytes.length,
      megabytes: container.bytes.length / 1e6,
      streams: container.manifest.streams,
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  await mkdir(dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, container.bytes);
  console.log(JSON.stringify({
    phase: 'done',
    outputPath,
    payloadPath,
    payloadMegabytes: container.bytes.length / 1e6,
    permanentTracks: layout.trackCount,
    observations: selectedEncoding.observations,
    xyzBitsPerGaussianKeyframe: selectedEncoding.bitsPerGaussianKeyframe,
    predictedXyzMegabytes: report.predictedXyzMegabytes,
    birthPlusPredictedXyzMegabytes: report.birthPlusPredictedXyzMegabytes,
  }));
}

await main();
