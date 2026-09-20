// #WDD-gpt 2026-09-20 - 高频预读更新不得推迟播放；绘制迟到只推进一帧，保留顺序播放语义。
import { expect, it } from 'vitest';
import { PlaybackClock } from './PlaybackClock';
it('advances at 30fps despite background updates every millisecond', () => {
  const clock = new PlaybackClock(1000 / 30); let frames = 0;
  for (let now = 0; now < 1000; now++) if (clock.take(now, true)) frames++;
  expect(frames).toBe(30);
});
it('waits for display readiness and does not burst catch-up frames after a stall', () => {
  const clock = new PlaybackClock(1000 / 30);
  expect(clock.take(0, true)).toBe(true);
  expect(clock.take(40, false)).toBe(false);
  expect(clock.take(1000, true)).toBe(true);
  expect(clock.take(1000, true)).toBe(false);
  expect(clock.take(1016, true)).toBe(false);
  expect(clock.take(1033.33, true)).toBe(true);
});
