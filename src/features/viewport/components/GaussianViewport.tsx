import { Raw4DPreparationClient } from '../../gaussian/runtime/Raw4DPreparationClient';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FOUR_CGS_HEADER_BYTES,
  fourCgsSceneTransformToInput,
  locateFourCgsFrame,
  readFourCgsManifest,
} from '../../gaussian/formats/fourcgs/FourCgsContainer';
import { FourCgsDecoderClient } from '../../gaussian/formats/fourcgs/FourCgsDecoderClient';
import { fourCgsRaw4DKeyframeStrides } from '../../gaussian/formats/fourcgs/FourCgsRaw4D';
import {
  createRaw4DRawBundleFiles,
  raw4DBundleStorage,
} from '../../gaussian/formats/fourcgs/FourCgsRaw4DBundle';
import {
  extractRaw4DFilesFromFourCgsZip,
  isFourCgsRaw4DZip,
} from '../../gaussian/formats/fourcgs/FourCgsRaw4DZip';
import type { FourCgsDescriptor } from '../../gaussian/formats/fourcgs/FourCgsTypes';
import { fourCgsTimelineSourceName, mergeFourCgsDescriptors } from '../../gaussian/formats/fourcgs/FourCgsMultiContainer';
import { locateRaw4DSequenceFrame } from '../../gaussian/formats/raw4d/Raw4DSequence';
import { raw4DCanonicalKeyframes } from '../../gaussian/formats/raw4d/Raw4DSchema';
import { Raw4DSequenceClient } from '../../gaussian/formats/raw4d/Raw4DSequenceClient';
import type { Raw4DSequenceDescriptor } from '../../gaussian/formats/raw4d/Raw4DSequenceTypes';
import type { GaussianRenderMode } from '../../gaussian/runtime/GaussianRenderMode';
import type { Gaussian4DMemoryPolicy } from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import {
  detectGaussianRuntimeProfile,
  resolveGaussianRuntimeProfile,
} from '../../gaussian/memory/GaussianRuntimeProfile';
import type { RelightingState } from '../../../plugins/relighting/RelightingTypes';
import type { ViewportPerformanceSnapshot } from '../runtime/ViewportPerformanceMonitor';
import type { GaussianCylinderSelectionRegion } from '../runtime/selection/GaussianCylinderSelection';
import {
  ViewportRuntime,
  type ViewportEditorTool,
  type ViewportCameraState,
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
  backgroundColor: string;
  // #WDD-gpt 2026-09-19 - 仅展示页选择透明背景，编辑器维持实色背景。
  transparentBackground?: boolean;
  // #WDD-gpt 2026-09-20 - 展示页要求全部片段显存驻留，失败必须报告而非悄悄回退窗口缓存。
  preloadAllSegments?: boolean;
  backgroundPreparation?: boolean;
  // #WDD-gpt 2026-09-20 - 展示页内部切段时保留上一张完整画面直到新段 postrender。
  retainFrameDuringTransitions?: boolean;
  brushRadius: number;
  currentFrame: number;
  forceSortSync: boolean;
  frameReadyRequestId: number;
  memoryPolicy: Gaussian4DMemoryPolicy;
  onMemoryChange: (memory: ViewportMemoryUsage) => void;
  onPerformanceChange: (performance: ViewportPerformanceSnapshot) => void;
  onHistoryChange: (state: ViewportHistoryState) => void;
  onFrameRenderReady: (requestId: number, sorted: boolean) => void;
  onFrameDisplayed: (frame: number) => void;
  onCameraBookmarksChange: (bookmarks: readonly (ViewportCameraState | null)[]) => void;
  onRelightingChange: (state: RelightingState) => void;
  onRuntimeChange: (runtime: ViewportRuntime | null) => void;
  onSelectionChange: (state: ViewportSelectionState) => void;
  onStatusChange: (status: ViewportStatus) => void;
  onTransformChange: (transform: ViewportTransform) => void;
  preserveDrawingBuffer?: boolean;
  renderMode: GaussianRenderMode;
  shLevel: number;
  showAxes: boolean;
  showHeightRuler: boolean;
  showGaussianEnvelope: boolean;
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
  readonly descriptor: FourCgsDescriptor;
  readonly residentSegments: readonly ViewportResidentRaw4DSegment[];
  readonly sourceName: string;
  readonly objectName: string;
  segmentIndex: number;
}

interface ActiveRaw4DSequenceSession {
  readonly client: Raw4DSequenceClient;
  readonly containerFile?: File;
  readonly descriptor: Raw4DSequenceDescriptor;
  readonly presentation: 'raw4d' | 'fourcgs-raw4d-zip' | 'fourcgs-raw4d-bundle';
  readonly residentSegments: readonly ViewportResidentRaw4DSegment[];
  segmentIndex: number;
}

function packagedRaw4DContainer(
  presentation: ActiveRaw4DSequenceSession['presentation'],
): 'raw4d-zip' | 'raw4d-bundle' | undefined {
  if (presentation === 'fourcgs-raw4d-zip') return 'raw4d-zip';
  if (presentation === 'fourcgs-raw4d-bundle') return 'raw4d-bundle';
  return undefined;
}

function packagedRaw4DLabel(presentation: ActiveRaw4DSequenceSession['presentation']): string {
  if (presentation === 'fourcgs-raw4d-zip') return '4CGS ZIP';
  if (presentation === 'fourcgs-raw4d-bundle') return '4CGS RAW4D Bundle';
  return 'RAW4D';
}

function raw4DSequenceTimeline(descriptor: Raw4DSequenceDescriptor): {
  readonly keyframes: readonly number[];
  readonly segmentNodes: readonly number[];
  readonly keyframeTracks: Readonly<Record<'position' | 'rotation' | 'colorDc' | 'scale' | 'opacity', readonly number[]>>;
} {
  const keyframes = new Set<number>();
  const keyframeTracks = {
    position: new Set<number>(),
    rotation: new Set<number>(),
    colorDc: new Set<number>(),
    scale: new Set<number>(),
    opacity: new Set<number>(),
  };
  for (const segment of descriptor.segments) {
    const globalOffset = segment.firstFrame - descriptor.firstFrame;
    for (const [track, frames] of Object.entries(segment.keyframes)) {
      for (const localFrame of frames) {
        const frame = globalOffset + localFrame;
        keyframes.add(frame);
        keyframeTracks[track as keyof typeof keyframeTracks].add(frame);
      }
    }
  }
  const segmentNodes = descriptor.segments.map((segment) => segment.firstFrame - descriptor.firstFrame);
  segmentNodes.push(descriptor.totalFrames - 1);
  return {
    keyframes: [...keyframes].sort((a, b) => a - b),
    segmentNodes: [...new Set(segmentNodes)].sort((a, b) => a - b),
    keyframeTracks: {
      position: [...keyframeTracks.position].sort((a, b) => a - b),
      rotation: [...keyframeTracks.rotation].sort((a, b) => a - b),
      colorDc: [...keyframeTracks.colorDc].sort((a, b) => a - b),
      scale: [...keyframeTracks.scale].sort((a, b) => a - b),
      opacity: [...keyframeTracks.opacity].sort((a, b) => a - b),
    },
  };
}

function fourCgsSequenceStatus(descriptor: FourCgsDescriptor, segmentIndex: number): NonNullable<ViewportStatus['raw4dSequence']> {
  const segmentNodes = descriptor.segments.map((segment) => segment.firstFrame - descriptor.firstFrame);
  segmentNodes.push(descriptor.totalFrames - 1);
  const keyframes = new Set<number>();
  const keyframeTracks = {
    position: new Set<number>(), rotation: new Set<number>(), colorDc: new Set<number>(),
    scale: new Set<number>(), opacity: new Set<number>(),
  };
  for (const segment of descriptor.segments) {
    const offset = segment.firstFrame - descriptor.firstFrame;
    const strides = fourCgsRaw4DKeyframeStrides(segment);
    for (const track of Object.keys(segment.bankCounts) as Array<keyof typeof segment.bankCounts>) {
      for (const localFrame of raw4DCanonicalKeyframes(segment.totalFrames, strides[track], segment.bankCounts[track])) {
        const frame = offset + localFrame;
        keyframes.add(frame);
        keyframeTracks[track].add(frame);
      }
    }
  }
  return {
    segmentIndex,
    segmentCount: descriptor.segments.length,
    boundaryFramesRemoved: 0,
    permanentTrackCount: descriptor.slotCount,
    sharedShCoefficientCount: 0,
    sharedShUpdateStateCount: 0,
    sharedShSavedBytes: 0,
    // #WDD-gpt 2026-08-20 - 从 4CGS 每段 bank/stride 还原真实唯一关键帧，供时间轴和场景统计共用。
    keyframes: [...keyframes].sort((a, b) => a - b),
    segmentNodes: [...new Set(segmentNodes)].sort((a, b) => a - b),
    keyframeTracks: {
      position: [...keyframeTracks.position].sort((a, b) => a - b),
      rotation: [...keyframeTracks.rotation].sort((a, b) => a - b),
      colorDc: [...keyframeTracks.colorDc].sort((a, b) => a - b),
      scale: [...keyframeTracks.scale].sort((a, b) => a - b),
      opacity: [...keyframeTracks.opacity].sort((a, b) => a - b),
    },
    firstFrame: descriptor.firstFrame,
    segments: descriptor.segments.map((segment) => ({
      name: segment.name,
      firstFrame: segment.firstFrame,
      lastFrame: segment.lastFrame,
      pointCount: segment.gaussianCount,
    })),
  };
}

export function GaussianViewport({
  activeTool,
  backgroundColor,
  transparentBackground = false,
  preloadAllSegments = false,
  backgroundPreparation = false,
  retainFrameDuringTransitions = false,
  brushRadius,
  currentFrame,
  forceSortSync,
  frameReadyRequestId,
  memoryPolicy,
  onMemoryChange,
  onPerformanceChange,
  onHistoryChange,
  onFrameRenderReady,
  onFrameDisplayed,
  onCameraBookmarksChange,
  onRelightingChange,
  onRuntimeChange,
  onSelectionChange,
  onStatusChange,
  onTransformChange,
  preserveDrawingBuffer = false,
  renderMode,
  shLevel,
  showAxes,
  showHeightRuler,
  showGaussianEnvelope,
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
  const holdCanvasRef = useRef<HTMLCanvasElement>(null);
  const heldTargetRef = useRef<number | null>(null);
  const lastDisplayedRef = useRef(-1);
  const runtimeRef = useRef<ViewportRuntime | null>(null);
  const fourCgsSessionRef = useRef<ActiveFourCgsSession | null>(null);
  const raw4DSequenceSessionRef = useRef<ActiveRaw4DSequenceSession | null>(null);
  const fourCgsLoadGenerationRef = useRef(0);
  const fourCgsLoadingSegmentRef = useRef<number | null>(null);
  const raw4DSequenceLoadGenerationRef = useRef(0);
  const raw4DSequenceLoadingSegmentRef = useRef<number | null>(null);
  const pendingFrameRef = useRef(currentFrame);
  const frameApplicationRef = useRef<Promise<void>>(Promise.resolve());
  const frameReadyGenerationRef = useRef(0);
  const activateFourCgsFrameRef = useRef<(frame: number) => Promise<void>>(async () => undefined);
  const activateRaw4DSequenceFrameRef = useRef<(frame: number) => Promise<void>>(async () => undefined);
  const backgroundColorRef = useRef(backgroundColor);
  const renderModeRef = useRef(renderMode);
  const onFrameDisplayedRef = useRef(onFrameDisplayed);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [detectedRuntimeProfile] = useState(detectGaussianRuntimeProfile);
  const runtimeProfile = useMemo(() => memoryPolicy.mode === 'mobile'
    ? resolveGaussianRuntimeProfile({ mobileHint: true })
    : detectedRuntimeProfile, [detectedRuntimeProfile, memoryPolicy.mode]);
  backgroundColorRef.current = backgroundColor;
  renderModeRef.current = renderMode;
  onFrameDisplayedRef.current = (frame) => {
    lastDisplayedRef.current = frame;
    if (heldTargetRef.current === frame) {
      heldTargetRef.current = null;
      if (canvasRef.current) canvasRef.current.style.visibility = '';
      if (holdCanvasRef.current) holdCanvasRef.current.style.visibility = 'hidden';
    }
    onFrameDisplayed(frame);
  };
  // #WDD-gpt 2026-09-20 - 仅在切段边界复制一次，不逐帧回读；前景保留图避免新实体排序期间露底或叠影。
  const holdPreviousFrame = (target: number) => {
    if (!retainFrameDuringTransitions || lastDisplayedRef.current < 0) return;
    const source = canvasRef.current, hold = holdCanvasRef.current;
    if (!source || !hold) return;
    if (heldTargetRef.current === null) {
      hold.width = source.width; hold.height = source.height;
      const context = hold.getContext('2d');
      if (!context) throw new Error('无法保留切段过渡画面。');
      context.globalCompositeOperation = 'copy';
      context.drawImage(source, 0, 0);
      hold.style.visibility = 'visible';
      source.style.visibility = 'hidden';
    }
    heldTargetRef.current = target;
  };
  pendingFrameRef.current = currentFrame;

  activateFourCgsFrameRef.current = async (frame: number) => {
    const runtime = runtimeRef.current;
    const session = fourCgsSessionRef.current;
    if (!runtime || !session) return;
    const location = locateFourCgsFrame(session.descriptor.segments, frame);
    if (session.segmentIndex === location.segmentIndex) {
      runtime.setFrame(location.localFrame, () => onFrameDisplayedRef.current(frame));
      return;
    }
    if (fourCgsLoadingSegmentRef.current === location.segmentIndex) return;
    holdPreviousFrame(frame);
    const generation = ++fourCgsLoadGenerationRef.current;
    fourCgsLoadingSegmentRef.current = location.segmentIndex;
    const previousSegmentIndex = session.segmentIndex;
    const segment = session.descriptor.segments[location.segmentIndex];
    const residentSegment = session.residentSegments[location.segmentIndex];
    const gpuReady = runtime.isResidentRaw4DGpuReady(residentSegment);
    const sequenceStatus = fourCgsSequenceStatus(session.descriptor, location.segmentIndex);
    const mappedStatus = (status: ViewportStatus): ViewportStatus => ({
      ...status,
      format: '4CGS',
      fourCgsContainer: 'binary',
      sourceName: session.sourceName,
      objectName: session.objectName,
      totalFrames: session.descriptor.totalFrames,
      keyframeCount: sequenceStatus.keyframes.length,
      raw4dSequence: sequenceStatus,
      splatCount: status.phase === 'loading' ? segment.gaussianCount : status.splatCount,
      message: status.phase === 'loading'
        ? `正在载入 4CGS ${segment.name}：${status.message ?? ''}`
        : `4CGS ${segment.name} · 源帧 ${segment.firstFrame}-${segment.lastFrame}`,
    });
    if (!gpuReady) {
      onStatusChange({
        phase: 'loading', renderer: '4CGS V2.4', splatCount: segment.gaussianCount,
        progress: 0.98, totalFrames: session.descriptor.totalFrames, keyframeCount: sequenceStatus.keyframes.length, fps: 30, shBands: 3,
        sourceName: session.sourceName, objectName: session.objectName,
        format: '4CGS', fourCgsContainer: 'binary', raw4dSequence: sequenceStatus, message: `正在从系统内存准备 4CGS ${segment.name}`,
      });
    }
    try {
      // #WDD-gpt 2026-08-16 - 4CGS 复用多 RAW4D 显存滑动窗口；预取命中时只切换隐藏实体，不再跨段重建文件。
      const status = await runtime.activateResidentRaw4D(residentSegment, (next) => {
        if (generation === fourCgsLoadGenerationRef.current) onStatusChange(mappedStatus(next));
      }, location.localFrame, () => onFrameDisplayedRef.current(frame));
      if (generation !== fourCgsLoadGenerationRef.current || fourCgsSessionRef.current !== session) return;
      session.segmentIndex = location.segmentIndex;
      fourCgsLoadingSegmentRef.current = null;
      const latestTimelineFrame = pendingFrameRef.current;
      const latest = locateFourCgsFrame(session.descriptor.segments, latestTimelineFrame);
      if (latest.segmentIndex === session.segmentIndex) {
        if (heldTargetRef.current !== null) heldTargetRef.current = latestTimelineFrame;
        runtime.setFrame(latest.localFrame, () => onFrameDisplayedRef.current(latestTimelineFrame));
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
      runtime.setFrame(location.localFrame, () => onFrameDisplayedRef.current(frame));
      return;
    }
    if (raw4DSequenceLoadingSegmentRef.current === location.segmentIndex) return;
    holdPreviousFrame(frame);
    const generation = ++raw4DSequenceLoadGenerationRef.current;
    raw4DSequenceLoadingSegmentRef.current = location.segmentIndex;
    const segment = session.descriptor.segments[location.segmentIndex];
    const residentSegment = session.residentSegments[location.segmentIndex];
    const gpuReady = runtime.isResidentRaw4DGpuReady(residentSegment);
    const timeline = raw4DSequenceTimeline(session.descriptor);
    const fourCgsContainer = packagedRaw4DContainer(session.presentation);
    const packagedAsFourCgs = Boolean(fourCgsContainer);
    const presentationLabel = packagedRaw4DLabel(session.presentation);
    const presentedSourceName = session.containerFile?.name ?? session.descriptor.sourceName;
    const presentedObjectName = session.containerFile
      ? session.containerFile.name.replace(/\.4cgs$/i, '')
      : session.descriptor.sourceName;
    const presentedFormat = packagedAsFourCgs ? '4CGS' : 'RAW4D';
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
      keyframeTracks: timeline.keyframeTracks,
      firstFrame: session.descriptor.firstFrame,
      segments: session.descriptor.segments.map((entry) => ({
        name: entry.name,
        firstFrame: entry.firstFrame,
        lastFrame: entry.lastFrame,
        pointCount: entry.splatCount,
      })),
    } as const;
    const mappedStatus = (status: ViewportStatus): ViewportStatus => ({
      ...status,
      sourceName: presentedSourceName,
      objectName: presentedObjectName,
      totalFrames: session.descriptor.totalFrames,
      keyframeCount: sequenceStatus.keyframes.length,
      format: presentedFormat,
      ...(fourCgsContainer ? { fourCgsContainer } : {}),
      raw4dSequence: sequenceStatus,
      message: status.phase === 'loading'
        ? `正在载入 ${presentationLabel} ${segment.name}：${status.message ?? ''}`
        : `${presentationLabel} ${segment.name} · 源帧 ${segment.firstFrame}-${segment.lastFrame}`,
    });
    if (!gpuReady) {
      onStatusChange({
        phase: 'loading', renderer: packagedAsFourCgs ? presentationLabel : 'RAW4D 多段序列', splatCount: segment.splatCount,
        progress: 0.96, totalFrames: session.descriptor.totalFrames, keyframeCount: sequenceStatus.keyframes.length, fps: 30, shBands: segment.shBands,
        sourceName: presentedSourceName, objectName: presentedObjectName,
        format: presentedFormat, ...(fourCgsContainer ? { fourCgsContainer } : {}), raw4dSequence: sequenceStatus,
        message: `正在准备第 ${location.segmentIndex + 1}/${session.descriptor.segments.length} 段 ${segment.name}`,
      });
    }
    try {
      const status = await runtime.activateResidentRaw4D(residentSegment, (next) => {
        if (generation === raw4DSequenceLoadGenerationRef.current) onStatusChange(mappedStatus(next));
      }, location.localFrame, () => onFrameDisplayedRef.current(frame));
      if (generation !== raw4DSequenceLoadGenerationRef.current || raw4DSequenceSessionRef.current !== session) return;
      session.segmentIndex = location.segmentIndex;
      raw4DSequenceLoadingSegmentRef.current = null;
      const latestTimelineFrame = pendingFrameRef.current;
      const latest = locateRaw4DSequenceFrame(session.descriptor.segments, latestTimelineFrame);
      if (latest.segmentIndex === session.segmentIndex) {
        if (heldTargetRef.current !== null) heldTargetRef.current = latestTimelineFrame;
        runtime.setFrame(latest.localFrame, () => onFrameDisplayedRef.current(latestTimelineFrame));
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

  // #WDD-gpt 2026-09-20 - 展示页让压缩解码与图形设备初始化重叠；持有同一会话，取消时释放线程。
  const eagerFourCgs = useRef<{ file: File; decoder: FourCgsDecoderClient; result: Promise<FourCgsDescriptor | null> } | null>(null);
  useEffect(() => {
    const file = sourceFiles.length === 1 ? sourceFiles[0] : null;
    if (!backgroundPreparation || !preloadAllSegments || !file?.name.toLowerCase().endsWith('.4cgs')) return;
    Raw4DPreparationClient.warm();
    const decoder = new FourCgsDecoderClient(true);
    let cancelled = false;
    const result = readFourCgsManifest(file).then(({ manifest }) => {
      if (cancelled) throw new DOMException('提前解码已取消', 'AbortError');
      if (raw4DBundleStorage(manifest)) return null;
      return decoder.open(file, ({ message, ratio }) => {
        if (!cancelled) onStatusChange({ phase: 'loading', renderer: '4CGS', splatCount: 0, progress: ratio * .55, message, sourceName: file.name });
      });
    });
    const session = { file, decoder, result };
    eagerFourCgs.current = session;
    void result.catch(() => undefined);
    return () => { cancelled = true; decoder.close(); if (eagerFourCgs.current === session) eagerFourCgs.current = null; };
  }, [sourceFiles, backgroundPreparation, preloadAllSegments, onStatusChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    // #WDD-gpt 2026-08-19 - 桌面/手机渲染档切换时先提交未就绪状态，确保现有场景随后按新 GraphicsDevice 重新上传。
    setRuntimeReady(false);
    const runtime = new ViewportRuntime(canvas, {
      backgroundColor: backgroundColorRef.current,
      transparentBackground,
      backgroundPreparation,
      showGuides,
      preserveDrawingBuffer,
      memoryPolicy,
      runtimeProfile,
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
          setRuntimeGeneration((generation) => generation + 1);
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
      fourCgsSessionRef.current = null;
      raw4DSequenceSessionRef.current?.client.close();
      raw4DSequenceSessionRef.current = null;
      setRuntimeReady(false);
      onHistoryChange({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
      onRuntimeChange(null);
      runtime.destroy();
      runtimeRef.current = null;
    };
  }, [onHistoryChange, onRelightingChange, onRuntimeChange, onSelectionChange, onStatusChange, onTransformChange, preserveDrawingBuffer, runtimeProfile, showGuides, transparentBackground, backgroundPreparation]);

  useEffect(() => {
    runtimeRef.current?.setBackgroundColor(backgroundColor);
  }, [backgroundColor, runtimeReady]);

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
    // #WDD-gpt 2026-08-21 - 强制排序开关直接作用到运行时门槛，关闭时立即落地滞留帧。
    runtimeRef.current?.setForceSortSync(forceSortSync);
  }, [forceSortSync, runtimeReady]);

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
    runtimeRef.current?.setHeightRulerVisible(showHeightRuler);
  }, [runtimeReady, showHeightRuler]);

  useEffect(() => {
    runtimeRef.current?.setGaussianEnvelopeVisible(showGaussianEnvelope);
  }, [runtimeReady, showGaussianEnvelope]);

  useEffect(() => {
    runtimeRef.current?.setMemoryPolicy(memoryPolicy);
  }, [memoryPolicy, runtimeReady]);

  useEffect(() => {
    let application: Promise<void>;
    if (fourCgsSessionRef.current) {
      application = activateFourCgsFrameRef.current(currentFrame).catch((error: unknown) => {
        onStatusChange({
          phase: 'error', renderer: '4CGS 段切换失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: fourCgsSessionRef.current?.sourceName,
          format: '4CGS',
        });
      });
    } else if (raw4DSequenceSessionRef.current) {
      application = activateRaw4DSequenceFrameRef.current(currentFrame).catch((error: unknown) => {
        const session = raw4DSequenceSessionRef.current;
        const fourCgsContainer = session ? packagedRaw4DContainer(session.presentation) : undefined;
        const packagedAsFourCgs = Boolean(fourCgsContainer);
        const presentationLabel = session ? packagedRaw4DLabel(session.presentation) : 'RAW4D';
        onStatusChange({
          phase: 'error', renderer: `${presentationLabel} 段切换失败`, splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: session?.containerFile?.name ?? session?.descriptor.sourceName,
          format: packagedAsFourCgs ? '4CGS' : 'RAW4D',
          ...(fourCgsContainer ? { fourCgsContainer } : {}),
        });
      });
    } else {
      runtimeRef.current?.setFrame(currentFrame, () => onFrameDisplayedRef.current(currentFrame));
      application = Promise.resolve();
    }
    frameApplicationRef.current = application;
  }, [currentFrame, onStatusChange]);

  useEffect(() => {
    if (frameReadyRequestId <= 0) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const generation = ++frameReadyGenerationRef.current;
    const application = frameApplicationRef.current;
    // #WDD-gpt 2026-08-19 - 分段切换先完成解码与首帧提交，再等待最新排序；旧请求不得恢复新一轮播放。
    void application
      .then(() => runtime.waitForGaussianFrameReady())
      .then((sorted) => {
        if (generation === frameReadyGenerationRef.current) onFrameRenderReady(frameReadyRequestId, sorted);
      });
  }, [frameReadyRequestId, onFrameRenderReady]);

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
    const multiFourCgs = sourceFiles.length > 1 && sourceFiles.every((file) => /\.4cgs$/i.test(file.name));
    if (multiFourCgs) {
      const containerAbortController = new AbortController();
      let activeDecoder: FourCgsDecoderClient | null = null;
      const closeActiveDecoder = () => { activeDecoder?.close(); activeDecoder = null; };
      let residentSegments: readonly ViewportResidentRaw4DSegment[] = [];
      const sourceName = `4CGS × ${sourceFiles.length}`;
      onStatusChange({ phase: 'loading', renderer: '多 4CGS 清单', splatCount: 0, progress: 0,
        message: `正在检查 ${sourceFiles.length} 个 4CGS 容器`, sourceName, objectName: sourceName, format: '4CGS' });
      void (async () => {
        const manifestSources = await Promise.all(sourceFiles.map(async (file) => {
          if (await isFourCgsRaw4DZip(file)) throw new Error(`多文件序列暂不接受 ZIP 容器：${file.name}`);
          const { manifest } = await readFourCgsManifest(file);
          if (raw4DBundleStorage(manifest)) throw new Error(`多文件序列暂不接受 RAW4D Bundle：${file.name}`);
          const descriptor: FourCgsDescriptor = {
            sourceName: file.name, sourceBytes: file.size, codecName: manifest.codecName,
            firstFrame: manifest.firstFrame, lastFrame: manifest.lastFrame, totalFrames: manifest.uniqueFrameCount,
            slotCount: manifest.slotCount, segments: manifest.segments,
            sceneTransform: manifest.metadata?.sceneTransform, cameraBookmarks: manifest.metadata?.cameraBookmarks,
            crossOriginIsolated: globalThis.crossOriginIsolated,
            decodeTimings: { streamReadMs: 0, attributeDecodeMs: 0, totalMs: 0, workerCount: 1,
              hardwareConcurrency: navigator.hardwareConcurrency || 4, attributeTasksMs: {} },
          };
          return { file, descriptor };
        }));
        if (!active) return;
        const merged = mergeFourCgsDescriptors(manifestSources.map((source) => source.descriptor));
        const tasks = merged.segmentSources.map((segmentSource) => ({
          ...segmentSource,
          file: manifestSources[segmentSource.sourceIndex].file,
        }));
        let openedSourceIndex = -1;
        residentSegments = await runtime.preloadDecodedRaw4DSequence(tasks.length, async (globalSegmentIndex, cpuBudgetBytes) => {
          const task = tasks[globalSegmentIndex];
          if (openedSourceIndex !== task.sourceIndex) {
            closeActiveDecoder();
            const decoder = new FourCgsDecoderClient();
            activeDecoder = decoder;
            openedSourceIndex = task.sourceIndex;
            await decoder.open(task.file, ({ message, ratio }) => {
              if (active) onStatusChange({ phase: 'loading', renderer: '多 4CGS 顺序解码', splatCount: 0,
                progress: (globalSegmentIndex + ratio) / tasks.length * 0.55,
                message: `${task.file.name} · ${message}`, sourceName, objectName: sourceName, format: '4CGS' });
            }, true);
          }
          const decoder = activeDecoder;
          if (!decoder) throw new Error('多 4CGS 解码器未初始化。');
          // #WDD-gpt 2026-09-20 - 多容器同样直达 Canonical RAM，取消逐文件临时 RAW4D 与 Loader 二次解析；GPU 不可用时由解码器内部回退 CPU。
          const decoded = await decoder.getAsset(task.segmentIndex, cpuBudgetBytes, true);
          const timelineSegment = merged.descriptor.segments[globalSegmentIndex];
          // #WDD-gpt 2026-09-20 - 驻留文件身份使用合并后范围，保证再编码的清单仍是 600–749 / 750–899 等真实时间轴。
          return { ...decoded, file: new File([], fourCgsTimelineSourceName(task.file.name, timelineSegment)) };
        }, ({ message, ratio }) => {
          if (active) onStatusChange({ phase: 'loading', renderer: '多 4CGS 系统内存驻留', splatCount: 0,
            progress: 0.55 + ratio * 0.43, message, sourceName, objectName: sourceName, format: '4CGS' });
        }, true);
        closeActiveDecoder();
        if (!active) { runtime.releaseRaw4DSequence(residentSegments); residentSegments = []; return; }
        if (merged.descriptor.sceneTransform) runtime.restoreSceneTransform(fourCgsSceneTransformToInput(merged.descriptor.sceneTransform));
        onCameraBookmarksChange(merged.descriptor.cameraBookmarks?.bookmarks ?? [null, null, null]);
        runtime.configureRaw4DSequenceGpuCache(residentSegments);
        // #WDD-gpt 2026-09-20 - 多容器仅在清单层合并时间轴；各文件严格顺序解码并在下一文件前关闭 Worker，限制峰值内存。
        fourCgsSessionRef.current = {
          descriptor: merged.descriptor, residentSegments,
          sourceName, objectName: sourceName, segmentIndex: -1,
        };
        await activateFourCgsFrameRef.current(pendingFrameRef.current);
      })().catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({ phase: 'error', renderer: '多 4CGS 导入失败', splatCount: 0,
          message: error instanceof Error ? error.message : String(error), sourceName, objectName: sourceName, format: '4CGS' });
      });
      return () => {
        active = false; containerAbortController.abort(); closeActiveDecoder(); runtime.cancelImport();
        runtime.releaseRaw4DSequence(residentSegments); residentSegments = [];
      };
    }
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
          client, descriptor, presentation: 'raw4d', residentSegments, segmentIndex: -1,
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
      const containerAbortController = new AbortController();
      const openStartedAt = performance.now();
      let decoder: FourCgsDecoderClient | null = null;
      let sequenceClient: Raw4DSequenceClient | null = null;
      let detectedContainer: 'binary' | 'raw4d-zip' | 'raw4d-bundle' = 'binary';
      let residentSegments: readonly ViewportResidentRaw4DSegment[] = [];
      onStatusChange({
        phase: 'loading', renderer: '4CGS 自动识别', splatCount: 0, progress: 0,
        message: '正在识别 4CGS 容器', sourceName: sourceFile.name,
        objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
      });
      void (async () => {
        const openPackagedRaw4DSequence = async (
          decodedSegments: readonly File[],
          presentation: 'fourcgs-raw4d-zip' | 'fourcgs-raw4d-bundle',
          preprocessingRatio: number,
        ): Promise<void> => {
          const fourCgsContainer = packagedRaw4DContainer(presentation)!;
          const presentationLabel = packagedRaw4DLabel(presentation);
          sequenceClient = new Raw4DSequenceClient();
          const client = sequenceClient;
          const descriptor = await client.open(decodedSegments, ({ message, ratio }) => {
            if (!active) return;
            onStatusChange({
              phase: 'loading', renderer: presentationLabel, splatCount: 0,
              progress: preprocessingRatio + ratio * (0.46 - preprocessingRatio), message,
              sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
              format: '4CGS', fourCgsContainer,
            });
          });
          if (!active) return;
          const sourceOrderResidentSegments = await runtime.preloadRaw4DSequence(decodedSegments, ({ message, ratio }) => {
            if (!active) return;
            onStatusChange({
              phase: 'loading', renderer: `${presentationLabel} 系统内存驻留`, splatCount: 0,
              progress: 0.46 + ratio * 0.5, message,
              sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
              format: '4CGS', fourCgsContainer,
            });
          });
          residentSegments = descriptor.segments.map((segment) => sourceOrderResidentSegments[segment.fileIndex]);
          if (!active) {
            runtime.releaseRaw4DSequence(residentSegments);
            residentSegments = [];
            return;
          }
          const rawBundleMaxShBands = presentation === 'fourcgs-raw4d-bundle' ? 2 : undefined;
          const fullGpuPlan = (presentation === 'fourcgs-raw4d-bundle' || preloadAllSegments)
            ? runtime.getRaw4DSequenceGpuPreloadPlan(residentSegments, rawBundleMaxShBands)
            : null;
          const preloadAllGpuSegments = Boolean(fullGpuPlan?.fits);
          // #WDD-gpt 2026-09-07 - Raw Bundle 先以 SH2 试算 180 段整体显存；足够则首帧前全部建好，不足才回退当前+下一段。
          runtime.configureRaw4DSequenceGpuCache(residentSegments, {
            ...((presentation === 'fourcgs-raw4d-bundle' || preloadAllSegments)
              ? {
                maxFutureSegments: preloadAllGpuSegments ? Number.POSITIVE_INFINITY : 1,
                releaseTextureUploadSources: preloadAllGpuSegments,
              }
              : {}),
            ...(rawBundleMaxShBands === undefined ? {} : { maxShBands: rawBundleMaxShBands }),
          });
          if (fullGpuPlan) {
            if (preloadAllSegments && !fullGpuPlan.fits) throw new Error('当前显存预算不足以让全部片段驻留。');
            const requiredGiB = fullGpuPlan.requiredBytes / 1024 ** 3;
            const budgetGiB = fullGpuPlan.budgetBytes / 1024 ** 3;
            if (preloadAllGpuSegments) {
              try {
                await runtime.preloadRaw4DSequenceGpu(residentSegments, (progress) => {
                  if (!active) return;
                  onStatusChange({
                    phase: 'loading', renderer: `${presentationLabel} 全显存驻留`, splatCount: 0,
                    progress: 0.96 + progress.ratio * 0.035,
                    message: `${progress.message} · SH2 试算 ${requiredGiB.toFixed(2)} / ${budgetGiB.toFixed(2)} GiB`,
                    sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
                    format: '4CGS', fourCgsContainer,
                  });
                }, containerAbortController.signal);
                console.info(`${presentationLabel} GPU preload ${JSON.stringify({
                  segmentCount: residentSegments.length,
                  shBands: rawBundleMaxShBands,
                  requiredBytes: fullGpuPlan.requiredBytes,
                  budgetBytes: fullGpuPlan.budgetBytes,
                  completed: true,
                })}`);
              } catch (error) {
                if (preloadAllSegments || (error instanceof DOMException && error.name === 'AbortError')) throw error;
                console.warn(`${presentationLabel} 全量显存预读失败，回退当前+下一段。`, error);
                runtime.configureRaw4DSequenceGpuCache(residentSegments, {
                  maxFutureSegments: 1,
                  maxShBands: rawBundleMaxShBands,
                });
              }
            } else {
              console.warn(`${presentationLabel} GPU preload skipped ${JSON.stringify({
                segmentCount: residentSegments.length,
                shBands: rawBundleMaxShBands,
                requiredBytes: fullGpuPlan.requiredBytes,
                budgetBytes: fullGpuPlan.budgetBytes,
              })}`);
            }
          }
          raw4DSequenceSessionRef.current = {
            client,
            containerFile: sourceFile,
            descriptor,
            presentation,
            residentSegments,
            segmentIndex: -1,
          };
          await activateRaw4DSequenceFrameRef.current(pendingFrameRef.current);
          console.info(`${presentationLabel} open timings ${JSON.stringify({
            segmentCount: decodedSegments.length,
            sourceBytes: sourceFile.size,
            raw4DBytes: decodedSegments.reduce((sum, file) => sum + file.size, 0),
            totalMs: performance.now() - openStartedAt,
          })}`);
        };

        const zipDetected = await isFourCgsRaw4DZip(sourceFile);
        if (!active) return;
        if (zipDetected) {
          detectedContainer = 'raw4d-zip';
          // #WDD-gpt 2026-09-07 - ZIP 版 4CGS 自动提取内部 RAW4D，后续完全复用多段顺序、边界与驻留链路。
          const decodedSegments = await extractRaw4DFilesFromFourCgsZip(sourceFile, {
            signal: containerAbortController.signal,
            onProgress: (progress) => {
              if (!active) return;
              onStatusChange({
                phase: 'loading', renderer: '4CGS RAW4D ZIP', splatCount: 0,
                progress: progress.ratio * 0.18,
                message: progress.entryName
                  ? `已解包 ${progress.completedSegments}/${progress.discoveredSegments} · ${progress.entryName}`
                  : `正在解包 4CGS ZIP · ${(progress.ratio * 100).toFixed(0)}%`,
                sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
                format: '4CGS', fourCgsContainer: 'raw4d-zip',
              });
            },
          });
          if (!active) return;
          await openPackagedRaw4DSequence(decodedSegments, 'fourcgs-raw4d-zip', 0.18);
          return;
        }

        const directory = await readFourCgsManifest(sourceFile);
        if (raw4DBundleStorage(directory.manifest) === 'raw') {
          detectedContainer = 'raw4d-bundle';
          // #WDD-gpt 2026-09-07 - Raw Bundle 的每段由源文件 Blob slice 直接组成，不读取或复制 7GB 级容器载荷。
          const decodedSegments = createRaw4DRawBundleFiles(
            sourceFile,
            directory.manifest,
            FOUR_CGS_HEADER_BYTES + directory.manifestBytes,
          );
          onStatusChange({
            phase: 'loading', renderer: '4CGS RAW4D Bundle', splatCount: 0, progress: 0.02,
            message: `已建立 ${decodedSegments.length} 个零拷贝 RAW4D 片段视图`,
            sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
            format: '4CGS', fourCgsContainer: 'raw4d-bundle',
          });
          await openPackagedRaw4DSequence(decodedSegments, 'fourcgs-raw4d-bundle', 0.02);
          return;
        }

        const eager = eagerFourCgs.current?.file === sourceFile ? eagerFourCgs.current : null;
        decoder = eager?.decoder ?? new FourCgsDecoderClient();
        const descriptor = (eager ? await eager.result : null) ?? await decoder.open(sourceFile, ({ message, ratio }) => {
          if (!active) return;
          onStatusChange({
            phase: 'loading', renderer: '4CGS V2.4', splatCount: 0, progress: ratio * 0.55,
            message, sourceName: sourceFile.name,
            objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS', fourCgsContainer: 'binary',
          });
        });
        if (!active) return;
        // #WDD-gpt 2026-08-16 - 保留实际 bitstream 解码阶段计时，便于评估多线程是否真正缩短等待。
        console.info(`4CGS decode timings ${JSON.stringify(descriptor.decodeTimings)}`);
        if (descriptor.sceneTransform) {
          // #WDD-gpt 2026-08-16 - 通过运行时原子恢复 4CGS TRS，保证首帧实体与检查器使用同一份元数据。
          runtime.restoreSceneTransform(fourCgsSceneTransformToInput(descriptor.sceneTransform));
        }
        // #WDD-gpt 2026-08-19 - 4CGS 内嵌书签在解码清单后立即恢复；旧文件显式清空三个槽位，禁止沿用上一场景。
        onCameraBookmarksChange(descriptor.cameraBookmarks?.bookmarks ?? [null, null, null]);
        const pipelineStartedAt = performance.now();
        let canonicalGpuSegments = 0;
        let canonicalCpuSegments = 0;
        let canonicalRawSegments = 0;
        let canonicalExpansionWorkerMs = 0;
        onStatusChange({
          phase: 'loading', renderer: '4CGS 解码驻留流水线', splatCount: 0, progress: 0.55,
          message: `正在启动最多 3 条片段提取、GPU/CPU 展开与 Loader 流水线`,
          sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
          format: '4CGS', fourCgsContainer: 'binary',
        });
        // #WDD-gpt 2026-09-20 - 每条 Loader lane 只按需提取一个片段；WebGPU 可用时并行展开 FP16 列，失败自动回退 CPU，禁止先堆齐 108 个巨型 File。
        // #WDD-gpt 2026-09-20 - 继续逐段释放解码行；并行 Loader 失败时重开低并发解码器，避免为重试常驻整文件副本。
        const prepareResident = (lowConcurrency = false) => runtime.preloadDecodedRaw4DSequence(
          descriptor.segments.length,
          async (segmentIndex, cpuBudgetBytes) => {
            // #WDD-gpt 2026-09-20 - 所有 Binary 4CGS 均走直达 Canonical RAM；前景启用 GPU，后台和低并发重试保留 CPU，取消临时 File 与 Loader 二次解析。
            const decoded = await decoder!.getAsset(
              segmentIndex, cpuBudgetBytes, !backgroundPreparation && !lowConcurrency,
            );
            if (!active) throw new DOMException('4CGS 片段提取已取消。', 'AbortError');
            canonicalExpansionWorkerMs += decoded.elapsedMs;
            if (decoded.backend === 'webgpu') canonicalGpuSegments += 1;
            else canonicalCpuSegments += 1;
            return decoded;
          },
          ({ message, ratio }) => {
          if (!active) return;
          onStatusChange({
            phase: 'loading', renderer: '4CGS 解码驻留流水线', splatCount: 0,
            progress: 0.55 + ratio * 0.43,
            message: `${message} · Canonical ${canonicalGpuSegments} GPU / ${canonicalCpuSegments} CPU`,
            sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''),
            format: '4CGS', fourCgsContainer: 'binary',
          });
          },
          lowConcurrency,
        );
        try { residentSegments = await prepareResident(); }
        catch (error) {
          if (!active || (error instanceof DOMException && error.name === 'AbortError')) throw error;
          onStatusChange({ phase: 'loading', renderer: '4CGS', splatCount: 0, progress: 0.55,
            message: '并行片段准备失败，正在单流水线重试', sourceName: sourceFile.name });
          decoder!.close();
          decoder = new FourCgsDecoderClient();
          await decoder.open(sourceFile, ({ message, ratio }) => {
            if (active) onStatusChange({ phase: 'loading', renderer: '4CGS', splatCount: 0, progress: ratio * 0.55,
              message: `低并发重试 · ${message}`, sourceName: sourceFile.name });
          }, true);
          if (!active) throw new DOMException('4CGS 片段提取已取消。', 'AbortError');
          residentSegments = await prepareResident(true);
        }
        const streamedResidencyMs = performance.now() - pipelineStartedAt;
        if (!active) {
          runtime.releaseRaw4DSequence(residentSegments);
          residentSegments = [];
          return;
        }
        // #WDD-gpt 2026-09-20 - show_dance 全量预建文件内所有 GPU 段，上传完整后才允许首帧就绪。
        runtime.configureRaw4DSequenceGpuCache(residentSegments, preloadAllSegments ? {
          maxFutureSegments: Number.POSITIVE_INFINITY, releaseTextureUploadSources: true,
        } : {});
        const gpuPreloadStartedAt = performance.now();
        if (preloadAllSegments) {
          const plan = await runtime.preloadRaw4DSequenceGpu(residentSegments, (progress) => {
            if (!active) return;
            onStatusChange({ phase: 'loading', renderer: '4CGS 全显存驻留', splatCount: 0,
              message: progress.message, progress: 0.98 + progress.ratio * 0.015,
              sourceName: sourceFile.name, format: '4CGS', fourCgsContainer: 'binary' });
          }, containerAbortController.signal);
          if (!plan.fits) throw new Error(`全部显存驻留需要 ${(plan.requiredBytes / 1024 ** 3).toFixed(2)} GiB，超过当前预算 ${(plan.budgetBytes / 1024 ** 3).toFixed(2)} GiB。`);
        }
        fourCgsSessionRef.current = {
          descriptor, residentSegments,
          sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''), segmentIndex: -1,
        };
        decoder.close();
        const activationStartedAt = performance.now();
        await activateFourCgsFrameRef.current(pendingFrameRef.current);
        // #WDD-gpt 2026-08-16 - 单独记录提取、CPU 驻留和首段 GPU 激活，避免只优化 Codec 却遗漏后续等待。
        console.info(`4CGS open timings ${JSON.stringify({
          decodeMs: descriptor.decodeTimings.totalMs,
          streamedResidencyMs,
          gpuPreloadMs: activationStartedAt - gpuPreloadStartedAt,
          canonicalExpansionWorkerMs,
          canonicalGpuSegments,
          canonicalCpuSegments,
          canonicalRawSegments,
          activationMs: performance.now() - activationStartedAt,
          totalMs: performance.now() - openStartedAt,
        })}`);
      })().catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({
          phase: 'error', renderer: detectedContainer === 'binary' ? '4CGS 导入失败' : `${detectedContainer === 'raw4d-zip' ? '4CGS RAW4D ZIP' : '4CGS RAW4D Bundle'} 导入失败`, splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: sourceFile.name, objectName: sourceFile.name.replace(/\.4cgs$/i, ''), format: '4CGS',
          fourCgsContainer: detectedContainer,
        });
      });
      return () => {
        active = false;
        containerAbortController.abort();
        fourCgsLoadGenerationRef.current += 1;
        raw4DSequenceLoadGenerationRef.current += 1;
        runtime.cancelImport();
        runtime.releaseRaw4DSequence(residentSegments);
        residentSegments = [];
        decoder?.close();
        sequenceClient?.close();
        fourCgsSessionRef.current = null;
        if (sequenceClient && raw4DSequenceSessionRef.current?.client === sequenceClient) raw4DSequenceSessionRef.current = null;
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
  }, [onCameraBookmarksChange, onStatusChange, runtimeGeneration, runtimeReady, sourceFiles, preloadAllSegments, backgroundPreparation]);

  return <><canvas aria-label={viewportLabel} className="viewport-canvas" ref={canvasRef} tabIndex={0} />
    {retainFrameDuringTransitions && <canvas ref={holdCanvasRef} aria-hidden="true" data-frame-hold="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', visibility: 'hidden', pointerEvents: 'none' }} />}</>;
}
