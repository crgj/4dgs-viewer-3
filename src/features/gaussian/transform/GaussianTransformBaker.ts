import { FloatPacking, Quat } from 'playcanvas';
import type { Raw4DAsset, Raw4DBounds, Raw4DScalarArray } from '../formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../formats/raw4d/Raw4DValues';

// #WDD-gpt 2026-08-17 - 将场景 TRS 烘焙到 Canonical 高斯及全部关键帧，并同步旋转椭球和方向相关 SH，避免仅移动中心造成外观错向。

const SH_C1 = 0.4886025119029199;
const SH_C2 = [
  1.0925484305920792,
  -1.0925484305920792,
  0.31539156525252005,
  -1.0925484305920792,
  0.5462742152960396,
] as const;
const SH_C3 = [
  -0.5900435899266435,
  2.890611442640554,
  -0.4570457994644658,
  0.3731763325901154,
  -0.4570457994644658,
  1.445305721320277,
  -0.5900435899266435,
] as const;
const FLOAT16_MAX = 65_504;

export interface GaussianBakeTransform {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

export type GaussianTransformBakeStage = 'position' | 'rotation' | 'scale' | 'sh' | 'complete';

export interface GaussianTransformBakeProgress {
  readonly ratio: number;
  readonly stage: GaussianTransformBakeStage;
  readonly processedPointPasses: number;
  readonly totalPointPasses: number;
}

export interface GaussianTransformBakeResult {
  readonly pointCount: number;
  readonly positionKeyframes: number;
  readonly rotationKeyframes: number;
  readonly scaleKeyframes: number;
  readonly rotatedSh: boolean;
  readonly shBands: number;
}

export interface GaussianTransformBakeOptions {
  readonly onProgress?: (progress: GaussianTransformBakeProgress) => void;
  readonly signal?: AbortSignal;
}

type QuaternionWxyz = readonly [number, number, number, number];
type Vector3 = readonly [number, number, number];

interface BakeContext {
  completedPointPasses: number;
  lastYieldAt: number;
  readonly onProgress?: (progress: GaussianTransformBakeProgress) => void;
  readonly signal?: AbortSignal;
  readonly totalPointPasses: number;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

async function yieldToHost(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('模型原点重设已取消。', 'AbortError');
}

async function reportAndYield(
  context: BakeContext,
  stage: GaussianTransformBakeStage,
  currentPassProgress = 0,
  force = false,
): Promise<void> {
  const elapsed = now() - context.lastYieldAt;
  if (!force && elapsed < 12) return;
  throwIfAborted(context.signal);
  const processedPointPasses = context.completedPointPasses + currentPassProgress;
  context.onProgress?.({
    ratio: context.totalPointPasses === 0 ? 1 : processedPointPasses / context.totalPointPasses,
    stage,
    processedPointPasses,
    totalPointPasses: context.totalPointPasses,
  });
  await yieldToHost();
  context.lastYieldAt = now();
}

function writeScalar(
  array: Raw4DScalarArray,
  index: number,
  encoding: Raw4DAsset['sourceEncoding'],
  value: number,
): void {
  array[index] = encoding === 'float16' ? FloatPacking.float2Half(value) : value;
}

function normalizedQuaternion(values: QuaternionWxyz): QuaternionWxyz {
  const length = Math.hypot(values[0], values[1], values[2], values[3]);
  if (!Number.isFinite(length) || length < 1e-12) return [1, 0, 0, 0];
  return [values[0] / length, values[1] / length, values[2] / length, values[3] / length];
}

function quaternionFromEuler(rotation: GaussianBakeTransform['rotation']): QuaternionWxyz {
  const quaternion = new Quat().setFromEulerAngles(rotation[0], rotation[1], rotation[2]).normalize();
  return [quaternion.w, quaternion.x, quaternion.y, quaternion.z];
}

function multiplyQuaternion(left: QuaternionWxyz, right: QuaternionWxyz): QuaternionWxyz {
  const [lw, lx, ly, lz] = left;
  const [rw, rx, ry, rz] = right;
  return normalizedQuaternion([
    lw * rw - lx * rx - ly * ry - lz * rz,
    lw * rx + lx * rw + ly * rz - lz * ry,
    lw * ry - lx * rz + ly * rw + lz * rx,
    lw * rz + lx * ry - ly * rx + lz * rw,
  ]);
}

function rotateVector(quaternion: QuaternionWxyz, vector: Vector3): [number, number, number] {
  const [w, x, y, z] = quaternion;
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ];
}

function inverseRotateVector(quaternion: QuaternionWxyz, vector: Vector3): [number, number, number] {
  return rotateVector([quaternion[0], -quaternion[1], -quaternion[2], -quaternion[3]], vector);
}

function isIdentityRotation(quaternion: QuaternionWxyz): boolean {
  return 1 - Math.abs(quaternion[0]) < 1e-12
    && Math.hypot(quaternion[1], quaternion[2], quaternion[3]) < 1e-10;
}

export function isUniformGaussianBakeScale(scale: GaussianBakeTransform['scale'], tolerance = 1e-6): boolean {
  const maximum = Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]), 1);
  return Math.abs(scale[0] - scale[1]) <= tolerance * maximum
    && Math.abs(scale[0] - scale[2]) <= tolerance * maximum;
}

export function isIdentityGaussianBakeTransform(transform: GaussianBakeTransform, tolerance = 1e-8): boolean {
  return transform.position.every((value) => Math.abs(value) <= tolerance)
    && transform.rotation.every((value) => Math.abs(value) <= tolerance)
    && transform.scale.every((value) => Math.abs(value - 1) <= tolerance);
}

function validateTransform(asset: Raw4DAsset, transform: GaussianBakeTransform): void {
  const values = [...transform.position, ...transform.rotation, ...transform.scale];
  if (!values.every(Number.isFinite) || transform.scale.some((value) => value <= 0)) {
    throw new Error('模型变换必须是有限数值，且缩放必须大于 0。');
  }
  if (!isUniformGaussianBakeScale(transform.scale)) {
    throw new Error('重设模型原点只接受等比缩放；非等比缩放无法无损烘焙有限阶 SH 与高斯椭球。');
  }
  if (asset.position.components !== 3 || asset.rotation.components !== 4 || asset.scale.components !== 3) {
    throw new Error('Canonical Gaussian 的位置、旋转或缩放轨迹结构无效。');
  }
  const validateTrack = (name: string, track: Raw4DAsset['position'], components: number): void => {
    if (track.keyframes.length === 0 || track.values.length !== track.keyframes.length * components) {
      throw new Error(`${name} 关键帧与分量数量不匹配，已在写入前停止。`);
    }
    if (track.values.some((component) => component.length !== asset.splatCount)) {
      throw new Error(`${name} 分量长度与高斯数量不匹配，已在写入前停止。`);
    }
  };
  // #WDD-gpt 2026-08-17 - 不可撤销写回前完整校验全部可变轨迹和 SH 数组，避免损坏文件只烘焙到一半。
  validateTrack('位置', asset.position, 3);
  validateTrack('旋转', asset.rotation, 4);
  validateTrack('缩放', asset.scale, 3);
  const coefficientCount = shCoefficientCount(asset.shBands);
  if (asset.shRest.length !== coefficientCount * 3
    || asset.shRest.some((component) => component.length !== asset.splatCount)) {
    throw new Error(`SH${asset.shBands} 系数结构无效，已在写入前停止。`);
  }
  if (asset.sourceEncoding === 'float16') {
    const quaternion = quaternionFromEuler(transform.rotation);
    const uniformScale = transform.scale[0];
    const corners: Vector3[] = [];
    for (const x of [asset.bounds.min[0], asset.bounds.max[0]]) {
      for (const y of [asset.bounds.min[1], asset.bounds.max[1]]) {
        for (const z of [asset.bounds.min[2], asset.bounds.max[2]]) corners.push([x, y, z]);
      }
    }
    for (const corner of corners) {
      const rotated = rotateVector(quaternion, [
        corner[0] * uniformScale,
        corner[1] * uniformScale,
        corner[2] * uniformScale,
      ]);
      for (let axis = 0; axis < 3; axis += 1) {
        const value = rotated[axis] + transform.position[axis];
        if (!Number.isFinite(value) || Math.abs(value) > FLOAT16_MAX) {
          throw new Error('烘焙后的位置超出 FP16 可表示范围（±65504），已拒绝写入以避免生成 Infinity。');
        }
      }
    }
  }
}

function realShBasis(degree: 1 | 2 | 3, direction: Vector3): number[] {
  const [x, y, z] = direction;
  if (degree === 1) return [-SH_C1 * y, SH_C1 * z, -SH_C1 * x];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  if (degree === 2) {
    return [
      SH_C2[0] * x * y,
      SH_C2[1] * y * z,
      SH_C2[2] * (2 * zz - xx - yy),
      SH_C2[3] * x * z,
      SH_C2[4] * (xx - yy),
    ];
  }
  return [
    SH_C3[0] * y * (3 * xx - yy),
    SH_C3[1] * x * y * z,
    SH_C3[2] * y * (4 * zz - xx - yy),
    SH_C3[3] * z * (2 * zz - 3 * xx - 3 * yy),
    SH_C3[4] * x * (4 * zz - xx - yy),
    SH_C3[5] * z * (xx - yy),
    SH_C3[6] * x * (xx - 3 * yy),
  ];
}

function invertMatrix(source: readonly (readonly number[])[]): number[][] {
  const size = source.length;
  const rows = source.map((row, rowIndex) => [
    ...row,
    ...Array.from({ length: size }, (_, columnIndex) => rowIndex === columnIndex ? 1 : 0),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) throw new Error('SH 旋转矩阵求解失败。');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let entry = 0; entry < size * 2; entry += 1) rows[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = 0; entry < size * 2; entry += 1) {
        rows[row][entry] -= factor * rows[column][entry];
      }
    }
  }
  return rows.map((row) => row.slice(size));
}

function multiplyMatrices(left: readonly (readonly number[])[], right: readonly (readonly number[])[]): number[][] {
  return left.map((row) => Array.from({ length: right[0].length }, (_, column) => (
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)
  )));
}

function buildShRotationMatrix(degree: 1 | 2 | 3, quaternion: QuaternionWxyz): number[][] {
  const size = degree * 2 + 1;
  const normal = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const right = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const sampleCount = 48;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const y = 1 - 2 * (sample + 0.5) / sampleCount;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = sample * goldenAngle;
    const direction: Vector3 = [Math.cos(phi) * radius, y, Math.sin(phi) * radius];
    const destinationBasis = realShBasis(degree, direction);
    const sourceBasis = realShBasis(degree, inverseRotateVector(quaternion, direction));
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        normal[row][column] += destinationBasis[row] * destinationBasis[column];
        right[row][column] += destinationBasis[row] * sourceBasis[column];
      }
    }
  }
  return multiplyMatrices(invertMatrix(normal), right);
}

function shCoefficientCount(shBands: number): number {
  if (shBands === 0) return 0;
  if (shBands === 1) return 3;
  if (shBands === 2) return 8;
  if (shBands === 3) return 15;
  throw new Error(`不支持 SH${shBands} 的方向烘焙。`);
}

async function bakePosition(
  asset: Raw4DAsset,
  transform: GaussianBakeTransform,
  quaternion: QuaternionWxyz,
  context: BakeContext,
  bounds: { min: [number, number, number]; max: [number, number, number] },
): Promise<void> {
  const uniformScale = transform.scale[0];
  for (let key = 0; key < asset.position.keyframes.length; key += 1) {
    const offset = key * 3;
    const x = asset.position.values[offset];
    const y = asset.position.values[offset + 1];
    const z = asset.position.values[offset + 2];
    for (let index = 0; index < asset.splatCount; index += 1) {
      const rotated = rotateVector(quaternion, [
        readRaw4DScalar(x, index, asset.position.encoding) * uniformScale,
        readRaw4DScalar(y, index, asset.position.encoding) * uniformScale,
        readRaw4DScalar(z, index, asset.position.encoding) * uniformScale,
      ]);
      const px = rotated[0] + transform.position[0];
      const py = rotated[1] + transform.position[1];
      const pz = rotated[2] + transform.position[2];
      writeScalar(x, index, asset.position.encoding, px);
      writeScalar(y, index, asset.position.encoding, py);
      writeScalar(z, index, asset.position.encoding, pz);
      // #WDD-gpt 2026-08-17 - 边界按真正写回的 FP16/FP32 数值计算，避免量化极值落到未量化 AABB 外。
      const storedX = readRaw4DScalar(x, index, asset.position.encoding);
      const storedY = readRaw4DScalar(y, index, asset.position.encoding);
      const storedZ = readRaw4DScalar(z, index, asset.position.encoding);
      bounds.min[0] = Math.min(bounds.min[0], storedX);
      bounds.min[1] = Math.min(bounds.min[1], storedY);
      bounds.min[2] = Math.min(bounds.min[2], storedZ);
      bounds.max[0] = Math.max(bounds.max[0], storedX);
      bounds.max[1] = Math.max(bounds.max[1], storedY);
      bounds.max[2] = Math.max(bounds.max[2], storedZ);
      if ((index & 0x7ff) === 0x7ff) await reportAndYield(context, 'position', index + 1);
    }
    context.completedPointPasses += asset.splatCount;
    await reportAndYield(context, 'position', 0, true);
  }
}

async function bakeRotation(
  asset: Raw4DAsset,
  quaternion: QuaternionWxyz,
  context: BakeContext,
): Promise<void> {
  for (let key = 0; key < asset.rotation.keyframes.length; key += 1) {
    const offset = key * 4;
    const values = asset.rotation.values.slice(offset, offset + 4);
    for (let index = 0; index < asset.splatCount; index += 1) {
      const local = normalizedQuaternion([
        readRaw4DScalar(values[0], index, asset.rotation.encoding),
        readRaw4DScalar(values[1], index, asset.rotation.encoding),
        readRaw4DScalar(values[2], index, asset.rotation.encoding),
        readRaw4DScalar(values[3], index, asset.rotation.encoding),
      ]);
      const result = multiplyQuaternion(quaternion, local);
      for (let component = 0; component < 4; component += 1) {
        writeScalar(values[component], index, asset.rotation.encoding, result[component]);
      }
      if ((index & 0x7ff) === 0x7ff) await reportAndYield(context, 'rotation', index + 1);
    }
    context.completedPointPasses += asset.splatCount;
    await reportAndYield(context, 'rotation', 0, true);
  }
}

async function bakeScale(
  asset: Raw4DAsset,
  uniformScale: number,
  context: BakeContext,
): Promise<void> {
  const logarithmicScale = Math.log(uniformScale);
  for (let key = 0; key < asset.scale.keyframes.length; key += 1) {
    const offset = key * 3;
    const values = asset.scale.values.slice(offset, offset + 3);
    for (let index = 0; index < asset.splatCount; index += 1) {
      for (let component = 0; component < 3; component += 1) {
        const value = readRaw4DScalar(values[component], index, asset.scale.encoding) + logarithmicScale;
        writeScalar(values[component], index, asset.scale.encoding, value);
      }
      if ((index & 0x7ff) === 0x7ff) await reportAndYield(context, 'scale', index + 1);
    }
    context.completedPointPasses += asset.splatCount;
    await reportAndYield(context, 'scale', 0, true);
  }
}

async function bakeSh(
  asset: Raw4DAsset,
  quaternion: QuaternionWxyz,
  context: BakeContext,
): Promise<void> {
  const coefficientCount = shCoefficientCount(asset.shBands);
  if (coefficientCount === 0) return;
  if (asset.shRest.length !== coefficientCount * 3) {
    throw new Error(`SH${asset.shBands} 系数数量无效：${asset.shRest.length}。`);
  }
  const bands = [
    { degree: 1 as const, offset: 0, size: 3 },
    ...(asset.shBands >= 2 ? [{ degree: 2 as const, offset: 3, size: 5 }] : []),
    ...(asset.shBands >= 3 ? [{ degree: 3 as const, offset: 8, size: 7 }] : []),
  ];
  const matrices = bands.map((band) => buildShRotationMatrix(band.degree, quaternion));
  const source = new Array<number>(7).fill(0);
  const result = new Array<number>(7).fill(0);
  for (let index = 0; index < asset.splatCount; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      const channelOffset = channel * coefficientCount;
      for (let bandIndex = 0; bandIndex < bands.length; bandIndex += 1) {
        const band = bands[bandIndex];
        const matrix = matrices[bandIndex];
        for (let coefficient = 0; coefficient < band.size; coefficient += 1) {
          source[coefficient] = readRaw4DScalar(
            asset.shRest[channelOffset + band.offset + coefficient],
            index,
            asset.sourceEncoding,
          );
        }
        for (let row = 0; row < band.size; row += 1) {
          let value = 0;
          for (let column = 0; column < band.size; column += 1) {
            value += matrix[row][column] * source[column];
          }
          result[row] = value;
        }
        for (let coefficient = 0; coefficient < band.size; coefficient += 1) {
          writeScalar(
            asset.shRest[channelOffset + band.offset + coefficient],
            index,
            asset.sourceEncoding,
            result[coefficient],
          );
        }
      }
    }
    if ((index & 0x3ff) === 0x3ff) await reportAndYield(context, 'sh', index + 1);
  }
  context.completedPointPasses += asset.splatCount;
  await reportAndYield(context, 'sh', 0, true);
}

function updateBounds(asset: Raw4DAsset, bounds: Raw4DBounds): void {
  const minimum = asset.bounds.min as [number, number, number];
  const maximum = asset.bounds.max as [number, number, number];
  for (let axis = 0; axis < 3; axis += 1) {
    minimum[axis] = bounds.min[axis];
    maximum[axis] = Math.max(bounds.max[axis], bounds.min[axis] + 1e-4);
  }
}

export async function bakeGaussianAssetTransform(
  asset: Raw4DAsset,
  transform: GaussianBakeTransform,
  options: GaussianTransformBakeOptions = {},
): Promise<GaussianTransformBakeResult> {
  validateTransform(asset, transform);
  throwIfAborted(options.signal);
  const quaternion = quaternionFromEuler(transform.rotation);
  const rotateSh = asset.shBands > 0 && !isIdentityRotation(quaternion);
  const totalPasses = asset.position.keyframes.length
    + asset.rotation.keyframes.length
    + asset.scale.keyframes.length
    + (rotateSh ? 1 : 0);
  const context: BakeContext = {
    completedPointPasses: 0,
    lastYieldAt: now(),
    onProgress: options.onProgress,
    signal: options.signal,
    totalPointPasses: totalPasses * asset.splatCount,
  };
  const bounds = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number, number],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY] as [number, number, number],
  };
  await bakePosition(asset, transform, quaternion, context, bounds);
  await bakeRotation(asset, quaternion, context);
  await bakeScale(asset, transform.scale[0], context);
  if (rotateSh) await bakeSh(asset, quaternion, context);
  updateBounds(asset, bounds);
  options.onProgress?.({
    ratio: 1,
    stage: 'complete',
    processedPointPasses: context.totalPointPasses,
    totalPointPasses: context.totalPointPasses,
  });
  return {
    pointCount: asset.splatCount,
    positionKeyframes: asset.position.keyframes.length,
    rotationKeyframes: asset.rotation.keyframes.length,
    scaleKeyframes: asset.scale.keyframes.length,
    rotatedSh: rotateSh,
    shBands: asset.shBands,
  };
}

export function validateGaussianAssetTransformBake(
  asset: Raw4DAsset,
  transform: GaussianBakeTransform,
): void {
  validateTransform(asset, transform);
}

export function gaussianTransformBakeTrackCount(asset: Raw4DAsset, transform: GaussianBakeTransform): number {
  const quaternion = quaternionFromEuler(transform.rotation);
  return asset.position.keyframes.length
    + asset.rotation.keyframes.length
    + asset.scale.keyframes.length
    + (asset.shBands > 0 && !isIdentityRotation(quaternion) ? 1 : 0);
}
