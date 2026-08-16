import { useEffect, useRef, useState } from 'react';
import {
  fourCgsSceneTransformToInput,
  locateFourCgsFrame,
} from '../../gaussian/formats/fourcgs/FourCgsContainer';
import { FourCgsDecoderClient } from '../../gaussian/formats/fourcgs/FourCgsDecoderClient';
import type { FourCgsDescriptor } from '../../gaussian/formats/fourcgs/FourCgsTypes';
import { locateRaw4DSequenceFrame } from '../../gaussian/formats/raw4d/Raw4DSequence';
import { Raw4DSequenceClient } from '../../gaussian/formats/raw4d/Raw4DSequenceClient';
import type { Raw4DSequenceDescriptor } from '../../gaussian/formats/raw4d/Raw4DSequenceTypes';
import type { GaussianRenderMode } from '../../gaussian/runtime/GaussianRenderMode';
import type { Gaussian4DMemoryPolicy } from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import type { RelightingState } from '../../../plugins/relighting/RelightingTypes';
import type { ViewportPerformanceSnapshot } from '../runtime/ViewportPerformanceMonitor';
import type { GaussianCylinderSelectionRegion } from '../runtime/selection/GaussianCylinderSelection';
import {
  ViewportRuntime,
  type ViewportEditorTool,
  type ViewportHistoryState,
  type ViewportMemoryUsage,
  type ViewportResidentRaw4DSegment,
  type ViewportSelectionState,
  type ViewportSelectionScope,
  type ViewportStatus,
  type ViewportTransform,
} from '../runtime/ViewportRuntime';

interface GaussianViewportProps {
  activeTool: ViewportEditorTool;
  brushRadius: number;
  currentFrame: number;
  memoryPolicy: Gaussian4DMemoryPolicy;
  onMemoryChange: (memory: ViewportMemoryUsage) => void;
  onPerformanceChange: (performance: ViewportPerformanceSnapshot) => void;
  onHistoryChange: (state: ViewportHistoryState) => void;
  onRelightingChange: (state: RelightingState) => void;
  onRuntimeChange: (runtime: ViewportRuntime | null) => void;
  onSelectionChange: (state: ViewportSelectionState) => void;
  onStatusChange: (status: ViewportStatus) => void;
  onTransformChange: (transform: ViewportTransform) => void;
  preserveDrawingBuffer?: boolean;
  renderMode: GaussianRenderMode;
  shLevel: number;
  showAxes: boolean;
  showGrid: boolean;
  showGuides: boolean;
  sourceFiles: readonly File[];
  selectionCylinder: GaussianCylinderSelectionRegion;
  selectionScope: ViewportSelectionScope;
  transform: ViewportTransform;
  uniformScale: boolean;
  viewportLabel: string;
}

interface ActiveFourCgsSession {
  readonly decoder: FourCgsDecoderClient;
  readonly descriptor: FourCgsDescriptor;
  readonly residentSegments: readonly ViewportResidentRaw4DSegment[];
  readonly sourceFile: File;
  segmentIndex: number;
}

interface ActiveRaw4DSequenceSession {
  readonly client: Raw4DSequenceClient;
  readonly descriptor: Raw4DSequenceDescriptor;
  readonly residentSegments: readonly ViewportResidentRaw4DSegment[];
  segmentIndex: number;
}

function raw4DSequenceTimeline(descriptor: Raw4DSequenceDescriptor): {
  readonly keyframes: readonly number[];
  readonly segmentNodes: readonly number[];
} {
  const keyframes = new Set<number>();
  for (const segment of descriptor.segments) {
    const globalOffset = segment.firstFrame - descriptor.firstFrame;
    for (const frames of Object.values(segment.keyframes)) {
      for (const localFrame of frames) keyframes.add(globalOffset + localFrame);
    }
  }
  const segmentNodes = descriptor.segments.map((segment) => segment.firstFrame - descriptor.firstFrame);
  segmentNodes.push(descriptor.totalFrames - 1);
  return {
    keyframes: [...keyframes].sort((a, b) => a - b),
    segmentNodes: [...new Set(segmentNodes)].sort((a, b) => a - b),
  };
}

export function GaussianViewport({
  activeTool,
  brushRadius,
  currentFrame,
  memoryPolicy,
  onMemoryChange,
  onPerformanceChange,
  onHistoryChange,
  onRelightingChange,
  onRuntimeChange,
  onSelectionChange,
  onStatusChange,
  onTransformChange,
  preserveDrawingBuffer = false,
  renderMode,
  shLevel,
  showAxes,
  showGrid,
  showGuides,
  sourceFiles,
  selectionCylinder,
  selectionScope,
  transform,
  uniformScale,
  viewportLabel,
}: GaussianViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewportRuntime | null>(null);
  const fourCgsSessionRef = useRef<ActiveFourCgsSession | null>(null);
  const raw4DSequenceSessionRef = useRef<ActiveRaw4DSequenceSession | null>(null);
  const fourCgsLoadGenerationRef = useRef(0);
  const fourCgsLoadingSegmentRef = useRef<number | null>(null);
  const raw4DSequenceLoadGenerationRef = useRef(0);
  const raw4DSequenceLoadingSegmentRef = useRef<number | null>(null);
  const pendingFrameRef = useRef(currentFrame);
  const activateFourCgsFrameRef = useRef<(frame: number) => Promise<void>>(async () => undefined);
  const activateRaw4DSequenceFrameRef = useRef<(frame: number) => Promise<void>>(async () => undefined);
  const renderModeRef = useRef(renderMode);
  const [runtimeReady, setRuntimeReady] = useState(false);
  renderModeRef.current = renderMode;
  pendingFrameRef.current = currentFrame;

  activateFourCgsFrameRef.current = async (frame: number) => {
    const runtime = runtimeRef.current;
    const session = fourCgsSessionRef.current;
    if (!runtime || !session) return;
    const location = locateFourCgsFrame(session.descriptor.segments, frame);
    if (session.segmentIndex === location.segmentIndex) {
      runtime.setFrame(location.localFrame);
      return;
    }
    if (fourCgsLoadingSegmentRef.current === location.segmentIndex) return;
    const generation = ++fourCgsLoadGenerationRef.current;
    fourCgsLoadingSegmentRef.current = location.segmentIndex;
    const previousSegmentIndex = session.segmentIndex;
    const segment = session.descriptor.segments[location.segmentIndex];
    const residentSegment = session.residentSegments[location.segmentIndex];
    const gpuReady = runtime.isResidentRaw4DGpuReady(residentSegment);
    const mappedStatus = (status: ViewportStatus): ViewportStatus => ({
      ...status,
      format: '4CGS',
      sourceName: session.sourceFile.name,
      objectName: session.sourceFile.name.replace(/\.4cgs$/i, ''),
      totalFrames: session.descriptor.totalFrames,
      splatCount: status.phase === 'loading' ? segment.gaussianCount : status.splatCount,
      message: status.phase === 'loading'
        ? `正在载入 4CGS ${segment.name}：${status.message ?? ''}`
        : `4CGS ${segment.name} · 源帧 ${segment.firstFrame}-${segment.lastFrame}`,
    });
    if (!gpuReady) {
      onStatusChange({
        phase: 'loading', renderer: '4CGS V2.4', splatCount: segment.gaussianCount,
        progress: 0.98, totalFrames: session.descriptor.totalFrames, fps: 30, shBands: 3,
        sourceName: session.sourceFile.name, objectName: session.sourceFile.name.replace(/\.4cgs$/i, ''),
        format: '4CGS', message: `正在从系统内存准备 4CGS ${segment.name}`,
      });
    }
    try {
      // #WDD-gpt 2026-08-16 - 4CGS 复用多 RAW4D 显存滑动窗口；预取命中时只切换隐藏实体，不再跨段重建文件。
      const status = await runtime.activateResidentRaw4D(residentSegment, (next) => {
        if (generation === fourCgsLoadGenerationRef.current) onStatusChange(mappedStatus(next));
      }, location.localFrame);
      if (generation !== fourCgsLoadGenerationRef.current || fourCgsSessionRef.current !== session) return;
      session.segmentIndex = location.segmentIndex;
      fourCgsLoadingSegmentRef.current = null;
      const latest = locateFourCgsFrame(session.descriptor.segments, pendingFrameRef.current);
      if (latest.segmentIndex === session.segmentIndex) {
        runtime.setFrame(latest.localFrame);
        onStatusChange(mappedStatus(status));
      } else {
        void activateFourCgsFrameRef.current(pendingFrameRef.current);
      }
    } catch (error) {
      if (generation !== fourCgsLoadGenerationRef.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      if (previousSegmentIndex >= 0) runtime.setGaussianSelectionSequenceActiveSegment(previousSegmentIndex);
      fourCgsLoadingSegmentRef.current = null;
      throw error;
    }
  };

  activateRaw4DSequenceFrameRef.current = async (frame: number) => {
    const runtime = runtimeRef.current;
    const session = raw4DSequenceSessionRef.current;
    if (!runtime || !session) return;
    const location = locateRaw4DSequenceFrame(session.descriptor.segments, frame);
    if (session.segmentIndex === location.segmentIndex) {
      runtime.setFrame(location.localFrame);
      return;
    }
    if (raw4DSequenceLoadingSegmentRef.current === location.segmentIndex) return;
    const generation = ++raw4DSequenceLoadGenerationRef.current;
    raw4DSequenceLoadingSegmentRef.current = location.segmentIndex;
    const segment = session.descriptor.segments[location.segmentIndex];
    const residentSegment = session.residentSegments[location.segmentIndex];
    const gpuReady = runtime.isResidentRaw4DGpuReady(residentSegment);
    const timeline = raw4DSequenceTimeline(session.descriptor);
    const sequenceStatus = {
      segmentIndex: location.segmentIndex,
      segmentCount: session.descriptor.segments.length,
      boundaryFramesRemoved: session.descriptor.boundaryFramesRemoved,
      permanentTrackCount: session.descriptor.permanentTrackCount,
      sharedShCoefficientCount: session.descriptor.sharedSh.coefficientCount,
      sharedShUpdateStateCount: session.descriptor.sharedSh.updateStateCount,
      sharedShSavedBytes: session.descriptor.sharedSh.savedBytes,
      keyframes: timeline.keyframes,
      segmentNodes: timeline.segmentNodes,
    } as const;
    const mappedStatus = (status: ViewportStatus): ViewportStatus => ({
      ...status,
      sourceName: session.descriptor.sourceName,
      objectName: session.descriptor.sourceName,
      totalFrames: session.descriptor.totalFrames,
      format: 'RAW4D',
      raw4dSequence: sequenceStatus,
      message: status.phase === 'loading'
        ? `正在载入 RAW4D ${segment.name}：${status.message ?? ''}`
        : `RAW4D ${segment.name} · 源帧 ${segment.firstFrame}-${segment.lastFrame}`,
    });
    if (!gpuReady) {
      onStatusChange({
        phase: 'loading', renderer: 'RAW4D 多段序列', splatCount: segment.splatCount,
        progress: 0.96, totalFrames: session.descriptor.totalFrames, fps: 30, shBands: segment.shBands,
        sourceName: session.descriptor.sourceName, objectName: session.descriptor.sourceName,
        format: 'RAW4D', raw4dSequence: sequenceStatus,
        message: `正在准备第 ${location.segmentIndex + 1}/${session.descriptor.segments.length} 段 ${segment.name}`,
      });
    }
    try {
      const status = await runtime.activateResidentRaw4D(residentSegment, (next) => {
        if (generation === raw4DSequenceLoadGenerationRef.current) onStatusChange(mappedStatus(next));
      }, location.localFrame);
      if (generation !== raw4DSequenceLoadGenerationRef.current || raw4DSequenceSessionRef.current !== session) return;
      session.segmentIndex = location.segmentIndex;
      raw4DSequenceLoadingSegmentRef.current = null;
      const latest = locateRaw4DSequenceFrame(session.descriptor.segments, pendingFrameRef.current);
      if (latest.segmentIndex === session.segmentIndex) {
        runtime.setFrame(latest.localFrame);
        onStatusChange(mappedStatus(status));
      } else {
        void activateRaw4DSequenceFrameRef.current(pendingFrameRef.current);
      }
    } catch (error) {
      if (generation !== raw4DSequenceLoadGenerationRef.current || (error instanceof DOMException && error.name === 'AbortError')) return;
      raw4DSequenceLoadingSegmentRef.current = null;
      throw error;
    }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const runtime = new ViewportRuntime(canvas, {
      showGuides,
      preserveDrawingBuffer,
      memoryPolicy,
      onTransformChange,
      onRelightingChange,
      onSelectionChange,
      onHistoryChange,
    });
    runtimeRef.current = runtime;
    runtime.setRenderMode(renderModeRef.current);
    let active = true;

    runtime.initialize().then(
      (status) => {
        if (active) {
          onStatusChange(status);
          setRuntimeReady(true);
          onHistoryChange(runtime.getHistoryState());
          onRuntimeChange(runtime);
        }
      },
      (error: unknown) => {
        if (active) {
          onStatusChange({
            phase: 'error',
            renderer: 'Unavailable',
            splatCount: 0,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    return () => {
      active = false;
      fourCgsSessionRef.current?.decoder.close();
      fourCgsSessionRef.current = null;
      raw4DSequenceSessionRef.current?.client.close();
      raw4DSequenceSessionRef.current = null;
      setRuntimeReady(false);
      onHistoryChange({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
      onRuntimeChange(null);
      runtime.destroy();
      runtimeRef.current = null;
    };
  }, [onHistoryChange, onRelightingChange, onRuntimeChange, onSelectionChange, onStatusChange, onTransformChange, preserveDrawingBuffer, showGuides]);

  useEffect(() => {
    runtimeRef.current?.setEditorTool(activeTool);
  }, [activeTool, runtimeReady]);

  useEffect(() => {
    runtimeRef.current?.setGaussianSelectionScope(selectionScope);
  }, [runtimeReady, selectionScope]);

  useEffect(() => {
    runtimeRef.current?.setGaussianSelectionBrushRadius(brushRadius);
  }, [brushRadius, runtimeReady]);

  useEffect(() => {
    runtimeRef.current?.setGaussianSelectionCylinder(selectionCylinder);
  }, [runtimeReady, selectionCylinder]);

  useEffect(() => {
    runtimeRef.current?.setSceneTransform(transform);
  }, [runtimeReady, transform]);

  useEffect(() => {
    runtimeRef.current?.setUniformScale(uniformScale);
  }, [runtimeReady, uniformScale]);

  useEffect(() => {
    runtimeRef.current?.setRenderMode(renderMode);
  }, [renderMode, runtimeReady]);

  useEffect(() => {
    runtimeRef.current?.setShLevel(shLevel);
  }, [runtimeReady, shLevel]);

  useEffect(() => {
    runtimeRef.current?.setGridVisible(showGrid);
  }, [runtimeReady, showGrid]);

  useEffect(() => {
    runtimeRef.current?.setAxesVisible(showAxes);
  }, [runtimeReady, showAxes]);

  useEffect(() => {
    runtimeRef.current?.setMemoryPolicy(memoryPolicy);
  }, [memoryPolicy, runtimeReady]);

  useEffect(() => {
    if (fourCgsSessionRef.current) {
      void activateFourCgsFrameRef.current(currentFrame).catch((error: unknown) => {
        onStatusChange({
          phase: 'error', renderer: '4CGS 段切换失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: fourCgsSessionRef.current?.sourceFile.name,
          format: '4CGS',
        });
      });
    } else if (raw4DSequenceSessionRef.current) {
      void activateRaw4DSequenceFrameRef.current(currentFrame).catch((error: unknown) => {
        onStatusChange({
          phase: 'error', renderer: 'RAW4D 段切换失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: raw4DSequenceSessionRef.current?.descriptor.sourceName,
          format: 'RAW4D',
        });
      });
    } else {
      runtimeRef.current?.setFrame(currentFrame);
    }
  }, [currentFrame, onStatusChange]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtimeReady) return;
    const publishDiagnostics = () => {
      onMemoryChange(runtime.getMemoryUsage());
      onPerformanceChange(runtime.getPerformanceSnapshot());
    };
    publishDiagnostics();
    // #WDD-gpt 2026-08-14 - 一秒采样一次，确保状态可读且不会干扰 4DGS 播放帧率。
    const interval = window.setInterval(publishDiagnostics, 1000);
    return () => window.clearInterval(interval);
  }, [onMemoryChange, onPerformanceChange, runtimeReady]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtimeReady) return;
    fourCgsLoadGenerationRef.current += 1;
    fourCgsLoadingSegmentRef.current = null;
    fourCgsSessionRef.current?.decoder.close();
    fourCgsSessionRef.current = null;
    raw4DSequenceLoadGenerationRef.current += 1;
    raw4DSequenceLoadingSegmentRef.current = null;
    raw4DSequenceSessionRef.current?.client.close();
    raw4DSequenceSessionRef.current = null;
    const sourceFile = sourceFiles[0] ?? null;
    if (!sourceFile) {
      const status = runtime.resetToDemo();
      if (status) onStatusChange(status);
      return;
    }
    let active = true;
    if (sourceFiles.length > 1) {
      const client = new Raw4DSequenceClient();
      let residentSegments: readonly ViewportResidentRaw4DSegment[] = [];
      const sourceName = `${sourceFiles.length} 段 RAW4D`;
      onStatusChange({
        phase: 'loading', renderer: 'RAW4D 多段预处理', splatCount: 0, progress: 0,
        message: `正在预处理 ${sourceFiles.length} 段 RAW4D`, sourceName, objectName: sourceName, format: 'RAW4D',
      });
      client.open(sourceFiles, ({ message, ratio }) => {
        if (!active) return;
        onStatusChange({
          phase: 'loading', renderer: 'RAW4D 多段预处理', splatCount: 0, progress: ratio * 0.32,
          message, sourceName, objectName: sourceName, format: 'RAW4D',
        });
      }).then(async (descriptor) => {
        if (!active) return;
        const sourceOrderResidentSegments = await runtime.preloadRaw4DSequence(sourceFiles, ({ message, ratio }) => {
          if (!active) return;
          onStatusChange({
            phase: 'loading', renderer: 'RAW4D 系统内存驻留', splatCount: 0,
            progress: 0.32 + ratio * 0.64, message,
            sourceName: descriptor.sourceName, objectName: descriptor.sourceName, format: 'RAW4D',
          });
        });
        residentSegments = descriptor.segments.map((segment) => sourceOrderResidentSegments[segment.fileIndex]);
        if (!active) {
          runtime.releaseRaw4DSequence(residentSegments);
          residentSegments = [];
          return;
        }
        // #WDD-gpt 2026-08-16 - 时间顺序交给运行时建立显存滑动窗口，当前段激活后自动预取未来段。
        runtime.configureRaw4DSequenceGpuCache(residentSegments);
        raw4DSequenceSessionRef.current = {
          client, descriptor, residentSegments, segmentIndex: -1,
        };
        await activateRaw4DSequenceFrameRef.current(pendingFrameRef.current);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({
          phase: 'error', renderer: 'RAW4D 多段导入失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName, objectName: sourceName, format: 'RAW4D',
        });
      });
      return () => {
        active = false;
        raw4DSequenceLoadGenerationRef.current += 1;
        client.close();
        if (raw4DSequenceSessionRef.current?.client === client) raw4DSequenceSessionRef.current = null;
        runtime.cancelImport();
        runtime.releaseRaw4DSequence(residentSegments);
        residentSegments = [];
      };
    }
    if (sourceFile.name.toLowerCase().endsWith('.4cgs')) {
      const decoder = new FourCgsDecoderClient();
      const openStartedAt = performance.now();
      let residentSegments: readonly ViewportResidentRaw4DSegment[] = [];
      onStatusChange({
        phase: 'loading', renderer: '4CGS V2.4', splatCount: 0, progress: 0,
        message: '正在打开 4CGS 文件', sourceName: sourceFile.name,
        objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
      });
      decoder.open(sourceFile, ({ message, ratio }) => {
        if (!active) return;
        onStatusChange({
          phase: 'loading', renderer: '4CGS V2.4', splatCount: 0, progress: ratio * 0.55,
          message, sourceName: sourceFile.name,
          objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
        });
      }).then(async (descriptor) => {
        if (!active) return;
        // #WDD-gpt 2026-08-16 - 保留实际 bitstream 解码阶段计时，便于评估多线程是否真正缩短等待。
        console.info(`4CGS decode timings ${JSON.stringify(descriptor.decodeTimings)}`);
        if (descriptor.sceneTransform) {
          // #WDD-gpt 2026-08-16 - 通过运行时原子恢复 4CGS TRS，保证首帧实体与检查器使用同一份元数据。
          runtime.restoreSceneTransform(fourCgsSceneTransformToInput(descriptor.sceneTransform));
        }
        const extractionStartedAt = performance.now();
        let extractedCount = 0;
        // #WDD-gpt 2026-08-16 - 一次提交全部片段请求，减少六次主线程往返并让后续 Loader 池尽早接手。
        const decodedSegments = await Promise.all(descriptor.segments.map(async (_segment, segmentIndex) => {
          const decoded = await decoder.getSegment(segmentIndex);
          if (!active) throw new DOMException('4CGS 片段提取已取消。', 'AbortError');
          extractedCount += 1;
          onStatusChange({
            phase: 'loading', renderer: '4CGS 系统内存预读', splatCount: 0,
            progress: 0.55 + 0.1 * extractedCount / descriptor.segments.length,
            message: `正在并行提取 4CGS 片段 ${extractedCount}/${descriptor.segments.length}`,
            sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
          });
          return decoded;
        }));
        const extractionMs = performance.now() - extractionStartedAt;
        const residencyStartedAt = performance.now();
        residentSegments = await runtime.preloadRaw4DSequence(decodedSegments, ({ message, ratio }) => {
          if (!active) return;
          onStatusChange({
            phase: 'loading', renderer: '4CGS 系统内存驻留', splatCount: 0,
            progress: 0.65 + ratio * 0.33, message,
            sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
          });
        });
        const residencyMs = performance.now() - residencyStartedAt;
        if (!active) {
          runtime.releaseRaw4DSequence(residentSegments);
          residentSegments = [];
          return;
        }
        // #WDD-gpt 2026-08-16 - 4CGS 六段先驻留系统内存，再建立当前段和未来段的显存预取窗口。
        runtime.configureRaw4DSequenceGpuCache(residentSegments);
        fourCgsSessionRef.current = {
          decoder, descriptor, residentSegments, sourceFile, segmentIndex: -1,
        };
        decoder.close();
        const activationStartedAt = performance.now();
        await activateFourCgsFrameRef.current(pendingFrameRef.current);
        // #WDD-gpt 2026-08-16 - 单独记录提取、CPU 驻留和首段 GPU 激活，避免只优化 Codec 却遗漏后续等待。
        console.info(`4CGS open timings ${JSON.stringify({
          decodeMs: descriptor.decodeTimings.totalMs,
          extractionMs,
          residencyMs,
          activationMs: performance.now() - activationStartedAt,
          totalMs: performance.now() - openStartedAt,
        })}`);
      }).catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({
          phase: 'error', renderer: '4CGS 导入失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
        });
      });
      return () => {
        active = false;
        fourCgsLoadGenerationRef.current += 1;
        runtime.cancelImport();
        runtime.releaseRaw4DSequence(residentSegments);
        residentSegments = [];
        decoder.close();
        if (fourCgsSessionRef.current?.decoder === decoder) fourCgsSessionRef.current = null;
      };
    }
    runtime.loadGaussianFile(sourceFile, (status) => {
      if (active) onStatusChange(status);
    }).then(
      (status) => {
        if (active) onStatusChange(status);
      },
      (error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({
          phase: 'error',
          renderer: 'Gaussian 导入失败',
          splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: sourceFile.name,
          objectName: sourceFile.name.replace(/\.[^.]+$/, ''),
          format: undefined,
        });
      },
    );
    return () => {
      active = false;
      runtime.cancelImport();
    };
  }, [onStatusChange, runtimeReady, sourceFiles]);

  return <canvas aria-label={viewportLabel} className="viewport-canvas" ref={canvasRef} tabIndex={0} />;
}
