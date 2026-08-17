import { describe, expect, it } from 'vitest';
import {
  createRaw4DPlySequenceEncoder,
  locateRaw4DPlySequenceFrame,
  planRaw4DPlySequenceSegments,
} from './Raw4DPlySequenceExporter';
import type { Raw4DMemorySnapshot, Raw4DAsset, Raw4DScalarArray, Raw4DTrack } from './Raw4DTypes';

// banks[bank][point][component]；关键帧固定为 frames 0 与 2，frame 1 处于中点插值。
function bankTrack(
  components: number,
  banks: readonly (readonly (readonly number[])[])[],
): Raw4DTrack {
  const values: Raw4DScalarArray[] = [];
  for (const bank of banks) {
    for (let component = 0; component < components; component += 1) {
      values.push(Float32Array.from(bank.map((point) => point[component])));
    }
  }
  return { encoding: 'float32', components, keyframes: [0, 2], values };
}

interface TestAssetOptions {
  readonly name: string;
  readonly position: readonly (readonly (readonly number[])[])[];
  readonly rotation: readonly (readonly (readonly number[])[])[];
  readonly dc: readonly (readonly (readonly number[])[])[];
  readonly scale: readonly (readonly (readonly number[])[])[];
  readonly opacity: readonly (readonly (readonly number[])[])[];
  readonly lifetimeMu: readonly number[];
  readonly lifetimeW: readonly number[];
  readonly shRest: readonly (readonly number[])[];
}

function makeTestAsset(options: TestAssetOptions): Raw4DAsset {
  const pointCount = options.lifetimeMu.length;
  return {
    sourceName: options.name,
    sourceEncoding: 'float32',
    splatCount: pointCount,
    totalFrames: 3,
    shBands: 1,
    position: bankTrack(3, options.position),
    rotation: bankTrack(4, options.rotation),
    colorDc: bankTrack(3, options.dc),
    scale: bankTrack(3, options.scale),
    opacity: bankTrack(1, options.opacity),
    shRest: options.shRest.map((coefficients) => Float32Array.from(coefficients)),
    lifetimeMu: Float32Array.from(options.lifetimeMu),
    lifetimeW: Float32Array.from(options.lifetimeW),
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  };
}

function singlePointAsset(name: string, overrides: Partial<TestAssetOptions> = {}): Raw4DAsset {
  return makeTestAsset({
    name,
    position: [[[0, 10, 20]], [[2, 10, 22]]],
    rotation: [[[2, 0, 0, 0]], [[2, 0, 2, 0]]],
    dc: [[[0.1, 0.2, 0.3]], [[0.3, 0.2, 0.1]]],
    scale: [[[Math.log(0.5), 0, Math.log(2)]], [[0, 0, Math.log(2)]]],
    opacity: [[[0]], [[2]]],
    lifetimeMu: [1],
    lifetimeW: [100],
    shRest: [[1], [2], [3], [4], [5], [6], [7], [8], [9]],
    ...overrides,
  });
}

function makeSnapshot(name: string, asset: Raw4DAsset, deletedStableIds: readonly number[] = []): Raw4DMemorySnapshot {
  const words = new Uint32Array(Math.ceil((asset.splatCount + 31) / 32));
  for (const id of deletedStableIds) words[id >>> 5] |= 1 << (id & 31);
  return { name, asset, deletionWords: words };
}

const PROPERTY_COUNT = 26;

interface ParsedPlyFrame {
  readonly filename: string;
  readonly headerLines: readonly string[];
  readonly view: DataView;
}

function readFrame(
  snapshots: readonly Raw4DMemorySnapshot[],
  timelineFrame: number,
): ParsedPlyFrame {
  const encoder = createRaw4DPlySequenceEncoder(snapshots);
  const frame = encoder.encodeFrame(timelineFrame);
  const text = new TextDecoder('ascii').decode(frame.header);
  const headerLines = text.split('\n');
  if (!headerLines.includes('end_header')) throw new Error('PLY 头部缺少 end_header。');
  return {
    filename: frame.filename,
    headerLines,
    view: new DataView(frame.rows.buffer, frame.rows.byteOffset, frame.rows.byteLength),
  };
}

function row(ply: ParsedPlyFrame, index: number, offset: number): number {
  return ply.view.getFloat32(index * PROPERTY_COUNT * 4 + offset * 4, true);
}

describe('Raw4DPlySequenceExporter timeline planning', () => {
  it('uses filename source ranges for global frame numbering', () => {
    const plans = planRaw4DPlySequenceSegments([
      makeSnapshot('segment_30_32.raw4d', singlePointAsset('segment_30_32.raw4d')),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].firstFrame).toBe(30);
    expect(plans[0].lastFrame).toBe(32);
  });

  it('sorts explicit-range segments and merges shared boundaries', () => {
    const a = makeSnapshot('segment_0_2.raw4d', singlePointAsset('segment_0_2.raw4d'));
    const b = makeSnapshot('segment_2_4.raw4d', singlePointAsset('segment_2_4.raw4d'));
    const plans = planRaw4DPlySequenceSegments([b, a]);
    expect(plans.map((plan) => plan.name)).toEqual(['segment_0_2.raw4d', 'segment_2_4.raw4d']);
    expect(plans.map((plan) => plan.firstFrame)).toEqual([0, 2]);
  });

  it('chains drag order when filenames carry no range', () => {
    const a = makeSnapshot('left.raw4d', singlePointAsset('left.raw4d'));
    const b = makeSnapshot('right.raw4d', singlePointAsset('right.raw4d'));
    const plans = planRaw4DPlySequenceSegments([a, b]);
    expect(plans.map((plan) => plan.firstFrame)).toEqual([0, 2]);
    expect(plans.map((plan) => plan.lastFrame)).toEqual([2, 4]);
  });

  it('rejects filename ranges inconsistent with total_frames', () => {
    const a = makeSnapshot('segment_0_9.raw4d', singlePointAsset('segment_0_9.raw4d'));
    expect(() => planRaw4DPlySequenceSegments([a])).toThrow(/帧范围与 total_frames/);
  });

  it('rejects segments without a shared boundary frame', () => {
    const a = makeSnapshot('segment_0_2.raw4d', singlePointAsset('segment_0_2.raw4d'));
    const b = makeSnapshot('segment_4_6.raw4d', singlePointAsset('segment_4_6.raw4d'));
    expect(() => planRaw4DPlySequenceSegments([a, b])).toThrow(/共享同一个首尾边界帧/);
  });

  it('hands the shared boundary frame to the later segment', () => {
    const a = makeSnapshot('segment_0_2.raw4d', singlePointAsset('segment_0_2.raw4d'));
    const b = makeSnapshot('segment_2_4.raw4d', singlePointAsset('segment_2_4.raw4d'));
    const plans = planRaw4DPlySequenceSegments([a, b]);
    expect(locateRaw4DPlySequenceFrame(plans, 2)).toEqual({ segmentIndex: 1, localFrame: 0 });
    expect(locateRaw4DPlySequenceFrame(plans, 1)).toEqual({ segmentIndex: 0, localFrame: 1 });
    expect(locateRaw4DPlySequenceFrame(plans, 4)).toEqual({ segmentIndex: 1, localFrame: 2 });
  });
});

describe('Raw4DPlySequenceExporter frame encoding', () => {
  const singleSnapshot = () => [makeSnapshot('segment_0_2.raw4d', singlePointAsset('segment_0_2.raw4d'))];

  it('writes a standard 3DGS PLY with Python-reference interpolation semantics', () => {
    const encoder = createRaw4DPlySequenceEncoder(singleSnapshot());
    expect(encoder.frameCount).toBe(3);
    expect(encoder.deletedPointCount).toBe(0);
    const midFrame = readFrame(singleSnapshot(), 1);
    expect(midFrame.filename).toBe('frame_000001.ply');
    expect(midFrame.headerLines).toContain('format binary_little_endian 1.0');
    expect(midFrame.headerLines).toContain('comment source_raw4d segment_0_2.raw4d');
    expect(midFrame.headerLines).toContain('comment local_frame 1');
    expect(midFrame.headerLines).toContain('comment global_frame 1');
    expect(midFrame.headerLines).toContain('element vertex 1');
    expect(midFrame.headerLines.indexOf('property float f_dc_2')).toBeLessThan(midFrame.headerLines.indexOf('property float f_rest_0'));
    expect(midFrame.headerLines.indexOf('property float f_rest_8')).toBeLessThan(midFrame.headerLines.indexOf('property float opacity'));
    expect(midFrame.headerLines.indexOf('property float scale_2')).toBeLessThan(midFrame.headerLines.indexOf('property float rot_0'));

    expect(row(midFrame, 0, 0)).toBeCloseTo(1, 5);
    expect(row(midFrame, 0, 1)).toBeCloseTo(10, 5);
    expect(row(midFrame, 0, 2)).toBeCloseTo(21, 5);
    expect(row(midFrame, 0, 3)).toBe(0);
    expect(row(midFrame, 0, 4)).toBe(0);
    expect(row(midFrame, 0, 5)).toBe(0);
    expect(row(midFrame, 0, 6)).toBeCloseTo(0.2, 5);
    expect(row(midFrame, 0, 7)).toBeCloseTo(0.2, 5);
    expect(row(midFrame, 0, 8)).toBeCloseTo(0.2, 5);
    for (let coefficient = 0; coefficient < 9; coefficient += 1) {
      expect(row(midFrame, 0, 9 + coefficient)).toBeCloseTo(coefficient + 1, 5);
    }
    // 宽生命周期门在 frame 1 近似为 1，opacity 即插值 logit 的恒等回写。
    expect(row(midFrame, 0, 18)).toBeCloseTo(1, 5);
    // Python 参考输出 raw log-scale：中点插值保持 log 值，不做 exp。
    expect(row(midFrame, 0, 19)).toBeCloseTo(Math.log(0.5) / 2, 5);
    expect(row(midFrame, 0, 20)).toBeCloseTo(0, 5);
    expect(row(midFrame, 0, 21)).toBeCloseTo(Math.log(2), 5);
    const halfAngle = Math.PI / 8;
    expect(row(midFrame, 0, 22)).toBeCloseTo(Math.cos(halfAngle), 5);
    expect(row(midFrame, 0, 23)).toBeCloseTo(0, 5);
    expect(row(midFrame, 0, 24)).toBeCloseTo(Math.sin(halfAngle), 5);
    expect(row(midFrame, 0, 25)).toBeCloseTo(0, 5);
  });

  it('keeps keyframe frames exact and applies the lifetime gate before writing logits', () => {
    const snapshots = [makeSnapshot('a.raw4d', singlePointAsset('a.raw4d', { lifetimeMu: [0], lifetimeW: [0] }))];

    const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
    const alphaAt = (logit: number, frame: number) => (
      sigmoid(logit) * sigmoid(10 * (frame - 0)) * sigmoid(10 * (0 - frame))
    );
    const logitOf = (alpha: number) => {
      const clipped = Math.min(1 - 1e-6, Math.max(1e-6, alpha));
      return Math.log(clipped / (1 - clipped));
    };

    const frame0 = readFrame(snapshots, 0);
    expect(frame0.filename).toBe('frame_000000.ply');
    expect(row(frame0, 0, 0)).toBe(0);
    expect(row(frame0, 0, 18)).toBeCloseTo(logitOf(alphaAt(0, 0)), 4);

    const frame1 = readFrame(snapshots, 1);
    expect(row(frame1, 0, 18)).toBeCloseTo(logitOf(alphaAt(1, 1)), 4);

    const frame2 = readFrame(snapshots, 2);
    expect(frame2.filename).toBe('frame_000002.ply');
    expect(row(frame2, 0, 0)).toBe(2);
    expect(row(frame2, 0, 2)).toBe(22);
    expect(row(frame2, 0, 18)).toBeCloseTo(Math.log(1e-6), 4);
  });

  it('compacts deleted points per segment and numbers frames across the merged timeline', () => {
    const first = makeTestAsset({
      name: 'segment_0_2.raw4d',
      position: [[[100, 0, 0], [200, 0, 0]], [[104, 0, 0], [208, 0, 0]]],
      rotation: [[[1, 0, 0, 0], [1, 0, 0, 0]], [[1, 0, 0, 0], [1, 0, 0, 0]]],
      dc: [[[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 0]]],
      scale: [[[0, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 0]]],
      opacity: [[[0], [0]], [[0], [0]]],
      lifetimeMu: [1, 1],
      lifetimeW: [100, 100],
      shRest: [[1, 9], [2, 8], [3, 7], [4, 6], [5, 5], [6, 4], [7, 3], [8, 2], [9, 1]],
    });
    const second = singlePointAsset('segment_2_4.raw4d', {
      position: [[[1000, 7, 7]], [[1002, 7, 7]]],
      opacity: [[[0]], [[0]]],
    });
    const snapshots = [
      makeSnapshot('segment_0_2.raw4d', first, [1]),
      makeSnapshot('segment_2_4.raw4d', second),
    ];
    const encoder = createRaw4DPlySequenceEncoder(snapshots);
    expect(encoder.frameCount).toBe(5);
    expect(encoder.deletedPointCount).toBe(1);
    expect(encoder.plans).toHaveLength(2);

    const keptFrame = readFrame(snapshots, 1);
    expect(keptFrame.filename).toBe('frame_000001.ply');
    expect(keptFrame.headerLines).toContain('element vertex 1');
    expect(row(keptFrame, 0, 0)).toBeCloseTo(102, 5);

    const boundary = readFrame(snapshots, 2);
    expect(boundary.filename).toBe('frame_000002.ply');
    expect(boundary.headerLines).toContain('comment source_raw4d segment_2_4.raw4d');
    expect(boundary.headerLines).toContain('comment local_frame 0');
    expect(row(boundary, 0, 0)).toBe(1000);

    const midSecond = readFrame(snapshots, 3);
    expect(midSecond.filename).toBe('frame_000003.ply');
    expect(row(midSecond, 0, 0)).toBeCloseTo(1001, 5);

    const last = readFrame(snapshots, 4);
    expect(last.filename).toBe('frame_000004.ply');
    expect(last.headerLines).toContain('comment local_frame 2');
    expect(row(last, 0, 0)).toBe(1002);
  });

  it('exposes frame byte sizes for directory writing', () => {
    const snapshots = [makeSnapshot('segment_5_7.raw4d', singlePointAsset('segment_5_7.raw4d'))];
    const encoder = createRaw4DPlySequenceEncoder(snapshots);
    expect(encoder.frameCount).toBe(3);
    const first = encoder.encodeFrame(0);
    expect(first.filename).toBe('frame_000005.ply');
    expect(first.header.length).toBeGreaterThan(0);
    expect(first.rows.byteLength).toBe(1 * PROPERTY_COUNT * 4);
    const second = encoder.encodeFrame(1);
    expect(second.filename).toBe('frame_000006.ply');
  });

  it('rejects segments whose every point is deleted', () => {
    const snapshots = [makeSnapshot('segment_0_2.raw4d', singlePointAsset('segment_0_2.raw4d'), [0])];
    expect(() => createRaw4DPlySequenceEncoder(snapshots).encodeFrame(0)).toThrow(/全部高斯都被删除/);
  });
});
