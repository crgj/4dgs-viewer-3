import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type {
  SmartAlignmentWorkerRequest,
  SmartAlignmentWorkerResponse,
} from './SmartAlignmentWorkerProtocol';

interface SmartAlignmentWorkerScope {
  onmessage: ((event: MessageEvent<SmartAlignmentWorkerRequest>) => void) | null;
  postMessage(message: SmartAlignmentWorkerResponse): void;
  close(): void;
}

const workerScope = globalThis as unknown as SmartAlignmentWorkerScope;
let landmarker: PoseLandmarker | null = null;

function reportError(requestId: number, error: unknown): void {
  workerScope.postMessage({
    type: 'error',
    requestId,
    message: error instanceof Error ? error.message : String(error),
  });
}

async function initialize(
  request: Extract<SmartAlignmentWorkerRequest, { type: 'initialize' }>,
): Promise<void> {
  try {
    if (!landmarker) {
      // #WDD-gpt 2026-08-15 - 模块 Worker 必须加载 ES Module 版 WASM 引导器，经典脚本不会把 ModuleFactory 写入 globalThis。
      const vision = await FilesetResolver.forVisionTasks(request.wasmRoot, true);
      // #WDD-gpt 2026-08-15 - 姿态模型固定在 CPU Worker，避免额外 WebGL 上下文与 4DGS 的 WebGPU/WebGL 渲染竞争。
      landmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: request.modelUrl,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        numPoses: 6,
        minPoseDetectionConfidence: 0.48,
        minPosePresenceConfidence: 0.48,
        minTrackingConfidence: 0.48,
        outputSegmentationMasks: false,
      });
    }
    workerScope.postMessage({ type: 'ready', requestId: request.requestId });
  } catch (error) {
    reportError(request.requestId, error);
  }
}

function detect(request: Extract<SmartAlignmentWorkerRequest, { type: 'detect' }>): void {
  try {
    if (!landmarker) throw new Error('Smart alignment pose model is not initialized.');
    const poseResult = landmarker.detect(request.bitmap);
    const poses = poseResult.landmarks.map((landmarks) => ({
      landmarks: landmarks.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })),
    }));
    workerScope.postMessage({ type: 'detection', requestId: request.requestId, poses, faces: [] });
  } catch (error) {
    reportError(request.requestId, error);
  } finally {
    request.bitmap.close();
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'initialize') {
    void initialize(request);
  } else if (request.type === 'detect') {
    detect(request);
  } else {
    landmarker?.close();
    landmarker = null;
    workerScope.close();
  }
};
