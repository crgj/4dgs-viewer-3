// #WDD-gpt 2026-09-20 - 独立空间视频相册按目录组织片段，保留源帧编号并消除共享边界帧重复播放。
import type { DiskCacheItem } from './AlbumDiskCache';
export interface ShowSegment extends DiskCacheItem {
  file: string;
  firstFrame: number;
  lastFrame: number;
}
export interface ShowVideo {
  id: string; name: string; description: string; tags: string[];
  snapshotUrl: string; fileBytes: number; fps: number;
  firstFrame: number; lastFrame: number; segments: ShowSegment[];
}
export interface ShowGallery { updatedAt: string; items: ShowVideo[]; }
export function parseShowGallery(value: unknown, url: string): ShowGallery {
  const source = value as { version?: number; updatedAt?: string; videos?: Record<string, unknown>[] };
  if (!source || source.version !== 1 || typeof source.updatedAt !== 'string' || !Array.isArray(source.videos)) throw new Error('空间视频相册清单无效。');
  const base = new URL('.', url);
  const ids = new Set<string>();
  const items = source.videos.map((raw): ShowVideo => {
    if (typeof raw.id !== 'string' || !raw.id || ids.has(raw.id) || typeof raw.name !== 'string' || !Array.isArray(raw.segments) || !raw.segments.length) throw new Error('视频名称、ID 或片段列表无效。');
    ids.add(raw.id);
    const asset = (path: unknown) => {
      if (typeof path !== 'string' || !path.startsWith(`${raw.id}/`)) throw new Error('视频资源必须位于自己的子目录中。');
      const result = new URL(path, base);
      if (result.origin !== base.origin || !result.pathname.startsWith(`${base.pathname}${encodeURIComponent(raw.id as string)}/`)) throw new Error('视频资源路径越界。');
      return result.href;
    };
    const paths = new Set<string>();
    const segments = raw.segments.map((part: Record<string, unknown>, index): ShowSegment => {
      const assetUrl = asset(part.file);
      if (paths.has(assetUrl) || !assetUrl.endsWith('.4cgs')) throw new Error('片段路径重复或扩展名无效。');
      paths.add(assetUrl);
      for (const key of ['fileBytes', 'firstFrame', 'lastFrame'] as const) if (!Number.isSafeInteger(part[key]) || Number(part[key]) < 0) throw new Error(`片段 ${key} 无效。`);
      if (!part.fileBytes || Number(part.lastFrame) < Number(part.firstFrame) || typeof part.codec !== 'string') throw new Error('片段大小、范围或编码无效。');
      return { id: `${raw.id}/${index}`, file: String(part.file), assetUrl, fileBytes: Number(part.fileBytes), codec: part.codec, firstFrame: Number(part.firstFrame), lastFrame: Number(part.lastFrame) };
    });
    segments.forEach((part, index) => {
      const previous = segments[index - 1];
      if (previous && (part.firstFrame <= previous.firstFrame || part.firstFrame < previous.lastFrame || part.firstFrame > previous.lastFrame + 1)) throw new Error('视频片段必须按帧顺序连续排列，仅允许共享一个边界帧。');
    });
    const fps = Number(raw.fps);
    if (!Number.isFinite(fps) || fps <= 0) throw new Error('视频帧率无效。');
    return { id: raw.id, name: raw.name, description: String(raw.description || ''), tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [], snapshotUrl: asset(raw.snapshot), fileBytes: segments.reduce((n, p) => n + p.fileBytes, 0), firstFrame: segments[0].firstFrame, lastFrame: segments.at(-1)!.lastFrame, fps, segments };
  });
  return { updatedAt: source.updatedAt, items };
}
export async function loadShowGallery(): Promise<ShowGallery> {
  const url = new URL('4cgs_show/gallery.json', document.baseURI).href;
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`空间视频相册读取失败：HTTP ${response.status}`);
  return parseShowGallery(await response.json(), response.url || url);
}
export function locateShowFrame(video: ShowVideo, frame: number) {
  const absolute = video.firstFrame + Math.max(0, Math.min(video.lastFrame - video.firstFrame, Math.floor(frame)));
  let index = 0;
  while (index + 1 < video.segments.length && video.segments[index + 1].firstFrame <= absolute) index++;
  return { index, localFrame: absolute - video.segments[index].firstFrame };
}
export const segmentPlaybackEnd = (video: ShowVideo, index: number) => (video.segments[index + 1]?.firstFrame ?? video.lastFrame + 1) - video.segments[index].firstFrame - 1;
