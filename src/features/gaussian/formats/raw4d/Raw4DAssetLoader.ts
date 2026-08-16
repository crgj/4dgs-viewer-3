import type { Raw4DAsset, Raw4DParseProgress } from './Raw4DTypes';
import type {
  Raw4DLoaderWorkerRequest,
  Raw4DLoaderWorkerResponse,
} from './Raw4DLoaderWorkerProtocol';

export interface LoadedRaw4DAsset {
  readonly bufferId: string;
  readonly asset: Raw4DAsset;
  readonly cpuResidentBytes: number;
  readonly sourceToResidentRatio: number;
  readonly transport: 'shared-array-buffer' | 'transferable';
  readonly decodeBackend: 'wasm' | 'fp16-bits' | 'typed-array';
  releaseBacking(): void;
}

interface Raw4DPendingLoad {
  readonly fileSize: number;
  readonly onProgress?: (progress: Raw4DParseProgress) => void;
  readonly resolve: (asset: LoadedRaw4DAsset) => void;
  readonly reject: (error: Error) => void;
  cleanupAbort(): void;
}

export class Raw4DAssetLoader {
  private worker: Worker | null = null;
  private readonly pendingLoads = new Map<number, Raw4DPendingLoad>();
  private readonly backingBufferIds = new Set<string>();
  private nextRequestId = 1;
  private destroyed = false;

  load(
    file: File,
    cpuBudgetBytes: number,
    options: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: Raw4DParseProgress) => void;
    } = {},
  ): Promise<LoadedRaw4DAsset> {
    if (this.destroyed) return Promise.reject(new Error('RAW4D asset loader has been destroyed.'));
    this.ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.post({ type: 'cancel', requestId });
        const pending = this.pendingLoads.get(requestId);
        if (!pending) return;
        pending.cleanupAbort();
        this.pendingLoads.delete(requestId);
        reject(new DOMException('RAW4D import was cancelled.', 'AbortError'));
      };
      const cleanupAbort = () => options.signal?.removeEventListener('abort', abort);
      this.pendingLoads.set(requestId, {
        fileSize: file.size,
        onProgress: options.onProgress,
        resolve,
        reject,
        cleanupAbort,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      // #WDD-gpt 2026-08-15 - RAW4D Loader 只负责格式解码，内存驻留和 GPU 预算交给通用协调器。
      this.post({
        type: 'load',
        requestId,
        file,
        cpuBudgetBytes: Math.max(0, cpuBudgetBytes),
        preferSharedMemory: true,
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const [requestId, pending] of this.pendingLoads) {
      this.worker?.postMessage({ type: 'cancel', requestId } satisfies Raw4DLoaderWorkerRequest);
      pending.cleanupAbort();
      pending.reject(new DOMException('RAW4D asset loader was destroyed.', 'AbortError'));
    }
    this.pendingLoads.clear();
    for (const bufferId of this.backingBufferIds) {
      this.worker?.postMessage({ type: 'release', bufferId } satisfies Raw4DLoaderWorkerRequest);
    }
    this.backingBufferIds.clear();
    this.worker?.terminate();
    this.worker = null;
    this.destroyed = true;
  }

  private handleMessage(response: Raw4DLoaderWorkerResponse): void {
    const pending = this.pendingLoads.get(response.requestId);
    if (!pending) {
      if (response.type === 'loaded') this.post({ type: 'release', bufferId: response.bufferId });
      return;
    }
    if (response.type === 'progress') {
      pending.onProgress?.(response.progress);
      return;
    }

    pending.cleanupAbort();
    this.pendingLoads.delete(response.requestId);
    if (response.type === 'error') {
      const error = response.name === 'AbortError'
        ? new DOMException(response.message, 'AbortError')
        : Object.assign(new Error(response.message), { name: response.name });
      pending.reject(error);
      return;
    }

    this.backingBufferIds.add(response.bufferId);
    let released = false;
    pending.resolve({
      bufferId: response.bufferId,
      asset: response.asset,
      cpuResidentBytes: response.cpuResidentBytes,
      sourceToResidentRatio: pending.fileSize / Math.max(1, response.cpuResidentBytes),
      transport: response.transport,
      decodeBackend: response.decodeBackend,
      releaseBacking: () => {
        if (released) return;
        released = true;
        this.backingBufferIds.delete(response.bufferId);
        this.post({ type: 'release', bufferId: response.bufferId });
      },
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./raw4d-loader.worker.ts', import.meta.url), {
      name: 'raw4d-loader-worker',
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<Raw4DLoaderWorkerResponse>) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || 'RAW4D loader worker stopped unexpectedly.');
      for (const [requestId, pending] of this.pendingLoads) {
        pending.cleanupAbort();
        pending.reject(error);
        this.pendingLoads.delete(requestId);
      }
    };
    this.worker = worker;
    return worker;
  }

  private post(message: Raw4DLoaderWorkerRequest): void {
    if (!this.destroyed) this.ensureWorker().postMessage(message);
  }
}
