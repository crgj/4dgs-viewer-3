const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const DEFAULT_CHUNK_BYTES = 64 * MIB;
const MIN_TARGET_BYTES = 64 * MIB;
const MAX_TARGET_BYTES = 32 * GIB;

export type BrowserMemoryPressureResultStatus = 'success' | 'allocation-failed' | 'cancelled' | 'worker-error';

export interface BrowserMemoryPressureProgress {
  readonly confirmedBytes: number;
  readonly targetBytes: number;
  readonly elapsedMs: number;
}

export interface BrowserMemoryPressureResult extends BrowserMemoryPressureProgress {
  readonly status: BrowserMemoryPressureResultStatus;
  readonly error?: string;
  readonly completedAt: number;
}

export interface BrowserMemoryPressureStartRequest {
  readonly type: 'start';
  readonly runId: number;
  readonly targetBytes: number;
  readonly chunkBytes: number;
}

export interface BrowserMemoryPressureCancelRequest {
  readonly type: 'cancel';
  readonly runId: number;
}

export type BrowserMemoryPressureWorkerRequest = BrowserMemoryPressureStartRequest | BrowserMemoryPressureCancelRequest;

export type BrowserMemoryPressureWorkerResponse =
  | ({ readonly type: 'progress'; readonly runId: number } & BrowserMemoryPressureProgress)
  | ({ readonly type: 'complete'; readonly runId: number } & Omit<BrowserMemoryPressureResult, 'completedAt'>);

export const MEMORY_PRESSURE_TARGET_GIB = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;

export function normalizeMemoryPressureOptions(targetBytes: number, chunkBytes = DEFAULT_CHUNK_BYTES): {
  readonly targetBytes: number;
  readonly chunkBytes: number;
} {
  const target = Math.max(MIN_TARGET_BYTES, Math.min(MAX_TARGET_BYTES, Math.floor(targetBytes)));
  const chunk = Math.max(16 * MIB, Math.min(256 * MIB, Math.floor(chunkBytes), target));
  return { targetBytes: target, chunkBytes: chunk };
}

// #WDD-gpt 2026-08-16 - 压力测试始终在独立 Worker 内执行；终止 Worker 会立即归还全部测试缓冲区，不污染编辑器数据池。
export class BrowserMemoryPressureTestClient {
  private worker: Worker | null = null;
  private resolveResult: ((result: BrowserMemoryPressureResult) => void) | null = null;
  private runId = 0;
  private lastProgress: BrowserMemoryPressureProgress = { confirmedBytes: 0, targetBytes: 0, elapsedMs: 0 };

  start(
    targetBytes: number,
    onProgress?: (progress: BrowserMemoryPressureProgress) => void,
  ): Promise<BrowserMemoryPressureResult> {
    if (this.worker) throw new Error('A browser memory pressure test is already running.');
    const options = normalizeMemoryPressureOptions(targetBytes);
    const runId = ++this.runId;
    const worker = new Worker(new URL('./browser-memory-pressure.worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.lastProgress = { confirmedBytes: 0, targetBytes: options.targetBytes, elapsedMs: 0 };

    return new Promise((resolve) => {
      this.resolveResult = resolve;
      worker.onmessage = (event: MessageEvent<BrowserMemoryPressureWorkerResponse>) => {
        if (event.data.runId !== runId) return;
        if (event.data.type === 'progress') {
          this.lastProgress = event.data;
          onProgress?.(event.data);
          return;
        }
        this.finish({ ...event.data, completedAt: Date.now() });
      };
      worker.onerror = (event) => {
        event.preventDefault();
        this.finish({
          ...this.lastProgress,
          status: 'worker-error',
          error: event.message || 'Memory pressure Worker stopped unexpectedly.',
          completedAt: Date.now(),
        });
      };
      worker.postMessage({
        type: 'start',
        runId,
        targetBytes: options.targetBytes,
        chunkBytes: options.chunkBytes,
      } satisfies BrowserMemoryPressureStartRequest);
    });
  }

  cancel(): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'cancel', runId: this.runId } satisfies BrowserMemoryPressureCancelRequest);
  }

  dispose(): void {
    if (!this.worker) return;
    this.finish({
      ...this.lastProgress,
      status: 'cancelled',
      completedAt: Date.now(),
    });
  }

  private finish(result: BrowserMemoryPressureResult): void {
    const resolve = this.resolveResult;
    this.worker?.terminate();
    this.worker = null;
    this.resolveResult = null;
    resolve?.(result);
  }
}
