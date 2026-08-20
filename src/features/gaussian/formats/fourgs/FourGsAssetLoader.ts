import type { Raw4DParseProgress } from '../raw4d/Raw4DTypes';
import type { LoadedRaw4DAsset } from '../raw4d/Raw4DAssetLoader';
import type { FourGsLoaderWorkerRequest, FourGsLoaderWorkerResponse } from './FourGsLoaderWorkerProtocol';

interface PendingLoad {
  readonly fileSize: number;
  readonly onProgress?: (progress: Raw4DParseProgress) => void;
  readonly resolve: (asset: LoadedRaw4DAsset) => void;
  readonly reject: (error: Error) => void;
  cleanupAbort(): void;
}

export class FourGsAssetLoader {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingLoad>();
  private readonly backingIds = new Set<string>();
  private nextRequestId = 1;
  private destroyed = false;

  load(file: File, cpuBudgetBytes: number, options: {
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Raw4DParseProgress) => void;
  } = {}): Promise<LoadedRaw4DAsset> {
    if (this.destroyed) return Promise.reject(new Error('4GS asset loader has been destroyed.'));
    this.ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.post({ type: 'cancel', requestId });
        const entry = this.pending.get(requestId);
        if (!entry) return;
        entry.cleanupAbort(); this.pending.delete(requestId);
        reject(new DOMException('4GS import was cancelled.', 'AbortError'));
      };
      const cleanupAbort = () => options.signal?.removeEventListener('abort', abort);
      this.pending.set(requestId, { fileSize: file.size, onProgress: options.onProgress, resolve, reject, cleanupAbort });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      else this.post({ type: 'load', requestId, file, cpuBudgetBytes: Math.max(0, cpuBudgetBytes), preferSharedMemory: true });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [requestId, entry] of this.pending) {
      this.worker?.postMessage({ type: 'cancel', requestId } satisfies FourGsLoaderWorkerRequest);
      entry.cleanupAbort(); entry.reject(new DOMException('4GS asset loader was destroyed.', 'AbortError'));
    }
    this.pending.clear();
    this.backingIds.forEach((bufferId) => this.worker?.postMessage({ type: 'release', bufferId } satisfies FourGsLoaderWorkerRequest));
    this.backingIds.clear(); this.worker?.terminate(); this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./fourgs-loader.worker.ts', import.meta.url), { name: 'fourgs-loader-worker', type: 'module' });
    worker.onmessage = (event: MessageEvent<FourGsLoaderWorkerResponse>) => this.handle(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || '4GS loader worker stopped unexpectedly.');
      this.pending.forEach((entry) => { entry.cleanupAbort(); entry.reject(error); });
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private handle(response: FourGsLoaderWorkerResponse): void {
    const entry = this.pending.get(response.requestId);
    if (!entry) {
      if (response.type === 'loaded') this.post({ type: 'release', bufferId: response.bufferId });
      return;
    }
    if (response.type === 'progress') { entry.onProgress?.(response.progress); return; }
    entry.cleanupAbort(); this.pending.delete(response.requestId);
    if (response.type === 'error') {
      entry.reject(response.name === 'AbortError'
        ? new DOMException(response.message, 'AbortError')
        : Object.assign(new Error(response.message), { name: response.name }));
      return;
    }
    this.backingIds.add(response.bufferId);
    let released = false;
    entry.resolve({
      bufferId: response.bufferId, asset: response.asset, cpuResidentBytes: response.cpuResidentBytes,
      sourceToResidentRatio: entry.fileSize / Math.max(1, response.cpuResidentBytes),
      transport: response.transport, decodeBackend: 'typed-array',
      releaseBacking: () => {
        if (released) return;
        released = true; this.backingIds.delete(response.bufferId); this.post({ type: 'release', bufferId: response.bufferId });
      },
    });
  }

  private post(message: FourGsLoaderWorkerRequest): void {
    if (!this.destroyed) this.ensureWorker().postMessage(message);
  }
}
