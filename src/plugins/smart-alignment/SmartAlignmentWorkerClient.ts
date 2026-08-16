import type {
  SmartAlignmentDetection,
  SmartAlignmentFace,
  SmartAlignmentLandmark,
  SmartAlignmentPose,
} from './SmartAlignmentTypes';
import type {
  SmartAlignmentWorkerRequest,
  SmartAlignmentWorkerResponse,
} from './SmartAlignmentWorkerProtocol';
import { SmartAlignmentFaceWorkerClient } from './SmartAlignmentFaceWorkerClient';

interface PendingRequest {
  readonly resolve: (response: SmartAlignmentWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: number;
}

export class SmartAlignmentWorkerClient {
  private readonly faceWorker = new SmartAlignmentFaceWorkerClient();
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private initializePromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const poseInitialization = this.request((requestId) => {
      const assetRoot = new URL(import.meta.env.BASE_URL, document.baseURI);
      return {
        type: 'initialize',
        requestId,
        wasmRoot: new URL('plugins/smart-alignment/wasm', assetRoot).href,
        modelUrl: new URL('plugins/smart-alignment/models/pose_landmarker_lite.task', assetRoot).href,
        faceModelUrl: new URL('plugins/smart-alignment/models/face_landmarker.task', assetRoot).href,
      };
    }).then(() => undefined);
    this.initializePromise = Promise.all([
      poseInitialization,
      this.faceWorker.initialize(),
    ]).then(() => undefined).catch((error) => {
      this.initializePromise = null;
      throw error;
    });
    return this.initializePromise;
  }

  async detect(bitmap: ImageBitmap): Promise<SmartAlignmentDetection> {
    await this.initialize();
    const faceSource = await createImageBitmap(bitmap);
    const response = await this.request(
      (requestId) => ({ type: 'detect', requestId, bitmap }),
      [bitmap],
    );
    if (response.type !== 'detection') throw new Error('Unexpected smart alignment worker response.');
    try {
      // #WDD-gpt 2026-08-15 - Gaussian 全景中的脸过小，按姿态身体轴两端裁剪放大，并同时检测 0/180 度以确认真实头端。
      const faces = await this.detectEndpointFaces(faceSource, response.poses);
      return { poses: response.poses, faces };
    } finally {
      faceSource.close();
    }
  }

  dispose(): void {
    this.faceWorker.dispose();
    if (!this.worker) return;
    const request: SmartAlignmentWorkerRequest = { type: 'dispose' };
    this.worker.postMessage(request);
    this.worker.terminate();
    this.worker = null;
    this.initializePromise = null;
    const error = new Error('Smart alignment worker was disposed.');
    this.pending.forEach(({ reject, timeoutId }) => {
      window.clearTimeout(timeoutId);
      reject(error);
    });
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./smart-alignment.worker.ts', import.meta.url), { type: 'module' });
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
      const cause = event.error instanceof Error ? event.error.message : '';
      const location = event.filename
        ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ''})`
        : '';
      const fallback = import.meta.env.DEV
        ? '智能对齐 Worker 加载失败；请刷新页面，若仍失败请重启 npm run dev。'
        : '智能对齐 Worker 加载失败；请确认 Worker、WASM 和模型静态资源可访问。';
      const error = new Error(`${event.message || cause || fallback}${location}`);
      // #WDD-gpt 2026-08-15 - 顶层加载失败后销毁失效 Worker，保证用户点击重试时会创建全新实例而不是永久挂起。
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.pending.forEach(({ reject, timeoutId }) => {
        window.clearTimeout(timeoutId);
        reject(error);
      });
      this.pending.clear();
      this.initializePromise = null;
    };
    this.worker = worker;
    return worker;
  }

  private async detectEndpointFaces(
    source: ImageBitmap,
    poses: readonly SmartAlignmentPose[],
  ): Promise<SmartAlignmentFace[]> {
    const faces: SmartAlignmentFace[] = [];
    for (const pose of poses) {
      const head = this.averageLandmarks(pose.landmarks, [0, 2, 5, 7, 8]);
      const feet = this.averageLandmarks(pose.landmarks, [27, 28, 29, 30, 31, 32]);
      if (!head || !feet) continue;
      const bodySpan = Math.hypot(head.x - feet.x, head.y - feet.y);
      const cropSize = Math.max(80, Math.min(source.width * 0.42, bodySpan * source.width * 0.42));
      const endpoints = [head, feet];
      const scores = await Promise.all(endpoints.map((endpoint) => (
        this.detectEndpointCrop(source, endpoint.x, endpoint.y, cropSize)
      )));
      const winnerIndex = scores[0] >= scores[1] ? 0 : 1;
      const loserIndex = winnerIndex === 0 ? 1 : 0;
      // #WDD-gpt 2026-08-15 - 每个人每个视角只接受一个明确胜出的脸端；两端都像脸或分差不足时整视角弃权。
      if (scores[winnerIndex] < 0.7 || scores[winnerIndex] - scores[loserIndex] < 0.12) continue;
      faces.push({
        x: endpoints[winnerIndex].x,
        y: endpoints[winnerIndex].y,
        width: cropSize / source.width,
        height: cropSize / source.height,
        confidence: scores[winnerIndex],
      });
    }
    return faces;
  }

  private async detectEndpointCrop(
    source: ImageBitmap,
    normalizedX: number,
    normalizedY: number,
    requestedSize: number,
  ): Promise<number> {
    const size = Math.min(requestedSize, source.width, source.height);
    const sourceX = Math.max(0, Math.min(source.width - size, normalizedX * source.width - size * 0.5));
    const sourceY = Math.max(0, Math.min(source.height - size, normalizedY * source.height - size * 0.5));
    const crop = await createImageBitmap(source, sourceX, sourceY, size, size, {
      resizeWidth: 256,
      resizeHeight: 256,
      resizeQuality: 'high',
    });
    const canvas = new OffscreenCanvas(256, 256);
    const context = canvas.getContext('2d');
    if (!context) {
      crop.close();
      return 0;
    }
    context.translate(128, 128);
    context.rotate(Math.PI);
    context.drawImage(crop, -128, -128, 256, 256);
    const rotated = canvas.transferToImageBitmap();
    const [uprightFaces, invertedFaces] = await Promise.all([
      this.faceWorker.detect(crop),
      this.faceWorker.detect(rotated),
    ]);
    return Math.max(
      0,
      ...uprightFaces.map(({ confidence }) => confidence),
      ...invertedFaces.map(({ confidence }) => confidence),
    );
  }

  private averageLandmarks(
    landmarks: readonly SmartAlignmentLandmark[],
    indices: readonly number[],
  ): { x: number; y: number } | null {
    const visible = indices
      .map((index) => landmarks[index])
      .filter((landmark): landmark is SmartAlignmentLandmark => Boolean(
        landmark
        && landmark.visibility >= 0.25
        && Number.isFinite(landmark.x)
        && Number.isFinite(landmark.y),
      ));
    if (visible.length === 0) return null;
    return {
      x: visible.reduce((sum, landmark) => sum + landmark.x, 0) / visible.length,
      y: visible.reduce((sum, landmark) => sum + landmark.y, 0) / visible.length,
    };
  }

  private request(
    createRequest: (requestId: number) => SmartAlignmentWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<SmartAlignmentWorkerResponse> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error('智能对齐 Worker 响应超时，请重试。'));
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
