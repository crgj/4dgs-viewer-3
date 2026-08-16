import { describe, expect, it } from 'vitest';
import {
  estimateConsensusPeopleCount,
  solveSmartAlignmentCenter,
  solveSmartAlignmentUp,
} from './SmartAlignmentSolver';
import type {
  SmartAlignmentFace,
  SmartAlignmentLandmark,
  SmartAlignmentVector3,
  SmartAlignmentViewAnalysis,
} from './SmartAlignmentTypes';

const basis = {
  'positive-z': { right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] },
  'positive-x': { right: [0, 0, -1], up: [0, 1, 0], forward: [-1, 0, 0] },
} as const satisfies Record<string, Record<string, SmartAlignmentVector3>>;

function pose(feetX: number, feetY: number, headX = feetX, headY = feetY - 0.6) {
  const point = (ratio: number) => ({
    x: headX + (feetX - headX) * ratio,
    y: headY + (feetY - headY) * ratio,
    z: 0,
    visibility: 0.95,
  });
  const landmarks: SmartAlignmentLandmark[] = Array.from({ length: 33 }, () => ({
    ...point(0.5),
  }));
  [0, 2, 5, 7, 8].forEach((index) => { landmarks[index] = point(0); });
  [11, 12].forEach((index) => { landmarks[index] = point(0.28); });
  [23, 24].forEach((index) => { landmarks[index] = point(0.62); });
  [27, 28, 29, 30, 31, 32].forEach((index) => { landmarks[index] = point(1); });
  return { landmarks };
}

function view(
  id: 'positive-z' | 'positive-x',
  poses: ReturnType<typeof pose>[],
  faces: SmartAlignmentFace[] = [{ x: 0.5, y: 0.2, width: 0.08, height: 0.1, confidence: 0.95 }],
): SmartAlignmentViewAnalysis {
  return {
    id,
    center: [0, 1, 0],
    ...basis[id],
    horizontalSpan: 4,
    verticalSpan: 4,
    poses,
    faces,
  };
}

describe('SmartAlignmentSolver', () => {
  it('recovers an upright body direction from orthogonal rendered views', () => {
    const solution = solveSmartAlignmentUp([
      view('positive-z', [pose(0.5, 0.82)]),
      view('positive-x', [pose(0.5, 0.82)]),
    ]);
    expect(solution).not.toBeNull();
    expect(solution!.worldUp[0]).toBeCloseTo(0, 5);
    expect(solution!.worldUp[1]).toBeCloseTo(1, 5);
    expect(solution!.worldUp[2]).toBeCloseTo(0, 5);
  });

  it('places the origin at the average standing point of multiple people', () => {
    const front = view('positive-z', [pose(0.25, 0.75), pose(0.75, 0.75)]);
    const side = view('positive-x', [pose(0.4, 0.75), pose(0.6, 0.75)]);
    const solution = solveSmartAlignmentCenter([front, side]);
    expect(solution).not.toBeNull();
    expect(solution!.peopleCount).toBe(2);
    expect(solution!.standingCenter[0]).toBeCloseTo(0, 5);
    expect(solution!.standingCenter[1]).toBeCloseTo(0, 5);
    expect(solution!.standingCenter[2]).toBeCloseTo(0, 5);
  });

  it('does not count a one-view Gaussian ghost as another person', () => {
    const views = [
      view('positive-z', [pose(0.5, 0.82)]),
      view('positive-x', [pose(0.5, 0.82)]),
      view('positive-z', [pose(0.5, 0.82)]),
      view('positive-x', [pose(0.5, 0.82), pose(0.12, 0.7)]),
    ];
    expect(estimateConsensusPeopleCount(views)).toBe(1);
    expect(solveSmartAlignmentUp(views)?.peopleCount).toBe(1);
    expect(solveSmartAlignmentCenter(views)?.peopleCount).toBe(1);
  });

  it('folds an upside-down view into the stable body axis instead of cancelling it', () => {
    const solution = solveSmartAlignmentUp([
      view('positive-z', [pose(0.5, 0.82)]),
      view('positive-x', [pose(0.5, 0.82)]),
      view('positive-z', [pose(0.5, 0.82)]),
      view('positive-x', [pose(0.5, 0.18, 0.5, 0.78)]),
    ]);
    expect(solution).not.toBeNull();
    expect(solution!.worldUp[1]).toBeGreaterThan(0.99);
    expect(solution!.viewsUsed).toBe(4);
    expect(solution!.directionalDominance).toBeCloseTo(1, 5);
    expect(solution!.hemisphereFlips).toBe(1);
    expect(solution!.opposingViews).toBe(0);
  });

  it('uses independent face votes to choose which end of the body axis is the head', () => {
    const bottomFace: SmartAlignmentFace[] = [
      { x: 0.5, y: 0.86, width: 0.08, height: 0.1, confidence: 0.95 },
    ];
    const solution = solveSmartAlignmentUp([
      view('positive-z', [pose(0.5, 0.82)], bottomFace),
      view('positive-x', [pose(0.5, 0.82)], bottomFace),
    ]);
    expect(solution).not.toBeNull();
    expect(solution!.semanticViewsUsed).toBe(2);
    expect(solution!.semanticDominance).toBeGreaterThan(0.99);
    expect(solution!.unsignedWorldUp[1]).toBeGreaterThan(0.99);
    expect(solution!.worldUp[1]).toBeLessThan(-0.99);
  });
});
