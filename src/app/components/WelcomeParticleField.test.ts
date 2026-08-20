import { describe, expect, it } from 'vitest';
import { limitScatterVelocity, scatterSpeedLimit } from './WelcomeParticleField';

describe('welcome particle scatter speed', () => {
  it('keeps random-state motion within the deliberate 6–17 px/s range at 60 FPS', () => {
    // #WDD-gpt 2026-08-20 - 随机态的最终速度硬上限需要可量化测试，避免解体或鼠标力重新制造快速飞点。
    expect(scatterSpeedLimit(0.2, 0.34) * 60).toBeCloseTo(6.348, 3);
    expect(scatterSpeedLimit(1, 3.75) * 60).toBeCloseTo(16.2, 3);
    const limited = limitScatterVelocity(4, 3, 0.5, 1.2);
    expect(Math.hypot(...limited)).toBeCloseTo(scatterSpeedLimit(0.5, 1.2), 8);
    expect(limitScatterVelocity(0.02, 0.03, 0.5, 1.2)).toEqual([0.02, 0.03]);
  });
});
