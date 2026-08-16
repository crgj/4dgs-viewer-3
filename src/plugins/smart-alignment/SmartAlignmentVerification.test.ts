import { describe, expect, it } from 'vitest';
import type {
  SmartAlignmentCenterSolution,
  SmartAlignmentUpSolution,
} from './SmartAlignmentSolver';
import { assessSmartAlignmentVerification } from './SmartAlignmentVerification';

function upSolution(overrides: Partial<SmartAlignmentUpSolution> = {}): SmartAlignmentUpSolution {
  return {
    unsignedWorldUp: [0, 1, 0],
    worldUp: [0, 1, 0],
    confidence: 0.7,
    directionalDominance: 0.8,
    hemisphereFlips: 0,
    opposingViews: 0,
    facesDetected: 0,
    semanticDominance: 0,
    semanticViewsUsed: 0,
    peopleCount: 1,
    viewsUsed: 12,
    ...overrides,
  };
}

function centerSolution(overrides: Partial<SmartAlignmentCenterSolution> = {}): SmartAlignmentCenterSolution {
  return {
    standingCenter: [0, 0, 0],
    confidence: 0.6,
    peopleCount: 1,
    viewsUsed: 10,
    ...overrides,
  };
}

describe('assessSmartAlignmentVerification', () => {
  it('keeps a geometrically reliable result when the verification pass cannot see a face', () => {
    expect(assessSmartAlignmentVerification(upSolution(), centerSolution())).toEqual({
      centerReliable: true,
      orientationReliable: true,
      semanticStatus: 'unknown',
    });
  });

  it('treats reliable upside-down face evidence as a hard veto', () => {
    const assessment = assessSmartAlignmentVerification(upSolution({
      worldUp: [0, -1, 0],
      facesDetected: 4,
      semanticDominance: 0.82,
      semanticViewsUsed: 4,
    }), centerSolution());
    expect(assessment.semanticStatus).toBe('inverted');
  });

  it('allows orientation acceptance while skipping an unreliable foot refinement', () => {
    const assessment = assessSmartAlignmentVerification(
      upSolution(),
      centerSolution({ confidence: 0.1, viewsUsed: 2 }),
    );
    expect(assessment.orientationReliable).toBe(true);
    expect(assessment.centerReliable).toBe(false);
  });
});
