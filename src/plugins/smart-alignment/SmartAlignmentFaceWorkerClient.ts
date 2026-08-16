import type { SmartAlignmentFace } from './SmartAlignmentTypes';
import type {
  SmartAlignmentWorkerRequest,
  SmartAlignmentWorkerResponse,
} from './SmartAlignmentWorkerProtocol';

interface PendingRequest {
  readonly resolve: (response: SmartAlignmentWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: number;
}

export class SmartAlignmentFaceWorkerClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private initializePromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.request((requestId) => {
      const assetRoot = new URL(import.meta.env.BASE_URL, document.baseURI);
      return {
        type: 'initialize',
        requestId,
        wasmRoot: new URL('plugins/smart-alignment/wasm', assetRoot).href,
        modelUrl: new URL('plugins/smart-alignment/models/pose_landmarker_lite.task', assetRoot).href,
        faceModelUrl: new URL('plugins/smart-alignment/models/face_landmarker.task', assetRoot).href,
      };
    }).then(() => undefined).catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    return this.initializePromise;
  }

  async detect(bitmap: ImageBitmap): Promise<readonly SmartAlignmentFace[]> {
    await this.initialize();
    const response = await this.request(
      (requestId) => ({ type: 'detect', requestId, bitmap }),
      [bitmap],
    );
    if (response.type !== 'detection') throw new Error('Unexpected face worker response.');
    return response.faces;
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'dispose' } satisfies SmartAlignmentWorkerRequest);
    this.worker.terminate();
    this.worker = null;
    this.initializePromise = null;
    this.rejectPending(new Error('Smart alignment face worker was disposed.'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./smart-alignment-face.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<SmartAlignmentWorkerResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.requestId);
      if (!request) return;
      this.pending.delete(response.requestId);
      window.clearTimeout(request.timeoutId);
      if (response.type === 'error') request.reject(new Error(response.message));
      else request.resolve(response);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || '智能对齐人脸 Worker 加载失败，请刷新页面后重试。');
      // #WDD-gpt 2026-08-15 - 人脸 Worker 顶层失败后销毁并清空初始化状态，保证重试会创建全新实例。
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.initializePromise = null;
      this.rejectPending(error);
    };
    this.worker = worker;
    return worker;
  }

  private rejectPending(error: Error): void {
    this.pending.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pending.clear();
  }

  private request(
    createRequest: (requestId: number) => SmartAlignmentWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<SmartAlignmentWorkerResponse> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error('智能对齐人脸 Worker 响应超时，请重试。'));
      }, 90_000);
      this.pending.set(requestId, { resolve, reject, timeoutId });
      try {
        this.ensureWorker().postMessage(createRequest(requestId), transfer);
      } catch (error) {
        this.pending.delete(requestId);
        window.clearTimeout(timeoutId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
