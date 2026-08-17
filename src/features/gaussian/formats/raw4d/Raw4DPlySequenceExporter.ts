import { raw4DSequenceFrameRangeFromName } from './Raw4DSequence';
import type { Raw4DMemorySnapshot, Raw4DAsset, Raw4DTrack } from './Raw4DTypes';
import { decodeRaw4DArray, readRaw4DScalar } from './Raw4DValues';

// #WDD-gpt 2026-08-17 - 浏览器版 .ply 序列导出，语义对齐 py/export_raw4d_to_ply_frames.py：
// 逐帧插值（xyz 线性、WXYZ SLERP、DC 线性、log-scale 原值线性、logit 插值后 sigmoid×生命周期门
// 再回写 logit），输出标准静态 3DGS float32 PLY；编码器逐帧产出，由 Worker 直接写入用户选择的目录。

export interface Raw4DPlySequenceSegmentPlan {
  readonly name: string;
  readonly snapshotIndex: number;
  readonly firstFrame: number;
  readonly lastFrame: number;
}

export interface Raw4DPlySequenceFrameOutput {
  readonly filename: string;
  readonly header: Uint8Array<ArrayBuffer>;
  readonly rows: Uint8Array<ArrayBuffer>;
}

export interface Raw4DPlySequenceEncoder {
  readonly plans: readonly Raw4DPlySequenceSegmentPlan[];
  readonly frameCount: number;
  readonly deletedPointCount: number;
  encodeFrame(timelineFrame: number): Raw4DPlySequenceFrameOutput;
}

const OPACITY_LOGIT_EPSILON = 1e-6;

interface ExplicitFrameRange {
  readonly firstFrame: number;
  readonly lastFrame: number;
}

interface TrackSpan {
  readonly left: number;
  readonly right: number;
  readonly alpha: number;
}

function isDeleted(words: Uint32Array, stableId: number): boolean {
  return Boolean(words[stableId >>> 5] & (1 << (stableId & 31)));
}

// 与导入侧 buildRaw4DSequenceSegments 相同的排序与链接规则：文件名带源帧范围时按范围排序，
// 否则按快照顺序链接共享边界；单文件直接使用其源帧范围或从 0 开始。
export function planRaw4DPlySequenceSegments(
  snapshots: readonly Raw4DMemorySnapshot[],
): readonly Raw4DPlySequenceSegmentPlan[] {
  if (snapshots.length === 0) throw new Error('PLY 序列导出没有可用段落。');
  const ordered = snapshots.map((snapshot, index) => ({
    name: snapshot.name,
    snapshotIndex: index,
    totalFrames: snapshot.asset.totalFrames,
    range: raw4DSequenceFrameRangeFromName(snapshot.name) as ExplicitFrameRange | null,
    order: index,
  }));
  if (ordered.every((entry) => entry.range !== null)) {
    ordered.sort((a, b) => a.range!.firstFrame - b.range!.firstFrame || a.order - b.order);
  }
  const plans: Raw4DPlySequenceSegmentPlan[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const firstFrame = entry.range?.firstFrame ?? (index === 0 ? 0 : plans[index - 1].lastFrame);
    const lastFrame = entry.range?.lastFrame ?? firstFrame + entry.totalFrames - 1;
    if (lastFrame - firstFrame + 1 !== entry.totalFrames) {
      throw new Error(`${entry.name} 的文件名帧范围与 total_frames=${entry.totalFrames} 不一致。`);
    }
    if (index > 0 && firstFrame !== plans[index - 1].lastFrame) {
      throw new Error(`${plans[index - 1].name} 与 ${entry.name} 没有共享同一个首尾边界帧。`);
    }
    plans.push({ name: entry.name, snapshotIndex: entry.snapshotIndex, firstFrame, lastFrame });
  }
  return plans;
}

// 共享边界只输出一次，且由后一段 local=0 接管，与播放时间轴 locateRaw4DSequenceFrame 一致。
export function locateRaw4DPlySequenceFrame(
  plans: readonly Raw4DPlySequenceSegmentPlan[],
  timelineFrame: number,
): { readonly segmentIndex: number; readonly localFrame: number } {
  const firstFrame = plans[0].firstFrame;
  const lastFrame = plans[plans.length - 1].lastFrame;
  const sourceFrame = Math.max(firstFrame, Math.min(lastFrame, firstFrame + timelineFrame));
  let segmentIndex = 0;
  for (let index = 1; index < plans.length; index += 1) {
    if (plans[index].firstFrame <= sourceFrame) segmentIndex = index;
    else break;
  }
  const plan = plans[segmentIndex];
  return {
    segmentIndex,
    localFrame: Math.max(0, Math.min(plan.lastFrame - plan.firstFrame, sourceFrame - plan.firstFrame)),
  };
}

function trackSpan(track: Raw4DTrack, frame: number): TrackSpan {
  if (track.keyframes.length === 1 || frame <= track.keyframes[0]) {
    return { left: 0, right: 0, alpha: 0 };
  }
  const last = track.keyframes.length - 1;
  if (frame >= track.keyframes[last]) {
    return { left: last, right: last, alpha: 0 };
  }
  for (let right = 1; right < track.keyframes.length; right += 1) {
    if (frame <= track.keyframes[right]) {
      const left = right - 1;
      const alpha = (frame - track.keyframes[left]) / (track.keyframes[right] - track.keyframes[left]);
      return { left, right, alpha };
    }
  }
  return { left: last, right: last, alpha: 0 };
}

function stableSigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

// 与渲染路径 interpolateExtended 相同的 ±Infinity 约定：任一侧 -Infinity 直接饱和，
// 避免相反符号无穷 logits 插值产生 NaN。
function interpolateExtended(left: number, right: number, alpha: number): number {
  if (alpha <= 0 || left === right) return left;
  if (alpha >= 1) return right;
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    if (left === -Infinity || right === -Infinity) return -Infinity;
  }
  return left + (right - left) * alpha;
}

function interpolateLinear(left: number, right: number, alpha: number): number {
  return left + (right - left) * alpha;
}

function alphaToLogit(alpha: number): number {
  const guarded = Number.isFinite(alpha) ? alpha : 0;
  const clipped = Math.min(1 - OPACITY_LOGIT_EPSILON, Math.max(OPACITY_LOGIT_EPSILON, guarded));
  return Math.log(clipped / (1 - clipped));
}

function slerpWxyz(
  leftW: number, leftX: number, leftY: number, leftZ: number,
  rightW: number, rightX: number, rightY: number, rightZ: number,
  alpha: number,
): readonly [number, number, number, number] {
  const leftLength = Math.hypot(leftW, leftX, leftY, leftZ);
  let lw = leftW; let lx = leftX; let ly = leftY; let lz = leftZ;
  if (leftLength > 1e-12) {
    lw /= leftLength; lx /= leftLength; ly /= leftLength; lz /= leftLength;
  } else {
    lw = 1; lx = 0; ly = 0; lz = 0;
  }
  const rightLength = Math.hypot(rightW, rightX, rightY, rightZ);
  let rw = rightW; let rx = rightX; let ry = rightY; let rz = rightZ;
  if (rightLength > 1e-12) {
    rw /= rightLength; rx /= rightLength; ry /= rightLength; rz /= rightLength;
  } else {
    rw = lw; rx = lx; ry = ly; rz = lz;
  }
  let dot = lw * rw + lx * rx + ly * ry + lz * rz;
  if (dot < 0) {
    rw = -rw; rx = -rx; ry = -ry; rz = -rz;
    dot = -dot;
  }
  dot = Math.min(1, Math.max(-1, dot));
  let leftWeight: number;
  let rightWeight: number;
  if (dot > 0.9995) {
    leftWeight = 1 - alpha;
    rightWeight = alpha;
  } else {
    const theta = Math.acos(dot);
    const sine = Math.sin(theta);
    leftWeight = Math.sin((1 - alpha) * theta) / sine;
    rightWeight = Math.sin(alpha * theta) / sine;
  }
  let w = lw * leftWeight + rw * rightWeight;
  let x = lx * leftWeight + rx * rightWeight;
  let y = ly * leftWeight + ry * rightWeight;
  let z = lz * leftWeight + rz * rightWeight;
  const length = Math.hypot(w, x, y, z);
  if (length > 1e-12) {
    return [w / length, x / length, y / length, z / length];
  }
  return [1, 0, 0, 0];
}

interface PreparedSegment {
  readonly plan: Raw4DPlySequenceSegmentPlan;
  readonly asset: Raw4DAsset;
  readonly keptIds: Int32Array;
  readonly shRest: readonly Float32Array[];
  readonly view: DataView;
  readonly propertyCount: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

function prepareSegment(plan: Raw4DPlySequenceSegmentPlan, snapshot: Raw4DMemorySnapshot): PreparedSegment {
  const asset = snapshot.asset;
  const keptIds: number[] = [];
  for (let stableId = 0; stableId < asset.splatCount; stableId += 1) {
    if (!isDeleted(snapshot.deletionWords, stableId)) keptIds.push(stableId);
  }
  if (keptIds.length === 0) throw new Error(`${plan.name} 的全部高斯都被删除，无法生成 PLY 帧。`);
  const propertyCount = 17 + asset.shRest.length;
  const buffer = new ArrayBuffer(keptIds.length * propertyCount * Float32Array.BYTES_PER_ELEMENT);
  return {
    plan,
    asset,
    keptIds: Int32Array.from(keptIds),
    // SH 静态轨迹在段内逐帧重复写出，先解码成 float32 避免逐帧查 fp16 表。
    shRest: asset.shRest.map((values) => decodeRaw4DArray(values, asset.sourceEncoding)),
    view: new DataView(buffer),
    bytes: new Uint8Array(buffer),
    propertyCount,
  };
}

function plyHeaderLines(
  plan: Raw4DPlySequenceSegmentPlan,
  localFrame: number,
  globalFrame: number,
  keptCount: number,
  shCount: number,
): string {
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment source_raw4d ${plan.name}`,
    `comment local_frame ${localFrame}`,
    `comment global_frame ${globalFrame}`,
    `element vertex ${keptCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'property float f_dc_0',
    'property float f_dc_1',
    'property float f_dc_2',
  ];
  for (let coefficient = 0; coefficient < shCount; coefficient += 1) {
    lines.push(`property float f_rest_${coefficient}`);
  }
  lines.push(
    'property float opacity',
    'property float scale_0',
    'property float scale_1',
    'property float scale_2',
    'property float rot_0',
    'property float rot_1',
    'property float rot_2',
    'property float rot_3',
    'end_header',
  );
  return `${lines.join('\n')}\n`;
}

function writeFrameRows(segment: PreparedSegment, localFrame: number): void {
  const asset = segment.asset;
  const position = trackSpan(asset.position, localFrame);
  const rotation = trackSpan(asset.rotation, localFrame);
  const colorDc = trackSpan(asset.colorDc, localFrame);
  const scale = trackSpan(asset.scale, localFrame);
  const opacity = trackSpan(asset.opacity, localFrame);

  const positionLeft = position.left * asset.position.components;
  const positionRight = position.right * asset.position.components;
  const rotationLeft = rotation.left * asset.rotation.components;
  const rotationRight = rotation.right * asset.rotation.components;
  const dcLeft = colorDc.left * asset.colorDc.components;
  const dcRight = colorDc.right * asset.colorDc.components;
  const scaleLeft = scale.left * asset.scale.components;
  const scaleRight = scale.right * asset.scale.components;
  const shCount = asset.shRest.length;
  const view = segment.view;

  for (let row = 0; row < segment.keptIds.length; row += 1) {
    const id = segment.keptIds[row];
    let offset = row * segment.propertyCount * Float32Array.BYTES_PER_ELEMENT;

    for (let component = 0; component < 3; component += 1) {
      view.setFloat32(offset, interpolateLinear(
        readRaw4DScalar(asset.position.values[positionLeft + component], id, asset.position.encoding),
        readRaw4DScalar(asset.position.values[positionRight + component], id, asset.position.encoding),
        position.alpha,
      ), true);
      offset += 4;
    }
    offset += 12;
    for (let component = 0; component < 3; component += 1) {
      view.setFloat32(offset, interpolateLinear(
        readRaw4DScalar(asset.colorDc.values[dcLeft + component], id, asset.colorDc.encoding),
        readRaw4DScalar(asset.colorDc.values[dcRight + component], id, asset.colorDc.encoding),
        colorDc.alpha,
      ), true);
      offset += 4;
    }
    for (let coefficient = 0; coefficient < shCount; coefficient += 1) {
      view.setFloat32(offset, segment.shRest[coefficient][id], true);
      offset += 4;
    }

    const rawLogit = interpolateExtended(
      readRaw4DScalar(asset.opacity.values[opacity.left], id, asset.opacity.encoding),
      readRaw4DScalar(asset.opacity.values[opacity.right], id, asset.opacity.encoding),
      opacity.alpha,
    );
    const lifetimeMu = readRaw4DScalar(asset.lifetimeMu, id, asset.sourceEncoding);
    const lifetimeW = readRaw4DScalar(asset.lifetimeW, id, asset.sourceEncoding);
    const leftGate = stableSigmoid(10 * (localFrame - (lifetimeMu - lifetimeW)));
    const rightGate = stableSigmoid(10 * ((lifetimeMu + lifetimeW) - localFrame));
    view.setFloat32(offset, alphaToLogit(stableSigmoid(rawLogit) * leftGate * rightGate), true);
    offset += 4;

    for (let component = 0; component < 3; component += 1) {
      // Python 参考实现输出 raw log-scale；这里保持插值后的 log 值，不做 exp。
      view.setFloat32(offset, interpolateLinear(
        readRaw4DScalar(asset.scale.values[scaleLeft + component], id, asset.scale.encoding),
        readRaw4DScalar(asset.scale.values[scaleRight + component], id, asset.scale.encoding),
        scale.alpha,
      ), true);
      offset += 4;
    }

    const [qw, qx, qy, qz] = slerpWxyz(
      readRaw4DScalar(asset.rotation.values[rotationLeft], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationLeft + 1], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationLeft + 2], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationLeft + 3], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationRight], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationRight + 1], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationRight + 2], id, asset.rotation.encoding),
      readRaw4DScalar(asset.rotation.values[rotationRight + 3], id, asset.rotation.encoding),
      rotation.alpha,
    );
    view.setFloat32(offset, qw, true);
    view.setFloat32(offset + 4, qx, true);
    view.setFloat32(offset + 8, qy, true);
    view.setFloat32(offset + 12, qz, true);
  }
}

// 逐帧编码器：段落行缓冲按需分配并在切换段落后交给 GC，同一时段内最多驻留一份帧缓冲。
export function createRaw4DPlySequenceEncoder(
  snapshots: readonly Raw4DMemorySnapshot[],
): Raw4DPlySequenceEncoder {
  const plans = planRaw4DPlySequenceSegments(snapshots);
  const firstFrame = plans[0].firstFrame;
  const frameCount = plans[plans.length - 1].lastFrame - firstFrame + 1;
  let deletedPointCount = 0;
  for (const snapshot of snapshots) {
    for (let stableId = 0; stableId < snapshot.asset.splatCount; stableId += 1) {
      if (isDeleted(snapshot.deletionWords, stableId)) deletedPointCount += 1;
    }
  }

  let prepared: PreparedSegment | null = null;
  return {
    plans,
    frameCount,
    deletedPointCount,
    encodeFrame(timelineFrame: number): Raw4DPlySequenceFrameOutput {
      const clamped = Math.max(0, Math.min(frameCount - 1, Math.floor(timelineFrame)));
      const { segmentIndex, localFrame } = locateRaw4DPlySequenceFrame(plans, clamped);
      const plan = plans[segmentIndex];
      const globalFrame = plan.firstFrame + localFrame;
      if (!prepared || prepared.plan !== plan) {
        prepared = prepareSegment(plan, snapshots[plan.snapshotIndex]);
      }
      const segment = prepared;
      writeFrameRows(segment, localFrame);
      return {
        filename: `frame_${String(globalFrame).padStart(6, '0')}.ply`,
        header: new TextEncoder().encode(
          plyHeaderLines(plan, localFrame, globalFrame, segment.keptIds.length, segment.asset.shRest.length),
        ) as Uint8Array<ArrayBuffer>,
        rows: segment.bytes,
      };
    },
  };
}
