import type { Raw4DHeader } from './Raw4DTypes';
import {
  RAW4D_TRACK_DEFINITIONS,
  raw4DBankCount,
  raw4DCanonicalKeyframes,
  raw4DTrackStride,
  type Raw4DTrackDefinition,
} from './Raw4DSchema';
import type {
  Raw4DSequenceBoundaryMatchWork,
  Raw4DSequenceExtractedSegment,
  Raw4DSequenceFrameLocation,
  Raw4DSequenceSegment,
} from './Raw4DSequenceTypes';

interface Raw4DSequenceSourceInfo {
  readonly fileIndex: number;
  readonly name: string;
  readonly header: Raw4DHeader;
}

interface ExplicitFrameRange {
  readonly firstFrame: number;
  readonly lastFrame: number;
}

function shBandsFromCount(count: number): number {
  const bands = new Map([[0, 0], [9, 1], [24, 2], [45, 3]]).get(count);
  if (bands === undefined) throw new Error(`不支持 ${count} 个 RAW4D SH 系数。`);
  return bands;
}

export function raw4DSequenceFrameRangeFromName(name: string): ExplicitFrameRange | null {
  const stem = name.replace(/\.(?:raw4d|ply4)$/i, '');
  const matches = [...stem.matchAll(/(?:^|[^0-9])(\d+)[_-](\d+)(?=$|[^0-9])/g)];
  const match = matches.at(-1);
  if (!match) return null;
  const firstFrame = Number(match[1]);
  const lastFrame = Number(match[2]);
  return Number.isSafeInteger(firstFrame) && Number.isSafeInteger(lastFrame) && lastFrame >= firstFrame
    ? { firstFrame, lastFrame }
    : null;
}

function shCoefficientCount(header: Raw4DHeader): number {
  const indices = header.propertyNames
    .map((name) => /^f_rest_(\d+)$/.exec(name))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
  if (indices.some((value, index) => value !== index)) {
    throw new Error('RAW4D SH 属性必须从 f_rest_0 连续排列。');
  }
  shBandsFromCount(indices.length);
  return indices.length;
}

function trackKeyframes(header: Raw4DHeader, definition: Raw4DTrackDefinition): number[] {
  const bankCount = raw4DBankCount(header.propertyNames, definition);
  if (bankCount === 0) return [0];
  return raw4DCanonicalKeyframes(header.totalFrames, raw4DTrackStride(header.comments, definition), bankCount);
}

// #WDD-gpt 2026-08-16 - 多段 RAW4D 优先使用文件名源帧范围；无范围时才按拖入顺序建立共享边界时间轴。
export function buildRaw4DSequenceSegments(sources: readonly Raw4DSequenceSourceInfo[]): Raw4DSequenceSegment[] {
  if (sources.length < 2) throw new Error('RAW4D 多段序列至少需要两个文件。');
  const explicit = sources.map((source) => raw4DSequenceFrameRangeFromName(source.name));
  const ordered = sources.map((source, index) => ({ source, range: explicit[index], order: index }));
  if (explicit.every((range) => range !== null)) {
    ordered.sort((a, b) => a.range!.firstFrame - b.range!.firstFrame || a.order - b.order);
  }

  const segments: Raw4DSequenceSegment[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const { source, range } = ordered[index];
    const firstFrame = range?.firstFrame ?? (index === 0 ? 0 : segments[index - 1].lastFrame);
    const lastFrame = range?.lastFrame ?? firstFrame + source.header.totalFrames - 1;
    if (lastFrame - firstFrame + 1 !== source.header.totalFrames) {
      throw new Error(`${source.name} 的文件名帧范围与 total_frames=${source.header.totalFrames} 不一致。`);
    }
    if (index > 0 && firstFrame !== segments[index - 1].lastFrame) {
      throw new Error(`${segments[index - 1].name} 与 ${source.name} 没有共享同一个首尾边界帧。`);
    }
    const coefficientCount = shCoefficientCount(source.header);
    segments.push({
      fileIndex: source.fileIndex,
      name: source.name,
      firstFrame,
      lastFrame,
      totalFrames: source.header.totalFrames,
      splatCount: source.header.vertexCount,
      shBands: shBandsFromCount(coefficientCount),
      shCoefficientCount: coefficientCount,
      keyframes: {
        position: trackKeyframes(source.header, RAW4D_TRACK_DEFINITIONS.position),
        rotation: trackKeyframes(source.header, RAW4D_TRACK_DEFINITIONS.rotation),
        colorDc: trackKeyframes(source.header, RAW4D_TRACK_DEFINITIONS.colorDc),
        scale: trackKeyframes(source.header, RAW4D_TRACK_DEFINITIONS.scale),
        opacity: trackKeyframes(source.header, RAW4D_TRACK_DEFINITIONS.opacity),
      },
    });
  }
  const first = segments[0];
  for (const segment of segments.slice(1)) {
    if (segment.shCoefficientCount !== first.shCoefficientCount) {
      throw new Error(`${segment.name} 的 SH 阶数与 ${first.name} 不一致。`);
    }
    const header = sources.find((source) => source.fileIndex === segment.fileIndex)!.header;
    if (header.scalarEncoding !== sources.find((source) => source.fileIndex === first.fileIndex)!.header.scalarEncoding) {
      throw new Error(`${segment.name} 的标量位宽与 ${first.name} 不一致。`);
    }
  }
  return segments;
}

// #WDD-gpt 2026-08-16 - 共享边界只显示一次，并由后一段 local=0 接管，避免播放时重复一帧。
export function locateRaw4DSequenceFrame(
  segments: readonly Raw4DSequenceSegment[],
  globalFrame: number,
): Raw4DSequenceFrameLocation {
  if (segments.length === 0) throw new Error('RAW4D 序列没有时间段。');
  const firstFrame = segments[0].firstFrame;
  const lastFrame = segments.at(-1)!.lastFrame;
  // #WDD-gpt 2026-08-16 - Master PLY4 时间是浮点帧索引；多段定位不再先四舍五入破坏段内插值。
  const sourceFrame = Math.max(firstFrame, Math.min(lastFrame, firstFrame + globalFrame));
  let segmentIndex = 0;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].firstFrame <= sourceFrame) segmentIndex = index;
    else break;
  }
  const segment = segments[segmentIndex];
  return {
    segmentIndex,
    localFrame: Math.max(0, Math.min(segment.totalFrames - 1, sourceFrame - segment.firstFrame)),
    sourceFrame,
  };
}

function positionKey(segment: Raw4DSequenceExtractedSegment, bits: Uint32Array, local: number): number | string {
  const offset = local * 3;
  if (segment.encoding === 'float16') {
    return bits[offset] * 4_294_967_296 + bits[offset + 1] * 65_536 + bits[offset + 2];
  }
  return `${bits[offset]}:${bits[offset + 1]}:${bits[offset + 2]}`;
}

function equalSh(previous: Raw4DSequenceExtractedSegment, previousLocal: number, current: Raw4DSequenceExtractedSegment, currentLocal: number): boolean {
  const count = previous.shCoefficientCount;
  const previousOffset = previousLocal * count;
  const currentOffset = currentLocal * count;
  for (let coefficient = 0; coefficient < count; coefficient += 1) {
    if (previous.shBits[previousOffset + coefficient] !== current.shBits[currentOffset + coefficient]) return false;
  }
  return true;
}

function tieScore(previous: Raw4DSequenceExtractedSegment, previousLocal: number, current: Raw4DSequenceExtractedSegment, currentLocal: number): number {
  let score = 0;
  const count = previous.shCoefficientCount;
  const previousSh = previousLocal * count;
  const currentSh = currentLocal * count;
  for (let coefficient = 0; coefficient < count; coefficient += 1) {
    if (previous.shBits[previousSh + coefficient] === current.shBits[currentSh + coefficient]) score += 4;
  }
  const previousDc = previousLocal * 3;
  const currentDc = currentLocal * 3;
  for (let component = 0; component < 3; component += 1) {
    if (previous.lastColorDcBits[previousDc + component] === current.firstColorDcBits[currentDc + component]) score += 2;
  }
  return score;
}

// #WDD-gpt 2026-08-16 - 边界位置按源标量位模式精确续接；重复位置用 SH/DC 全位比较消歧并统计 SH 轨迹更新。
export function matchRaw4DSequenceBoundary(
  previous: Raw4DSequenceExtractedSegment,
  previousTrackMap: Int32Array,
  current: Raw4DSequenceExtractedSegment,
  firstNewTrackId: number,
): Raw4DSequenceBoundaryMatchWork {
  if (previous.encoding !== current.encoding || previous.shCoefficientCount !== current.shCoefficientCount) {
    throw new Error('RAW4D 边界的标量位宽或 SH 布局不兼容。');
  }
  if (previousTrackMap.length !== previous.count) throw new Error('RAW4D 上一段 Track Map 长度无效。');
  const buckets = new Map<number | string, number[]>();
  for (let local = 0; local < previous.count; local += 1) {
    const key = positionKey(previous, previous.lastPositionBits, local);
    const candidates = buckets.get(key);
    if (candidates) candidates.push(local);
    else buckets.set(key, [local]);
  }

  const currentTrackMap = new Int32Array(current.count);
  let nextTrackId = firstNewTrackId;
  let matchedCount = 0;
  let duplicateCandidateCount = 0;
  let shUpdateCount = 0;
  for (let currentLocal = 0; currentLocal < current.count; currentLocal += 1) {
    const candidates = buckets.get(positionKey(current, current.firstPositionBits, currentLocal));
    if (!candidates?.length) {
      currentTrackMap[currentLocal] = nextTrackId++;
      continue;
    }
    let candidateIndex = candidates.length - 1;
    if (candidates.length > 1) {
      duplicateCandidateCount += 1;
      let bestScore = -1;
      for (let index = 0; index < candidates.length; index += 1) {
        const score = tieScore(previous, candidates[index], current, currentLocal);
        if (score > bestScore) {
          bestScore = score;
          candidateIndex = index;
        }
      }
    }
    const previousLocal = candidates[candidateIndex];
    candidates[candidateIndex] = candidates[candidates.length - 1];
    candidates.pop();
    currentTrackMap[currentLocal] = previousTrackMap[previousLocal];
    matchedCount += 1;
    if (!equalSh(previous, previousLocal, current, currentLocal)) shUpdateCount += 1;
  }
  return { currentTrackMap, matchedCount, duplicateCandidateCount, shUpdateCount, nextTrackId };
}
