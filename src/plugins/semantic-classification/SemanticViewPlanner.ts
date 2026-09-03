import type { SemanticVector3 } from './SemanticClassificationTypes';

function normalize(vector: SemanticVector3): [number, number, number] {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length < 1e-8) return [0, 0, 1];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(first: SemanticVector3, second: SemanticVector3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}

// #WDD-gpt 2026-08-27 - 使用固定 Fibonacci 分层球面；种子只改变遍历顺序，不改变视角集合，消除随机机位导致的分类计数漂移。
export function planSemanticViewDirections(
  viewCount: number,
  seed: number,
  startDirection: SemanticVector3,
): readonly SemanticVector3[] {
  const count = Math.max(2, Math.min(24, Math.round(viewCount)));
  const start = normalize(startDirection);
  const opposite = normalize([-start[0], -start[1], -start[2]]);
  const fixed: SemanticVector3[] = [start, opposite];
  if (count === 2) return fixed;
  const remaining = count - 2;
  const candidates: SemanticVector3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < 192; index += 1) {
    const azimuth = index * goldenAngle;
    // 适度覆盖上下表面但避开纯顶/底视角，人物类别在这些视角中肢体重叠最严重。
    const elevation = Math.asin((((index + 0.5) / 192) * 2 - 1) * 0.84);
    const horizontal = Math.cos(elevation);
    candidates.push([
      Math.cos(azimuth) * horizontal,
      Math.sin(elevation),
      Math.sin(azimuth) * horizontal,
    ]);
  }
  while (fixed.length < count && candidates.length > 0) {
    let selectedIndex = 0;
    let selectedSeparation = Number.NEGATIVE_INFINITY;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const nearestDot = Math.max(...fixed.map((selected) => dot(candidates[candidateIndex], selected)));
      if (-nearestDot > selectedSeparation) {
        selectedSeparation = -nearestDot;
        selectedIndex = candidateIndex;
      }
    }
    fixed.push(candidates.splice(selectedIndex, 1)[0]);
  }
  const offset = (seed >>> 0) % remaining;
  const result: SemanticVector3[] = [fixed[0], fixed[1]];
  for (let index = 0; index < remaining; index += 1) {
    result.push(fixed[2 + ((index + offset) % remaining)]);
  }
  return result;
}

// #WDD-gpt 2026-08-27 - 动态 4GS 将有限推理次数均匀铺到时间轴；第一帧保留用户当前帧，其余用最远点采样扩大生命周期覆盖。
export function planSemanticCaptureFrames(
  totalFrames: number,
  captureCount: number,
  currentFrame: number,
): readonly number[] {
  const frameCount = Math.max(1, Math.round(totalFrames));
  const count = Math.max(1, Math.round(captureCount));
  const current = Math.max(0, Math.min(frameCount - 1, Math.round(currentFrame)));
  if (frameCount === 1) return Array.from({ length: count }, () => 0);
  const temporalCount = Math.min(frameCount, count, Math.max(2, Math.round(Math.sqrt(count))));
  const selected: number[] = [current];
  while (selected.length < temporalCount) {
    let bestFrame = 0;
    let bestDistance = -1;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (selected.includes(frame)) continue;
      const distance = Math.min(...selected.map((value) => Math.abs(frame - value)));
      if (distance > bestDistance || (distance === bestDistance && frame < bestFrame)) {
        bestFrame = frame;
        bestDistance = distance;
      }
    }
    selected.push(bestFrame);
  }
  return Array.from({ length: count }, (_, index) => selected[index % selected.length]);
}
