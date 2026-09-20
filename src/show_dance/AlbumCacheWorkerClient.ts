// #WDD-gpt 2026-09-20 - 下载、文件校验与流式落盘独立于播放主线程，仅传递文件句柄及低频进度。
import type { CacheSnapshot, DiskCacheItem } from './AlbumDiskCache';
export class AlbumCacheWorkerClient {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private listeners = new Set<(state: CacheSnapshot) => void>();
  state: CacheSnapshot = { entries: {}, location: '正在准备磁盘缓存', persistent: false, paused: false };
  subscribe(listener: (state: CacheSnapshot) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private request<T = void>(method: string, args: unknown[] = []): Promise<T> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./album-cache.worker.ts', import.meta.url), { type: 'module', name: 'show-dance-download' });
      this.worker.onmessage = ({ data }) => {
        if (data.type === 'state') { this.state = data.state; this.listeners.forEach((listener) => listener(this.state)); return; }
        const task = this.pending.get(data.id); if (!task) return;
        this.pending.delete(data.id);
        if (data.error) task.reject(new Error(data.error)); else task.resolve(data.value);
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || '磁盘缓存 Worker 失败');
        this.pending.forEach((task) => task.reject(error)); this.pending.clear();
        this.state = { ...this.state, paused: true, error: error.message };
        this.listeners.forEach((listener) => listener(this.state));
      };
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try { this.worker!.postMessage({ id, method, args }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  initialize(items: readonly DiskCacheItem[], revision: string, parent?: FileSystemDirectoryHandle) { return this.request('initialize', [items, revision, parent]); }
  get(item: DiskCacheItem) { return this.request<File>('get', [item]); }
  start(items: readonly DiskCacheItem[]) { this.command('start', [items]); }
  resume(items: readonly DiskCacheItem[]) { this.command('resume', [items]); }
  private command(method: string, args: unknown[]) { void this.request(method, args).catch((error) => { this.state = { ...this.state, error: String(error) }; this.listeners.forEach((listener) => listener(this.state)); }); }
  stop() { return this.worker ? this.request('stop') : Promise.resolve(); }
  clear() { return this.request('clear'); }
  async persist() {
    // 持久化授权仍从用户手势所在的 Window 发起。
    const persistent = await navigator.storage.persist();
    await this.request('persistent', [persistent]);
  }
  dispose() {
    this.worker?.terminate(); this.worker = undefined;
    this.pending.forEach((task) => task.reject(new DOMException('缓存 Worker 已关闭', 'AbortError')));
    this.pending.clear(); this.listeners.clear();
  }
}
