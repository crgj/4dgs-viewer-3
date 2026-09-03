import { describe, expect, it } from 'vitest';
import { planSemanticCaptureFrames, planSemanticViewDirections } from './SemanticViewPlanner';

describe('planSemanticViewDirections', () => {
  it('is deterministic, normalized, and begins from the current camera direction', () => {
    const first = planSemanticViewDirections(12, 20260826, [2, 0, 0]);
    const second = planSemanticViewDirections(12, 20260826, [2, 0, 0]);
    expect(first).toEqual(second);
    expect(first[0]).toEqual([1, 0, 0]);
    expect(first[1]).toEqual([-1, -0, -0]);
    expect(first).toHaveLength(12);
    for (const direction of first) expect(Math.hypot(...direction)).toBeCloseTo(1, 6);
  });

  it('changes generated views when the seed changes', () => {
    expect(planSemanticViewDirections(4, 1, [0, 0, 1]))
      .not.toEqual(planSemanticViewDirections(4, 2, [0, 0, 1]));
  });

  it('keeps the same physical view set across seeds and only changes capture order', () => {
    const canonical = (direction: readonly number[]) => direction.map((value) => value.toFixed(7)).join(',');
    const first = planSemanticViewDirections(16, 20260827, [0, 0, 1]).map(canonical).sort();
    const second = planSemanticViewDirections(16, 20260828, [0, 0, 1]).map(canonical).sort();
    expect(first).toEqual(second);
  });

  it('keeps planned cameras angularly separated instead of clustering random samples', () => {
    const directions = planSemanticViewDirections(12, 77, [0, 0, 1]);
    for (let index = 0; index < directions.length; index += 1) {
      const nearestOther = Math.max(...directions
        .filter((_, otherIndex) => otherIndex !== index)
        .map((other) => directions[index][0] * other[0] + directions[index][1] * other[1] + directions[index][2] * other[2]));
      expect(nearestOther).toBeLessThan(0.82);
    }
  });
});

describe('planSemanticCaptureFrames', () => {
  it('starts at the user frame and spreads captures across a dynamic timeline', () => {
    const frames = planSemanticCaptureFrames(30, 8, 15);
    expect(frames[0]).toBe(15);
    expect(frames).toHaveLength(8);
    expect(new Set(frames).size).toBe(3);
    expect(Math.min(...frames)).toBe(0);
    expect(Math.max(...frames)).toBe(29);
  });

  it('keeps static scenes on frame zero and repeats deterministically when captures exceed frames', () => {
    expect(planSemanticCaptureFrames(1, 4, 99)).toEqual([0, 0, 0, 0]);
    expect(planSemanticCaptureFrames(2, 4, 0)).toEqual([0, 1, 0, 1]);
  });
});
