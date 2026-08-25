import { describe, expect, it } from 'vitest';
import { addressRelightingFrames, buildRelightingSegmentFramePlans } from './RelightingMeshFramePlan';

describe('RelightingMeshFramePlan', () => {
  it('maps shared boundaries to the following segment exactly once', () => {
    const plans = buildRelightingSegmentFramePlans([31, 31]);
    expect(plans).toEqual([
      { segmentIndex: 0, firstFrame: 0, lastFrame: 30, totalFrames: 31 },
      { segmentIndex: 1, firstFrame: 30, lastFrame: 60, totalFrames: 31 },
    ]);
    const addresses = addressRelightingFrames(plans, 29, 31);
    expect(addresses).toEqual([
      { globalFrame: 29, localFrame: 29, segmentIndex: 0 },
      { globalFrame: 30, localFrame: 0, segmentIndex: 1 },
      { globalFrame: 31, localFrame: 1, segmentIndex: 1 },
    ]);
  });

  it('clamps a requested range to the unified timeline', () => {
    const plans = buildRelightingSegmentFramePlans([3]);
    expect(addressRelightingFrames(plans, -4, 8)).toEqual([
      { globalFrame: 0, localFrame: 0, segmentIndex: 0 },
      { globalFrame: 1, localFrame: 1, segmentIndex: 0 },
      { globalFrame: 2, localFrame: 2, segmentIndex: 0 },
    ]);
  });
});
