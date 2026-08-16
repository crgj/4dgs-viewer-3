import {
  Application,
  Color,
  DEVICETYPE_WEBGPU,
  Entity,
  Gizmo,
  Layer,
  PROJECTION_ORTHOGRAPHIC,
  Quat,
  RotateGizmo,
  ScaleGizmo,
  TransformGizmo,
  TranslateGizmo,
  Vec3,
  createGraphicsDevice,
} from 'playcanvas';
import { RenderExtensionRegistry } from '../../../core/engine/RenderExtension';
import {
  EditorHistory,
  INITIAL_EDITOR_HISTORY_STATE,
  type EditorHistoryState,
} from '../../editor/history/EditorHistory';
import type {
  SmartAlignmentCapture,
  SmartAlignmentCaptureOptions,
  SmartAlignmentHost,
  SmartAlignmentTransform,
  SmartAlignmentVector3,
  SmartAlignmentViewId,
} from '../../../plugins/smart-alignment/SmartAlignmentTypes';
import { Raw4DAssetLoader } from '../../gaussian/formats/raw4d/Raw4DAssetLoader';
import type { Raw4DAsset } from '../../gaussian/formats/raw4d/Raw4DTypes';
import {
  exportCompactedRaw4D as encodeCompactedRaw4D,
  exportCompactedRaw4DSource,
  type Raw4DExportProgress,
} from '../../gaussian/formats/raw4d/Raw4DExporter';
import { readRaw4DScalar, readRaw4DTrack } from '../../gaussian/formats/raw4d/Raw4DValues';
import type {
  GaussianAttributeDefinition,
  GaussianSelectionMode,
} from '../../gaussian/edit/GaussianEditStore';
import {
  GaussianMemoryCoordinator,
  type GaussianCpuPageLease,
  type GaussianGpuExternalLease,
} from '../../gaussian/memory/GaussianMemoryCoordinator';
import {
  detectAutomaticGaussian4DMemoryPolicy,
  type Gaussian4DMemoryPolicy,
} from '../../gaussian/memory/Gaussian4DMemoryPolicy';
import { createRaw4DGaussian, type Raw4DGaussian } from '../../gaussian/runtime/createRaw4DGaussian';
import { Raw4DFrameSampler } from '../../gaussian/runtime/Raw4DFrameSampler';
import {
  installGaussianRenderModes,
  setGaussianRenderMode,
  type GaussianRenderMode,
} from '../../gaussian/runtime/GaussianRenderMode';
import {
  estimateGS2MeshFocus,
  perspectiveIntrinsics,
  rotateGS2MeshOffset,
} from '../../../plugins/gs2mesh/GS2MeshCameraPlanner';
import { GS2MeshSceneObject } from '../../../plugins/gs2mesh/GS2MeshSceneObject';
import type {
  GS2MeshCamera,
  GS2MeshCaptureOptions,
  GS2MeshCapturePair,
  GS2MeshCaptureResult,
  GS2MeshData,
  GS2MeshFieldView,
  GS2MeshGaussianCaptureOptions,
  GS2MeshGaussianFieldInput,
  GS2MeshHost,
  GS2MeshSceneStats,
  GS2MeshVector3,
} from '../../../plugins/gs2mesh/GS2MeshTypes';
import { GaussianRelightingController } from '../../../plugins/relighting/GaussianRelightingController';
import {
  INITIAL_RELIGHTING_STATE,
  type RelightingLightPatch,
  type RelightingSettings,
  type RelightingState,
} from '../../../plugins/relighting/RelightingTypes';
import { OrbitCameraController } from './camera/OrbitCameraController';
import {
  createGaussianBrushSelectionRegion,
  createGaussianPolygonSelectionRegion,
  createGaussianRectSelectionRegion,
  gaussianSelectionIdsFromMask,
  gaussianSelectionModeFromModifiers,
  normalizeGaussianSelectionRect,
  type GaussianScreenPoint,
  type GaussianScreenSelectionRegion,
  type GaussianScreenSelectionScope,
  type GaussianSelectionModifiers,
} from './selection/GaussianScreenSelection';
import { Raw4DSelectionFrameSampler } from './selection/Raw4DSelectionFrameSampler';
import { SceneGuides } from './scene/SceneGuides';

export interface ViewportStatus {
  phase: 'initializing' | 'loading' | 'ready' | 'error';
  renderer: string;
  splatCount: number;
  message?: string;
  progress?: number;
  totalFrames?: number;
  fps?: number;
  shBands?: number;
  sourceName?: string;
  objectName?: string;
  format?: 'Procedural' | 'RAW4D';
  bufferId?: string;
  sourceToResidentRatio?: number;
  memoryTransport?: 'shared-array-buffer' | 'transferable';
  gpuBackend?: 'storage-buffer' | 'texture';
  decodeBackend?: 'wasm' | 'fp16-bits' | 'typed-array';
}

export interface ViewportMemoryUsage {
  jsHeapBytes: number | null;
  jsHeapLimitBytes: number | null;
  gpuBytes: number;
  managedCpuBytes: number;
  cpuCompressedBytes: number;
  cpuDecodedBytes: number;
  cpuEvictableBytes: number;
  cpuEvictionCount: number;
  managedGpuBytes: number;
  gpuActiveBytes: number;
  gpuCachedBytes: number;
  gpuOverBudgetBytes: number;
  gpuBufferReuseCount: number;
  transferActiveCount: number;
  transferQueuedCount: number;
  transferCompletedCount: number;
  transferCancelledCount: number;
  cpuBudgetBytes: number;
  gpuBudgetBytes: number;
  transport: 'shared-array-buffer' | 'transferable';
  bufferId: string | null;
}

export interface EvaluationCameraPose {
  position: [number, number, number];
  rotation: [[number, number, number], [number, number, number], [number, number, number]];
  fx: number;
  sourceWidth: number;
}

export type ViewportTransformTool = 'move' | 'rotate' | 'scale';
export type ViewportSelectionTool = 'select-brush' | 'select-rect' | 'select-poly';
export type ViewportSelectionScope = GaussianScreenSelectionScope;
export type ViewportEditorTool = 'select' | ViewportSelectionTool | ViewportTransformTool;
export type ViewportTransformSpace = 'world' | 'local';

export interface ViewportSelectionState {
  readonly phase: 'idle' | 'selecting' | 'ready' | 'error';
  readonly scope: GaussianScreenSelectionScope | null;
  readonly progress: number;
  readonly selectedCount: number;
  readonly deletedCount?: number;
  readonly hitCount?: number;
  readonly message?: string;
}

export const INITIAL_VIEWPORT_SELECTION_STATE: ViewportSelectionState = {
  phase: 'idle',
  scope: null,
  progress: 0,
  selectedCount: 0,
  deletedCount: 0,
};

export { INITIAL_EDITOR_HISTORY_STATE };
export type { EditorHistoryState as ViewportHistoryState };

export interface ViewportTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

interface ViewportRuntimeOptions {
  showGuides?: boolean;
  preserveDrawingBuffer?: boolean;
  memoryPolicy?: Gaussian4DMemoryPolicy;
  onTransformChange?: (transform: ViewportTransform) => void;
  onRelightingChange?: (state: RelightingState) => void;
  onSelectionChange?: (state: ViewportSelectionState) => void;
  onHistoryChange?: (state: EditorHistoryState) => void;
}

interface SmartAlignmentCameraStart {
  readonly azimuthRadians: number;
  readonly distance: number;
  readonly target: Vec3;
}

export class ViewportRuntime implements SmartAlignmentHost, GS2MeshHost {
  private app: Application | null = null;
  private camera: Entity | null = null;
  private orbit: OrbitCameraController | null = null;
  private guides: SceneGuides | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly extensions = new RenderExtensionRegistry();
  private destroyRequested = false;
  private assetDisposer: (() => void) | null = null;
  private activeRaw4D: Raw4DGaussian | null = null;
  private activeRaw4DAsset: Raw4DAsset | null = null;
  private activeRaw4DSource: File | null = null;
  private gs2MeshObject: GS2MeshSceneObject | null = null;
  private relighting: GaussianRelightingController | null = null;
  private memoryCoordinator: GaussianMemoryCoordinator | null = null;
  private raw4DLoader: Raw4DAssetLoader | null = null;
  private activeFormat: 'RAW4D' | null = null;
  private importController: AbortController | null = null;
  private rendererLabel = '正在初始化';
  private pendingFrame = 0;
  private renderMode: GaussianRenderMode = 'gaussian';
  private editorTool: ViewportEditorTool = 'select';
  private selectionScope: ViewportSelectionScope = 'visible';
  private selectionBrushRadius = 48;
  private transformSpace: ViewportTransformSpace = 'world';
  private uniformScale = true;
  private smartAlignmentCaptureRunning = false;
  private gs2MeshCaptureRunning = false;
  private transformLayer: Layer | null = null;
  private readonly transformGizmos = new Map<ViewportTransformTool, TransformGizmo>();
  private readonly history: EditorHistory;
  private gizmoTransformStart: ViewportTransform | null = null;
  private smartAlignmentHistoryStart: ViewportTransform | null = null;
  private selectionOverlay: HTMLDivElement | null = null;
  private selectionBrushOverlay: HTMLDivElement | null = null;
  private selectionBrushTrailOverlay: SVGSVGElement | null = null;
  private selectionBrushTrailShape: SVGPathElement | null = null;
  private selectionPolygonOverlay: SVGSVGElement | null = null;
  private selectionPolygonShape: SVGPolygonElement | null = null;
  private selectionPolygonCursorLine: SVGLineElement | null = null;
  private selectionPolygonPoints: GaussianScreenPoint[] = [];
  private selectionPolygonCursor: GaussianScreenPoint | null = null;
  private selectionPointer: GaussianScreenPoint | null = null;
  private selectionPolygonModifiers: GaussianSelectionModifiers | null = null;
  private selectionRunId = 0;
  private selectionDrag: {
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly modifiers: GaussianSelectionModifiers;
    readonly path: GaussianScreenPoint[];
    currentX: number;
    currentY: number;
  } | null = null;
  private pendingTransform: ViewportTransform = {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: ViewportRuntimeOptions = {},
  ) {
    this.history = new EditorHistory(options.onHistoryChange);
  }

  async initialize(): Promise<ViewportStatus> {
    //WDD-gpt 2026-08-14 - 优先 WebGPU，并保留 PlayCanvas 自动追加的 WebGL2 回退路径。
    const graphicsDeviceOptions = {
      deviceTypes: [DEVICETYPE_WEBGPU],
      antialias: false,
      // #WDD-gpt 2026-08-15 - 仅独立压缩渲染器开启帧缓冲保留，正式页面维持默认性能路径。
      preserveDrawingBuffer: this.options.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
    } as Parameters<typeof createGraphicsDevice>[1] & { preserveDrawingBuffer: boolean };
    const graphicsDevice = await createGraphicsDevice(this.canvas, graphicsDeviceOptions);

    if (this.destroyRequested) {
      graphicsDevice.destroy();
      throw new Error('Viewport initialization was cancelled.');
    }

    graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const app = new Application(this.canvas, { graphicsDevice });
    this.app = app;
    this.memoryCoordinator = new GaussianMemoryCoordinator(
      graphicsDevice,
      this.options.memoryPolicy ?? detectAutomaticGaussian4DMemoryPolicy(),
    );
    this.raw4DLoader = new Raw4DAssetLoader();
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    app.scene.ambientLight = new Color(0.35, 0.38, 0.45);
    app.scene.gsplatCentersEnabled = !graphicsDevice.isWebGPU;
    installGaussianRenderModes(app, this.renderMode);

    const camera = new Entity('Editor Camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.025, 0.026, 0.029),
      fov: 48,
      nearClip: 0.01,
      farClip: 200,
    });
    camera.camera!.horizontalFov = true;
    app.root.addChild(camera);
    this.camera = camera;

    this.orbit = new OrbitCameraController(this.canvas, camera, {
      distance: 5.3,
      pitch: 30,
      target: { x: 0, y: 0.8, z: 0 },
      yaw: 38,
    });
    this.initializeGaussianSelectionInput();
    this.initializeTransformGizmos();
    // #WDD-gpt 2026-08-14 - 纯渲染验收时不创建网格和坐标轴，保证截图只含 4DGS 结果。
    if (this.options.showGuides !== false) {
      this.guides = new SceneGuides(app, camera.camera!);
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement ?? this.canvas);
    this.extensions.attachAll({ app, canvas: this.canvas });
    this.resize();
    app.start();
    this.rendererLabel = graphicsDevice.isWebGPU ? 'WebGPU · GPU Sort' : 'WebGL2 · Worker Sort';
    return this.installEmptyScene();
  }

  destroy(): void {
    this.destroyRequested = true;
    this.history.clear();
    this.destroyGaussianSelectionInput();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.extensions.disposeAttached();
    this.destroyTransformGizmos();
    this.orbit?.destroy();
    this.orbit = null;
    this.guides?.destroy();
    this.guides = null;
    this.importController?.abort();
    this.importController = null;
    this.assetDisposer?.();
    this.assetDisposer = null;
    this.activeRaw4D = null;
    this.activeRaw4DAsset = null;
    this.relighting?.destroy();
    this.relighting = null;
    this.gs2MeshObject?.destroy();
    this.gs2MeshObject = null;
    this.raw4DLoader?.destroy();
    this.raw4DLoader = null;
    this.memoryCoordinator?.destroy();
    this.memoryCoordinator = null;
    this.app?.destroy();
    this.app = null;
    this.camera = null;
  }

  //WDD-gpt 2026-08-15 - 允许质量验收直接复用训练相机外参与水平焦距，避免只在手工轨道相机上过拟合。
  setEvaluationCamera(pose: EvaluationCameraPose): void {
    const camera = this.camera;
    if (!camera?.camera) {
      throw new Error('Viewport camera is not ready.');
    }
    const position = new Vec3(...pose.position);
    const forward = new Vec3(
      pose.rotation[0][2],
      pose.rotation[1][2],
      pose.rotation[2][2],
    ).normalize();
    const up = new Vec3(
      -pose.rotation[0][1],
      -pose.rotation[1][1],
      -pose.rotation[2][1],
    ).normalize();
    camera.setPosition(position);
    camera.lookAt(position.clone().add(forward), up);
    camera.camera.horizontalFov = true;
    camera.camera.fov = 2 * Math.atan(pose.sourceWidth / (2 * pose.fx)) * 180 / Math.PI;
  }

  setRenderMode(mode: GaussianRenderMode): void {
    this.renderMode = mode;
    if (this.app) {
      setGaussianRenderMode(this.app, mode);
    }
  }

  setFrame(frame: number): void {
    this.pendingFrame = frame;
    this.activeRaw4D?.setFrame(frame);
  }

  // #WDD-gpt 2026-08-16 - 编辑 API 始终使用源点稳定 ID；删除只更新紧凑位集和 GPU R8 掩码，不重排 Canonical 数据。
  setGaussianDeleted(stableIds: readonly number[], deleted = true): void {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    this.activeRaw4D.deleteStableIds(stableIds, deleted);
  }

  isGaussianDeleted(stableId: number): boolean {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    return this.activeRaw4D.edits.isDeleted(stableId);
  }

  selectGaussians(stableIds: readonly number[], mode: GaussianSelectionMode = 'replace'): void {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    this.activeRaw4D.selectStableIds(stableIds, mode);
    this.publishSelectionState({
      phase: 'ready',
      scope: this.selectionScope,
      progress: 1,
      selectedCount: this.activeRaw4D.edits.selectionCount,
      hitCount: stableIds.length,
    });
  }

  clearGaussianSelection(): void {
    const raw4D = this.activeRaw4D;
    if (!raw4D) return;
    raw4D.selectStableIds([], 'replace');
    this.publishSelectionState({
      phase: 'ready',
      scope: this.selectionScope,
      progress: 1,
      selectedCount: 0,
      hitCount: 0,
    });
  }

  deleteSelectedGaussians(): number {
    const raw4D = this.activeRaw4D;
    if (!raw4D) return 0;
    this.cancelGaussianSelectionRun();
    const stableIds = raw4D.edits.selectedStableIds();
    const markedCount = raw4D.edits.markSelectedDeleted();
    this.publishSelectionState({
      phase: 'ready',
      scope: this.selectionScope,
      progress: 1,
      selectedCount: 0,
      hitCount: markedCount,
    });
    if (stableIds.length > 0) {
      // #WDD-gpt  2026-08-16 - 删除历史仅捕获实际由本次操作改动的稳定 ID，撤销可恢复显示和选择。
      this.history.pushApplied({
        label: 'delete',
        undo: () => {
          raw4D.deleteStableIds(stableIds, false);
          raw4D.selectStableIds(stableIds, 'add');
          this.publishGaussianEditHistoryState(raw4D, stableIds.length);
        },
        redo: () => {
          raw4D.deleteStableIds(stableIds, true);
          raw4D.selectStableIds(stableIds, 'remove');
          this.publishGaussianEditHistoryState(raw4D, stableIds.length);
        },
      });
    }
    return markedCount;
  }

  async exportCompactedRaw4D(onProgress?: (progress: Raw4DExportProgress) => void): Promise<Blob> {
    const raw4D = this.activeRaw4D;
    const asset = this.activeRaw4DAsset;
    if (!raw4D || !asset) throw new Error('No active RAW4D dataset.');
    return this.activeRaw4DSource
      ? exportCompactedRaw4DSource(this.activeRaw4DSource, raw4D.edits.deletionWords, { onProgress })
      : encodeCompactedRaw4D(asset, raw4D.edits.deletionWords, { onProgress });
  }

  // #WDD-gpt  2026-08-16 - 反选遵循当前范围：可见只切换当前帧视口内高斯，全局切换整个文件的未删除稳定 ID。
  invertGaussianSelection(scope: ViewportSelectionScope = this.selectionScope): void {
    const raw4D = this.activeRaw4D;
    if (!raw4D) return;
    this.cancelGaussianSelectionRun();
    this.selectionScope = scope;
    if (scope === 'global') {
      const invertedCount = raw4D.edits.invertUndeletedSelection();
      this.publishSelectionState({
        phase: 'ready',
        scope,
        progress: 1,
        selectedCount: raw4D.edits.selectionCount,
        hitCount: invertedCount,
      });
      return;
    }
    const bounds = this.canvas.getBoundingClientRect();
    this.startGaussianSelectionRun(
      createGaussianRectSelectionRegion({ left: 0, top: 0, right: bounds.width, bottom: bounds.height }),
      { altKey: false, ctrlKey: true, metaKey: false, shiftKey: false },
    );
  }

  isGaussianSelected(stableId: number): boolean {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    return this.activeRaw4D.edits.isSelected(stableId);
  }

  defineGaussianAttribute(definition: GaussianAttributeDefinition): void {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    this.activeRaw4D.defineAttribute(definition);
  }

  listGaussianAttributes(): readonly GaussianAttributeDefinition[] {
    return this.activeRaw4D?.edits.listAttributes() ?? [];
  }

  deleteGaussianAttribute(name: string): boolean {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    return this.activeRaw4D.edits.deleteAttribute(name);
  }

  setGaussianAttribute(name: string, stableId: number, value: number | readonly number[]): void {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    this.activeRaw4D.setAttribute(name, stableId, value);
  }

  getGaussianAttribute(name: string, stableId: number): readonly number[] | null {
    if (!this.activeRaw4D) throw new Error('No active RAW4D dataset.');
    return this.activeRaw4D.edits.getAttribute(name, stableId);
  }

  // #WDD-gpt 2026-08-15 - 将检查器数值直接写入活动 Gaussian 实体，修复原有只读 UI 不生效的问题。
  setSceneTransform(transform: ViewportTransform): void {
    const next: ViewportTransform = {
      position: [...transform.position],
      rotation: [...transform.rotation],
      scale: transform.scale.map((value) => Math.max(0.001, value)) as [number, number, number],
    };
    if (this.transformsEqual(this.pendingTransform, next)) return;
    const previous = this.getSceneTransform();
    this.pendingTransform = next;
    const entity = this.activeRaw4D?.entity;
    if (!entity) return;
    this.applyTransform(entity, this.pendingTransform);
    this.activeGizmo()?.update();
    this.pushTransformHistory(previous, next);
  }

  getHistoryState(): EditorHistoryState {
    return this.history.getState();
  }

  undo(): boolean {
    this.cancelGaussianSelectionRun();
    return this.history.undo();
  }

  redo(): boolean {
    this.cancelGaussianSelectionRun();
    return this.history.redo();
  }

  setEditorTool(tool: ViewportEditorTool): void {
    if (this.editorTool === tool) return;
    this.cancelGaussianSelectionRun();
    this.editorTool = tool;
    const selectionTool = this.selectionToolForEditor();
    this.canvas.classList.toggle('gaussian-selection-active', selectionTool !== null);
    this.canvas.classList.toggle('gaussian-selection-brush', selectionTool === 'select-brush');
    this.canvas.classList.toggle('gaussian-selection-poly', selectionTool === 'select-poly');
    this.updateGaussianSelectionOverlayVisibility();
    if (selectionTool) {
      this.publishSelectionState({
        phase: this.activeRaw4D ? 'ready' : 'idle',
        scope: this.selectionScope,
        progress: this.activeRaw4D ? 1 : 0,
        selectedCount: this.activeRaw4D?.edits.selectionCount ?? 0,
      });
    }
    this.updateTransformGizmoAttachment();
  }

  setGaussianSelectionScope(scope: ViewportSelectionScope): void {
    if (this.selectionScope === scope) return;
    this.cancelGaussianSelectionRun();
    this.selectionScope = scope;
    if (this.selectionToolForEditor()) {
      this.publishSelectionState({
        phase: this.activeRaw4D ? 'ready' : 'idle',
        scope,
        progress: this.activeRaw4D ? 1 : 0,
        selectedCount: this.activeRaw4D?.edits.selectionCount ?? 0,
      });
    }
  }

  setGaussianSelectionBrushRadius(radius: number): void {
    this.selectionBrushRadius = Math.max(8, Math.min(160, radius));
    this.updateGaussianBrushOverlay();
    this.updateGaussianBrushTrailOverlay();
  }

  setTransformSpace(space: ViewportTransformSpace): void {
    this.transformSpace = space;
    this.transformGizmos.forEach((gizmo) => {
      gizmo.coordSpace = space;
    });
  }

  setUniformScale(uniform: boolean): void {
    this.uniformScale = uniform;
    const scaleGizmo = this.transformGizmos.get('scale');
    if (scaleGizmo instanceof ScaleGizmo) scaleGizmo.uniform = uniform;
  }

  setMemoryPolicy(policy: Gaussian4DMemoryPolicy): void {
    this.memoryCoordinator?.setPolicy(policy);
  }

  getMemoryUsage(): ViewportMemoryUsage {
    // #WDD-gpt 2026-08-14 - 同时采集浏览器实际 JS Heap 和 PlayCanvas 跟踪的 GPU 资源占用。
    const memory = (performance as PerformanceWithMemory).memory;
    const vram = this.app?.graphicsDevice._vram;
    const managed = this.memoryCoordinator?.getStats();
    return {
      jsHeapBytes: memory?.usedJSHeapSize ?? null,
      jsHeapLimitBytes: memory?.jsHeapSizeLimit ?? null,
      gpuBytes: vram
        ? (vram.tex ?? 0) + (vram.vb ?? 0) + (vram.ib ?? 0) + (vram.ub ?? 0) + (vram.sb ?? 0)
        : 0,
      managedCpuBytes: managed?.cpuResidentBytes ?? 0,
      cpuCompressedBytes: managed?.cpuCompressedBytes ?? 0,
      cpuDecodedBytes: managed?.cpuDecodedBytes ?? 0,
      cpuEvictableBytes: managed?.cpuEvictableBytes ?? 0,
      cpuEvictionCount: managed?.cpuEvictionCount ?? 0,
      managedGpuBytes: managed?.gpuManagedBytes ?? 0,
      gpuActiveBytes: managed?.gpuActiveBytes ?? 0,
      gpuCachedBytes: managed?.gpuCachedBytes ?? 0,
      gpuOverBudgetBytes: managed?.gpuOverBudgetBytes ?? 0,
      gpuBufferReuseCount: managed?.gpuBufferReuseCount ?? 0,
      transferActiveCount: managed?.transferActiveCount ?? 0,
      transferQueuedCount: managed?.transferQueuedCount ?? 0,
      transferCompletedCount: managed?.transferCompletedCount ?? 0,
      transferCancelledCount: managed?.transferCancelledCount ?? 0,
      cpuBudgetBytes: managed?.cpuBudgetBytes ?? 0,
      gpuBudgetBytes: managed?.gpuBudgetBytes ?? 0,
      transport: managed?.transport ?? 'transferable',
      bufferId: managed?.activeBufferId ?? null,
    };
  }

  // #WDD-gpt 2026-08-15 - 为 UI 同步和浏览器验收提供只读变换/相机快照，不暴露底层 PlayCanvas 实体。
  getSceneTransform(): ViewportTransform {
    return {
      position: [...this.pendingTransform.position],
      rotation: [...this.pendingTransform.rotation],
      scale: [...this.pendingTransform.scale],
    };
  }

  getCameraPosition(): [number, number, number] | null {
    if (!this.camera) return null;
    const position = this.camera.getPosition();
    return [position.x, position.y, position.z];
  }

  getSmartAlignmentTransform(): ViewportTransform {
    const transform = this.getSceneTransform();
    this.smartAlignmentHistoryStart = transform;
    return transform;
  }

  restoreSmartAlignmentTransform(transform: SmartAlignmentTransform): void {
    const restored: ViewportTransform = {
      position: [...transform.position],
      rotation: [...transform.rotation],
      scale: [...transform.scale],
    };
    this.applyHistoricalTransform(restored);
    this.smartAlignmentHistoryStart = null;
  }

  // #WDD-gpt  2026-08-16 - 智能对齐包含多轮试算，成功后合并为一条历史，失败恢复不污染撤销栈。
  commitSmartAlignmentTransform(): void {
    const previous = this.smartAlignmentHistoryStart;
    this.smartAlignmentHistoryStart = null;
    if (previous) this.pushTransformHistory(previous, this.getSceneTransform());
  }

  applySmartAlignmentSolution(
    worldUp: SmartAlignmentVector3,
    standingCenter: SmartAlignmentVector3,
  ): SmartAlignmentVector3 {
    const entity = this.activeRaw4D?.entity;
    if (!entity) throw new Error('请先导入 RAW4D 文件。');
    const source = new Vec3(...worldUp);
    if (source.lengthSq() < 1e-8) throw new Error('人体朝向向量无效。');
    source.normalize();
    const correction = new Quat().setFromDirections(source, Vec3.UP);
    const nextRotation = new Quat().mul2(correction, entity.getRotation()).normalize();
    const pivot = entity.getPosition().clone();
    const correctedStandingCenter = correction
      .transformVector(new Vec3(...standingCenter).sub(pivot))
      .add(pivot);
    entity.setRotation(nextRotation);
    entity.setPosition(pivot.sub(correctedStandingCenter));
    this.publishActiveTransform();
    this.activeGizmo()?.update();
    return [correctedStandingCenter.x, correctedStandingCenter.y, correctedStandingCenter.z];
  }

  async captureSmartAlignmentViews(
    viewIds: readonly SmartAlignmentViewId[],
    options: SmartAlignmentCaptureOptions = {},
  ): Promise<SmartAlignmentCapture[]> {
    const app = this.app;
    const camera = this.camera;
    if (!app || !camera?.camera || !this.activeRaw4D) {
      throw new Error('请先完成 RAW4D 文件导入。');
    }
    if (this.smartAlignmentCaptureRunning) throw new Error('智能对齐抓帧正在进行。');
    this.smartAlignmentCaptureRunning = true;

    const cameraPosition = camera.getLocalPosition().clone();
    const cameraRotation = camera.getLocalRotation().clone();
    const cameraProjection = camera.camera.projection;
    const cameraOrthoHeight = camera.camera.orthoHeight;
    const cameraHorizontalFov = camera.camera.horizontalFov;
    const cameraFov = camera.camera.fov;
    const cameraNearClip = camera.camera.nearClip;
    const cameraFarClip = camera.camera.farClip;
    const guidesEnabled = this.guides?.getEnabled() ?? false;
    const captures: SmartAlignmentCapture[] = [];
    const cameraStart = this.getSmartAlignmentCameraStart();

    this.detachTransformGizmos();
    this.orbit?.setInputEnabled(false);
    this.guides?.setEnabled(false);
    try {
      for (let index = 0; index < viewIds.length; index += 1) {
        const id = viewIds[index];
        const metadata = options.useCurrentCameraAsFirstView && index === 0
          ? this.describeCurrentSmartAlignmentCamera(id, cameraStart)
          : this.configureSmartAlignmentCamera(id, cameraStart);
        // #WDD-gpt 2026-08-15 - 相机切换后等待两次完整渲染，使 GPU/Worker Gaussian 排序稳定后再抓取识别帧。
        await this.waitForPostRender();
        await this.waitForPostRender();
        captures.push({ ...metadata, bitmap: await this.captureViewportBitmap() });
      }
      return captures;
    } catch (error) {
      captures.forEach(({ bitmap }) => bitmap.close());
      throw error;
    } finally {
      camera.setLocalPosition(cameraPosition);
      camera.setLocalRotation(cameraRotation);
      camera.camera.projection = cameraProjection;
      camera.camera.orthoHeight = cameraOrthoHeight;
      camera.camera.horizontalFov = cameraHorizontalFov;
      camera.camera.fov = cameraFov;
      camera.camera.nearClip = cameraNearClip;
      camera.camera.farClip = cameraFarClip;
      this.guides?.setEnabled(guidesEnabled);
      this.smartAlignmentCaptureRunning = false;
      this.updateTransformGizmoAttachment();
      this.orbit?.setInputEnabled(true);
    }
  }

  async captureGS2MeshViews(options: GS2MeshCaptureOptions): Promise<GS2MeshCaptureResult> {
    const app = this.app;
    const camera = this.camera;
    const raw4D = this.activeRaw4D;
    const asset = this.activeRaw4DAsset;
    if (!app || !camera?.camera || !raw4D || !asset) {
      throw new Error('请先完成 RAW4D 文件导入。');
    }
    if (camera.camera.projection === PROJECTION_ORTHOGRAPHIC) {
      throw new Error('GS2Mesh 双目深度需要透视摄像机，请先切换回透视视图。');
    }
    if (this.gs2MeshCaptureRunning || this.smartAlignmentCaptureRunning) {
      throw new Error('另一个多视角抓帧任务正在进行。');
    }
    const viewCount = Math.max(3, Math.min(16, Math.round(options.viewCount)));
    const resolution = Math.max(256, Math.min(1280, Math.round(options.resolution)));
    const baselinePercent = Math.max(1, Math.min(20, options.baselinePercent));
    this.gs2MeshCaptureRunning = true;

    const originalPosition = camera.getPosition().clone();
    const originalRotation = camera.getRotation().clone();
    const originalProjection = camera.camera.projection;
    const originalHorizontalFov = camera.camera.horizontalFov;
    const originalFov = camera.camera.fov;
    const originalNearClip = camera.camera.nearClip;
    const originalFarClip = camera.camera.farClip;
    const guidesEnabled = this.guides?.getEnabled() ?? false;
    const meshVisible = this.gs2MeshObject?.visible ?? false;
    const gaussianVisible = raw4D.entity.enabled;
    const { min, max } = this.getSmartAlignmentWorldBounds();
    const fallback = min.clone().add(max).mulScalar(0.5);
    const focusPoints = this.sampleGS2MeshWorldPoints(asset, raw4D, this.pendingFrame);
    const focusEstimate = estimateGS2MeshFocus(
      [originalPosition.x, originalPosition.y, originalPosition.z],
      [camera.forward.x, camera.forward.y, camera.forward.z],
      focusPoints,
      [fallback.x, fallback.y, fallback.z],
    );
    const focus = new Vec3(...focusEstimate.focus);
    const surfaceSampleCount = Math.min(30_000, focusPoints.length);
    const surfacePoints = new Float32Array(surfaceSampleCount * 3);
    for (let index = 0; index < surfaceSampleCount; index += 1) {
      const source = focusPoints[Math.floor(index * focusPoints.length / surfaceSampleCount)];
      surfacePoints[index * 3] = source[0];
      surfacePoints[index * 3 + 1] = source[1];
      surfacePoints[index * 3 + 2] = source[2];
    }
    const boundsDiagonal = max.clone().sub(min).length();
    const sceneRadius = Math.max(boundsDiagonal * 0.5, focusEstimate.distance * 0.1, 0.001);
    // #WDD-gpt 2026-08-15 - GS2Mesh 的基线百分比相对于摄像机到焦点的环绕半径，而不是场景包围盒半径。
    const baseline = Math.max(0.0001, focusEstimate.distance * baselinePercent / 100);
    const aspect = Math.max(0.1, this.canvas.width / Math.max(1, this.canvas.height));
    const captureWidth = resolution;
    const captureHeight = Math.max(128, Math.round(resolution / aspect));
    const intrinsics = perspectiveIntrinsics(
      captureWidth,
      captureHeight,
      camera.camera.fov,
      camera.camera.horizontalFov,
    );
    const originalOffset: GS2MeshVector3 = [
      originalPosition.x - focus.x,
      originalPosition.y - focus.y,
      originalPosition.z - focus.z,
    ];
    const pairs: GS2MeshCapturePair[] = [];

    this.detachTransformGizmos();
    this.orbit?.setInputEnabled(false);
    this.guides?.setEnabled(false);
    this.gs2MeshObject?.setVisible(false);
    raw4D.entity.enabled = true;
    try {
      for (let index = 0; index < viewCount; index += 1) {
        if (options.signal?.aborted) throw new DOMException('GS2Mesh capture was cancelled.', 'AbortError');
        if (index === 0) {
          // #WDD-gpt 2026-08-15 - 第一组双目的左眼严格保留用户点击时的当前摄像机视角。
          camera.setPosition(originalPosition);
          camera.setRotation(originalRotation);
        } else {
          const angle = index * Math.PI * 2 / viewCount;
          const offset = rotateGS2MeshOffset(originalOffset, [0, 1, 0], angle);
          camera.setPosition(focus.x + offset[0], focus.y + offset[1], focus.z + offset[2]);
          const forward = focus.clone().sub(camera.getPosition()).normalize();
          const upHint = Math.abs(forward.dot(Vec3.UP)) > 0.96 ? camera.up.clone() : Vec3.UP;
          camera.lookAt(focus, upHint);
        }

        await this.waitForStableCapture();
        const leftCamera = this.describeGS2MeshCamera(captureWidth, captureHeight, intrinsics);
        const left = await this.captureGS2MeshImage(captureWidth, captureHeight);
        const leftPosition = camera.getPosition().clone();
        const leftRotation = camera.getRotation().clone();
        camera.setPosition(leftPosition.clone().add(camera.right.clone().mulScalar(baseline)));
        camera.setRotation(leftRotation);
        await this.waitForStableCapture();
        const rightCamera = this.describeGS2MeshCamera(captureWidth, captureHeight, intrinsics);
        const right = await this.captureGS2MeshImage(captureWidth, captureHeight);
        pairs.push({
          id: `orbit-${index.toString().padStart(3, '0')}`,
          left,
          right,
          leftCamera,
          rightCamera,
          baseline,
        });
        options.onProgress?.(index + 1, viewCount);
      }
      return {
        frame: this.pendingFrame,
        focus: [focus.x, focus.y, focus.z],
        sceneRadius,
        boundsMin: [min.x, min.y, min.z],
        boundsMax: [max.x, max.y, max.z],
        // #WDD-gpt 2026-08-15 - 向前端融合器提供当前帧 Gaussian 表面样本，用空间邻域约束剔除双目漂浮点。
        surfacePoints,
        pairs,
      };
    } finally {
      camera.setPosition(originalPosition);
      camera.setRotation(originalRotation);
      camera.camera.projection = originalProjection;
      camera.camera.horizontalFov = originalHorizontalFov;
      camera.camera.fov = originalFov;
      camera.camera.nearClip = originalNearClip;
      camera.camera.farClip = originalFarClip;
      this.guides?.setEnabled(guidesEnabled);
      this.gs2MeshObject?.setVisible(meshVisible);
      raw4D.entity.enabled = gaussianVisible;
      this.gs2MeshCaptureRunning = false;
      this.updateTransformGizmoAttachment();
      this.orbit?.setInputEnabled(true);
    }
  }

  async captureGS2MeshGaussians(
    options: GS2MeshGaussianCaptureOptions,
  ): Promise<GS2MeshGaussianFieldInput> {
    const raw4D = this.activeRaw4D;
    const asset = this.activeRaw4DAsset;
    const camera = this.camera;
    if (!raw4D || !asset || !camera) throw new Error('请先完成 RAW4D 文件导入。');
    if (camera.camera?.projection === PROJECTION_ORTHOGRAPHIC) {
      throw new Error('GS2Mesh Visual Hull 需要透视摄像机，请先切换回透视视图。');
    }
    if (options.signal?.aborted) {
      throw new DOMException('GS2Mesh Gaussian sampling was cancelled.', 'AbortError');
    }

    const maximum = Math.max(10_000, Math.min(200_000, Math.round(options.maxGaussians)));
    const sampler = new Raw4DFrameSampler(asset);
    sampler.sample(this.pendingFrame);
    const properties = sampler.properties;
    const groupSize = Math.max(1, Math.ceil(asset.splatCount / maximum));
    const selected: number[] = [];
    for (let start = 0; start < asset.splatCount; start += groupSize) {
      let bestIndex = -1;
      let bestScore = 0;
      const end = Math.min(asset.splatCount, start + groupSize);
      for (let index = start; index < end; index += 1) {
        if (raw4D.edits.isDeleted(index)) continue;
        const opacity = properties.opacity[index];
        const largestScale = Math.max(
          properties.scaleX[index],
          properties.scaleY[index],
          properties.scaleZ[index],
        );
        const score = opacity * Math.sqrt(Math.max(0, largestScale));
        if (opacity >= 0.035 && Number.isFinite(score) && score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) selected.push(bestIndex);
      if (((start / groupSize) & 4095) === 0) {
        if (options.signal?.aborted) {
          throw new DOMException('GS2Mesh Gaussian sampling was cancelled.', 'AbortError');
        }
        options.onProgress?.(Math.min(end, asset.splatCount), asset.splatCount);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (selected.length < 64) throw new Error('当前帧没有足够的可见 Gaussian 用于表面重建。');

    const positions = new Float32Array(selected.length * 3);
    const rotations = new Float32Array(selected.length * 4);
    const scales = new Float32Array(selected.length * 3);
    const colors = new Uint8Array(selected.length * 4);
    const opacities = new Float32Array(selected.length);
    const matrix = raw4D.entity.getWorldTransform();
    const entityRotation = raw4D.entity.getRotation();
    const entityScale = matrix.getScale(new Vec3());
    const uniformScale = Math.max(
      1e-6,
      Math.abs(entityScale.x),
      Math.abs(entityScale.y),
      Math.abs(entityScale.z),
    );
    const localPosition = new Vec3();
    const worldPosition = new Vec3();
    const localRotation = new Quat();
    const worldRotation = new Quat();
    const min = new Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = new Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    const focusSamples: GS2MeshVector3[] = [];
    const focusStride = Math.max(1, Math.ceil(selected.length / 30_000));
    const shC0 = 0.28209479177387814;
    for (let outputIndex = 0; outputIndex < selected.length; outputIndex += 1) {
      const sourceIndex = selected[outputIndex];
      matrix.transformPoint(localPosition.set(
        properties.x[sourceIndex],
        properties.y[sourceIndex],
        properties.z[sourceIndex],
      ), worldPosition);
      const positionOffset = outputIndex * 3;
      positions[positionOffset] = worldPosition.x;
      positions[positionOffset + 1] = worldPosition.y;
      positions[positionOffset + 2] = worldPosition.z;
      min.x = Math.min(min.x, worldPosition.x);
      min.y = Math.min(min.y, worldPosition.y);
      min.z = Math.min(min.z, worldPosition.z);
      max.x = Math.max(max.x, worldPosition.x);
      max.y = Math.max(max.y, worldPosition.y);
      max.z = Math.max(max.z, worldPosition.z);
      if (outputIndex % focusStride === 0) {
        focusSamples.push([worldPosition.x, worldPosition.y, worldPosition.z]);
      }

      localRotation.set(
        properties.rotationX[sourceIndex],
        properties.rotationY[sourceIndex],
        properties.rotationZ[sourceIndex],
        properties.rotationW[sourceIndex],
      );
      worldRotation.mul2(entityRotation, localRotation).normalize();
      const rotationOffset = outputIndex * 4;
      // #WDD-gpt 2026-08-15 - 不透明度场以世界空间 xyzw 四元数保存各向异性 Gaussian 方向。
      rotations[rotationOffset] = worldRotation.x;
      rotations[rotationOffset + 1] = worldRotation.y;
      rotations[rotationOffset + 2] = worldRotation.z;
      rotations[rotationOffset + 3] = worldRotation.w;
      scales[positionOffset] = Math.max(1e-7, properties.scaleX[sourceIndex] * uniformScale);
      scales[positionOffset + 1] = Math.max(1e-7, properties.scaleY[sourceIndex] * uniformScale);
      scales[positionOffset + 2] = Math.max(1e-7, properties.scaleZ[sourceIndex] * uniformScale);
      const colorOffset = outputIndex * 4;
      colors[colorOffset] = Math.round(Math.max(0, Math.min(1, 0.5 + properties.colorR[sourceIndex] * shC0)) * 255);
      colors[colorOffset + 1] = Math.round(Math.max(0, Math.min(1, 0.5 + properties.colorG[sourceIndex] * shC0)) * 255);
      colors[colorOffset + 2] = Math.round(Math.max(0, Math.min(1, 0.5 + properties.colorB[sourceIndex] * shC0)) * 255);
      colors[colorOffset + 3] = 255;
      opacities[outputIndex] = properties.opacity[sourceIndex];
    }
    options.onProgress?.(asset.splatCount, asset.splatCount);

    const fallback = min.clone().add(max).mulScalar(0.5);
    const focusEstimate = estimateGS2MeshFocus(
      [camera.getPosition().x, camera.getPosition().y, camera.getPosition().z],
      [camera.forward.x, camera.forward.y, camera.forward.z],
      focusSamples,
      [fallback.x, fallback.y, fallback.z],
    );
    const focus = new Vec3(...focusEstimate.focus);
    const cameraPosition = camera.getPosition();
    const cameraOffset: GS2MeshVector3 = [
      cameraPosition.x - focus.x,
      cameraPosition.y - focus.y,
      cameraPosition.z - focus.z,
    ];
    const viewCount = Math.max(4, Math.min(16, Math.round(options.viewCount)));
    const captureWidth = Math.max(1, this.canvas.width);
    const captureHeight = Math.max(1, this.canvas.height);
    const intrinsics = perspectiveIntrinsics(
      captureWidth,
      captureHeight,
      camera.camera?.fov ?? 60,
      camera.camera?.horizontalFov ?? false,
    );
    const tanHalfFovX = captureWidth * 0.5 / intrinsics.fx;
    const tanHalfFovY = captureHeight * 0.5 / intrinsics.fy;
    const views: GS2MeshFieldView[] = [];
    for (let index = 0; index < viewCount; index += 1) {
      const offset = index === 0
        ? cameraOffset
        : rotateGS2MeshOffset(cameraOffset, [0, 1, 0], index * Math.PI * 2 / viewCount);
      const position = new Vec3(focus.x + offset[0], focus.y + offset[1], focus.z + offset[2]);
      if (index === 0) {
        views.push({
          position: [position.x, position.y, position.z],
          right: [camera.right.x, camera.right.y, camera.right.z],
          up: [camera.up.x, camera.up.y, camera.up.z],
          forward: [camera.forward.x, camera.forward.y, camera.forward.z],
          tanHalfFovX,
          tanHalfFovY,
        });
        continue;
      }
      const forward = focus.clone().sub(position).normalize();
      const upHint = Math.abs(forward.dot(Vec3.UP)) > 0.96 ? camera.up.clone() : Vec3.UP;
      const right = new Vec3().cross(forward, upHint).normalize();
      const up = new Vec3().cross(right, forward).normalize();
      views.push({
        position: [position.x, position.y, position.z],
        right: [right.x, right.y, right.z],
        up: [up.x, up.y, up.z],
        forward: [forward.x, forward.y, forward.z],
        tanHalfFovX,
        tanHalfFovY,
      });
    }
    const sceneUnitMillimeters = Number.isFinite(options.sceneUnitMillimeters)
      ? Math.max(1e-3, Math.min(1_000_000, options.sceneUnitMillimeters))
      : 1000;
    const targetVoxelMillimeters = Number.isFinite(options.targetVoxelMillimeters)
      ? Math.max(0.1, Math.min(20, options.targetVoxelMillimeters))
      : 0.5;
    return {
      frame: this.pendingFrame,
      focus: focusEstimate.focus,
      boundsMin: [min.x, min.y, min.z],
      boundsMax: [max.x, max.y, max.z],
      positions,
      rotations,
      scales,
      colors,
      opacities,
      // #WDD-gpt 2026-08-15 - 当前相机始终是 Visual Hull/GOF 的第一视角，其余视角只构造参数而不重复渲染截图。
      views,
      // #WDD-gpt 2026-08-15 - Keep the legacy quality control for previews while metric leaf spacing drives the sparse refinement path.
      fieldResolution: Math.max(48, Math.min(1024, Math.round(options.fieldResolution))),
      isoLevel: Math.max(0.08, Math.min(0.8, options.isoLevel)),
      // #WDD-gpt 2026-08-15 - Convert the user-provided physical calibration to a world-space leaf size before transferring the frame to the Worker.
      sceneUnitMillimeters,
      targetVoxelMillimeters,
      targetVoxelSize: Math.max(1e-7, Math.min(
        1,
        targetVoxelMillimeters / sceneUnitMillimeters,
      )),
      smoothingIterations: Number.isFinite(options.smoothingIterations)
        ? Math.max(0, Math.min(5, Math.round(options.smoothingIterations)))
        : 3,
    };
  }

  installGS2Mesh(data: GS2MeshData): GS2MeshSceneStats {
    if (!this.app) throw new Error('三维视口尚未初始化完成。');
    const previous = this.gs2MeshObject;
    const next = new GS2MeshSceneObject(this.app, data);
    this.gs2MeshObject = next;
    this.relighting?.setProxy(next);
    previous?.destroy();
    return next.stats;
  }

  clearGS2Mesh(): void {
    this.relighting?.setProxy(null);
    this.gs2MeshObject?.destroy();
    this.gs2MeshObject = null;
  }

  setGS2MeshVisible(visible: boolean): void {
    this.gs2MeshObject?.setVisible(visible);
  }

  setGaussianVisible(visible: boolean): void {
    if (this.activeRaw4D) this.activeRaw4D.entity.enabled = visible;
  }

  // #WDD-gpt 2026-08-15 - 重光照控制器按需创建，核心离屏渲染、阴影和光源编辑全部留在当前浏览器场景。
  getRelightingState(): RelightingState {
    return this.relighting?.getState() ?? { ...INITIAL_RELIGHTING_STATE };
  }

  setRelightingEnabled(enabled: boolean): RelightingState {
    return this.ensureRelighting().setEnabled(enabled);
  }

  setRelightingEditing(editing: boolean): RelightingState {
    if (!editing && !this.relighting) return this.getRelightingState();
    return this.ensureRelighting().setEditing(editing);
  }

  addRelightingLight(): RelightingState {
    return this.ensureRelighting().addLight();
  }

  removeRelightingLight(id: string): RelightingState {
    return this.ensureRelighting().removeLight(id);
  }

  selectRelightingLight(id: string | null): RelightingState {
    return this.ensureRelighting().setSelectedLight(id);
  }

  updateRelightingLight(id: string, patch: RelightingLightPatch): RelightingState {
    return this.ensureRelighting().updateLight(id, patch);
  }

  updateRelightingSettings(patch: Partial<RelightingSettings>): RelightingState {
    return this.ensureRelighting().updateSettings(patch);
  }

  cancelImport(): void {
    this.importController?.abort();
    this.importController = null;
  }

  resetToDemo(): ViewportStatus | null {
    this.cancelImport();
    if (!this.app) return null;
    if (this.activeFormat === null) {
      return this.emptyStatus();
    }
    return this.installEmptyScene();
  }

  async loadRaw4D(
    file: File,
    onStatusChange: (status: ViewportStatus) => void,
  ): Promise<ViewportStatus> {
    if (!this.app || !this.memoryCoordinator || !this.raw4DLoader) {
      throw new Error('三维视口尚未初始化完成。');
    }
    this.cancelGaussianSelectionRun();
    this.publishSelectionState(INITIAL_VIEWPORT_SELECTION_STATE);
    this.cancelImport();
    const controller = new AbortController();
    this.importController = controller;
    const loadingStatus = (message: string, progress: number): ViewportStatus => ({
      phase: 'loading',
      renderer: this.rendererLabel,
      splatCount: 0,
      message,
      progress,
      sourceName: file.name,
      objectName: file.name.replace(/\.[^.]+$/, ''),
      format: 'RAW4D',
    });
    onStatusChange(loadingStatus('正在打开 RAW4D 文件', 0));

    const loadedAsset = await this.raw4DLoader.load(file, this.memoryCoordinator.availableCpuBytes, {
      signal: controller.signal,
      onProgress: ({ message, ratio }) => {
        if (!controller.signal.aborted) {
          onStatusChange(loadingStatus(message, ratio));
        }
      },
    });
    if (controller.signal.aborted || this.destroyRequested || !this.app || !this.memoryCoordinator) {
      loadedAsset.releaseBacking();
      throw new DOMException('RAW4D import was cancelled.', 'AbortError');
    }

    let residentAsset: GaussianCpuPageLease<Raw4DAsset>;
    try {
      residentAsset = this.memoryCoordinator.registerCpuPage({
        id: loadedAsset.bufferId,
        kind: 'decoded',
        byteSize: loadedAsset.cpuResidentBytes,
        value: loadedAsset.asset,
        transport: loadedAsset.transport,
        pinned: true,
        onEvict: loadedAsset.releaseBacking,
      });
    } catch (error) {
      loadedAsset.releaseBacking();
      throw error;
    }

    onStatusChange(loadingStatus('正在写入长期 GPUBuffer 并建立 GPU 解码路径', 0.99));
    let raw4D: Raw4DGaussian;
    try {
      const app = this.app;
      const memoryCoordinator = this.memoryCoordinator;
      raw4D = await memoryCoordinator.scheduleGpuTransfer({
        key: `raw4d:${residentAsset.id}`,
        priority: 'immediate',
        signal: controller.signal,
        run: () => createRaw4DGaussian(app, residentAsset.value, memoryCoordinator.gpuPool),
      });
    } catch (error) {
      residentAsset.release();
      throw error;
    }
    if (controller.signal.aborted || this.destroyRequested || !this.app || !this.memoryCoordinator) {
      raw4D.dispose();
      residentAsset.release();
      throw new DOMException('RAW4D import was cancelled.', 'AbortError');
    }
    let editLease: GaussianCpuPageLease<Raw4DGaussian['edits']>;
    let gpuExternalLease: GaussianGpuExternalLease;
    try {
      editLease = this.memoryCoordinator.registerCpuPage({
        id: `${residentAsset.id}:edits`,
        kind: 'decoded',
        byteSize: raw4D.edits.byteLength,
        value: raw4D.edits,
        transport: 'transferable',
        pinned: true,
      });
      gpuExternalLease = this.memoryCoordinator.registerExternalGpuAllocation(
        `${residentAsset.id}:textures`, raw4D.externalGpuByteSize,
      );
    } catch (error) {
      raw4D.dispose();
      residentAsset.release();
      throw error;
    }
    const stopTrackingEditMemory = raw4D.edits.onChange(() => editLease.resize(raw4D.edits.byteLength));
    raw4D.setFrame(this.pendingFrame);
    this.clearGS2Mesh();
    const previousDisposer = this.assetDisposer;
    this.assetDisposer = () => {
      stopTrackingEditMemory();
      raw4D.dispose();
      gpuExternalLease.release();
      editLease.release();
      residentAsset.release();
    };
    // #WDD-gpt  2026-08-16 - 文件切换后旧实体命令不再有效，只在新资源确认可用后清空历史。
    this.history.clear();
    this.activeRaw4D = raw4D;
    this.activeRaw4DAsset = residentAsset.value;
    this.activeRaw4DSource = file;
    this.activeFormat = 'RAW4D';
    this.memoryCoordinator.setActiveCpuPage(residentAsset.id);
    this.applyTransform(raw4D.entity, this.pendingTransform);
    // #WDD-gpt  2026-08-15 - 仅在存在活动 Gaussian 时挂载网格深度代理，避免空场景保留已销毁的绘制实例。
    this.guides?.setGaussianDepthSourceEnabled(true);
    previousDisposer?.();
    this.updateTransformGizmoAttachment();
    this.publishSelectionState({
      phase: 'ready',
      scope: this.selectionScope,
      progress: 1,
      selectedCount: 0,
      hitCount: 0,
    });
    this.importController = null;

    return {
      phase: 'ready',
      renderer: this.rendererLabel,
      splatCount: residentAsset.value.splatCount,
      totalFrames: residentAsset.value.totalFrames,
      fps: 30,
      shBands: residentAsset.value.shBands,
      sourceName: residentAsset.value.sourceName,
      objectName: residentAsset.value.sourceName.replace(/\.[^.]+$/, ''),
      format: 'RAW4D',
      bufferId: loadedAsset.bufferId,
      sourceToResidentRatio: loadedAsset.sourceToResidentRatio,
      memoryTransport: loadedAsset.transport,
      gpuBackend: raw4D.gpuBackend,
      decodeBackend: loadedAsset.decodeBackend,
    };
  }

  private emptyStatus(): ViewportStatus {
    return {
      phase: 'ready',
      renderer: this.rendererLabel,
      splatCount: 0,
      totalFrames: 1,
      fps: 30,
      shBands: 0,
    };
  }

  private ensureRelighting(): GaussianRelightingController {
    if (!this.app || !this.camera || !this.orbit) throw new Error('三维视口尚未初始化完成。');
    if (!this.relighting) {
      this.relighting = new GaussianRelightingController(
        this.app,
        this.camera,
        (enabled) => this.orbit?.setInputEnabled(enabled),
        this.options.onRelightingChange,
      );
      this.relighting.setProxy(this.gs2MeshObject);
    }
    return this.relighting;
  }

  private installEmptyScene(): ViewportStatus {
    if (!this.app) {
      throw new Error('Cannot reset the viewport before initialization.');
    }
    this.cancelGaussianSelectionRun();
    this.history.clear();
    const previousDisposer = this.assetDisposer;
    this.detachTransformGizmos();
    this.assetDisposer = null;
    this.activeRaw4D = null;
    this.activeRaw4DAsset = null;
    this.activeRaw4DSource = null;
    this.activeFormat = null;
    this.clearGS2Mesh();
    this.guides?.setGaussianDepthSourceEnabled(false);
    previousDisposer?.();
    this.publishSelectionState(INITIAL_VIEWPORT_SELECTION_STATE);
    //WDD-gpt 2026-08-15 - 空工作区不再生成演示Gaussian，减少无效显存、对象说明和界面噪声。
    return this.emptyStatus();
  }

  // #WDD-gpt  2026-08-16 - 按 viewer-2 语义统一接管 Brush/Rect/Polygon 左键输入，右键和非选择工具仍留给摄像机。
  private readonly onGaussianSelectionPointerDown = (event: PointerEvent): void => {
    const tool = this.selectionToolForEditor();
    if (!tool || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = this.gaussianSelectionCanvasPoint(event);
    this.selectionPointer = point;
    const modifiers = this.gaussianSelectionModifiers(event);

    if (tool === 'select-poly') {
      if (event.detail > 1) return;
      if (this.selectionPolygonPoints.length === 0) {
        this.cancelGaussianSelectionRun();
        this.selectionPolygonModifiers = modifiers;
      }
      this.selectionPolygonPoints.push(point);
      this.selectionPolygonCursor = point;
      this.orbit?.setInputEnabled(false);
      this.updateGaussianPolygonOverlay();
      return;
    }

    this.cancelGaussianSelectionRun();
    this.selectionPointer = point;
    this.selectionDrag = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      modifiers,
      path: [point],
    };
    this.orbit?.setInputEnabled(false);
    this.canvas.setPointerCapture(event.pointerId);
    this.updateGaussianSelectionOverlay();
    this.updateGaussianBrushOverlay();
    this.updateGaussianBrushTrailOverlay();
  };

  private readonly onGaussianSelectionPointerMove = (event: PointerEvent): void => {
    const tool = this.selectionToolForEditor();
    if (!tool) return;
    const point = this.gaussianSelectionCanvasPoint(event);
    this.selectionPointer = point;
    if (tool === 'select-brush') this.updateGaussianBrushOverlay();
    if (tool === 'select-poly') {
      this.selectionPolygonCursor = point;
      this.updateGaussianPolygonOverlay();
    }

    const drag = this.selectionDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    drag.currentX = point.x;
    drag.currentY = point.y;
    if (tool === 'select-brush') {
      const last = drag.path[drag.path.length - 1];
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 2) drag.path.push(point);
    }
    this.updateGaussianSelectionOverlay();
    this.updateGaussianBrushTrailOverlay();
  };

  private readonly onGaussianSelectionPointerUp = (event: PointerEvent): void => {
    const tool = this.selectionToolForEditor();
    if (tool === 'select-poly') {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const drag = this.selectionDrag;
    if (!tool || !drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const point = this.gaussianSelectionCanvasPoint(event);
    drag.currentX = point.x;
    drag.currentY = point.y;
    if (tool === 'select-brush') drag.path.push(point);
    const region = tool === 'select-brush'
      ? createGaussianBrushSelectionRegion(drag.path, this.selectionBrushRadius)
      : createGaussianRectSelectionRegion(normalizeGaussianSelectionRect(
        drag.startX, drag.startY, drag.currentX, drag.currentY, 6,
      ));
    const modifiers = this.mergeGaussianSelectionModifiers(drag.modifiers, event);
    this.finishGaussianSelectionDrag(event.pointerId);
    this.startGaussianSelectionRun(region, modifiers);
  };

  private readonly onGaussianSelectionPointerCancel = (event: PointerEvent): void => {
    if (this.selectionDrag?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finishGaussianSelectionDrag(event.pointerId);
    this.orbit?.setInputEnabled(true);
  };

  private readonly onGaussianSelectionDoubleClick = (event: MouseEvent): void => {
    if (this.selectionToolForEditor() !== 'select-poly') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.finalizeGaussianPolygonSelection(this.gaussianSelectionModifiers(event));
  };

  private readonly onGaussianSelectionKeyDown = (event: KeyboardEvent): void => {
    if (this.selectionToolForEditor() !== 'select-poly' || this.selectionPolygonPoints.length === 0) return;
    if (event.key === 'Escape') {
      this.cancelGaussianSelectionRun();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.finalizeGaussianPolygonSelection(this.gaussianSelectionModifiers(event));
    }
  };

  private readonly onGaussianSelectionPointerLeave = (): void => {
    if (!this.selectionDrag && this.selectionBrushOverlay) this.selectionBrushOverlay.hidden = true;
  };

  private initializeGaussianSelectionInput(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const rectangle = document.createElement('div');
    rectangle.className = 'gaussian-selection-box';
    rectangle.setAttribute('aria-hidden', 'true');
    rectangle.hidden = true;
    const brush = document.createElement('div');
    brush.className = 'gaussian-selection-brush-cursor';
    brush.setAttribute('aria-hidden', 'true');
    brush.hidden = true;
    const brushTrailOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    brushTrailOverlay.classList.add('gaussian-selection-brush-trail-overlay');
    brushTrailOverlay.setAttribute('aria-hidden', 'true');
    brushTrailOverlay.style.display = 'none';
    const brushTrail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    brushTrail.classList.add('gaussian-selection-brush-trail');
    brushTrailOverlay.append(brushTrail);
    const polygonOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    polygonOverlay.classList.add('gaussian-selection-polygon-overlay');
    polygonOverlay.setAttribute('aria-hidden', 'true');
    polygonOverlay.style.display = 'none';
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.classList.add('gaussian-selection-polygon-shape');
    const cursorLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    cursorLine.classList.add('gaussian-selection-polygon-cursor-line');
    polygonOverlay.append(polygon, cursorLine);
    parent.append(rectangle, brushTrailOverlay, brush, polygonOverlay);
    this.selectionOverlay = rectangle;
    this.selectionBrushOverlay = brush;
    this.selectionBrushTrailOverlay = brushTrailOverlay;
    this.selectionBrushTrailShape = brushTrail;
    this.selectionPolygonOverlay = polygonOverlay;
    this.selectionPolygonShape = polygon;
    this.selectionPolygonCursorLine = cursorLine;
    this.canvas.addEventListener('pointerdown', this.onGaussianSelectionPointerDown, { capture: true });
    this.canvas.addEventListener('pointermove', this.onGaussianSelectionPointerMove, { capture: true });
    this.canvas.addEventListener('pointerup', this.onGaussianSelectionPointerUp, { capture: true });
    this.canvas.addEventListener('pointercancel', this.onGaussianSelectionPointerCancel, { capture: true });
    this.canvas.addEventListener('pointerleave', this.onGaussianSelectionPointerLeave, { capture: true });
    this.canvas.addEventListener('dblclick', this.onGaussianSelectionDoubleClick, { capture: true });
    window.addEventListener('keydown', this.onGaussianSelectionKeyDown);
  }

  private destroyGaussianSelectionInput(): void {
    this.cancelGaussianSelectionRun();
    this.canvas.removeEventListener('pointerdown', this.onGaussianSelectionPointerDown, { capture: true });
    this.canvas.removeEventListener('pointermove', this.onGaussianSelectionPointerMove, { capture: true });
    this.canvas.removeEventListener('pointerup', this.onGaussianSelectionPointerUp, { capture: true });
    this.canvas.removeEventListener('pointercancel', this.onGaussianSelectionPointerCancel, { capture: true });
    this.canvas.removeEventListener('pointerleave', this.onGaussianSelectionPointerLeave, { capture: true });
    this.canvas.removeEventListener('dblclick', this.onGaussianSelectionDoubleClick, { capture: true });
    window.removeEventListener('keydown', this.onGaussianSelectionKeyDown);
    this.selectionOverlay?.remove();
    this.selectionBrushOverlay?.remove();
    this.selectionBrushTrailOverlay?.remove();
    this.selectionPolygonOverlay?.remove();
    this.selectionOverlay = null;
    this.selectionBrushOverlay = null;
    this.selectionBrushTrailOverlay = null;
    this.selectionBrushTrailShape = null;
    this.selectionPolygonOverlay = null;
    this.selectionPolygonShape = null;
    this.selectionPolygonCursorLine = null;
    this.canvas.classList.remove('gaussian-selection-active', 'gaussian-selection-brush', 'gaussian-selection-poly');
  }

  private finishGaussianSelectionDrag(pointerId: number): void {
    this.selectionDrag = null;
    if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
    if (this.selectionOverlay) this.selectionOverlay.hidden = true;
    this.updateGaussianBrushTrailOverlay();
  }

  private cancelGaussianSelectionRun(): void {
    this.selectionRunId += 1;
    const pointerId = this.selectionDrag?.pointerId;
    if (pointerId !== undefined) this.finishGaussianSelectionDrag(pointerId);
    this.selectionPolygonPoints = [];
    this.selectionPolygonCursor = null;
    this.selectionPolygonModifiers = null;
    this.updateGaussianPolygonOverlay();
    this.orbit?.setInputEnabled(true);
  }

  private gaussianSelectionCanvasPoint(event: MouseEvent | PointerEvent): GaussianScreenPoint {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
      y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
    };
  }

  private gaussianSelectionModifiers(event: MouseEvent | PointerEvent | KeyboardEvent): GaussianSelectionModifiers {
    return {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
  }

  private mergeGaussianSelectionModifiers(
    start: GaussianSelectionModifiers,
    end: MouseEvent | PointerEvent | KeyboardEvent,
  ): GaussianSelectionModifiers {
    return {
      altKey: end.altKey || start.altKey,
      ctrlKey: end.ctrlKey || start.ctrlKey,
      metaKey: end.metaKey || start.metaKey,
      shiftKey: end.shiftKey || start.shiftKey,
    };
  }

  private gaussianSelectionParentOffset(): GaussianScreenPoint {
    const parent = this.canvas.parentElement;
    if (!parent) return { x: 0, y: 0 };
    const canvasBounds = this.canvas.getBoundingClientRect();
    const parentBounds = parent.getBoundingClientRect();
    return { x: canvasBounds.left - parentBounds.left, y: canvasBounds.top - parentBounds.top };
  }

  private updateGaussianSelectionOverlay(): void {
    const drag = this.selectionDrag;
    const overlay = this.selectionOverlay;
    if (!drag || !overlay || this.selectionToolForEditor() !== 'select-rect') {
      if (overlay) overlay.hidden = true;
      return;
    }
    const rect = normalizeGaussianSelectionRect(drag.startX, drag.startY, drag.currentX, drag.currentY, 0);
    const offset = this.gaussianSelectionParentOffset();
    overlay.hidden = false;
    overlay.style.left = `${offset.x + rect.left}px`;
    overlay.style.top = `${offset.y + rect.top}px`;
    overlay.style.width = `${rect.right - rect.left}px`;
    overlay.style.height = `${rect.bottom - rect.top}px`;
  }

  private updateGaussianBrushOverlay(): void {
    const overlay = this.selectionBrushOverlay;
    const point = this.selectionPointer;
    if (!overlay || !point || this.selectionToolForEditor() !== 'select-brush') {
      if (overlay) overlay.hidden = true;
      return;
    }
    const offset = this.gaussianSelectionParentOffset();
    const diameter = this.selectionBrushRadius * 2;
    overlay.hidden = false;
    overlay.style.left = `${offset.x + point.x - this.selectionBrushRadius}px`;
    overlay.style.top = `${offset.y + point.y - this.selectionBrushRadius}px`;
    overlay.style.width = `${diameter}px`;
    overlay.style.height = `${diameter}px`;
  }

  private updateGaussianBrushTrailOverlay(): void {
    const overlay = this.selectionBrushTrailOverlay;
    const shape = this.selectionBrushTrailShape;
    const drag = this.selectionDrag;
    const active = this.selectionToolForEditor() === 'select-brush' && drag !== null && drag.path.length > 0;
    if (!overlay || !shape || !active) {
      if (overlay) overlay.style.display = 'none';
      if (shape) shape.removeAttribute('d');
      return;
    }
    const offset = this.gaussianSelectionParentOffset();
    const points = drag.path.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y }));
    const first = points[0];
    // #WDD-gpt  2026-08-16 - 宽圆角 SVG 笔迹持续显示本次刷选覆盖区，松开后立即清除且不截获视口输入。
    const path = points.length === 1
      ? `M ${first.x} ${first.y} l 0.01 0`
      : points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    overlay.style.display = 'block';
    shape.setAttribute('d', path);
    shape.setAttribute('stroke-width', String(this.selectionBrushRadius * 2));
  }

  private updateGaussianPolygonOverlay(): void {
    const overlay = this.selectionPolygonOverlay;
    const polygon = this.selectionPolygonShape;
    const cursorLine = this.selectionPolygonCursorLine;
    if (!overlay || !polygon || !cursorLine) return;
    const active = this.selectionToolForEditor() === 'select-poly' && this.selectionPolygonPoints.length > 0;
    overlay.style.display = active ? 'block' : 'none';
    if (!active) return;
    const offset = this.gaussianSelectionParentOffset();
    polygon.setAttribute('points', this.selectionPolygonPoints
      .map((point) => `${point.x + offset.x},${point.y + offset.y}`)
      .join(' '));
    const last = this.selectionPolygonPoints[this.selectionPolygonPoints.length - 1];
    const cursor = this.selectionPolygonCursor ?? last;
    cursorLine.setAttribute('x1', String(last.x + offset.x));
    cursorLine.setAttribute('y1', String(last.y + offset.y));
    cursorLine.setAttribute('x2', String(cursor.x + offset.x));
    cursorLine.setAttribute('y2', String(cursor.y + offset.y));
  }

  private updateGaussianSelectionOverlayVisibility(): void {
    this.updateGaussianSelectionOverlay();
    this.updateGaussianBrushOverlay();
    this.updateGaussianBrushTrailOverlay();
    this.updateGaussianPolygonOverlay();
  }

  private selectionToolForEditor(tool = this.editorTool): ViewportSelectionTool | null {
    if (tool === 'select-brush' || tool === 'select-rect' || tool === 'select-poly') return tool;
    return null;
  }

  private finalizeGaussianPolygonSelection(endModifiers: GaussianSelectionModifiers): void {
    if (this.selectionPolygonPoints.length < 3) return;
    const region = createGaussianPolygonSelectionRegion(this.selectionPolygonPoints);
    const modifiers = this.selectionPolygonModifiers
      ? {
        altKey: endModifiers.altKey || this.selectionPolygonModifiers.altKey,
        ctrlKey: endModifiers.ctrlKey || this.selectionPolygonModifiers.ctrlKey,
        metaKey: endModifiers.metaKey || this.selectionPolygonModifiers.metaKey,
        shiftKey: endModifiers.shiftKey || this.selectionPolygonModifiers.shiftKey,
      }
      : endModifiers;
    this.selectionPolygonPoints = [];
    this.selectionPolygonCursor = null;
    this.selectionPolygonModifiers = null;
    this.updateGaussianPolygonOverlay();
    this.startGaussianSelectionRun(region, modifiers);
  }

  private startGaussianSelectionRun(
    region: GaussianScreenSelectionRegion,
    modifiers: GaussianSelectionModifiers,
  ): void {
    const runId = ++this.selectionRunId;
    const scope = this.selectionScope;
    this.orbit?.setInputEnabled(false);
    void this.selectGaussiansInScreenRegion(scope, region, modifiers, runId).finally(() => {
      if (runId === this.selectionRunId && this.selectionPolygonPoints.length === 0) {
        this.orbit?.setInputEnabled(true);
      }
    });
  }

  private publishSelectionState(state: ViewportSelectionState): void {
    this.options.onSelectionChange?.({
      ...state,
      deletedCount: this.activeRaw4D?.edits.deletionCount ?? 0,
    });
  }

  // #WDD-gpt  2026-08-16 - 三种屏幕区域共享同一跨帧投影扫描，并分批让出主线程避免大规模 4DGS 冻结页面。
  private async selectGaussiansInScreenRegion(
    scope: GaussianScreenSelectionScope,
    region: GaussianScreenSelectionRegion,
    modifiers: GaussianSelectionModifiers,
    runId: number,
  ): Promise<void> {
    const raw4D = this.activeRaw4D;
    const asset = this.activeRaw4DAsset;
    const camera = this.camera;
    if (!raw4D || !asset || !camera?.camera) {
      this.publishSelectionState({
        phase: 'error',
        scope,
        progress: 0,
        selectedCount: raw4D?.edits.selectionCount ?? 0,
        message: '请先导入 RAW4D 文件。',
      });
      return;
    }

    this.publishSelectionState({
      phase: 'selecting',
      scope,
      progress: 0,
      selectedCount: raw4D.edits.selectionCount,
    });

    try {
      const sampler = new Raw4DSelectionFrameSampler(asset);
      const frameCount = scope === 'visible' ? 1 : asset.totalFrames;
      const firstFrame = scope === 'visible' ? this.pendingFrame : 0;
      const hits = new Uint8Array(asset.splatCount);
      const deletionWords = raw4D.edits.deletionWords;
      const entityTransform = raw4D.entity.getWorldTransform().clone();
      const cameraPosition = camera.getPosition().clone();
      const cameraForward = camera.forward.clone();
      const localPoint = new Vec3();
      const worldPoint = new Vec3();
      const cameraOffset = new Vec3();
      const screenPoint = new Vec3();
      const nearClip = camera.camera.nearClip;
      const farClip = camera.camera.farClip;
      const batchSize = 32_768;

      for (let frameOffset = 0; frameOffset < frameCount; frameOffset += 1) {
        if (runId !== this.selectionRunId || raw4D !== this.activeRaw4D) return;
        const frame = scope === 'visible' ? firstFrame : frameOffset;
        sampler.sample(frame);
        const { x, y, z, opacity } = sampler.properties;
        for (let start = 0; start < asset.splatCount; start += batchSize) {
          const end = Math.min(asset.splatCount, start + batchSize);
          for (let stableId = start; stableId < end; stableId += 1) {
            if (hits[stableId] || opacity[stableId] < 0.01) continue;
            if ((deletionWords[stableId >>> 5] & (1 << (stableId & 31))) !== 0) continue;
            localPoint.set(x[stableId], y[stableId], z[stableId]);
            entityTransform.transformPoint(localPoint, worldPoint);
            cameraOffset.sub2(worldPoint, cameraPosition);
            const depth = cameraOffset.dot(cameraForward);
            if (depth < nearClip || depth > farClip) continue;
            camera.camera.worldToScreen(worldPoint, screenPoint);
            if (Number.isFinite(screenPoint.x)
              && Number.isFinite(screenPoint.y)
              && region.contains(screenPoint.x, screenPoint.y)) {
              hits[stableId] = 1;
            }
          }
          if (end < asset.splatCount || frameOffset + 1 < frameCount) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
            if (runId !== this.selectionRunId || raw4D !== this.activeRaw4D) return;
          }
        }
        this.publishSelectionState({
          phase: 'selecting',
          scope,
          progress: (frameOffset + 1) / frameCount,
          selectedCount: raw4D.edits.selectionCount,
        });
      }

      const stableIds = gaussianSelectionIdsFromMask(hits);
      raw4D.selectStableIds(stableIds, gaussianSelectionModeFromModifiers(modifiers));
      this.publishSelectionState({
        phase: 'ready',
        scope,
        progress: 1,
        selectedCount: raw4D.edits.selectionCount,
        hitCount: stableIds.length,
      });
    } catch (error) {
      if (runId !== this.selectionRunId) return;
      this.publishSelectionState({
        phase: 'error',
        scope,
        progress: 0,
        selectedCount: raw4D.edits.selectionCount,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private initializeTransformGizmos(): void {
    if (!this.app || !this.camera?.camera) return;
    const layer = Gizmo.createLayer(this.app, 'Editor Transform Gizmo');
    this.transformLayer = layer;
    const gizmos: Array<[ViewportTransformTool, TransformGizmo]> = [
      ['move', new TranslateGizmo(this.camera.camera, layer)],
      ['rotate', new RotateGizmo(this.camera.camera, layer)],
      ['scale', new ScaleGizmo(this.camera.camera, layer)],
    ];
    gizmos.forEach(([tool, gizmo]) => {
      gizmo.size = 0.78;
      gizmo.coordSpace = this.transformSpace;
      gizmo.on(TransformGizmo.EVENT_TRANSFORMSTART, () => {
        this.gizmoTransformStart = this.getSceneTransform();
        this.orbit?.setInputEnabled(false);
      });
      gizmo.on(TransformGizmo.EVENT_TRANSFORMMOVE, () => this.publishActiveTransform());
      gizmo.on(TransformGizmo.EVENT_TRANSFORMEND, () => {
        this.publishActiveTransform();
        if (this.gizmoTransformStart) {
          this.pushTransformHistory(this.gizmoTransformStart, this.getSceneTransform());
          this.gizmoTransformStart = null;
        }
        this.orbit?.setInputEnabled(true);
      });
      this.transformGizmos.set(tool, gizmo);
    });
    const scaleGizmo = this.transformGizmos.get('scale');
    if (scaleGizmo instanceof ScaleGizmo) {
      scaleGizmo.uniform = this.uniformScale;
      scaleGizmo.lowerBoundScale.set(0.001, 0.001, 0.001);
    }
    // #WDD-gpt 2026-08-15 - 三个 Gizmo 共享同一渲染层，去重相机 layer ID 避免重复绘制操作轴。
    this.camera.camera.layers = [...new Set(this.camera.camera.layers)];
    this.updateTransformGizmoAttachment();
  }

  private destroyTransformGizmos(): void {
    this.detachTransformGizmos();
    this.transformGizmos.forEach((gizmo) => gizmo.destroy());
    this.transformGizmos.clear();
    if (this.transformLayer && this.app) {
      if (this.camera?.camera) {
        this.camera.camera.layers = this.camera.camera.layers.filter((id) => id !== this.transformLayer!.id);
      }
      this.app.scene.layers.remove(this.transformLayer);
    }
    this.transformLayer = null;
  }

  private detachTransformGizmos(): void {
    this.transformGizmos.forEach((gizmo) => gizmo.detach());
    this.gizmoTransformStart = null;
    this.orbit?.setInputEnabled(true);
  }

  private updateTransformGizmoAttachment(): void {
    this.detachTransformGizmos();
    const entity = this.activeRaw4D?.entity;
    const gizmo = this.activeGizmo();
    if (entity && gizmo) gizmo.attach(entity);
  }

  private activeGizmo(): TransformGizmo | null {
    if (this.editorTool !== 'move' && this.editorTool !== 'rotate' && this.editorTool !== 'scale') return null;
    return this.transformGizmos.get(this.editorTool) ?? null;
  }

  private applyTransform(entity: Entity, transform: ViewportTransform): void {
    entity.setLocalPosition(...transform.position);
    entity.setLocalEulerAngles(...transform.rotation);
    entity.setLocalScale(...transform.scale);
  }

  private transformsEqual(first: ViewportTransform, second: ViewportTransform): boolean {
    return (['position', 'rotation', 'scale'] as const).every((key) => first[key].every(
      (value, index) => Math.abs(value - second[key][index]) < 1e-6,
    ));
  }

  private pushTransformHistory(previous: ViewportTransform, next: ViewportTransform): void {
    if (this.transformsEqual(previous, next)) return;
    const before = this.cloneTransform(previous);
    const after = this.cloneTransform(next);
    this.history.pushApplied({
      label: 'transform',
      undo: () => this.applyHistoricalTransform(before),
      redo: () => this.applyHistoricalTransform(after),
    });
  }

  private applyHistoricalTransform(transform: ViewportTransform): void {
    this.pendingTransform = this.cloneTransform(transform);
    const entity = this.activeRaw4D?.entity;
    if (entity) this.applyTransform(entity, this.pendingTransform);
    this.activeGizmo()?.update();
    this.options.onTransformChange?.(this.getSceneTransform());
  }

  private cloneTransform(transform: ViewportTransform): ViewportTransform {
    return {
      position: [...transform.position],
      rotation: [...transform.rotation],
      scale: [...transform.scale],
    };
  }

  private publishGaussianEditHistoryState(raw4D: Raw4DGaussian, hitCount: number): void {
    if (this.activeRaw4D !== raw4D) return;
    this.publishSelectionState({
      phase: 'ready',
      scope: this.selectionScope,
      progress: 1,
      selectedCount: raw4D.edits.selectionCount,
      hitCount,
    });
  }

  private getSmartAlignmentCameraStart(): SmartAlignmentCameraStart {
    const camera = this.camera;
    if (!camera?.camera) throw new Error('智能对齐相机不可用。');
    const orbitState = this.orbit?.getState();
    let target: Vec3;
    if (orbitState) {
      target = new Vec3(...orbitState.target);
    } else {
      const { min, max } = this.getSmartAlignmentWorldBounds();
      target = min.clone().add(max).mulScalar(0.5);
    }
    const offset = camera.getPosition().clone().sub(target);
    const distance = Math.max(0.01, offset.length());
    return {
      azimuthRadians: Math.atan2(offset.z, offset.x),
      distance,
      target,
    };
  }

  private describeCurrentSmartAlignmentCamera(
    id: SmartAlignmentViewId,
    start: SmartAlignmentCameraStart,
  ): Omit<SmartAlignmentCapture, 'bitmap'> {
    const camera = this.camera;
    if (!camera?.camera) throw new Error('智能对齐相机不可用。');
    const aspect = Math.max(0.01, this.canvas.width / Math.max(1, this.canvas.height));
    let horizontalSpan: number;
    let verticalSpan: number;
    if (camera.camera.projection === PROJECTION_ORTHOGRAPHIC) {
      verticalSpan = camera.camera.orthoHeight * 2;
      horizontalSpan = verticalSpan * aspect;
    } else {
      const fieldOfView = camera.camera.fov * (Math.PI / 180);
      if (camera.camera.horizontalFov) {
        horizontalSpan = 2 * start.distance * Math.tan(fieldOfView * 0.5);
        verticalSpan = horizontalSpan / aspect;
      } else {
        verticalSpan = 2 * start.distance * Math.tan(fieldOfView * 0.5);
        horizontalSpan = verticalSpan * aspect;
      }
    }
    const forward = camera.forward.clone().normalize();
    const right = camera.right.clone().normalize();
    const up = camera.up.clone().normalize();
    // #WDD-gpt 2026-08-15 - 第一个抓帧不改投影、位置或观察中心，完整保留用户点击按钮时看到的构图。
    return {
      id,
      center: [start.target.x, start.target.y, start.target.z],
      right: [right.x, right.y, right.z],
      up: [up.x, up.y, up.z],
      forward: [forward.x, forward.y, forward.z],
      horizontalSpan,
      verticalSpan,
    };
  }

  private configureSmartAlignmentCamera(
    id: SmartAlignmentViewId,
    start: SmartAlignmentCameraStart,
  ): Omit<SmartAlignmentCapture, 'bitmap'> {
    const camera = this.camera;
    const raw4D = this.activeRaw4D;
    if (!camera?.camera || !raw4D) throw new Error('智能对齐相机不可用。');
    const legacyCameraDirectionById: Partial<Record<SmartAlignmentViewId, Vec3>> = {
      'positive-x': new Vec3(1, 0, 0),
      'negative-x': new Vec3(-1, 0, 0),
      'positive-z': new Vec3(0, 0, 1),
      'negative-z': new Vec3(0, 0, -1),
      // #WDD-gpt 2026-08-15 - 增加四个 45 度水平环绕视角，同时避开容易造成肢体重叠误检的纯俯视和仰视。
      'positive-x-positive-z': new Vec3(1, 0, 1).normalize(),
      'positive-x-negative-z': new Vec3(1, 0, -1).normalize(),
      'negative-x-positive-z': new Vec3(-1, 0, 1).normalize(),
      'negative-x-negative-z': new Vec3(-1, 0, -1).normalize(),
    };
    // #WDD-gpt 2026-08-15 - azimuth ID 使用十分之一度编码，允许智能对齐以 22.5 度间隔稳定扩展到十六个环绕视角。
    const azimuthTenths = id.startsWith('azimuth-') ? Number(id.slice('azimuth-'.length)) : Number.NaN;
    const azimuthRadians = start.azimuthRadians + (azimuthTenths / 10) * (Math.PI / 180);
    // #WDD-gpt 2026-08-15 - 仅第一张保留用户俯仰；其余环绕视图保持水平，避免把单个透视俯仰误差复制到全部身体轴观测。
    const pitchRadians = 0;
    const cameraDirection = Number.isFinite(azimuthRadians)
      ? new Vec3(
        Math.cos(azimuthRadians) * Math.cos(pitchRadians),
        Math.sin(pitchRadians),
        Math.sin(azimuthRadians) * Math.cos(pitchRadians),
      )
      : legacyCameraDirectionById[id]?.clone();
    if (!cameraDirection) throw new Error(`未知的智能对齐视角：${id}`);
    const forward = cameraDirection.clone().mulScalar(-1);
    const upHint = Math.abs(forward.dot(Vec3.UP)) > 0.92 ? Vec3.FORWARD : Vec3.UP;
    const right = new Vec3().cross(forward, upHint).normalize();
    const up = new Vec3().cross(right, forward).normalize();

    const { min, max, corners } = this.getSmartAlignmentWorldBounds();
    const boundsCenter = min.clone().add(max).mulScalar(0.5);
    let minRight = Number.POSITIVE_INFINITY;
    let maxRight = Number.NEGATIVE_INFINITY;
    let minUp = Number.POSITIVE_INFINITY;
    let maxUp = Number.NEGATIVE_INFINITY;
    for (const corner of corners) {
      const offset = corner.clone().sub(boundsCenter);
      const rightDistance = offset.dot(right);
      const upDistance = offset.dot(up);
      minRight = Math.min(minRight, rightDistance);
      maxRight = Math.max(maxRight, rightDistance);
      minUp = Math.min(minUp, upDistance);
      maxUp = Math.max(maxUp, upDistance);
    }
    const frameCenter = boundsCenter
      .clone()
      .add(right.clone().mulScalar((minRight + maxRight) * 0.5))
      .add(up.clone().mulScalar((minUp + maxUp) * 0.5));
    const halfWidth = Math.max(0.05, (maxRight - minRight) * 0.5);
    const halfHeight = Math.max(0.05, (maxUp - minUp) * 0.5);
    const aspect = Math.max(0.01, this.canvas.width / Math.max(1, this.canvas.height));
    const orthoHeight = Math.max(halfHeight, halfWidth / aspect) * 1.16;
    const diagonal = max.clone().sub(min).length();
    const distance = Math.max(2, diagonal * 1.4);

    camera.camera.projection = PROJECTION_ORTHOGRAPHIC;
    camera.camera.orthoHeight = orthoHeight;
    camera.camera.nearClip = 0.01;
    camera.camera.farClip = Math.max(200, distance * 4);
    camera.setPosition(frameCenter.clone().add(cameraDirection.clone().mulScalar(distance)));
    camera.lookAt(frameCenter, up);

    return {
      id,
      center: [frameCenter.x, frameCenter.y, frameCenter.z],
      right: [right.x, right.y, right.z],
      up: [up.x, up.y, up.z],
      forward: [forward.x, forward.y, forward.z],
      horizontalSpan: orthoHeight * 2 * aspect,
      verticalSpan: orthoHeight * 2,
    };
  }

  private getSmartAlignmentWorldBounds(): { min: Vec3; max: Vec3; corners: Vec3[] } {
    const raw4D = this.activeRaw4D;
    if (!raw4D) throw new Error('智能对齐对象不可用。');
    const matrix = raw4D.entity.getWorldTransform();
    const corners: Vec3[] = [];
    for (const x of [raw4D.bounds.min[0], raw4D.bounds.max[0]]) {
      for (const y of [raw4D.bounds.min[1], raw4D.bounds.max[1]]) {
        for (const z of [raw4D.bounds.min[2], raw4D.bounds.max[2]]) {
          corners.push(matrix.transformPoint(new Vec3(x, y, z), new Vec3()));
        }
      }
    }
    const min = new Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const max = new Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (const corner of corners) {
      min.x = Math.min(min.x, corner.x);
      min.y = Math.min(min.y, corner.y);
      min.z = Math.min(min.z, corner.z);
      max.x = Math.max(max.x, corner.x);
      max.y = Math.max(max.y, corner.y);
      max.z = Math.max(max.z, corner.z);
    }
    return { min, max, corners };
  }

  private sampleGS2MeshWorldPoints(
    asset: Raw4DAsset,
    raw4D: Raw4DGaussian,
    requestedFrame: number,
  ): GS2MeshVector3[] {
    const track = asset.position;
    const frame = Math.max(0, Math.min(asset.totalFrames - 1, requestedFrame));
    let rightKey = track.keyframes.findIndex((keyframe) => keyframe >= frame);
    if (rightKey < 0) rightKey = track.keyframes.length - 1;
    const leftKey = Math.max(0, rightKey - (track.keyframes[rightKey] > frame ? 1 : 0));
    const leftFrame = track.keyframes[leftKey];
    const rightFrame = track.keyframes[rightKey];
    const alpha = rightFrame > leftFrame ? (frame - leftFrame) / (rightFrame - leftFrame) : 0;
    const opacityTrack = asset.opacity;
    let opacityRightKey = opacityTrack.keyframes.findIndex((keyframe) => keyframe >= frame);
    if (opacityRightKey < 0) opacityRightKey = opacityTrack.keyframes.length - 1;
    const opacityLeftKey = Math.max(
      0,
      opacityRightKey - (opacityTrack.keyframes[opacityRightKey] > frame ? 1 : 0),
    );
    const opacityLeftFrame = opacityTrack.keyframes[opacityLeftKey];
    const opacityRightFrame = opacityTrack.keyframes[opacityRightKey];
    const opacityAlpha = opacityRightFrame > opacityLeftFrame
      ? (frame - opacityLeftFrame) / (opacityRightFrame - opacityLeftFrame)
      : 0;
    const stride = Math.max(1, Math.ceil(asset.splatCount / 100_000));
    const matrix = raw4D.entity.getWorldTransform();
    const local = new Vec3();
    const world = new Vec3();
    const points: GS2MeshVector3[] = [];
    for (let index = 0; index < asset.splatCount; index += stride) {
      if (raw4D.edits.isDeleted(index)) continue;
      const opacityLeft = readRaw4DTrack(opacityTrack, opacityLeftKey, index);
      const opacityRight = readRaw4DTrack(opacityTrack, opacityRightKey, index);
      const opacityLogit = opacityAlpha <= 0
        ? opacityLeft
        : opacityLeft * (1 - opacityAlpha) + opacityRight * opacityAlpha;
      const opacity = 1 / (1 + Math.exp(-opacityLogit));
      const lifetimeMu = readRaw4DScalar(asset.lifetimeMu, index, asset.sourceEncoding);
      const lifetimeW = readRaw4DScalar(asset.lifetimeW, index, asset.sourceEncoding);
      const alive = frame >= lifetimeMu - lifetimeW && frame <= lifetimeMu + lifetimeW;
      // #WDD-gpt 2026-08-15 - 焦点只统计当前帧仍存活且可见的高斯，避免轨迹包围盒中的历史点拉偏环绕圆心。
      if (!alive || opacity < 0.04) continue;
      const x = readRaw4DTrack(track, leftKey * 3, index) * (1 - alpha)
        + readRaw4DTrack(track, rightKey * 3, index) * alpha;
      const y = readRaw4DTrack(track, leftKey * 3 + 1, index) * (1 - alpha)
        + readRaw4DTrack(track, rightKey * 3 + 1, index) * alpha;
      const z = readRaw4DTrack(track, leftKey * 3 + 2, index) * (1 - alpha)
        + readRaw4DTrack(track, rightKey * 3 + 2, index) * alpha;
      matrix.transformPoint(local.set(x, y, z), world);
      points.push([world.x, world.y, world.z]);
    }
    return points;
  }

  private describeGS2MeshCamera(
    width: number,
    height: number,
    intrinsics: { fx: number; fy: number; cx: number; cy: number },
  ): GS2MeshCamera {
    const camera = this.camera;
    if (!camera) throw new Error('GS2Mesh 摄像机不可用。');
    const position = camera.getPosition();
    const right = camera.right;
    const up = camera.up;
    const forward = camera.forward;
    return {
      position: [position.x, position.y, position.z],
      right: [right.x, right.y, right.z],
      up: [up.x, up.y, up.z],
      forward: [forward.x, forward.y, forward.z],
      width,
      height,
      ...intrinsics,
    };
  }

  private async waitForStableCapture(): Promise<void> {
    await this.waitForPostRender();
    await this.waitForPostRender();
  }

  private async captureGS2MeshImage(width: number, height: number): Promise<Blob> {
    const bitmap = await createImageBitmap(this.canvas, 0, 0, this.canvas.width, this.canvas.height, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });
    try {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器无法创建 GS2Mesh 图像编码画布。');
      context.drawImage(bitmap, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    } finally {
      bitmap.close();
    }
  }

  private waitForPostRender(): Promise<void> {
    const app = this.app;
    if (!app) return Promise.reject(new Error('视口渲染器不可用。'));
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        app.off('postrender', onPostRender);
        reject(new Error('等待智能对齐渲染帧超时。'));
      }, 5000);
      const onPostRender = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      app.once('postrender', onPostRender);
      app.renderNextFrame = true;
    });
  }

  private async captureViewportBitmap(): Promise<ImageBitmap> {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const cropSize = Math.min(width, height);
    const cropX = Math.floor((width - cropSize) * 0.5);
    const cropY = Math.floor((height - cropSize) * 0.5);
    await this.waitForPostRender();
    // #WDD-gpt 2026-08-15 - 中心正方形抓帧避免姿态模型的非方形 ROI 投影误差，世界跨度与相机正交高度保持一致。
    return createImageBitmap(this.canvas, cropX, cropY, cropSize, cropSize, {
      resizeWidth: 640,
      resizeHeight: 640,
      resizeQuality: 'high',
    });
  }

  private publishActiveTransform(): void {
    const entity = this.activeRaw4D?.entity;
    if (!entity) return;
    const position = entity.getLocalPosition();
    const rotation = entity.getLocalEulerAngles();
    const scale = entity.getLocalScale();
    this.pendingTransform = {
      position: [position.x, position.y, position.z],
      rotation: [rotation.x, rotation.y, rotation.z],
      scale: [scale.x, scale.y, scale.z],
    };
    this.options.onTransformChange?.(this.pendingTransform);
  }

  private resize(): void {
    const container = this.canvas.parentElement ?? this.canvas;
    if (!this.app || container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }
    //WDD-gpt 2026-08-14 - 仅调整 GPU backbuffer，避免 PlayCanvas 内联样式覆盖 React 响应式布局。
    this.app.graphicsDevice.resizeCanvas(container.clientWidth, container.clientHeight);
  }
}
