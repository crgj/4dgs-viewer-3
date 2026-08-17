import { FloatPacking } from 'playcanvas';
import type { Raw4DAsset, Raw4DBounds, Raw4DScalarArray, Raw4DTrack } from '../../features/gaussian/formats/raw4d/Raw4DTypes';
import { readRaw4DScalar } from '../../features/gaussian/formats/raw4d/Raw4DValues';

// #WDD-gpt 2026-08-17 - 健康修复只软删除所有透明度关键帧均精确为 -Infinity 的点；有限低透明度和证据不完整一律保留。

export type ModelHealthSeverity = 'warning' | 'error';
export interface ModelHealthIssue {
  readonly code: string;
  readonly count: number;
  readonly label: string;
  readonly severity: ModelHealthSeverity;
}
export interface ModelHealthReport {
  readonly checkedValues: number;
  readonly fixedValues: number;
  readonly healthy: boolean;
  readonly issues: readonly ModelHealthIssue[];
  readonly markedDeletedPoints: number;
  readonly safeDeletionCandidates: number;
}

export interface ModelHealthInspectOptions {
  readonly includeVisibility?: boolean;
  readonly isDeleted?: (stableId: number) => boolean;
}

function writeScalar(array: Raw4DScalarArray, index: number, encoding: 'float16' | 'float32', value: number): void {
  array[index] = encoding === 'float16' ? FloatPacking.float2Half(value) : value;
}

function inspectArray(
  array: Raw4DScalarArray,
  encoding: 'float16' | 'float32',
  replacement: (value: number, index: number) => number,
  repair: boolean,
  isValid: (value: number) => boolean = Number.isFinite,
): { checked: number; invalid: number; fixed: number } {
  let invalid = 0; let fixed = 0;
  for (let index = 0; index < array.length; index += 1) {
    const value = readRaw4DScalar(array, index, encoding);
    if (isValid(value)) continue;
    invalid += 1;
    if (repair) { writeScalar(array, index, encoding, replacement(value, index)); fixed += 1; }
  }
  return { checked: array.length, invalid, fixed };
}

function hasCompleteVisibilityEvidence(asset: Raw4DAsset, stableId: number): boolean {
  if (!Number.isInteger(asset.totalFrames) || asset.totalFrames <= 0) return false;
  const mu = readRaw4DScalar(asset.lifetimeMu, stableId, asset.sourceEncoding);
  const width = readRaw4DScalar(asset.lifetimeW, stableId, asset.sourceEncoding);
  if (!Number.isFinite(mu) || !Number.isFinite(width) || width < 0) return false;
  if (
    asset.opacity.components !== 1
    || asset.opacity.keyframes.length === 0
    || asset.opacity.values.length !== asset.opacity.keyframes.length
  ) return false;
  for (let key = 0; key < asset.opacity.keyframes.length; key += 1) {
    const frame = asset.opacity.keyframes[key];
    if (!Number.isFinite(frame) || (key > 0 && frame <= asset.opacity.keyframes[key - 1])) return false;
  }
  for (const values of asset.opacity.values) {
    const value = stableId < values.length
      ? readRaw4DScalar(values, stableId, asset.opacity.encoding)
      : Number.NaN;
    if (!Number.isFinite(value) && value !== Number.NEGATIVE_INFINITY) {
      return false;
    }
  }
  return true;
}

/**
 * Returns only points whose opacity Logit is exactly -Infinity at every keyframe. The renderer preserves
 * -Infinity through its extended interpolation and maps sigmoid(-Infinity) to exact zero, so these points
 * cannot contribute at any playback frame. Finite low opacity, camera occlusion, frustum, scale and a
 * temporary lifetime gate are deliberately not accepted as deletion evidence.
 */
export function findCompletelyInvisibleStableIds(
  asset: Raw4DAsset,
  options: ModelHealthInspectOptions = {},
): number[] {
  if (!Number.isInteger(asset.totalFrames) || asset.totalFrames <= 0 || asset.opacity.keyframes.length === 0) return [];
  const invisible: number[] = [];
  for (let stableId = 0; stableId < asset.splatCount; stableId += 1) {
    if (options.isDeleted?.(stableId) || !hasCompleteVisibilityEvidence(asset, stableId)) continue;
    const allOpacityKeysAreNegativeInfinity = asset.opacity.values.every((values) => (
      readRaw4DScalar(values, stableId, asset.opacity.encoding) === Number.NEGATIVE_INFINITY
    ));
    if (allOpacityKeysAreNegativeInfinity) invisible.push(stableId);
  }
  return invisible;
}

function nearestFiniteTrackValue(track: Raw4DTrack, valueIndex: number, stableId: number): number | null {
  const component = valueIndex % track.components;
  const key = Math.floor(valueIndex / track.components);
  for (let distance = 1; distance < track.keyframes.length; distance += 1) {
    for (const candidateKey of [key - distance, key + distance]) {
      if (candidateKey < 0 || candidateKey >= track.keyframes.length) continue;
      const candidate = readRaw4DScalar(
        track.values[candidateKey * track.components + component],
        stableId,
        track.encoding,
      );
      if (Number.isFinite(candidate)) return candidate;
    }
  }
  return null;
}

function calculateModelBounds(position: Raw4DTrack): Raw4DBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let key = 0; key < position.keyframes.length; key += 1) {
    const offset = key * position.components;
    const x = position.values[offset];
    const y = position.values[offset + 1];
    const z = position.values[offset + 2];
    if (!x || !y || !z) continue;
    const count = Math.min(x.length, y.length, z.length);
    for (let stableId = 0; stableId < count; stableId += 1) {
      const px = readRaw4DScalar(x, stableId, position.encoding);
      const py = readRaw4DScalar(y, stableId, position.encoding);
      const pz = readRaw4DScalar(z, stableId, position.encoding);
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
      minX = Math.min(minX, px); minY = Math.min(minY, py); minZ = Math.min(minZ, pz);
      maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); maxZ = Math.max(maxZ, pz);
    }
  }
  if (!Number.isFinite(minX)) return { min: [-1, -1, -1], max: [1, 1, 1] };
  const epsilon = 1e-4;
  return {
    min: [minX, minY, minZ],
    max: [Math.max(maxX, minX + epsilon), Math.max(maxY, minY + epsilon), Math.max(maxZ, minZ + epsilon)],
  };
}

function nonFiniteTrackReplacement(
  track: Raw4DTrack,
  valueIndex: number,
  stableId: number,
  value: number,
  fallback: number,
  range?: readonly [number, number],
): number {
  if (value === Number.POSITIVE_INFINITY && range) return range[1];
  if (value === Number.NEGATIVE_INFINITY && range) return range[0];
  return nearestFiniteTrackValue(track, valueIndex, stableId) ?? fallback;
}

export function inspectGaussianModel(
  asset: Raw4DAsset,
  repair = false,
  options: ModelHealthInspectOptions = {},
): ModelHealthReport {
  const counts = new Map<string, { count: number; label: string; severity: ModelHealthSeverity }>();
  let checkedValues = 0;
  let fixedValues = 0;
  const add = (code: string, count: number, label: string, severity: ModelHealthSeverity) => {
    if (count > 0) counts.set(code, { count, label, severity });
  };
  const tracks: Array<[string, Raw4DTrack, number, (readonly [number, number])?]> = [
    ['position', asset.position, 0], ['rotation', asset.rotation, 0], ['color', asset.colorDc, 0],
    ['scale', asset.scale, 0, [-20, 10]], ['opacity', asset.opacity, 0, [-20, 20]],
  ];
  for (const [name, track, fallback, range] of tracks) {
    let invalid = 0;
    for (let valueIndex = 0; valueIndex < track.values.length; valueIndex += 1) {
      const values = track.values[valueIndex];
      const component = valueIndex % track.components;
      const componentFallback = name === 'rotation' && component === 0 ? 1 : fallback;
      const result = inspectArray(values, track.encoding, (value, stableId) => (
        // #WDD-gpt 2026-08-16 - NaN 透明度没有可推断语义，回退中性可见值，禁止修复本身制造后续删除候选。
        name === 'opacity' && Number.isNaN(value)
          ? 0
          : nonFiniteTrackReplacement(track, valueIndex, stableId, value, componentFallback, range)
      ), repair, (value) => Number.isFinite(value) || (
        name === 'opacity' && value === Number.NEGATIVE_INFINITY
      ));
      checkedValues += result.checked; invalid += result.invalid; fixedValues += result.fixed;
    }
    add(`nonfinite-${name}`, invalid, `${name} 包含非有限数值`, 'error');
  }
  let invalidSh = 0;
  for (const values of asset.shRest) {
    const result = inspectArray(values, asset.sourceEncoding, () => 0, repair);
    checkedValues += result.checked; invalidSh += result.invalid; fixedValues += result.fixed;
  }
  add('nonfinite-sh', invalidSh, 'SH 系数包含非有限数值', 'error');

  let quaternionIssues = 0;
  for (let key = 0; key < asset.rotation.keyframes.length; key += 1) {
    const arrays = asset.rotation.values.slice(key * 4, key * 4 + 4);
    for (let index = 0; index < asset.splatCount; index += 1) {
      let w = readRaw4DScalar(arrays[0], index, asset.rotation.encoding);
      let x = readRaw4DScalar(arrays[1], index, asset.rotation.encoding);
      let y = readRaw4DScalar(arrays[2], index, asset.rotation.encoding);
      let z = readRaw4DScalar(arrays[3], index, asset.rotation.encoding);
      const length = Math.hypot(w, x, y, z);
      if (Number.isFinite(length) && Math.abs(length - 1) <= 0.02) continue;
      quaternionIssues += 1;
      if (repair) {
        if (!Number.isFinite(length) || length < 1e-8) { w = 1; x = 0; y = 0; z = 0; }
        else { w /= length; x /= length; y /= length; z /= length; }
        [w, x, y, z].forEach((value, component) => writeScalar(arrays[component], index, asset.rotation.encoding, value));
        fixedValues += 4;
      }
    }
  }
  checkedValues += asset.splatCount * asset.rotation.keyframes.length;
  add('quaternion', quaternionIssues, '旋转四元数未归一化', 'warning');

  let clampedScale = 0; let clampedOpacity = 0;
  for (const values of asset.scale.values) {
    for (let index = 0; index < values.length; index += 1) {
      const value = readRaw4DScalar(values, index, asset.scale.encoding);
      const safe = Math.max(-20, Math.min(10, value));
      if (safe === value) continue;
      clampedScale += 1;
      if (repair) { writeScalar(values, index, asset.scale.encoding, safe); fixedValues += 1; }
    }
  }
  for (const values of asset.opacity.values) {
    for (let index = 0; index < values.length; index += 1) {
      const value = readRaw4DScalar(values, index, asset.opacity.encoding);
      if (value === Number.NEGATIVE_INFINITY || !Number.isFinite(value)) continue;
      const safe = Math.max(-20, Math.min(20, value));
      if (safe === value) continue;
      clampedOpacity += 1;
      if (repair) { writeScalar(values, index, asset.opacity.encoding, safe); fixedValues += 1; }
    }
  }
  add('scale-range', clampedScale, '缩放超出安全对数范围', 'warning');
  add('opacity-range', clampedOpacity, '透明度超出安全 Logit 范围', 'warning');

  let lifetimeIssues = 0;
  for (let index = 0; index < asset.splatCount; index += 1) {
    const mu = readRaw4DScalar(asset.lifetimeMu, index, asset.sourceEncoding);
    const width = readRaw4DScalar(asset.lifetimeW, index, asset.sourceEncoding);
    if (Number.isFinite(mu) && Number.isFinite(width) && width >= 0) continue;
    lifetimeIssues += 1;
    if (repair) {
      writeScalar(asset.lifetimeMu, index, asset.sourceEncoding, Number.isFinite(mu) ? mu : (asset.totalFrames - 1) / 2);
      writeScalar(asset.lifetimeW, index, asset.sourceEncoding, Number.isFinite(width) ? Math.abs(width) : asset.totalFrames);
      fixedValues += 2;
    }
  }
  checkedValues += asset.splatCount * 2;
  add('lifetime', lifetimeIssues, '生命周期范围无效', 'error');

  const safeDeletionCandidates = options.includeVisibility === false
    ? 0
    : findCompletelyInvisibleStableIds(asset, options).length;
  if (repair) {
    // #WDD-gpt 2026-08-16 - 包围盒必须解码 FP16 并覆盖全部位置关键帧，否则后续动画帧会被错误视锥裁剪。
    const bounds = calculateModelBounds(asset.position);
    (asset as unknown as { bounds: Raw4DBounds }).bounds = bounds;
  }
  const issues = [...counts.entries()].map(([code, issue]) => ({ code, ...issue }));
  return {
    checkedValues,
    fixedValues,
    healthy: issues.length === 0,
    issues,
    markedDeletedPoints: 0,
    safeDeletionCandidates,
  };
}
