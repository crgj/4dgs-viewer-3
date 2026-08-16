import { describe, expect, it } from 'vitest';
import { matchFourCgsBoundary, type FourCgsBoundaryAttributes } from './FourCgsBoundaryMatcher';

function boundary(positions: number[], colors = positions.map(() => 0)): FourCgsBoundaryAttributes {
  const count = positions.length / 3;
  return {
    count,
    position: new Float32Array(positions),
    rotation: new Float32Array(Array.from({ length: count }, () => [1, 0, 0, 0]).flat()),
    colorDc: new Float32Array(colors),
    scale: new Float32Array(count * 3),
    opacity: new Float32Array(count),
  };
}

const limits = {
  cellSize: 0.1,
  maxPositionDistance: 0.1,
  maxRotationAngle: 0.1,
  maxColorDistance: 0.1,
  maxScaleDistance: 0.1,
  maxOpacityDistance: 0.1,
};

describe('matchFourCgsBoundary', () => {
  it('continues only one Gaussian into each previous slot', () => {
    const previous = boundary([0, 0, 0, 1, 0, 0]);
    const current = boundary([0.01, 0, 0, 0.02, 0, 0, 1.01, 0, 0]);
    const result = matchFourCgsBoundary(previous, current, limits);

    expect(result.matchedCount).toBe(2);
    expect([...result.currentToPrevious].filter((value) => value === 0)).toHaveLength(1);
    expect(result.currentToPrevious[2]).toBe(1);
  });

  it('preserves a distinct birth when attributes fail the conservative gate', () => {
    const previous = boundary([0, 0, 0]);
    const current = boundary([0.01, 0, 0], [1, 0, 0]);
    const result = matchFourCgsBoundary(previous, current, limits);

    expect(result.matchedCount).toBe(0);
    expect(result.rejectedByAttributes).toBe(1);
    expect(result.currentToPrevious[0]).toBe(-1);
  });
});
