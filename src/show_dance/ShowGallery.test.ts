// #WDD-gpt 2026-09-20 - 验证共享边界帧只播放一次、全局拖动定位和片段路径/连续性校验。
import { describe, it, expect } from 'vitest';
import { parseShowGallery, locateShowFrame, segmentPlaybackEnd } from './ShowGallery';
const source = () => ({ version: 1, updatedAt: 'v1', videos: [{ id: 'dance', name: 'dance', fps: 30, snapshot: 'dance/thumbnail.webp', segments: [
  { file: 'dance/01.4cgs', fileBytes: 4, firstFrame: 0, lastFrame: 90, codec: 'test' },
  { file: 'dance/02.4cgs', fileBytes: 4, firstFrame: 90, lastFrame: 180, codec: 'test' },
  { file: 'dance/03.4cgs', fileBytes: 4, firstFrame: 181, lastFrame: 200, codec: 'test' },
] }] });
const url = 'https://test/4cgs_show/gallery.json';
describe('show gallery', () => {
  it('maps every global frame once across shared or adjacent endpoints', () => {
    const video = parseShowGallery(source(), url).items[0];
    const frames = video.segments.flatMap((part, index) => Array.from({ length: segmentPlaybackEnd(video, index) + 1 }, (_, frame) => part.firstFrame + frame));
    expect(frames).toEqual(Array.from({ length: 201 }, (_, frame) => frame));
    expect(locateShowFrame(video, 89)).toEqual({ index: 0, localFrame: 89 });
    expect(locateShowFrame(video, 90)).toEqual({ index: 1, localFrame: 0 });
    expect(locateShowFrame(video, 180)).toEqual({ index: 1, localFrame: 90 });
    expect(locateShowFrame(video, 200)).toEqual({ index: 2, localFrame: 19 });
  });
  it('rejects missing, reordered or overlapping frames', () => {
    for (const frame of [89, 92]) { const input = source(); input.videos[0].segments[1].firstFrame = frame; expect(() => parseShowGallery(input, url)).toThrow('连续排列'); }
  });
  it('rejects paths outside the video directory', () => {
    const input = source(); input.videos[0].segments[0].file = 'dance/../../4cgs/red.4cgs';
    expect(() => parseShowGallery(input, url)).toThrow('越界');
  });
});
