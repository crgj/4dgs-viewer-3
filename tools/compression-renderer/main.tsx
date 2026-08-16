import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { detectAutomaticGaussian4DMemoryPolicy } from '../../src/features/gaussian/memory/Gaussian4DMemoryPolicy';
import { GaussianViewport } from '../../src/features/viewport/components/GaussianViewport';
import {
  type EvaluationCameraPose,
  type ViewportMemoryUsage,
  type ViewportRuntime,
  type ViewportSelectionState,
  type ViewportStatus,
  type ViewportTransform,
} from '../../src/features/viewport/runtime/ViewportRuntime';
import './styles.css';

type CameraRecord = {
  readonly img_name: string;
  readonly width: number;
  readonly position: EvaluationCameraPose['position'];
  readonly rotation: EvaluationCameraPose['rotation'];
  readonly fx: number;
};

type SampleMetric = {
  readonly cameraIndex: number;
  readonly cameraName: string;
  readonly frame: number;
  readonly mse: number;
  readonly psnr: number | null;
  readonly maxAbsoluteError: number;
  readonly sourceNonBlackPixels: number;
};

const initialStatus: ViewportStatus = {
  phase: 'initializing',
  renderer: 'Initializing',
  splatCount: 0,
};

const memoryPolicy = detectAutomaticGaussian4DMemoryPolicy();
const identityTransform: ViewportTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};
const ignoreMemory = (_memory: ViewportMemoryUsage) => undefined;
const ignoreTransform = (_transform: ViewportTransform) => undefined;
// #WDD-gpt 2026-08-16 - 压缩评测不使用选择工具状态，但显式满足 Viewport 新增的受控选择接口。
const ignoreSelection = (_selection: ViewportSelectionState) => undefined;
// #WDD-gpt 2026-08-15 - 独立压缩评测不启用重光照，但仍显式接收 Viewport 新增的状态回调以保持构建隔离。
const ignoreRelighting = () => undefined;

const nextPaint = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
});

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, milliseconds);
});

function assetName(path: string): string {
  return path.split('/').pop() || 'evaluation.raw4d';
}

function captureCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas PNG export failed')), 'image/png');
  });
}

async function captureRenderableCanvas(canvas: HTMLCanvasElement, settleMilliseconds: number): Promise<Blob> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const blob = await captureCanvas(canvas);
    const pixels = await readBlobPixels(blob);
    let visiblePixels = 0;
    for (let pixel = 0; pixel < pixels.width * pixels.height; pixel += 1) {
      const offset = pixel * 4;
      if (pixels.data[offset] + pixels.data[offset + 1] + pixels.data[offset + 2] > 48) visiblePixels += 1;
    }
    if (visiblePixels >= 64) return blob;
    await wait(Math.max(500, settleMilliseconds));
    await nextPaint();
  }
  throw new Error('Renderer remained blank after five readiness retries');
}

async function readBlobPixels(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  const copy = document.createElement('canvas');
  copy.width = bitmap.width;
  copy.height = bitmap.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('2D canvas is unavailable');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, copy.width, copy.height);
}

async function compareBlobs(source: Blob, decoded: Blob) {
  const [left, right] = await Promise.all([readBlobPixels(source), readBlobPixels(decoded)]);
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(`Canvas size mismatch: ${left.width}x${left.height} vs ${right.width}x${right.height}`);
  }
  let squaredError = 0;
  let maxAbsoluteError = 0;
  let sourceNonBlackPixels = 0;
  for (let pixel = 0; pixel < left.width * left.height; pixel += 1) {
    const offset = pixel * 4;
    if (left.data[offset] + left.data[offset + 1] + left.data[offset + 2] > 48) {
      sourceNonBlackPixels += 1;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = left.data[offset + channel] - right.data[offset + channel];
      squaredError += difference * difference;
      maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(difference));
    }
  }
  const valueCount = left.width * left.height * 3;
  const mse = squaredError / valueCount;
  return {
    width: left.width,
    height: left.height,
    squaredError,
    valueCount,
    mse,
    psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
    maxAbsoluteError,
    sourceNonBlackPixels,
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('PNG data URL export failed'));
    reader.readAsDataURL(blob);
  });
}

function CompressionRenderer() {
  const sourcePanelRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<'awaiting-source' | 'capturing-source' | 'awaiting-decoded' | 'capturing-decoded' | 'complete'>('awaiting-source');
  const sourceCapturesRef = useRef<Array<{
    readonly cameraIndex: number;
    readonly cameraName: string;
    readonly frame: number;
    readonly blob: Blob;
  }>>([]);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [decodedFile, setDecodedFile] = useState<File | null>(null);
  const [activeFile, setActiveFile] = useState<File | null>(null);
  const [cameras, setCameras] = useState<CameraRecord[]>([]);
  const [runtime, setRuntime] = useState<ViewportRuntime | null>(null);
  const [status, setStatus] = useState<ViewportStatus>(initialStatus);
  const [result, setResult] = useState('');
  const [worstSource, setWorstSource] = useState('');
  const [worstDecoded, setWorstDecoded] = useState('');

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const sourcePath = query.get('source');
    const decodedPath = query.get('decoded');
    const camerasPath = query.get('cameras');
    if (!sourcePath || !decodedPath || !camerasPath) {
      setResult(JSON.stringify({ error: 'source, decoded and cameras query parameters are required' }));
      document.documentElement.dataset.status = 'error';
      return;
    }
    // #WDD-gpt 2026-08-15 - 压缩验收资产只由独立渲染程序读取，不进入用户编辑器页面。
    void Promise.all([
      fetch(sourcePath).then((response) => response.arrayBuffer()),
      fetch(decodedPath).then((response) => response.arrayBuffer()),
      fetch(camerasPath).then((response) => response.json() as Promise<CameraRecord[]>),
    ]).then(([sourceBuffer, decodedBuffer, cameraRecords]) => {
      const uniqueCameras = cameraRecords.filter((camera, index, all) => (
        all.findIndex((candidate) => candidate.img_name === camera.img_name) === index
      ));
      const requestedCameraLimit = Math.max(1, Number.parseInt(query.get('cameraLimit') || `${uniqueCameras.length}`, 10));
      // #WDD-gpt 2026-08-15 - 抽查模式按完整相机序列等距取样，避免只测相邻视角造成虚高 PSNR。
      const sampledCameras = requestedCameraLimit < uniqueCameras.length
        ? Array.from({ length: requestedCameraLimit }, (_, index) => uniqueCameras[Math.floor(index * uniqueCameras.length / requestedCameraLimit)])
        : uniqueCameras;
      const nextSourceFile = new File([sourceBuffer], assetName(sourcePath), { type: 'application/octet-stream' });
      const nextDecodedFile = new File([decodedBuffer], assetName(decodedPath), { type: 'application/octet-stream' });
      setSourceFile(nextSourceFile);
      setDecodedFile(nextDecodedFile);
      setActiveFile(nextSourceFile);
      setCameras(sampledCameras);
    }).catch((error: unknown) => {
      setResult(JSON.stringify({ error: String(error) }));
      document.documentElement.dataset.status = 'error';
    });
  }, []);

  useEffect(() => {
    if (!runtime || !sourceFile || !decodedFile || cameras.length === 0 || status.phase !== 'ready') return;
    const query = new URLSearchParams(window.location.search);
    const frames = (query.get('frames') || '0,10,20,30')
      .split(',')
      .map(Number)
      .filter((frame) => Number.isInteger(frame) && frame >= 0);
    const settleMilliseconds = Math.max(120, Number(query.get('settle')) || 300);
    const canvas = sourcePanelRef.current?.querySelector('canvas');
    if (!canvas) return;

    const capturePlan = async () => {
      const captures: Array<{
        readonly cameraIndex: number;
        readonly cameraName: string;
        readonly frame: number;
        readonly blob: Blob;
      }> = [];
      // #WDD-gpt 2026-08-16 - 大 RAW4D 报告 ready 后仍给相机控制器一个稳定周期，避免首个评测姿态早于相机初始化。
      await wait(settleMilliseconds);
      await nextPaint();
      for (let cameraIndex = 0; cameraIndex < cameras.length; cameraIndex += 1) {
        const camera = cameras[cameraIndex];
        const pose: EvaluationCameraPose = {
          position: camera.position,
          rotation: camera.rotation,
          fx: camera.fx,
          sourceWidth: camera.width,
        };
        for (const frame of frames) {
          runtime.setEvaluationCamera(pose);
          runtime.setFrame(frame);
          await nextPaint();
          await wait(settleMilliseconds);
          captures.push({
            cameraIndex,
            cameraName: camera.img_name,
            frame,
            // #WDD-gpt 2026-08-16 - GPU 资源 ready 与首个可见帧之间存在一拍延迟，黑帧必须重试，不能污染压缩 PSNR。
            blob: await captureRenderableCanvas(canvas, settleMilliseconds),
          });
        }
      }
      return captures;
    };

    if (phaseRef.current === 'awaiting-source' && status.sourceName === sourceFile.name) {
      phaseRef.current = 'capturing-source';
      document.documentElement.dataset.status = 'capturing-source';
      void capturePlan().then((captures) => {
        sourceCapturesRef.current = captures;
        phaseRef.current = 'awaiting-decoded';
        document.documentElement.dataset.status = 'loading-decoded';
        setActiveFile(decodedFile);
      }).catch((error: unknown) => {
        setResult(JSON.stringify({ error: String(error) }));
        document.documentElement.dataset.status = 'error';
      });
      return;
    }

    if (phaseRef.current !== 'awaiting-decoded' || status.sourceName !== decodedFile.name) return;
    phaseRef.current = 'capturing-decoded';
    document.documentElement.dataset.status = 'capturing-decoded';

    void (async () => {
      const sourceCaptures = sourceCapturesRef.current;
      if (sourceCaptures.length !== cameras.length * frames.length) {
        throw new Error(`Source capture count mismatch: ${sourceCaptures.length}`);
      }
      const metrics: SampleMetric[] = [];
      let totalSquaredError = 0;
      let totalValueCount = 0;
      let worstPsnr = Number.POSITIVE_INFINITY;
      let worstSourceBlob: Blob | null = null;
      let worstDecodedBlob: Blob | null = null;

      for (let sampleIndex = 0; sampleIndex < sourceCaptures.length; sampleIndex += 1) {
        const sourceCapture = sourceCaptures[sampleIndex];
        const camera = cameras[sourceCapture.cameraIndex];
        const pose: EvaluationCameraPose = {
          position: camera.position,
          rotation: camera.rotation,
          fx: camera.fx,
          sourceWidth: camera.width,
        };
        runtime.setEvaluationCamera(pose);
        runtime.setFrame(sourceCapture.frame);
        await nextPaint();
        // #WDD-gpt 2026-08-15 - 同一运行时先后渲染原始与解码资产，消除双 Worker sorter 的跨实例时序干扰。
        await wait(settleMilliseconds);
        const decodedBlob = await captureRenderableCanvas(canvas, settleMilliseconds);
        const comparison = await compareBlobs(sourceCapture.blob, decodedBlob);
        const effectivePsnr = comparison.psnr ?? Number.POSITIVE_INFINITY;
        metrics.push({
          cameraIndex: sourceCapture.cameraIndex,
          cameraName: sourceCapture.cameraName,
          frame: sourceCapture.frame,
          mse: comparison.mse,
          psnr: comparison.psnr,
          maxAbsoluteError: comparison.maxAbsoluteError,
          sourceNonBlackPixels: comparison.sourceNonBlackPixels,
        });
        totalSquaredError += comparison.squaredError;
        totalValueCount += comparison.valueCount;
        if (metrics.length === 1 || effectivePsnr < worstPsnr) {
          worstPsnr = effectivePsnr;
          worstSourceBlob = sourceCapture.blob;
          worstDecodedBlob = decodedBlob;
        }
      }

      const finitePsnr = metrics.flatMap((metric) => metric.psnr === null ? [] : [metric.psnr]);
      const aggregateMse = totalSquaredError / totalValueCount;
      const perFrame = frames.map((frame) => {
        const samples = metrics.filter((metric) => metric.frame === frame);
        const mse = samples.reduce((sum, sample) => sum + sample.mse, 0) / samples.length;
        const finite = samples.flatMap((sample) => sample.psnr === null ? [] : [sample.psnr]);
        return {
          frame,
          aggregatePsnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
          minimumPsnr: finite.length === 0 ? null : Math.min(...finite),
          losslessViews: samples.filter((sample) => sample.psnr === null).length,
        };
      });
      const report = {
        renderer: status.renderer,
        width: canvas.width,
        height: canvas.height,
        cameras: cameras.length,
        frames,
        settleMilliseconds,
        samples: metrics.length,
        aggregatePsnr: aggregateMse === 0 ? null : 10 * Math.log10((255 * 255) / aggregateMse),
        minimumPsnr: finitePsnr.length === 0 ? null : Math.min(...finitePsnr),
        losslessViews: metrics.filter((metric) => metric.psnr === null).length,
        maximumAbsoluteError: Math.max(...metrics.map((metric) => metric.maxAbsoluteError)),
        minimumSourceNonBlackPixels: Math.min(...metrics.map((metric) => metric.sourceNonBlackPixels)),
        perFrame,
        metrics,
      };
      if (worstSourceBlob && worstDecodedBlob) {
        const [sourcePng, decodedPng] = await Promise.all([
          blobToDataUrl(worstSourceBlob),
          blobToDataUrl(worstDecodedBlob),
        ]);
        setWorstSource(sourcePng);
        setWorstDecoded(decodedPng);
      }
      setResult(JSON.stringify(report));
      phaseRef.current = 'complete';
      document.documentElement.dataset.status = 'complete';
    })().catch((error: unknown) => {
      setResult(JSON.stringify({ error: String(error) }));
      document.documentElement.dataset.status = 'error';
    });
  }, [cameras, decodedFile, runtime, sourceFile, status]);

  return (
    <main className="compression-renderer">
      <section className="compression-renderer-panel" ref={sourcePanelRef}>
        <GaussianViewport
          activeTool="select"
          brushRadius={24}
          currentFrame={0}
          memoryPolicy={memoryPolicy}
          onMemoryChange={ignoreMemory}
          onRelightingChange={ignoreRelighting}
          onRuntimeChange={setRuntime}
          onSelectionChange={ignoreSelection}
          onStatusChange={setStatus}
          onTransformChange={ignoreTransform}
          preserveDrawingBuffer
          renderMode="gaussian"
          showGuides={false}
          sourceFile={activeFile}
          selectionScope="visible"
          transform={identityTransform}
          transformSpace="world"
          uniformScale
          viewportLabel="Source compression renderer"
        />
      </section>
      <textarea aria-label="Compression result" className="compression-renderer-output" readOnly value={result} />
      <textarea aria-label="Worst source PNG" className="compression-renderer-output" readOnly value={worstSource} />
      <textarea aria-label="Worst decoded PNG" className="compression-renderer-output" readOnly value={worstDecoded} />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<CompressionRenderer />);
