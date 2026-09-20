// #WDD-gpt 2026-09-20 - 有界分块传送给准备线程；共享内存只传视图，否则只复制当前小块，禁止复制整段 Canonical。
import type { Raw4DAsset, Raw4DScalarArray, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import type { PreparationRequest, PreparationTrackRequest, PreparedArray } from './Raw4DPreparation';
const slice = (array: Raw4DScalarArray, first: number, end: number): Raw4DScalarArray =>
  typeof SharedArrayBuffer !== 'undefined' && array.buffer instanceof SharedArrayBuffer ? array.subarray(first, end) : array.slice(first, end);
const trackSlice = (track: Raw4DTrack, first: number, end: number, firstKey = false): Raw4DTrack => ({
  ...track, keyframes: firstKey ? [track.keyframes[0]] : track.keyframes,
  values: (firstKey ? track.values.slice(0, track.components) : track.values).map((array) => slice(array, first, end)),
});
export class Raw4DPreparationClient {
  // #WDD-gpt 2026-09-20 - 片段成功完成后复用最多九个空闲 Worker，避免每个 GPU 子段重复启动和 JIT 预热。
  private static idle: Worker[] = [];
  // #WDD-gpt 2026-09-20 - 在压缩解码期间预热三路准备池，避免 GPU 关键路径上反复加载模块。
  static warm(): void {
    const count = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 4))) * 3;
    while (this.idle.length < count) this.idle.push(new Worker(new URL('./raw4d-preparation.worker.ts', import.meta.url), { type: 'module', name: 'show-dance-texture-preparation' }));
  }
  // #WDD-gpt 2026-09-20 - 有界三线程准备池，失败后重放未完成小块到单线程；旧线程事件不再影响新池。
  private workers: Worker[] = [];
  private lane = 0;
  private lowConcurrency = false;
  private sequence = 0;
  private pending = new Map<number, { request: PreparationRequest; resolve(result: Record<string, PreparedArray>): void; reject(error: Error): void }>();
  private closed = false;
  private lastYield = 0;
  constructor(private readonly signal?: AbortSignal) {
    this.createPool(Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 4) / 4))));
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }
  private createPool(count: number) {
    this.workers = Array.from({ length: count }, () => {
      const worker = Raw4DPreparationClient.idle.pop() ?? new Worker(new URL('./raw4d-preparation.worker.ts', import.meta.url), { type: 'module', name: 'show-dance-texture-preparation' });
      worker.onmessage = ({ data }) => {
        if (this.closed || !this.workers.includes(worker)) return;
        const task = this.pending.get(data.id); if (!task) return;
        if (data.error) { this.fallback(new Error(data.error)); return; }
        this.pending.delete(data.id); task.resolve(data.result);
      };
      worker.onerror = (event) => { if (this.workers.includes(worker)) this.fallback(new Error(event.message || '后台纹理准备 Worker 失败')); };
      return worker;
    });
    this.lane = 0;
  }
  private fallback(error: Error) {
    if (this.closed) return;
    if (this.lowConcurrency) { this.close(error); return; }
    this.lowConcurrency = true;
    this.workers.forEach((worker) => worker.terminate());
    this.createPool(1);
    for (const [id, task] of this.pending) this.post(id, task.request);
  }
  private post(id: number, request: PreparationRequest) {
    try { this.workers[this.lane++ % this.workers.length].postMessage({ id, request }); }
    catch (error) { this.fallback(error instanceof Error ? error : new Error(String(error))); }
  }
  private async chunks(count: number, batch: number, run: (first: number, end: number) => Promise<void>) {
    let next = 0;
    await Promise.all(this.workers.map(async () => {
      while (next < count) { const first = next; next += batch; await run(first, Math.min(first + batch, count)); }
    }));
  }
  private abort = () => this.close(new DOMException('后台准备已取消', 'AbortError'));
  close(error: Error = new DOMException('后台准备已关闭', 'AbortError')) {
    if (this.closed) return; this.closed = true;
    const reusable = this.pending.size === 0 && !this.signal?.aborted && !this.lowConcurrency;
    this.workers.forEach((worker) => {
      if (reusable && Raw4DPreparationClient.idle.length < 9) Raw4DPreparationClient.idle.push(worker);
      else worker.terminate();
    });
    this.signal?.removeEventListener('abort', this.abort);
    this.pending.forEach((task) => task.reject(error)); this.pending.clear();
  }
  async yieldToRenderer() {
    this.signal?.throwIfAborted();
    // #WDD-gpt 2026-09-20 - 合并同一时间片内的小纹理上传，避免每张纹理强制等待一帧。
    if (performance.now() - this.lastYield < 8) return;
    // rAF 后的 macrotask 留出当前帧提交机会；取消不依赖页面仍可见。
    await new Promise<void>((resolve, reject) => {
      let timer = 0;
      const cancel = () => { cancelAnimationFrame(raf); clearTimeout(timer); reject(new DOMException('后台准备已取消', 'AbortError')); };
      const raf = requestAnimationFrame(() => { timer = window.setTimeout(() => { this.signal?.removeEventListener('abort', cancel); resolve(); }, 0); });
      this.signal?.addEventListener('abort', cancel, { once: true });
    });
    this.lastYield = performance.now();
    this.signal?.throwIfAborted();
  }
  private request(request: PreparationRequest): Promise<Record<string, PreparedArray>> {
    if (this.closed) return Promise.reject(new DOMException('后台准备已关闭', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { request, resolve, reject });
      this.post(id, request);
    });
  }
  async resource(asset: Raw4DAsset, shBands: number, receive: (first: number, packed: Record<string, PreparedArray>) => void) {
    await this.chunks(asset.splatCount, 16384, async (first, end) => {
      const chunk: Raw4DAsset = { ...asset, splatCount: end - first, temporalLayout: undefined,
        position: trackSlice(asset.position, first, end, true), rotation: trackSlice(asset.rotation, first, end, true),
        scale: trackSlice(asset.scale, first, end, true), colorDc: trackSlice(asset.colorDc, first, end, true), opacity: trackSlice(asset.opacity, first, end, true),
        shRest: asset.shRest.map((array) => slice(array, first, end)), lifetimeMu: slice(asset.lifetimeMu, first, end), lifetimeW: slice(asset.lifetimeW, first, end),
      };
      receive(first, await this.request({ kind: 'resource', asset: chunk, shBands }));
    });
  }
  // #WDD-gpt 2026-09-20 - 每个点块一次提交所有关键帧槽位，总在途点块仍限制为三个。
  async tracks(tracks: PreparationTrackRequest[], receive: (index: number, first: number, packed: PreparedArray) => void) {
    if (!tracks.length) return;
    const valuesPerPoint = tracks.reduce((sum, task) => sum + task.track.values.length, 0);
    const batch = Math.max(2, Math.min(16384, Math.floor(524288 / Math.max(1, valuesPerPoint) / 2) * 2));
    await this.chunks(tracks[0].track.values[0].length, batch, async (first, end) => {
      const result = await this.request({ kind: 'tracks', tracks: tracks.map((task) => ({ ...task, track: trackSlice(task.track, first, end) })) });
      for (let index = 0; index < tracks.length; index++) receive(index, first, result[String(index)]);
    });
    await this.yieldToRenderer();
  }
  async track(track: Raw4DTrack, components: readonly number[], half: boolean, layout: 'vector' | 'opacity' | 'scalar', receive: (first: number, packed: PreparedArray) => void, preserveHalf = false) {
    // 保持偶数点批量，确保 WebGPU FP16 writeBuffer 偏移和长度均为 4 字节对齐。
    const batch = Math.max(2, Math.min(16384, Math.floor(262144 / Math.max(1, track.values.length) / 2) * 2));
    await this.chunks(track.values[0].length, batch, async (first, end) => {
      const chunk = trackSlice(track, first, end);
      receive(first, (await this.request({ kind: 'track', track: chunk, components, half, layout, preserveHalf })).data);
    });
  }
}
