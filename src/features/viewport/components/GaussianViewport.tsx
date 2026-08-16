import { useEffect, useRef, useState } from 'react';
import type { GaussianRenderMode } from '../../gaussian/runtime/GaussianRenderMode';
import type { Gaussian4DMemoryPolicy } from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import type { RelightingState } from '../../../plugins/relighting/RelightingTypes';
import {
  ViewportRuntime,
  type ViewportEditorTool,
  type ViewportHistoryState,
  type ViewportMemoryUsage,
  type ViewportSelectionState,
  type ViewportSelectionScope,
  type ViewportStatus,
  type ViewportTransform,
  type ViewportTransformSpace,
} from '../runtime/ViewportRuntime';

interface GaussianViewportProps {
  activeTool: ViewportEditorTool;
  brushRadius: number;
  currentFrame: number;
  memoryPolicy: Gaussian4DMemoryPolicy;
  onMemoryChange: (memory: ViewportMemoryUsage) => void;
  onHistoryChange: (state: ViewportHistoryState) => void;
  onRelightingChange: (state: RelightingState) => void;
  onRuntimeChange: (runtime: ViewportRuntime | null) => void;
  onSelectionChange: (state: ViewportSelectionState) => void;
  onStatusChange: (status: ViewportStatus) => void;
  onTransformChange: (transform: ViewportTransform) => void;
  preserveDrawingBuffer?: boolean;
  renderMode: GaussianRenderMode;
  showGuides: boolean;
  sourceFile: File | null;
  selectionScope: ViewportSelectionScope;
  transform: ViewportTransform;
  transformSpace: ViewportTransformSpace;
  uniformScale: boolean;
  viewportLabel: string;
}

export function GaussianViewport({
  activeTool,
  brushRadius,
  currentFrame,
  memoryPolicy,
  onMemoryChange,
  onHistoryChange,
  onRelightingChange,
  onRuntimeChange,
  onSelectionChange,
  onStatusChange,
  onTransformChange,
  preserveDrawingBuffer = false,
  renderMode,
  showGuides,
  sourceFile,
  selectionScope,
  transform,
  transformSpace,
  uniformScale,
  viewportLabel,
}: GaussianViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<ViewportRuntime | null>(null);
  const renderModeRef = useRef(renderMode);
  const [runtimeReady, setRuntimeReady] = useState(false);
  renderModeRef.current = renderMode;

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
      setRuntimeReady(false);
      onHistoryChange({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
      onRuntimeChange(null);
      runtime.destroy();
      runtimeRef.current = null;
    };
  }, [onHistoryChange, onRelightingChange, onRuntimeChange, onSelectionChange, onStatusChange, onTransformChange, preserveDrawingBuffer, showGuides]);

  useEffect(() => {
    runtimeRef.current?.setEditorTool(activeTool);
  }, [activeTool]);

  useEffect(() => {
    runtimeRef.current?.setGaussianSelectionScope(selectionScope);
  }, [selectionScope]);

  useEffect(() => {
    runtimeRef.current?.setGaussianSelectionBrushRadius(brushRadius);
  }, [brushRadius]);

  useEffect(() => {
    runtimeRef.current?.setSceneTransform(transform);
  }, [transform]);

  useEffect(() => {
    runtimeRef.current?.setTransformSpace(transformSpace);
  }, [transformSpace]);

  useEffect(() => {
    runtimeRef.current?.setUniformScale(uniformScale);
  }, [uniformScale]);

  useEffect(() => {
    runtimeRef.current?.setRenderMode(renderMode);
  }, [renderMode]);

  useEffect(() => {
    runtimeRef.current?.setMemoryPolicy(memoryPolicy);
  }, [memoryPolicy]);

  useEffect(() => {
    runtimeRef.current?.setFrame(currentFrame);
  }, [currentFrame]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtimeReady) return;
    const publishMemory = () => onMemoryChange(runtime.getMemoryUsage());
    publishMemory();
    // #WDD-gpt 2026-08-14 - 一秒采样一次，确保状态可读且不会干扰 4DGS 播放帧率。
    const interval = window.setInterval(publishMemory, 1000);
    return () => window.clearInterval(interval);
  }, [onMemoryChange, runtimeReady]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !runtimeReady) return;
    if (!sourceFile) {
      const status = runtime.resetToDemo();
      if (status) onStatusChange(status);
      return;
    }
    let active = true;
    runtime.loadRaw4D(sourceFile, (status) => {
      if (active) onStatusChange(status);
    }).then(
      (status) => {
        if (active) onStatusChange(status);
      },
      (error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
        onStatusChange({
          phase: 'error',
          renderer: 'RAW4D 导入失败',
          splatCount: 0,
          message: error instanceof Error ? error.message : String(error),
          sourceName: sourceFile.name,
          objectName: sourceFile.name.replace(/\.[^.]+$/, ''),
          format: 'RAW4D',
        });
      },
    );
    return () => {
      active = false;
      runtime.cancelImport();
    };
  }, [onStatusChange, runtimeReady, sourceFile]);

  return <canvas aria-label={viewportLabel} className="viewport-canvas" ref={canvasRef} tabIndex={0} />;
}
