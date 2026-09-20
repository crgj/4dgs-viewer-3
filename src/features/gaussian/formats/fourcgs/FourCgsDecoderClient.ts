import type { Raw4DAsset } from '../raw4d/Raw4DTypes';
import type { ImportedGaussianAsset } from '../import/GaussianImportTypes';
import { measureRaw4DAssetBytes } from '../raw4d/Raw4DMemoryMetrics';
import type { FourCgsDescriptor, FourCgsProgress } from './FourCgsTypes';

interface WorkerProgressMessage {
  readonly type: 'progress';
  readonly ratio: number;
  readonly message: string;
}

interface WorkerResultMessage {
  readonly type: 'result';
  readonly requestId: number;
  readonly value: unknown;
}

interface WorkerErrorMessage {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

type WorkerResponse = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

export interface FourCgsDecodedSegment {
  readonly file: File;
  readonly backend: 'webgpu' | 'cpu' | 'raw';
  readonly elapsedMs: number;
}

export class FourCgsDecoderClient {
  // #WDD-gpt 2026-09-20 - 展示页只复用一个已完成会话的线程树，reset 先释放大数组，取消或失败绝不进入空闲池。
  private static idle: Worker | null = null;
  private opened = false;
  private messageListener: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private closed = false;
  private progressListener: ((progress: FourCgsProgress) => void) | null = null;

  constructor(private readonly reusable = false) {
    this.worker = this.createWorker();
  }

  // #WDD-gpt 2026-09-20 - 换线程重试时忽略旧线程迟到事件，避免误伤新的请求。
  private createWorker(): Worker {
    const worker = (this.reusable ? FourCgsDecoderClient.idle : null) ?? new Worker(new URL('./fourcgs-decoder.worker.ts', import.meta.url), { type: 'module' });
    if (this.reusable) FourCgsDecoderClient.idle = null;
    this.messageListener = (event: MessageEvent<WorkerResponse>) => {
      if (this.worker === worker && !this.closed) this.handleMessage(event.data);
    };
    this.errorListener = (event: ErrorEvent) => {
      if (this.worker === worker && !this.closed) this.failAll(new Error(event.message || '4CGS 解码 Worker 崩溃。'));
    };
    worker.addEventListener('message', this.messageListener);
    worker.addEventListener('error', this.errorListener);
    return worker;
  }

  // #WDD-gpt 2026-09-20 - 所有片段优先高并发，失败释放整个解码线程树后仅重试一次低并发；取消不重试。
  async open(file: File, onProgress?: (progress: FourCgsProgress) => void, lowConcurrency = false): Promise<FourCgsDescriptor> {
    this.opened = false;
    this.progressListener = onProgress ?? null;
    try {
      const result = await this.request<FourCgsDescriptor>({ type: 'open', file, background: lowConcurrency });
      this.opened = true; return result;
    } catch (error) {
      if (lowConcurrency || this.closed || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      this.worker.terminate();
      this.worker = this.createWorker();
      const reason = error instanceof Error ? error.message : String(error);
      this.progressListener?.({ ratio: 0, message: `高并发解码失败，正在低并发重试：${reason}` });
      try {
        const result = await this.request<FourCgsDescriptor>({ type: 'open', file, background: true });
        this.opened = true; return result;
      } catch (retryError) {
        if (this.closed) throw retryError;
        const retryReason = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`高并发解码失败：${reason}；低并发重试失败：${retryReason}`);
      }
    }
  }

  async getSegment(segmentIndex: number, consume = false, preferGpu = true): Promise<FourCgsDecodedSegment> {
    const result = await this.request<{
      name: string;
      bytes: ArrayBuffer;
      backend: FourCgsDecodedSegment['backend'];
      elapsedMs: number;
    }>({ type: 'segment', segmentIndex, consume, preferGpu });
    return {
      file: new File([result.bytes], `${result.name}.raw4d`, {
        type: 'application/octet-stream',
        lastModified: Date.now(),
      }),
      backend: result.backend,
      elapsedMs: result.elapsedMs,
    };
  }

  // #WDD-gpt 2026-09-20 - 不经临时 File 的内部导入通道；内存租约仍由 ViewportRuntime 注册与回收。
  async getAsset(segmentIndex: number, cpuBudgetBytes: number): Promise<{ file: File; loaded: ImportedGaussianAsset; elapsedMs: number }> {
    const result = await this.request<{ asset: Raw4DAsset; elapsedMs: number; shared: boolean }>({ type: 'asset', segmentIndex, consume: true, cpuBudgetBytes });
    const cpuResidentBytes = measureRaw4DAssetBytes(result.asset);
    return { file: new File([], result.asset.sourceName), elapsedMs: result.elapsedMs,
      loaded: { asset: result.asset, bufferId: `fourcgs-direct-${crypto.randomUUID()}`, cpuResidentBytes,
        sourceToResidentRatio: 1, transport: result.shared ? 'shared-array-buffer' : 'transferable', decodeBackend: 'fp16-bits', format: 'RAW4D',
        releaseBacking() { /* Worker 不保留已返回的列，最后一个 RAM/GPU 租约释放后由 GC 回收。 */ },
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.messageListener) this.worker.removeEventListener('message', this.messageListener);
    if (this.errorListener) this.worker.removeEventListener('error', this.errorListener);
    if (this.reusable && this.opened && this.pending.size === 0 && !FourCgsDecoderClient.idle) {
      this.worker.postMessage({ type: 'reset' });
      FourCgsDecoderClient.idle = this.worker;
    } else this.worker.terminate();
    this.progressListener = null;
    this.failAll(new DOMException('4CGS decoder was closed.', 'AbortError'));
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new DOMException('4CGS decoder is closed.', 'AbortError'));
    const requestId = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...payload, requestId });
    });
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'progress') {
      this.progressListener?.({ ratio: message.ratio, message: message.message });
      return;
    }
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') request.reject(new Error(message.message));
    else request.resolve(message.value);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
