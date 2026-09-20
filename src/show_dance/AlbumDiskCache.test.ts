// #WDD-gpt 2026-09-20 - 验证缓存命中、版本隔离、半文件拒绝与清理中的并发下载取消。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlbumDiskCache } from './AlbumDiskCache';
import type { FourCgsGalleryItem } from '../app/fourCgsGallery';
const item = (id: string, size = 4) => ({ id, assetUrl: `https://test/${id}.4cgs`, fileBytes: size, codec: 'test' } as FourCgsGalleryItem);
function setup(fetcher: typeof fetch) {
  const files = new Map<string, Blob>();
  const directory = {
    name: 'test', getDirectoryHandle: async () => directory,
    getFileHandle: async (name: string, options?: { create: boolean }) => {
      if (!files.has(name) && !options?.create) throw new DOMException('Missing', 'NotFoundError');
      return {
        getFile: async () => new File([files.get(name) || new Blob()], name),
        createWritable: async () => {
          const chunks: BlobPart[] = [];
          const stream = new WritableStream({ write: (chunk) => { chunks.push(chunk); }, close: () => { files.set(name, new Blob(chunks)); } });
          return Object.assign(stream, { write: async (chunk: BlobPart) => { chunks.push(chunk); } });
        },
      };
    },
    removeEntry: async (name: string) => { files.delete(name); },
    async *keys() { yield* files.keys(); },
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => directory, persisted: async () => true, estimate: async () => ({ quota: 1000000, usage: 0 }) } });
  vi.stubGlobal('fetch', fetcher);
  return files;
}
afterEach(() => vi.unstubAllGlobals());
describe('AlbumDiskCache', () => {
  it('reuses complete files across instances without fetching, and isolates revisions', async () => {
    const fetcher = vi.fn(async () => new Response('abcd'));
    const files = setup(fetcher);
    const a = new AlbumDiskCache(); await a.initialize([item('a')], 'v1'); await a.get(item('a'));
    const b = new AlbumDiskCache(); await b.initialize([item('a')], 'v1'); expect(await (await b.get(item('a'))).text()).toBe('abcd');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const c = new AlbumDiskCache(); await c.initialize([item('a')], 'v2'); await c.get(item('a'));
    expect(fetcher).toHaveBeenCalledTimes(2); expect(files.size).toBe(4);
  });
  it('allows disk playback while paused and never falls back to network', async () => {
    const fetcher = vi.fn(async () => new Response('abcd')); setup(fetcher);
    const cache = new AlbumDiskCache(); await cache.initialize([item('a')], 'v1'); await cache.get(item('a')); await cache.stop();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await (await cache.get(item('a'))).text()).toBe('abcd');
    await expect(cache.get(item('missing'))).rejects.toThrow('缓存已暂停');
  });
  it('preserves previous complete version when an upgrade fails', async () => {
    const files = setup(vi.fn(async () => new Response('abcd')));
    const old = new AlbumDiskCache(); await old.initialize([item('a')], 'v1'); await old.get(item('a'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ab')));
    const next = new AlbumDiskCache(); await next.initialize([item('a')], 'v2'); await expect(next.get(item('a'))).rejects.toThrow();
    expect(files.size).toBe(2); expect(await (await old.get(item('a'))).text()).toBe('abcd');
  });
  it('rejects truncated downloads and removes partial files', async () => {
    const files = setup(vi.fn(async () => new Response('ab')));
    const cache = new AlbumDiskCache(); await cache.initialize([item('a')], 'v1');
    await expect(cache.get(item('a'))).rejects.toThrow('文件不完整');
    expect(cache.state.entries.a.phase).toBe('error'); expect(files.size).toBe(0);
  });
  it('deduplicates one item and caps concurrent jobs at two', async () => {
    let active = 0, peak = 0;
    setup(vi.fn(async () => { active++; peak = Math.max(active, peak); await new Promise((resolve) => setTimeout(resolve, 15)); active--; return new Response('abcd'); }));
    const cache = new AlbumDiskCache(); const items = ['a', 'b', 'c'].map((id) => item(id)); await cache.initialize(items, 'v1');
    const first = cache.get(items[0]); expect(cache.get(items[0])).toBe(first);
    await Promise.all([first, cache.get(items[1]), cache.get(items[2])]); expect(peak).toBe(2);
  });
  it('prefetches only selected video in FIFO order even when a later part is requested', async () => {
    const order: string[] = []; let active = 0, peak = 0;
    setup(vi.fn(async (url) => { order.push(String(url)); active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--; return new Response('abcd'); }));
    const cache = new AlbumDiskCache({ concurrency: 1, preserveOrder: true });
    const chosen = ['a', 'b', 'c'].map((id) => item(id));
    await cache.initialize([...chosen, item('other-video')], 'v1');
    cache.start(chosen);
    await cache.get(chosen[2]);
    expect(order).toEqual(chosen.map((part) => part.assetUrl));
    expect(peak).toBe(1);
    expect(cache.state.entries['other-video'].phase).toBe('queued');
    await cache.stop();
  });
  it('aborts active and queued work before clear and stays paused until resumed', async () => {
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError'))); } }));
    });
    const files = setup(fetcher); files.set('user-notes.txt', new Blob(['keep']));
    const cache = new AlbumDiskCache(); const items = ['a', 'b', 'c'].map((id) => item(id)); await cache.initialize(items, 'v1');
    const jobs = items.map((i) => cache.get(i).catch(() => null));
    await new Promise((resolve) => setTimeout(resolve, 10)); await cache.clear(); await Promise.all(jobs);
    expect(cache.state.paused).toBe(true); expect([...files.keys()]).toEqual(['user-notes.txt']);
    expect(Object.values(cache.state.entries).every((entry) => entry.phase === 'paused')).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('abcd')));
    cache.resume(items); await cache.get(items[0]); expect(cache.state.entries.a.phase).toBe('cached'); await cache.stop();
  });
});
