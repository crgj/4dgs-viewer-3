import { describe, expect, it } from 'vitest';
import { evaluationCameraManualAspectRatio } from './EvaluationCameraProjection';

describe('evaluationCameraManualAspectRatio', () => {
  it('preserves independent horizontal and vertical focal lengths', () => {
    expect(evaluationCameraManualAspectRatio({
      fx: 5417.7656,
      fy: 5422.0681,
      sourceWidth: 3840,
      sourceHeight: 2160,
    })).toBeCloseTo(5422.0681 * 3840 / (5417.7656 * 2160), 12);
  });

  it('falls back to automatic aspect ratio when vertical intrinsics are absent', () => {
    expect(evaluationCameraManualAspectRatio({ fx: 1000, sourceWidth: 1920 })).toBeNull();
  });
});
