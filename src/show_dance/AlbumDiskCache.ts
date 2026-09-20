// #WDD-gpt 2026-09-20 - 相册采用有界并发流式落盘，完整关闭并校验长度后才发布完成标记。
export interface DiskCacheItem { readonly id: string; readonly assetUrl: string; readonly fileBytes: number; readonly codec: string; }
export type CachePhase = 'queued' | 'checking' | 'downloading' | 'cached' | 'error' | 'paused';
export interface CacheEntry { phase: CachePhase; received: number; total: number; error?: string; }
export interface CacheSnapshot { entries: Record<string, CacheEntry>; location: string; persistent: boolean; quota?: number; usage?: number; paused: boolean; error?: string; }
const DIRECTORY = 'show-dance-album-v1';
const abortError = () => new DOMException('缓存任务已停止', 'AbortError');
export const cacheIdentity = (item: DiskCacheItem, revision: string) => JSON.stringify([1, revision, item.assetUrl, item.fileBytes, item.codec]);
export async function cacheKey(item: DiskCacheItem, revision: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cacheIdentity(item, revision)));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
interface Job { item: DiskCacheItem; promise: Promise<File>; resolve: (file: File) => void; reject: (cause: unknown) => void; }
export class AlbumDiskCache {
  // #WDD-gpt 2026-09-20 - 播放器可指定单路 FIFO，拖动到后续片段不会打乱顺序缓存。
  constructor(private readonly options: { concurrency?: number; preserveOrder?: boolean } = {}) {}
  private directory?: FileSystemDirectoryHandle;
  private revision = '';
  private external = false;
  private queue: Job[] = [];
  private jobs = new Map<string, Job>();
  private active = new Set<Promise<void>>();
  private controller = new AbortController();
  private stopped = false;
  private listeners = new Set<(state: CacheSnapshot) => void>();
  state: CacheSnapshot = { entries: {}, location: '正在准备磁盘缓存', persistent: false, paused: false };
  subscribe(listener: (state: CacheSnapshot) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<CacheSnapshot> = {}) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener(this.state)); }
  private entry(item: DiskCacheItem, patch: CacheEntry) { this.publish({ entries: { ...this.state.entries, [item.id]: patch } }); }
  async initialize(items: readonly DiskCacheItem[], revision: string, parent?: FileSystemDirectoryHandle) {
    this.revision = revision; this.external = Boolean(parent);
    this.publish({ entries: Object.fromEntries(items.map((item) => [item.id, { phase: 'queued', received: 0, total: item.fileBytes }])), error: undefined });
    try {
      const root = parent ?? await navigator.storage.getDirectory();
      this.directory = await root.getDirectoryHandle(DIRECTORY, { create: true });
      if (this.stopped) throw abortError();
      const persistent = parent ? true : await navigator.storage.persisted();
      const estimate = parent ? {} : await navigator.storage.estimate();
      this.publish({ location: parent ? `硬盘目录：${parent.name}/${DIRECTORY}` : 'OPFS · 浏览器管理的磁盘空间', persistent, ...estimate });
    } catch (error) {
      if (!this.stopped) this.publish({ error: `磁盘缓存不可用：${String(error)}。可尝试选择硬盘目录。`, location: '存储不可用' });
      throw error;
    }
  }
  start(items: readonly DiskCacheItem[]) {
    if (!this.directory || this.stopped) return;
    this.publish({ paused: false });
    for (const item of items) void this.get(item).catch(() => {});
  }
  get(item: DiskCacheItem): Promise<File> {
    if (!this.directory) return Promise.reject(new Error(this.state.error || '请先选择存储位置。'));
    if (this.stopped) return this.readWhilePaused(item);
    const existing = this.jobs.get(item.id);
    if (existing) {
      const index = this.queue.indexOf(existing);
      if (index > 0 && !this.options.preserveOrder) { this.queue.splice(index, 1); this.queue.unshift(existing); }
      return existing.promise;
    }
    let resolve!: (file: File) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<File>((yes, no) => { resolve = yes; reject = no; });
    const job = { item, promise, resolve, reject };
    this.jobs.set(item.id, job); this.queue.push(job); this.pump();
    return promise;
  }
  // #WDD-gpt 2026-09-20 - 暂停仅阻止网络写入，已完整缓存的模型仍可播放。
  private async readWhilePaused(item: DiskCacheItem): Promise<File> {
    const key = await cacheKey(item, this.revision);
    try {
      const marker = JSON.parse(await (await (await this.directory!.getFileHandle(`${key}.json`)).getFile()).text());
      const file = await (await this.directory!.getFileHandle(`${key}.4cgs`)).getFile();
      if (marker.identity === cacheIdentity(item, this.revision) && file.size === item.fileBytes) return file;
    } catch { /* 无完整文件时不回退网络。 */ }
    throw new Error('缓存已暂停，此文件尚未完整保存。请在缓存管理中恢复缓存。');
  }
  private pump() {
    while (!this.stopped && this.active.size < (this.options.concurrency ?? 2) && this.queue.length) {
      const job = this.queue.shift()!;
      const work = this.load(job.item).then(job.resolve, (error) => {
        this.entry(job.item, { phase: this.stopped ? 'paused' : 'error', received: 0, total: job.item.fileBytes, error: this.stopped ? undefined : String(error) });
        job.reject(error);
      }).finally(() => { this.jobs.delete(job.item.id); this.active.delete(work); this.pump(); });
      this.active.add(work);
    }
  }
  private async load(item: DiskCacheItem): Promise<File> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    const key = await cacheKey(item, this.revision);
    const run = async () => {
      signal.throwIfAborted();
      const directory = this.directory!;
      this.entry(item, { phase: 'checking', received: 0, total: item.fileBytes });
      try {
        const marker = JSON.parse(await (await (await directory.getFileHandle(`${key}.json`)).getFile()).text());
        const file = await (await directory.getFileHandle(`${key}.4cgs`)).getFile();
        if (marker.identity === cacheIdentity(item, this.revision) && file.size === item.fileBytes) {
          signal.throwIfAborted();
          this.entry(item, { phase: 'cached', received: file.size, total: file.size });
          return file;
        }
      } catch (error) { if (signal.aborted) throw error; }
      const response = await fetch(item.assetUrl, { signal, cache: 'no-store' });
      if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
      let handle: FileSystemFileHandle, writer: FileSystemWritableFileStream;
      try { handle = await directory.getFileHandle(`${key}.4cgs`, { create: true }); writer = await handle.createWritable(); }
      catch (error) { await response.body.cancel().catch(() => {}); throw error; }
      let received = 0, lastUpdate = 0;
      try {
        // 每个网络块写入完成后才继续读取，通过反压限制内存；不合并大 Blob 或 ArrayBuffer。
        await response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, controller) => {
          received += chunk.byteLength;
          if (received > item.fileBytes) throw new Error('下载内容超过相册标注的文件大小。');
          const now = performance.now();
          if (now - lastUpdate > 120) { this.entry(item, { phase: 'downloading', received, total: item.fileBytes }); lastUpdate = now; }
          controller.enqueue(chunk);
        }})).pipeTo(writer, { signal });
        signal.throwIfAborted();
        if (received !== item.fileBytes) throw new Error(`文件不完整：预期 ${item.fileBytes} 字节，收到 ${received} 字节。`);
        const file = await handle.getFile();
        if (file.size !== item.fileBytes) throw new Error('落盘长度校验失败。');
        const marker = await (await directory.getFileHandle(`${key}.json`, { create: true })).createWritable();
        await marker.write(JSON.stringify({ identity: cacheIdentity(item, this.revision), size: file.size, savedAt: Date.now() }));
        await marker.close();
        signal.throwIfAborted();
        this.entry(item, { phase: 'cached', received, total: item.fileBytes });
        await this.refreshUsage();
        return file;
      } catch (error) {
        await writer.abort().catch(() => {});
        await directory.removeEntry(`${key}.json`).catch(() => {});
        await directory.removeEntry(`${key}.4cgs`).catch(() => {});
        throw error;
      }
    };
    // 多标签页同版本去重；共享总锁允许两路下载，清理使用排他总锁。
    return navigator.locks
      ? navigator.locks.request(DIRECTORY, { mode: 'shared', signal }, () => navigator.locks.request(`${DIRECTORY}:${key}`, { signal }, run))
      : run();
  }
  async stop() {
    this.stopped = true; this.controller.abort();
    for (const job of this.queue.splice(0)) { this.entry(job.item, { phase: 'paused', received: 0, total: job.item.fileBytes }); this.jobs.delete(job.item.id); job.reject(abortError()); }
    await Promise.allSettled([...this.active]);
    this.publish({ paused: true });
  }
  resume(items: readonly DiskCacheItem[]) { if (this.stopped) { this.stopped = false; this.controller = new AbortController(); } this.start(items); }
  async clear() {
    await this.stop();
    const remove = async () => {
      if (!this.directory) return;
      // 只删除当前专属目录内本缓存命名的文件，不触碰用户其他文件。
      for await (const name of (this.directory as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }).keys()) {
        if (/^[a-f0-9]{64}\.(4cgs|json)$/.test(name)) await this.directory.removeEntry(name);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request(DIRECTORY, remove); else await remove();
      await this.refreshUsage();
      this.publish({ entries: Object.fromEntries(Object.entries(this.state.entries).map(([id, entry]) => [id, { phase: 'paused', total: entry.total, received: 0 }])), error: undefined });
    } catch (error) { this.publish({ error: `清理失败：${String(error)}` }); throw error; }
  }
  private async refreshUsage() {
    if (!this.external) { try { const estimate = await navigator.storage.estimate(); this.publish(estimate); } catch { /* 空间统计失败不影响已完成缓存。 */ } }
  }
  async persist() { const persistent = await navigator.storage.persist(); this.publish({ persistent }); }
}
