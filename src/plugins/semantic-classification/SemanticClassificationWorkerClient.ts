import type {
  SemanticWorkerRequest,
  SemanticWorkerResponse,
} from './SemanticClassificationWorkerProtocol';
import type { SemanticClassificationBackend } from './SemanticClassificationBackend';

interface PendingRequest {
  readonly resolve: (response: SemanticWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: (progress: Extract<SemanticWorkerResponse, { type: 'progress' }>) => void;
  readonly idleTimeoutMs: number;
  readonly timeoutMessage: string;
  timeoutId: number;
}

export interface SemanticWorkerMask {
  readonly width: number;
  readonly height: number;
  readonly probabilities: Float32Array;
}

export class SemanticClassificationWorkerClient {
  private worker: Worker | null = null;
  private initializePromise: Promise<SemanticClassificationBackend> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;

  initialize(onProgress?: PendingRequest['onProgress']): Promise<SemanticClassificationBackend> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.request(
      (requestId) => ({ type: 'initialize', requestId }),
      [],
      onProgress,
      300_000,
      'CLIPSeg 模型下载或建图连续 5 分钟没有进度，请检查网络后重试。',
    ).then((response) => {
      if (response.type !== 'ready') throw new Error('CLIPSeg Worker 返回了无效初始化结果。');
      return response.backend;
    }).catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    return this.initializePromise;
  }

  async classify(bitmap: ImageBitmap, prompts: readonly string[]): Promise<SemanticWorkerMask> {
    await this.initialize();
    const response = await this.request(
      (requestId) => ({ type: 'classify', requestId, bitmap, prompts }),
      [bitmap],
      undefined,
      180_000,
      'CLIPSeg 单视角推理连续 3 分钟没有完成，请降低 Tag 数量后重试。',
    );
    if (response.type !== 'result') throw new Error('CLIPSeg Worker 返回了无效分割结果。');
    return response;
  }

  dispose(): void {
    if (this.worker) {
      const request: SemanticWorkerRequest = { type: 'dispose' };
      this.worker.postMessage(request);
      this.worker.terminate();
    }
    this.worker = null;
    this.initializePromise = null;
    const error = new Error('CLIPSeg Worker 已停止。');
    this.pending.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./semantic-classification.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SemanticWorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      if (response.type === 'progress') {
        this.refreshRequestTimeout(response.requestId, pending);
        pending.onProgress?.(response);
        return;
      }
      this.pending.delete(response.requestId);
      window.clearTimeout(pending.timeoutId);
      if (response.type === 'error') pending.reject(new Error(response.message));
      else pending.resolve(response);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || 'CLIPSeg Worker 启动失败。');
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.initializePromise = null;
      this.pending.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  private request(
    createRequest: (requestId: number) => SemanticWorkerRequest,
    transfer: Transferable[],
    onProgress: PendingRequest['onProgress'],
    idleTimeoutMs: number,
    timeoutMessage: string,
  ): Promise<SemanticWorkerResponse> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        onProgress,
        idleTimeoutMs,
        timeoutMessage,
        timeoutId: 0,
      };
      this.pending.set(requestId, pending);
      pending.timeoutId = this.createRequestTimeout(requestId, pending);
      this.ensureWorker().postMessage(createRequest(requestId), transfer);
    });
  }

  // #WDD-gpt 2026-08-26 - 大模型下载按“连续无进度”计时；每次收到字节进度就续期，避免慢速但健康的 139MB 下载被固定总时限中断并从头重来。
  private refreshRequestTimeout(requestId: number, pending: PendingRequest): void {
    window.clearTimeout(pending.timeoutId);
    pending.timeoutId = this.createRequestTimeout(requestId, pending);
  }

  private createRequestTimeout(requestId: number, pending: PendingRequest): number {
    return window.setTimeout(() => {
      if (this.pending.get(requestId) !== pending) return;
      this.pending.delete(requestId);
      pending.reject(new Error(pending.timeoutMessage));
    }, pending.idleTimeoutMs);
  }
}
