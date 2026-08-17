import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type {
  SmartAlignmentWorkerRequest,
  SmartAlignmentWorkerResponse,
} from './SmartAlignmentWorkerProtocol';
import {
  restoreSmartAlignmentPoseRotation,
  type SmartAlignmentImageRotation,
} from './SmartAlignmentPoseRotation';
import type { SmartAlignmentPose } from './SmartAlignmentTypes';

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

function detectPoses(source: ImageBitmap | OffscreenCanvas): SmartAlignmentPose[] {
  if (!landmarker) throw new Error('Smart alignment pose model is not initialized.');
  const poseResult = landmarker.detect(source);
  return poseResult.landmarks.map((landmarks) => ({
    landmarks: landmarks.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })),
  }));
}

function createRotatedPoseSource(
  bitmap: ImageBitmap,
  rotation: Exclude<SmartAlignmentImageRotation, 0>,
): OffscreenCanvas {
  const swapDimensions = Math.abs(rotation) === 90;
  const canvas = new OffscreenCanvas(
    swapDimensions ? bitmap.height : bitmap.width,
    swapDimensions ? bitmap.width : bitmap.height,
  );
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Smart alignment cannot create a rotated pose canvas.');
  if (rotation === 90) {
    context.translate(bitmap.height, 0);
    context.rotate(Math.PI / 2);
  } else if (rotation === -90) {
    context.translate(0, bitmap.width);
    context.rotate(-Math.PI / 2);
  } else {
    context.translate(bitmap.width, bitmap.height);
    context.rotate(Math.PI);
  }
  context.drawImage(bitmap, 0, 0);
  return canvas;
}

function detect(request: Extract<SmartAlignmentWorkerRequest, { type: 'detect' }>): void {
  try {
    if (!landmarker) throw new Error('Smart alignment pose model is not initialized.');
    let poses = detectPoses(request.bitmap);
    // #WDD-gpt 2026-08-17 - 未知世界朝上方向会让人物横置或倒置；常规检测为零时在 Worker 内旋转截图重试，命中后再恢复原图坐标。
    for (const rotation of [90, -90, 180] as const) {
      if (poses.length > 0) break;
      const rotatedPoses = detectPoses(createRotatedPoseSource(request.bitmap, rotation));
      if (rotatedPoses.length > 0) {
        poses = restoreSmartAlignmentPoseRotation(rotatedPoses, rotation);
      }
    }
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
