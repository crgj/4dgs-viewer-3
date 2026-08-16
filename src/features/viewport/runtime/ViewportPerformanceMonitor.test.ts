import { describe, expect, it } from 'vitest';
import { ViewportPerformanceMonitor } from './ViewportPerformanceMonitor';

describe('ViewportPerformanceMonitor', () => {
  it('keeps bounded histories and reports slow-frame warnings', () => {
    const monitor = new ViewportPerformanceMonitor();
    for (let sample = 0; sample < 4; sample += 1) {
      for (let frame = 0; frame < 12; frame += 1) monitor.recordFrame(50);
    }
    const snapshot = monitor.snapshot({ backend: 'WebGL2', renderer: 'test', logicalCores: 8, deviceMemoryGiB: 16 });
    expect(snapshot.fps).toBeCloseTo(20);
    expect(snapshot.frameTimeMs).toBe(50);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.fpsHistory.length).toBeLessThanOrEqual(60);
  });
});

