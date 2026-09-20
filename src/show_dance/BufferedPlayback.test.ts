// #WDD-gpt 2026-09-20 - 覆盖黄色区间拒绝、磁盘缓存不算就绪、绿色跳转以及缓冲区末尾循环策略。
import { it, expect } from 'vitest';
import { pacedCacheSegments, playableSeekTarget, nextPreparedPart } from './BufferedPlayback';
import type { ShowVideo } from './ShowGallery';
const video = { firstFrame: 0, lastFrame: 179, segments: [{ id: 'a', firstFrame: 0, lastFrame: 90 }, { id: 'b', firstFrame: 90, lastFrame: 179 }] } as ShowVideo;
it('refuses disk-only segments and accepts only resident playable segments', () => {
  expect(playableSeekTarget(video, 89, [0])).toEqual({ index: 0, localFrame: 89 });
  expect(playableSeekTarget(video, 90, [0])).toBeNull();
  expect(playableSeekTarget(video, 90, [0, 1])).toEqual({ index: 1, localFrame: 0 });
  // 场景释放后，即使磁盘文件还在，也必须重新禁止跳转。
  expect(playableSeekTarget(video, 89, [1])).toBeNull();
});
it('loops to the beginning until the immediate next segment is rendered and ready', () => {
  expect(nextPreparedPart(0, [0])).toBe(0);
  expect(nextPreparedPart(1, [0, 1, 3])).toBe(0);
  expect(nextPreparedPart(1, [0, 1, 2])).toBe(2);
  expect(nextPreparedPart(11, [0, 11])).toBe(0);
});

it('queues only the first non-playable segment so download and decode do not overlap', () => {
  expect(pacedCacheSegments(video, []).map((part) => part.id)).toEqual(['a']);
  expect(pacedCacheSegments(video, [0]).map((part) => part.id)).toEqual(['b']);
  expect(pacedCacheSegments(video, [1]).map((part) => part.id)).toEqual(['a']);
  expect(pacedCacheSegments(video, [0, 1])).toEqual([]);
});
