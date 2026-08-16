import type { GS2MeshData, GS2MeshGaussianFieldInput } from './GS2MeshTypes';
import type {
  GS2MeshOpacityWorkerRequest,
  GS2MeshOpacityWorkerResponse,
  GS2MeshOpacityWorkerStage,
} from './GS2MeshOpacityWorkerProtocol';

export interface GS2MeshOpacityReconstruction {
  readonly mesh: GS2MeshData;
  readonly backend: string;
}

interface PendingOpacityReconstruction {
  readonly requestId: number;
  readonly resolve: (data: GS2MeshOpacityReconstruction) => void;
  readonly reject: (reason: unknown) => void;
  readonly onProgress: (stage: GS2MeshOpacityWorkerStage, progress: number) => void;
  readonly onPreview: (data: GS2MeshData, backend: string, elapsedMs: number) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  readonly abort: () => void;
  lastStage: GS2MeshOpacityWorkerStage;
  lastProgress: number;
  previewReceived: boolean;
  readonly gaussianCount: number;
  readonly fieldResolution: number;
  readonly targetVoxelMillimeters?: number;
  readonly input: GS2MeshGaussianFieldInput;
  submitted: boolean;
  workerStarted: boolean;
}

export class GS2MeshOpacityWorkerCrashError extends Error {
  readonly previewReceived: boolean;

  constructor(message: string, previewReceived: boolean) {
    super(message);
    this.name = 'GS2MeshOpacityWorkerCrashError';
    this.previewReceived = previewReceived;
  }
}

export class GS2MeshOpacityWorkerClient {
  private worker: Worker | null = null;
  private workerReady = false;
  private pending: PendingOpacityReconstruction | null = null;
  private nextRequestId = 1;

  reconstruct(
    input: GS2MeshGaussianFieldInput,
    signal: AbortSignal,
    onProgress: (stage: GS2MeshOpacityWorkerStage, progress: number) => void,
    onPreview: (data: GS2MeshData, backend: string, elapsedMs: number) => void,
  ): Promise<GS2MeshOpacityReconstruction> {
    if (this.pending) return Promise.reject(new Error('GS2Mesh opacity reconstruction is already running.'));
    if (signal.aborted) return Promise.reject(new DOMException('GS2Mesh reconstruction was cancelled.', 'AbortError'));
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId++;
    return new Promise<GS2MeshOpacityReconstruction>((resolve, reject) => {
      const abort = (): void => this.cancel();
      const timeout = setTimeout(() => {
        this.failPending(new Error('浏览器不透明度场重建超时，请将目标叶子体素调到 2 mm，或将 Gaussian 上限降到 40K。'));
        this.resetWorker(worker);
      }, 10 * 60 * 1000);
      this.pending = {
        requestId,
        resolve,
        reject,
        onProgress,
        onPreview,
        timeout,
        signal,
        abort,
        lastStage: 'matching',
        lastProgress: 0,
        previewReceived: false,
        gaussianCount: input.positions.length / 3,
        fieldResolution: input.fieldResolution,
        targetVoxelMillimeters: input.targetVoxelMillimeters,
        input,
        submitted: false,
        workerStarted: false,
      };
      signal.addEventListener('abort', abort, { once: true });
      // #WDD-gpt 2026-08-15 - Wait for a module-level ready handshake before transferring the full frame so startup failures cannot masquerade as reconstruction OOM.
      if (this.workerReady) this.submitPending(worker, this.pending);
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
    const worker = new Worker(new URL('./gs2mesh-opacity.worker.ts', import.meta.url), { type: 'module' });
    this.workerReady = false;
    worker.onmessage = (event: MessageEvent<GS2MeshOpacityWorkerResponse>) => this.handleMessage(worker, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.failWorker(worker, event.message, event.filename, event.lineno, event.colno);
    };
    worker.onmessageerror = () => this.failWorker(worker, '主线程无法解析 Worker 返回的网格数据。');
    this.worker = worker;
    return worker;
  }

  private handleMessage(worker: Worker, message: GS2MeshOpacityWorkerResponse): void {
    if (message.type === 'ready') {
      if (this.worker !== worker) return;
      this.workerReady = true;
      const pending = this.pending;
      if (pending) {
        pending.workerStarted = true;
        this.submitPending(worker, pending);
      }
      return;
    }
    const pending = this.pending;
    if (!pending || pending.requestId !== message.requestId) return;
    if (message.type === 'progress') {
      pending.lastStage = message.stage;
      pending.lastProgress = Math.max(0, Math.min(1, message.progress));
      pending.onProgress(message.stage, Math.max(0, Math.min(1, message.progress)));
      return;
    }
    if (message.type === 'preview') {
      pending.previewReceived = true;
      pending.lastStage = 'fusing';
      pending.onPreview({
        positions: message.positions,
        normals: message.normals,
        colors: message.colors,
        indices: message.indices,
      }, message.backend, message.elapsedMs);
      return;
    }
    this.clearPending(pending);
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
      return;
    }
    pending.resolve({
      mesh: {
        positions: message.positions,
        normals: message.normals,
        colors: message.colors,
        indices: message.indices,
      },
      backend: message.backend ?? 'Frontend Gaussian opacity refinement',
    });
  }

  private submitPending(worker: Worker, pending: PendingOpacityReconstruction): void {
    if (pending.submitted || this.pending !== pending || this.worker !== worker) return;
    pending.submitted = true;
    pending.workerStarted = true;
    const { input } = pending;
    const request: GS2MeshOpacityWorkerRequest = { type: 'reconstruct-opacity', requestId: pending.requestId, input };
    // #WDD-gpt 2026-08-15 - 将当前帧参数所有权直接转交 Worker，避免复制数十万 Gaussian 数组。
    try {
      worker.postMessage(request, [
        input.positions.buffer,
        input.rotations.buffer,
        input.scales.buffer,
        input.colors.buffer,
        input.opacities.buffer,
      ]);
    } catch (error) {
      // #WDD-gpt 2026-08-15 - A synchronous structured-clone failure must clear the pending slot so Retry creates a clean Worker request.
      this.failPending(error instanceof Error ? error : new Error(String(error)));
      this.resetWorker(worker);
    }
  }

  private failPending(error: Error | DOMException): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending(pending);
    pending.reject(error);
  }

  private failWorker(
    worker: Worker,
    rawMessage = '',
    filename = '',
    line = 0,
    column = 0,
  ): void {
    const pending = this.pending;
    if (pending) {
      const stage = !pending.workerStarted ? '启动' : pending.previewReceived ? '毫米级细化' : '快速预览';
      const target = pending.targetVoxelMillimeters
        ? `${pending.targetVoxelMillimeters} mm`
        : `${pending.fieldResolution}³`;
      const source = filename ? `（${filename.split('/').at(-1)}:${line}:${column}）` : '';
      const detail = rawMessage.trim()
        ? `${rawMessage.trim()}${source}`
        : !pending.workerStarted
          ? 'Worker 模块没有完成启动；开发环境通常是 Vite 依赖缓存过期，而不是网格内存不足'
          : '浏览器未返回 JS 异常，通常表示 Worker 被内存上限直接终止';
      const recovery = !pending.workerStarted
        ? '请重新启动当前 5173 前端以重建依赖缓存'
        : pending.previewReceived
        ? '建议改用 2 mm 或 40K Gaussian 后重试'
        : '快速预览现已固定为 72³ / 12K Gaussian；请强制刷新页面以加载新的 Worker 后重试';
      // #WDD-gpt 2026-08-15 - Replace the opaque Worker error with the last confirmed phase and request size so users can recover without opening DevTools.
      this.failPending(new GS2MeshOpacityWorkerCrashError(
        `GS2Mesh ${stage} Worker 异常终止：${detail}。当前 ${pending.gaussianCount.toLocaleString()} Gaussian / ${target} / ${Math.round(pending.lastProgress * 100)}%。${recovery}。`,
        pending.previewReceived,
      ));
    }
    this.resetWorker(worker);
  }

  private resetWorker(worker: Worker): void {
    worker.terminate();
    if (this.worker === worker) {
      this.worker = null;
      this.workerReady = false;
    }
  }

  private clearPending(pending: PendingOpacityReconstruction): void {
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener('abort', pending.abort);
    if (this.pending === pending) this.pending = null;
  }
}
