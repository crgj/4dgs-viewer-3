import { describe, expect, it } from 'vitest';
import type { SmartAlignmentPose } from './SmartAlignmentTypes';
import {
  restoreSmartAlignmentPoseRotation,
  type SmartAlignmentImageRotation,
} from './SmartAlignmentPoseRotation';

function rotatedPose(rotation: SmartAlignmentImageRotation): SmartAlignmentPose[] {
  const coordinates = rotation === 90
    ? [0.7, 0.2]
    : rotation === -90
      ? [0.3, 0.8]
      : rotation === 180
        ? [0.8, 0.7]
        : [0.2, 0.3];
  return [{
    landmarks: [{
      x: coordinates[0],
      y: coordinates[1],
      z: -0.4,
      visibility: 0.91,
    }],
  }];
}

describe('restoreSmartAlignmentPoseRotation', () => {
  it.each([0, 90, -90, 180] as const)(
    'maps a %s degree inference back into the original capture',
    (rotation) => {
      const [pose] = restoreSmartAlignmentPoseRotation(rotatedPose(rotation), rotation);
      expect(pose.landmarks[0].x).toBeCloseTo(0.2, 12);
      expect(pose.landmarks[0].y).toBeCloseTo(0.3, 12);
      expect(pose.landmarks[0].z).toBe(-0.4);
      expect(pose.landmarks[0].visibility).toBe(0.91);
    },
  );
});
