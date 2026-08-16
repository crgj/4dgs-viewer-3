import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type {
  SmartAlignmentWorkerRequest,
  SmartAlignmentWorkerResponse,
} from './SmartAlignmentWorkerProtocol';

interface SmartAlignmentFaceWorkerScope {
  onmessage: ((event: MessageEvent<SmartAlignmentWorkerRequest>) => void) | null;
  postMessage(message: SmartAlignmentWorkerResponse): void;
  close(): void;
}

const workerScope = globalThis as unknown as SmartAlignmentFaceWorkerScope;
let detector: FaceLandmarker | null = null;

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
    if (!detector) {
      // #WDD-gpt 2026-08-15 - Face Landmarker 使用独立 Worker 与 WASM factory，完整人脸网格用于排除靴子等假阳性。
      const vision = await FilesetResolver.forVisionTasks(request.wasmRoot, true);
      detector = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: request.faceModelUrl,
          delegate: 'CPU',
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    }
    workerScope.postMessage({ type: 'ready', requestId: request.requestId });
  } catch (error) {
    detector?.close();
    detector = null;
    reportError(request.requestId, error);
  }
}

function detect(request: Extract<SmartAlignmentWorkerRequest, { type: 'detect' }>): void {
  try {
    if (!detector) throw new Error('Smart alignment face model is not initialized.');
    const result = detector.detect(request.bitmap);
    const faces = result.faceLandmarks.flatMap((landmarks) => {
      if (landmarks.length < 400) return [];
      const minX = Math.min(...landmarks.map(({ x }) => x));
      const maxX = Math.max(...landmarks.map(({ x }) => x));
      const minY = Math.min(...landmarks.map(({ y }) => y));
      const maxY = Math.max(...landmarks.map(({ y }) => y));
      return [{
        x: (minX + maxX) * 0.5,
        y: (minY + maxY) * 0.5,
        width: maxX - minX,
        height: maxY - minY,
        confidence: 0.98,
      }];
    });
    workerScope.postMessage({ type: 'detection', requestId: request.requestId, poses: [], faces });
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
    detector?.close();
    detector = null;
    workerScope.close();
  }
};
