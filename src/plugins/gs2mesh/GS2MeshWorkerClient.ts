import type { GS2MeshCaptureResult, GS2MeshData } from './GS2MeshTypes';
import type {
  GS2MeshWorkerRequest,
  GS2MeshWorkerResponse,
  GS2MeshWorkerStage,
} from './GS2MeshWorkerProtocol';

interface PendingReconstruction {
  readonly requestId: number;
  readonly resolve: (data: GS2MeshData) => void;
  readonly reject: (reason: unknown) => void;
  readonly onProgress: (stage: GS2MeshWorkerStage, progress: number) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
}

export class GS2MeshWorkerClient {
  private worker: Worker | null = null;
  private pending: PendingReconstruction | null = null;
  private nextRequestId = 1;

  reconstruct(
    capture: GS2MeshCaptureResult,
    signal: AbortSignal,
    onProgress: (stage: GS2MeshWorkerStage, progress: number) => void,
  ): Promise<GS2MeshData> {
    if (this.pending) return Promise.reject(new Error('GS2Mesh browser reconstruction is already running.'));
    if (signal.aborted) return Promise.reject(new DOMException('GS2Mesh reconstruction was cancelled.', 'AbortError'));
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise<GS2MeshData>((resolve, reject) => {
      const abort = (): void => this.cancel();
      const timeout = setTimeout(() => {
        this.failPending(new Error('浏览器内 GS2Mesh 重建超时，请降低采集宽度或环绕视角数量。'));
      }, 10 * 60 * 1000);
      this.pending = { requestId, resolve, reject, onProgress, timeout, signal, abort };
      signal.addEventListener('abort', abort, { once: true });
      const request: GS2MeshWorkerRequest = { type: 'reconstruct', requestId, capture };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (this.pending) this.failPending(new DOMException('GS2Mesh reconstruction was cancelled.', 'AbortError'));
    this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    if (this.pending) this.failPending(new Error('GS2Mesh plugin was disposed.'));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./gs2mesh.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<GS2MeshWorkerResponse>) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      this.failPending(new Error(event.message || 'GS2Mesh browser Worker failed.'));
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private handleMessage(message: GS2MeshWorkerResponse): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== message.requestId) return;
    if (message.type === 'progress') {
      pending.onProgress(message.stage, Math.max(0, Math.min(1, message.progress)));
      return;
    }
    this.clearPending(pending);
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
      return;
    }
    pending.resolve({
      positions: message.positions,
      normals: message.normals,
      colors: message.colors,
      indices: message.indices,
    });
  }

  private failPending(error: Error | DOMException): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending(pending);
    pending.reject(error);
  }

  private clearPending(pending: PendingReconstruction): void {
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener('abort', pending.abort);
    if (this.pending === pending) this.pending = null;
  }
}
