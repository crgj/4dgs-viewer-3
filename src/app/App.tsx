import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import changeLogMarkdown from '../../CHANGELOG.md?raw';
import { formatBytes } from '../core/format/formatBytes';
import {
  isEditorRedoShortcut,
  isEditorUndoShortcut,
  isGaussianDeleteShortcut,
  isViewportBrowseShortcut,
} from '../features/editor/tools/EditorKeyboardShortcuts';
import {
  createGaussian4DMemoryPolicy,
  type Gaussian4DMemoryMode,
} from '../features/gaussian/memory/Gaussian4DMemoryPolicy';
import {
  detectGaussianRuntimeProfile,
  resolveForceSortSync,
} from '../features/gaussian/memory/GaussianRuntimeProfile';
import type { GaussianRenderMode } from '../features/gaussian/runtime/GaussianRenderMode';
import { writeFourCgsFile } from '../features/gaussian/formats/fourcgs/FourCgsContainer';
import {
  encodeRaw4DMemoryAsFourCgs,
  type FourCgsEncodeResult,
} from '../features/gaussian/formats/fourcgs/FourCgsEncoderClient';
import type { FourCgsProgress } from '../features/gaussian/formats/fourcgs/FourCgsTypes';
import { FourCgsRaw4DZipWriter } from '../features/gaussian/formats/fourcgs/FourCgsRaw4DZip';
import { exportRaw4DSequenceAsPlyDirectory } from '../features/gaussian/formats/raw4d/Raw4DPlySequenceExportClient';
import { GaussianViewport } from '../features/viewport/components/GaussianViewport';
import { MemoryTelemetryPanel } from '../features/viewport/components/MemoryTelemetryPanel';
import { PerformanceDiagnosticsPanel } from '../features/viewport/components/PerformanceDiagnosticsPanel';
import type { ViewportPerformanceSnapshot } from '../features/viewport/runtime/ViewportPerformanceMonitor';
import type { GaussianCylinderSelectionRegion } from '../features/viewport/runtime/selection/GaussianCylinderSelection';
import { gaussianSelectionModeFromModifiers } from '../features/viewport/runtime/selection/GaussianScreenSelection';
import {
  DEFAULT_VIEWPORT_BACKGROUND_COLOR,
  isViewportBackgroundColor,
  normalizeViewportBackgroundColor,
  VIEWPORT_BACKGROUND_COLOR_STORAGE_KEY,
} from '../features/viewport/runtime/ViewportBackgroundColor';
import {
  INITIAL_EDITOR_HISTORY_STATE,
  INITIAL_VIEWPORT_SELECTION_STATE,
  ViewportRuntime,
  type ViewportCameraView,
  type ViewportEditorTool,
  type ViewportHistoryState,
  type ViewportMemoryUsage,
  type ViewportSelectionState,
  type ViewportSelectionScope,
  type ViewportSelectionTool,
  type ViewportStatus,
  type ViewportTransform,
  type ViewportTransformBakeProgress,
  type ViewportTransformBakeResult,
  type ViewportTransformTool,
} from '../features/viewport/runtime/ViewportRuntime';
import { SmartAlignmentPanel } from '../plugins/smart-alignment/SmartAlignmentPanel';
import { SmartAlignmentPlugin } from '../plugins/smart-alignment/SmartAlignmentPlugin';
import {
  INITIAL_SMART_ALIGNMENT_STATE,
  type SmartAlignmentState,
} from '../plugins/smart-alignment/SmartAlignmentTypes';
import { GS2MeshPlugin } from '../plugins/gs2mesh/GS2MeshPlugin';
import {
  INITIAL_RELIGHTING_MESH_STATE,
  RelightingMeshSequence,
  type RelightingMeshState,
} from '../plugins/relighting/RelightingMeshSequence';
import {
  INITIAL_GS2MESH_STATE,
  type GS2MeshOptions,
  type GS2MeshState,
} from '../plugins/gs2mesh/GS2MeshTypes';
import {
  reconcileRelightingWorkflowStep,
  RelightingWorkflowPanel,
  type RelightingMeshStatus,
  type RelightingWorkflowStep,
} from '../plugins/relighting/RelightingWorkflowPanel';
import {
  INITIAL_RELIGHTING_STATE,
  type RelightingLightPatch,
  type RelightingSettings,
  type RelightingState,
} from '../plugins/relighting/RelightingTypes';
import { ModelHealthPanel } from '../plugins/model-health/ModelHealthPanel';
import type { ModelHealthReport } from '../plugins/model-health/ModelHealth';
import { SemanticClassificationPanel } from '../plugins/semantic-classification/SemanticClassificationPanel';
import { SemanticClassificationResultsPanel } from '../plugins/semantic-classification/SemanticClassificationResultsPanel';
import {
  clampPluginWindowPosition,
  type PluginWindowPosition,
} from './components/PluginWindowBounds';
import {
  SemanticClassificationPlugin,
  type SemanticClassificationOptions,
} from '../plugins/semantic-classification/SemanticClassificationPlugin';
import {
  INITIAL_SEMANTIC_CLASSIFICATION_STATE,
  type SemanticClassificationState,
} from '../plugins/semantic-classification/SemanticClassificationTypes';
import {
  UI_COPY,
  localizeRuntimeMessage,
  type UiCopy,
  type UiLanguage,
} from './i18n';
import { ValidatedNumberInput } from './components/ValidatedNumberInput';
import { UiSelect } from './components/UiSelect';
import { GlobalTooltipLayer } from './components/GlobalTooltipLayer';
import { ViewCube3D } from './components/ViewCube3D';
import { ReleaseNotesDialog } from './components/ReleaseNotesDialog';
import { MemoryPressureTestDialog } from './components/MemoryPressureTestDialog';
import { AppNoticeDialog, type AppNoticeTone } from './components/AppNoticeDialog';
import { FourCgsGalleryDialog } from './components/FourCgsGalleryDialog';
import { SceneOutliner } from './components/SceneOutliner';
import { GaussianHistogramPanel } from './components/GaussianHistogramPanel';
import { WelcomePage } from './components/WelcomePage';
import { ExportCenterDialog } from './components/ExportCenterDialog';
import {
  supportsFourCgsSceneExport,
  supportsRaw4DSceneExport,
  type ExportTarget,
} from './components/ExportCenterModel';
import { describeAppError } from './errors/AppError';
import {
  clearWorkspaceDraft,
  FORCE_SORT_SYNC_REVISION,
  loadWorkspaceDraft,
  restoreWorkspaceForceSortSync,
  saveWorkspaceDraft,
  workspaceSourceIdentities,
  workspaceSourcesMatch,
  type WorkspaceDraft,
} from './workspace/WorkspaceState';
import { parseReleaseNotes } from './releaseNotes';
import type { BrowserMemoryPressureResult } from '../features/gaussian/memory/BrowserMemoryPressureTest';
import {
  PLY_SEQUENCE_DIRECTORY_PICKER_OPTIONS,
  isDirectoryPickerAbort,
} from './plySequenceDirectory';
import {
  createFourCgsSavePickerOptions,
  isFilePickerAbort,
  writeBlobToFileHandle,
} from './fourCgsFileSave';
import {
  createRaw4DSavePickerOptions,
  RAW4D_SEGMENTS_DIRECTORY_PICKER_OPTIONS,
  uniqueRaw4DExportFilenames,
  writeRaw4DBlobToDirectory,
} from './raw4dFileSave';
import {
  fetchFourCgsGalleryFile,
  type FourCgsGalleryItem,
} from './fourCgsGallery';

type IconName =
  | 'cursor'
  | 'selectVisible'
  | 'selectGlobal'
  | 'brush'
  | 'rect'
  | 'poly'
  | 'cylinder'
  | 'move'
  | 'rotate'
  | 'scale'
  | 'folder'
  | 'export'
  | 'undo'
  | 'redo'
  | 'chevron'
  | 'play'
  | 'pause'
  | 'stepBack'
  | 'stepForward'
  | 'loop';

const iconPaths: Record<IconName, string> = {
  cursor: 'M6 3l11 8-5 1.5L9 17z',
  selectVisible: 'M4 5h16v14H4zM8 9h3v3H8zM14 9h2M14 12h2M8 15h8',
  selectGlobal: 'M5 4h14v14H5zM8 7h14v14H8zM11 11h3v3h-3zM17 11h2M17 14h2M11 17h8',
  brush: 'M20.7 5.6l-2.3-2.3a1 1 0 0 0-1.4 0l-6.5 6.5 3.7 3.7 6.5-6.5a1 1 0 0 0 0-1.4zM12.8 14.9L9.1 11.2 3 18.8V21h2.2zM3 21c1.8 0 3-1 3-2.6',
  rect: 'M4 6h16v12H4z',
  poly: 'M12 3l8 6-3 11H7L4 9zM12 3v0M20 9v0M17 20v0M7 20v0M4 9v0',
  cylinder: 'M5 6c0-2 3.1-3.5 7-3.5S19 4 19 6v12c0 2-3.1 3.5-7 3.5S5 20 5 18V6zm0 0c0 2 3.1 3.5 7 3.5S19 8 19 6M5 18c0 2 3.1 3.5 7 3.5S19 20 19 18',
  move: 'M12 2l3 3h-2v5h5V8l3 3-3 3v-2h-5v5h2l-3 3-3-3h2v-5H6v2l-3-3 3-3v2h5V5H9z',
  rotate: 'M5 7a8 8 0 0 1 13.5 1M19 3v5h-5M19 17a8 8 0 0 1-13.5-1M5 21v-5h5',
  scale: 'M5 19l5-5m-5 5v-4m0 4h4M19 5l-5 5m5-5v4m0-4h-4',
  folder: 'M3 6.5h7l2 2h9v10H3z',
  export: 'M12 15V3m0 0L8 7m4-4 4 4M5 13v7h14v-7',
  undo: 'M9 7H4v-5M4 7l4-4M4.5 7.5A8 8 0 1 1 6 17',
  redo: 'M15 7h5v-5M20 7l-4-4M19.5 7.5A8 8 0 1 0 18 17',
  chevron: 'm9 18 6-6-6-6',
  play: 'M8 5v14l11-7z',
  pause: 'M8 5v14M16 5v14',
  stepBack: 'M6 5v14M18 6l-8 6 8 6z',
  stepForward: 'M18 5v14M6 6l8 6-8 6z',
  loop: 'M4 8h12l-2.5-2.5M16 8l-2.5 2.5M20 16H8l2.5 2.5M8 16l2.5-2.5',
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={iconPaths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

interface EditorToolDescriptor {
  readonly id: ViewportEditorTool;
  readonly labelKey: keyof UiCopy;
  readonly tipKey: keyof UiCopy;
  readonly icon: IconName;
  readonly shortcut: string;
}

// #WDD-gpt  2026-08-16 - 按 viewer-2 将范围与形态解耦：选择用 1/2/3，Esc 回到浏览，变换用 4/5/6。
const selectionTools: ReadonlyArray<EditorToolDescriptor & { readonly id: ViewportSelectionTool }> = [
  { id: 'select-brush', labelKey: 'toolSelectBrush', tipKey: 'toolSelectBrushTip', icon: 'brush', shortcut: '1' },
  { id: 'select-rect', labelKey: 'toolSelectRect', tipKey: 'toolSelectRectTip', icon: 'rect', shortcut: '2' },
  { id: 'select-poly', labelKey: 'toolSelectPoly', tipKey: 'toolSelectPolyTip', icon: 'poly', shortcut: '3' },
  { id: 'select-cylinder', labelKey: 'toolSelectCylinder', tipKey: 'toolSelectCylinderTip', icon: 'cylinder', shortcut: 'C' },
];

const operationTools: ReadonlyArray<EditorToolDescriptor> = [
  { id: 'select', labelKey: 'toolSelect', tipKey: 'toolSelectTip', icon: 'cursor', shortcut: 'Esc' },
  { id: 'move', labelKey: 'toolMove', tipKey: 'toolMoveTip', icon: 'move', shortcut: '4' },
  { id: 'rotate', labelKey: 'toolRotate', tipKey: 'toolRotateTip', icon: 'rotate', shortcut: '5' },
  { id: 'scale', labelKey: 'toolScale', tipKey: 'toolScaleTip', icon: 'scale', shortcut: '6' },
];

const allEditorTools = [...selectionTools, ...operationTools];

function isViewportTransformTool(tool: ViewportEditorTool): tool is ViewportTransformTool {
  return tool === 'move' || tool === 'rotate' || tool === 'scale';
}

function isGaussianSelectionTool(tool: ViewportEditorTool): tool is ViewportSelectionTool {
  return tool === 'select-brush' || tool === 'select-rect' || tool === 'select-poly' || tool === 'select-cylinder';
}

const createInitialTransform = (): ViewportTransform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

const createInitialSelectionCylinder = (): GaussianCylinderSelectionRegion => ({
  centerX: 0,
  centerZ: 0,
  radius: 1,
  height: 2,
  groundPadding: 0.08,
});

const transformAxes = ['x', 'y', 'z'] as const;
const playbackFpsOptions = [1, 2, 4, 10, 15, 30, 60] as const;

interface ExportMonitorState {
  readonly kind: 'fourcgs' | 'fourcgs-raw4d-zip' | 'raw4d' | 'ply-sequence';
  readonly phase: 'running' | 'success' | 'error' | 'cancelled';
  readonly inputBytes: number;
  readonly progress: FourCgsProgress;
  readonly logs: readonly { readonly elapsedMs: number; readonly message: string }[];
  readonly result?: FourCgsEncodeResult;
  readonly plyStats?: {
    readonly segmentCount: number;
    readonly frameCount: number;
    readonly deletedPointCount: number;
  };
  readonly raw4DStats?: {
    readonly completedFiles: number;
    readonly fileCount: number;
    readonly pointCount: number;
    readonly sourcePreservedCount: number;
  };
  readonly outputBytes?: number;
  readonly error?: string;
}
const cameraViews: ReadonlyArray<{
  readonly id: ViewportCameraView;
  readonly labelKey: keyof UiCopy;
  readonly shortKey: keyof UiCopy;
}> = [
  { id: 'front', labelKey: 'cameraViewFront', shortKey: 'cameraViewFrontShort' },
  { id: 'back', labelKey: 'cameraViewBack', shortKey: 'cameraViewBackShort' },
  { id: 'left', labelKey: 'cameraViewLeft', shortKey: 'cameraViewLeftShort' },
  { id: 'right', labelKey: 'cameraViewRight', shortKey: 'cameraViewRightShort' },
  { id: 'top', labelKey: 'cameraViewTop', shortKey: 'cameraViewTopShort' },
  { id: 'bottom', labelKey: 'cameraViewBottom', shortKey: 'cameraViewBottomShort' },
];

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

function TransformNumberField({
  axis,
  disabled,
  label,
  max,
  min,
  onChange,
  precision,
  scrubStep,
  step,
  value,
}: {
  axis: typeof transformAxes[number];
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  precision: number;
  scrubStep: number;
  step: number;
  value: number;
}) {
  return (
    <label>
      <b aria-hidden="true" className={`axis-${axis}`}>{axis.toUpperCase()}</b>
      {/* #WDD-gpt 2026-08-16 - 对齐 view2：数值框本体可水平拖拽，单击后仍可完整键入并在提交时限值。 */}
      <ValidatedNumberInput
        aria-label={`${label} ${axis.toUpperCase()}`}
        disabled={disabled}
        max={max}
        min={min}
        onCommit={onChange}
        precision={precision}
        scrub
        scrubStep={scrubStep}
        step={step}
        value={value}
      />
    </label>
  );
}

function TransformVectorEditor({
  disabled,
  label,
  max,
  min,
  onChange,
  onReset,
  precision,
  resetLabel,
  scrubStep,
  step,
  values,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (axis: number, value: number) => void;
  onReset: () => void;
  precision: number;
  resetLabel: string;
  scrubStep: number;
  step: number;
  values: [number, number, number];
}) {
  return (
    <div className="transform-vector-card">
      <div className="transform-vector-heading">
        <strong>{label}</strong>
        <button disabled={disabled} onClick={onReset} type="button">{resetLabel}</button>
      </div>
      <div className="vector-row">
        {transformAxes.map((axis, index) => (
          <TransformNumberField axis={axis} disabled={disabled} key={axis} label={label} max={max} min={min} onChange={(value) => onChange(index, value)} precision={precision} scrubStep={scrubStep} step={step} value={values[index]} />
        ))}
      </div>
    </div>
  );
}

const initialStatus: ViewportStatus = {
  phase: 'initializing',
  renderer: '正在初始化',
  splatCount: 0,
};

const initialRuntimeProfile = detectGaussianRuntimeProfile();
const initialMemoryPolicy = createGaussian4DMemoryPolicy(initialRuntimeProfile.defaultMemoryMode);
const releaseNotes = parseReleaseNotes(changeLogMarkdown);

const initialMemoryUsage: ViewportMemoryUsage = {
  runtimePolicyMode: null,
  browserDeviceMemoryBytes: null,
  jsHeapBytes: null,
  jsHeapLimitBytes: null,
  gpuBytes: 0,
  managedCpuBytes: 0,
  cpuCompressedBytes: 0,
  cpuDecodedBytes: 0,
  cpuEvictableBytes: 0,
  cpuEvictionCount: 0,
  managedGpuBytes: 0,
  gpuActiveBytes: 0,
  gpuCachedBytes: 0,
  gpuOverBudgetBytes: 0,
  gpuBufferReuseCount: 0,
  transferActiveCount: 0,
  transferQueuedCount: 0,
  transferCompletedCount: 0,
  transferCancelledCount: 0,
  cpuBudgetBytes: initialMemoryPolicy.cpuBudgetBytes,
  gpuBudgetBytes: initialMemoryPolicy.gpuBudgetBytes,
  transport: 'transferable',
  bufferId: null,
};

const initialPerformanceSnapshot: ViewportPerformanceSnapshot = {
  fps: 0,
  frameTimeMs: 0,
  fpsHistory: [],
  frameTimeHistory: [],
  device: { backend: '--', renderer: '--', logicalCores: null, deviceMemoryGiB: null },
  loadTimings: [],
  warnings: [],
};

const gaussianRenderModes: Array<{
  id: GaussianRenderMode;
  labelKey: keyof UiCopy;
  titleKey: keyof UiCopy;
}> = [
  { id: 'gaussian', labelKey: 'renderGaussian', titleKey: 'renderGaussianTitle' },
  { id: 'point', labelKey: 'renderPoint', titleKey: 'renderPointTitle' },
  { id: 'ellipse', labelKey: 'renderEllipse', titleKey: 'renderEllipseTitle' },
  { id: 'all', labelKey: 'renderAll', titleKey: 'renderAllTitle' },
];

type MenuName = 'file' | 'view' | 'plugins' | null;
type InspectorTab = 'scene' | 'transform' | 'gaussian' | 'semantic' | 'performance';
type PluginId = 'smart-alignment' | 'relighting' | 'model-health' | 'semantic-classification';
type PluginStatusTone = 'idle' | 'running' | 'success' | 'error';
const inspectorTabs: ReadonlyArray<{ readonly id: InspectorTab; readonly labelKey: keyof UiCopy }> = [
  { id: 'scene', labelKey: 'tabScene' },
  { id: 'transform', labelKey: 'tabTransform' },
  { id: 'gaussian', labelKey: 'tabGaussian' },
  { id: 'semantic', labelKey: 'tabSemantic' },
  { id: 'performance', labelKey: 'tabPerformance' },
];

// #WDD-gpt  2026-08-15 - 通过统一插件目录生成菜单卡片，避免插件入口再次散落到右侧检查器。
const pluginMenuItems: ReadonlyArray<{
  readonly id: PluginId;
  readonly mark: string;
  readonly titleKey: keyof UiCopy;
  readonly descriptionKey: keyof UiCopy;
}> = [
  { id: 'smart-alignment', mark: '✦', titleKey: 'pluginSmartAlignment', descriptionKey: 'pluginSmartAlignmentDescription' },
  { id: 'relighting', mark: '☀', titleKey: 'pluginRelighting', descriptionKey: 'pluginRelightingDescription' },
  { id: 'model-health', mark: '✓', titleKey: 'pluginModelHealth', descriptionKey: 'pluginModelHealthDescription' },
  { id: 'semantic-classification', mark: '◈', titleKey: 'pluginSemanticClassification', descriptionKey: 'pluginSemanticClassificationDescription' },
];

const pluginStatusLabelKeys: Readonly<Record<PluginStatusTone, keyof UiCopy>> = {
  idle: 'pluginStatusIdle',
  running: 'pluginStatusRunning',
  success: 'pluginStatusSuccess',
  error: 'pluginStatusError',
};

export function App() {
  const [mobilePlayerMode, setMobilePlayerMode] = useState(() => initialRuntimeProfile.name === 'mobile-compatible'
    || (typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches));
  const [activeTool, setActiveTool] = useState<ViewportEditorTool>('select');
  const [selectionState, setSelectionState] = useState<ViewportSelectionState>(INITIAL_VIEWPORT_SELECTION_STATE);
  const [selectionScope, setSelectionScope] = useState<ViewportSelectionScope>('visible');
  const [selectionBrushRadius, setSelectionBrushRadius] = useState(48);
  const [selectionCylinder, setSelectionCylinder] = useState<GaussianCylinderSelectionRegion>(createInitialSelectionCylinder);
  const [historyState, setHistoryState] = useState<ViewportHistoryState>(INITIAL_EDITOR_HISTORY_STATE);
  const [status, setStatus] = useState<ViewportStatus>(initialStatus);
  const [memoryUsage, setMemoryUsage] = useState<ViewportMemoryUsage>(initialMemoryUsage);
  const [performanceSnapshot, setPerformanceSnapshot] = useState<ViewportPerformanceSnapshot>(initialPerformanceSnapshot);
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const [activePlugin, setActivePlugin] = useState<PluginId | null>(null);
  const [pluginWindowMinimized, setPluginWindowMinimized] = useState(false);
  const [pluginWindowPosition, setPluginWindowPosition] = useState<PluginWindowPosition>({ x: 0, y: 0 });
  //WDD-gpt 2026-08-15 - 默认收起低频检查器，把启动后的主要空间完整留给4DGS视口。
  const [inspectorPanelVisible, setInspectorPanelVisible] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('scene');
  const [language, setLanguage] = useState<UiLanguage>('zh');
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<readonly File[]>([]);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [fourCgsGalleryVisible, setFourCgsGalleryVisible] = useState(false);
  const [activeGalleryId, setActiveGalleryId] = useState<string | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [loopSortWaiting, setLoopSortWaiting] = useState(false);
  const [frameReadyRequestId, setFrameReadyRequestId] = useState(0);
  // #WDD-gpt 2026-08-16 - 播放速率独立于文件元数据并默认 30 FPS，允许用户按检查需求降速或加速。
  const [playbackFps, setPlaybackFps] = useState(30);
  // #WDD-gpt 2026-09-08 - 默认恢复正确性优先的逐帧排序；流畅模式仍可手动选择，但会明确提示可能使用旧遮挡顺序。
  const [forceSortSync, setForceSortSync] = useState(true);
  // Mobile playback always waits for the current frame's depth sort. The stored
  // desktop preference remains independent so responsive layout changes are reversible.
  const effectiveForceSortSync = resolveForceSortSync(mobilePlayerMode, forceSortSync);
  const [renderMode, setRenderMode] = useState<GaussianRenderMode>('gaussian');
  const [backgroundColor, setBackgroundColor] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_VIEWPORT_BACKGROUND_COLOR;
    try {
      return normalizeViewportBackgroundColor(window.localStorage.getItem(VIEWPORT_BACKGROUND_COLOR_STORAGE_KEY));
    } catch {
      return DEFAULT_VIEWPORT_BACKGROUND_COLOR;
    }
  });
  // #WDD-gpt 2026-08-19 - 手机首屏默认 SH0，先保证低功耗 GPU 稳定出图；用户仍可在渲染栏手动提高级别。
  const [shLevel, setShLevel] = useState(initialRuntimeProfile.name === 'mobile-compatible' ? 0 : 3);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showHeightRuler, setShowHeightRuler] = useState(false);
  const [showGaussianEnvelope, setShowGaussianEnvelope] = useState(false);
  const [sceneTransform, setSceneTransform] = useState<ViewportTransform>(createInitialTransform);
  const [uniformScale, setUniformScale] = useState(true);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportCenterVisible, setExportCenterVisible] = useState(false);
  const [exportMonitor, setExportMonitor] = useState<ExportMonitorState | null>(null);
  const [exportElapsedMs, setExportElapsedMs] = useState(0);
  const [viewportRuntime, setViewportRuntime] = useState<ViewportRuntime | null>(null);
  const [smartAlignmentState, setSmartAlignmentState] = useState<SmartAlignmentState>(INITIAL_SMART_ALIGNMENT_STATE);
  const [gs2MeshState, setGS2MeshState] = useState<GS2MeshState>(INITIAL_GS2MESH_STATE);
  const [relightMeshState, setRelightMeshState] = useState<RelightingMeshState>(INITIAL_RELIGHTING_MESH_STATE);
  const [relightingState, setRelightingState] = useState<RelightingState>(INITIAL_RELIGHTING_STATE);
  const [relightingWorkflowStep, setRelightingWorkflowStep] = useState<RelightingWorkflowStep>('mesh');
  const [gs2MeshVisible, setGS2MeshVisible] = useState(true);
  const [gaussianVisible, setGaussianVisible] = useState(true);
  const [modelHealthReport, setModelHealthReport] = useState<ModelHealthReport | null>(null);
  const [modelHealthBusy, setModelHealthBusy] = useState(false);
  const [semanticClassificationState, setSemanticClassificationState] = useState<SemanticClassificationState>(INITIAL_SEMANTIC_CLASSIFICATION_STATE);
  const [originBakeDialogVisible, setOriginBakeDialogVisible] = useState(false);
  const [originBakeBusy, setOriginBakeBusy] = useState(false);
  const [originBakeProgress, setOriginBakeProgress] = useState<ViewportTransformBakeProgress | null>(null);
  const [originBakeResult, setOriginBakeResult] = useState<ViewportTransformBakeResult | null>(null);
  const [originBakeError, setOriginBakeError] = useState<string | null>(null);
  // #WDD-gpt 2026-08-17 - Chromium 禁止网页直接获准“下载”根目录，导出前先引导选择可写子目录。
  const [plyDirectoryDialogVisible, setPlyDirectoryDialogVisible] = useState(false);
  const [plyDirectoryPicking, setPlyDirectoryPicking] = useState(false);
  const [plyDirectoryError, setPlyDirectoryError] = useState<string | null>(null);
  const [raw4DDirectoryDialogVisible, setRaw4DDirectoryDialogVisible] = useState(false);
  const [raw4DDirectoryPicking, setRaw4DDirectoryPicking] = useState(false);
  const [raw4DDirectoryError, setRaw4DDirectoryError] = useState<string | null>(null);
  const [appNotice, setAppNotice] = useState<{
    readonly message: string;
    readonly title: string;
    readonly tone: AppNoticeTone;
    readonly details?: string;
    readonly suggestion?: string;
    readonly retryLabel?: string;
    readonly onRetry?: () => void;
  } | null>(null);
  const [workspaceDraft, setWorkspaceDraft] = useState<WorkspaceDraft | null>(null);
  const [workspaceSaveState, setWorkspaceSaveState] = useState<'empty' | 'saving' | 'saved' | 'recovery'>('empty');
  const [workspaceSavedAt, setWorkspaceSavedAt] = useState<number | null>(null);
  const [workspaceSaveTick, setWorkspaceSaveTick] = useState(0);
  const [cameraBookmarks, setCameraBookmarks] = useState<readonly (NonNullable<ReturnType<ViewportRuntime['getCameraState']>> | null)[]>([null, null, null]);
  const [timelineDetailsVisible, setTimelineDetailsVisible] = useState(false);
  // #WDD-gpt 2026-08-19 - 桌面继续默认高内存档，手机首屏自动切入低驻留兼容档，避免先崩溃再要求用户手动切换。
  const [memoryMode, setMemoryMode] = useState<Gaussian4DMemoryMode>(initialRuntimeProfile.defaultMemoryMode);
  const [pendingLocalMaximumMode, setPendingLocalMaximumMode] = useState(false);
  const [releaseNotesVisible, setReleaseNotesVisible] = useState(false);
  const [memoryPressureDialogVisible, setMemoryPressureDialogVisible] = useState(false);
  const [lastMemoryPressureResult, setLastMemoryPressureResult] = useState<BrowserMemoryPressureResult | null>(null);
  const [customCpuGiB, setCustomCpuGiB] = useState(12);
  const [customGpuGiB, setCustomGpuGiB] = useState(6);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportStartedAtRef = useRef(0);
  const workspaceRef = useRef<HTMLElement>(null);
  const pluginWindowRef = useRef<HTMLElement>(null);
  const pluginDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly origin: PluginWindowPosition;
  } | null>(null);
  const fileDragDepthRef = useRef(0);
  const workspaceSaveBusyRef = useRef(false);
  const loopRestartPendingRef = useRef(false);
  const loopRestartRequestIdRef = useRef(0);
  const pendingDisplayedFrameRef = useRef<{
    readonly frame: number;
    readonly timeoutId: number;
    readonly resolve: (displayed: boolean) => void;
  } | null>(null);
  const restoredWorkspaceSignatureRef = useRef<string | null>(null);
  const smartAlignmentPluginRef = useRef<SmartAlignmentPlugin | null>(null);
  const gs2MeshPluginRef = useRef<GS2MeshPlugin | null>(null);
  const relightMeshRef = useRef<RelightingMeshSequence | null>(null);
  const semanticClassificationRef = useRef<SemanticClassificationPlugin | null>(null);
  if (!smartAlignmentPluginRef.current) smartAlignmentPluginRef.current = new SmartAlignmentPlugin();
  if (!gs2MeshPluginRef.current) gs2MeshPluginRef.current = new GS2MeshPlugin();
  if (!relightMeshRef.current) relightMeshRef.current = new RelightingMeshSequence();
  if (!semanticClassificationRef.current) semanticClassificationRef.current = new SemanticClassificationPlugin();
  const memoryPolicy = useMemo(
    () => createGaussian4DMemoryPolicy(memoryMode, customCpuGiB, customGpuGiB),
    [customCpuGiB, customGpuGiB, memoryMode],
  );
  const timelineEndFrame = Math.max(0, (status.totalFrames ?? 121) - 1);
  const copy = UI_COPY[language];
  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const detectedMobile = initialRuntimeProfile.name === 'mobile-compatible';
    const updateMode = () => setMobilePlayerMode(detectedMobile || media.matches);
    updateMode();
    media.addEventListener('change', updateMode);
    return () => media.removeEventListener('change', updateMode);
  }, []);

  useEffect(() => {
    if (!mobilePlayerMode) return;
    // #WDD-gpt 2026-08-19 - 手机端收敛为播放器：隐藏编辑能力的同时关闭不可见的辅助绘制，避免白耗 GPU 与触控命中区域。
    setInspectorPanelVisible(false);
    setActivePlugin(null);
    setActiveTool('select');
    setShowGrid(false);
    setShowAxes(false);
    setShowHeightRuler(false);
    setShowGaussianEnvelope(false);
    setTimelineDetailsVisible(false);
    if (renderMode !== 'gaussian' && renderMode !== 'point') setRenderMode('gaussian');
  }, [mobilePlayerMode, renderMode]);

  const handleFrameRenderReady = useCallback((requestId: number, sorted: boolean) => {
    if (!loopRestartPendingRef.current || requestId !== loopRestartRequestIdRef.current) return;
    if (!sorted) {
      // 超时不放行未排序帧；重新等待下一次引擎 ready，而不是退回固定延时播放。
      const retryId = loopRestartRequestIdRef.current + 1;
      loopRestartRequestIdRef.current = retryId;
      setFrameReadyRequestId(retryId);
      return;
    }
    loopRestartPendingRef.current = false;
    setLoopSortWaiting(false);
    setIsPlaying(true);
  }, []);
  const stopPlayback = useCallback(() => {
    loopRestartPendingRef.current = false;
    loopRestartRequestIdRef.current += 1;
    setLoopSortWaiting(false);
    setIsPlaying(false);
  }, []);
  // #WDD-gpt 2026-08-16 - 极限内存预设必须在网页内二次确认，避免低配置设备因误触直接进入高驻留预算。
  const requestMemoryMode = (nextMode: Gaussian4DMemoryMode) => {
    if (nextMode === 'local-maximum' && memoryMode !== 'local-maximum') {
      setPendingLocalMaximumMode(true);
      return;
    }
    setMemoryMode(nextMode);
  };
  const activateLocalMaximumMode = () => {
    setMemoryMode('local-maximum');
    setPendingLocalMaximumMode(false);
  };
  useEffect(() => {
    if (!pendingLocalMaximumMode) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPendingLocalMaximumMode(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [pendingLocalMaximumMode]);
  useEffect(() => {
    if (!releaseNotesVisible) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setReleaseNotesVisible(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [releaseNotesVisible]);
  useEffect(() => {
    if (!originBakeDialogVisible || originBakeBusy) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOriginBakeDialogVisible(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [originBakeBusy, originBakeDialogVisible]);
  useEffect(() => {
    if (!plyDirectoryDialogVisible || plyDirectoryPicking) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setPlyDirectoryDialogVisible(false);
      setPlyDirectoryError(null);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [plyDirectoryDialogVisible, plyDirectoryPicking]);
  useEffect(() => {
    if (!raw4DDirectoryDialogVisible || raw4DDirectoryPicking) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setRaw4DDirectoryDialogVisible(false);
      setRaw4DDirectoryError(null);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [raw4DDirectoryDialogVisible, raw4DDirectoryPicking]);
  useEffect(() => {
    if (!appNotice) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setAppNotice(null);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [appNotice]);
  const cameraViewLabels = useMemo(
    () => Object.fromEntries(cameraViews.map((view) => [view.id, {
      long: UI_COPY[language][view.labelKey],
      short: UI_COPY[language][view.shortKey],
    }])) as Record<ViewportCameraView, { long: string; short: string }>,
    [language],
  );
  const activeSelectionDescriptor = isGaussianSelectionTool(activeTool)
    ? selectionTools.find((tool) => tool.id === activeTool) ?? null
    : null;
  const displaySceneName = sceneName ?? copy.untitledScene;

  const transformDisabled = status.phase !== 'ready' || status.splatCount === 0;
  const transformControlsDisabled = transformDisabled || originBakeBusy;
  const sceneScaleMaximum = Math.max(...sceneTransform.scale, 1);
  const sceneScaleIsUniform = Math.abs(sceneTransform.scale[0] - sceneTransform.scale[1]) <= sceneScaleMaximum * 1e-6
    && Math.abs(sceneTransform.scale[0] - sceneTransform.scale[2]) <= sceneScaleMaximum * 1e-6;
  const sceneTransformIsIdentity = sceneTransform.position.every((value) => Math.abs(value) <= 1e-8)
    && sceneTransform.rotation.every((value) => Math.abs(value) <= 1e-8)
    && sceneTransform.scale.every((value) => Math.abs(value - 1) <= 1e-8);
  const sceneRotationIsIdentity = sceneTransform.rotation.every((value) => Math.abs(value) <= 1e-8);
  const hasGS2Mesh = gs2MeshState.stage === 'success' || relightMeshState.stage === 'success';
  const statusDeletedCount = selectionState.deletedCount ?? 0;
  const statusActiveCount = Math.max(0, (selectionState.pointCount ?? status.splatCount) - statusDeletedCount);
  const statusCurrentFrameDisplayedCount = selectionState.currentFrameDisplayedCount
    ?? Math.max(0, status.splatCount - Math.min(status.splatCount, statusDeletedCount));
  const statusKeyframeCount = status.keyframeCount
    ?? status.raw4dSequence?.keyframes.length
    ?? (status.splatCount > 0 ? 1 : 0);
  const gaussianCountLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const sourceFile = sourceFiles.length === 1 ? sourceFiles[0] : null;
  const localizedStatusMessage = localizeRuntimeMessage(language, status.message);
  const viewportErrorDescription = status.phase === 'error'
    ? describeAppError(status.message ?? status.renderer, language, status.renderer)
    : null;
  const showAppNotice = (message: string, title?: string, tone: AppNoticeTone = 'error') => {
    setAppNotice({
      message,
      title: title ?? (language === 'zh' ? '操作未完成' : 'Operation not completed'),
      tone,
    });
  };
  const showAppError = (error: unknown, context?: string, onRetry?: () => void) => {
    const description = describeAppError(error, language, context);
    setAppNotice({
      message: description.summary,
      title: description.title,
      tone: 'error',
      suggestion: description.suggestion,
      details: description.details,
      retryLabel: language === 'zh' ? '重试' : 'Retry',
      onRetry,
    });
  };
  const pluginStatusById: Readonly<Record<PluginId, PluginStatusTone>> = {
    'smart-alignment': smartAlignmentState.stage === 'success'
      ? 'success'
      : smartAlignmentState.stage === 'error'
        ? 'error'
        : smartAlignmentState.stage === 'idle' ? 'idle' : 'running',
    relighting: relightingState.error || gs2MeshState.stage === 'error' || relightMeshState.stage === 'error'
      ? 'error'
      : ['capturing', 'matching', 'fusing', 'installing'].includes(gs2MeshState.stage) || ['capturing', 'rebuilding'].includes(relightMeshState.stage)
        ? 'running'
        : relightingState.enabled ? 'success' : 'idle',
    'model-health': modelHealthBusy ? 'running' : modelHealthReport?.healthy ? 'success' : modelHealthReport ? 'error' : 'idle',
    'semantic-classification': semanticClassificationState.stage === 'success'
      ? 'success'
      : semanticClassificationState.stage === 'error'
        ? 'error'
        : semanticClassificationState.stage === 'idle' || semanticClassificationState.stage === 'cancelled'
          ? 'idle'
          : 'running',
  };
  const activePluginItem = pluginMenuItems.find((plugin) => plugin.id === activePlugin) ?? null;

  useEffect(() => () => {
    exportAbortRef.current?.abort();
    smartAlignmentPluginRef.current?.dispose();
    gs2MeshPluginRef.current?.dispose();
    relightMeshRef.current?.dispose();
    semanticClassificationRef.current?.dispose();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEWPORT_BACKGROUND_COLOR_STORAGE_KEY, backgroundColor);
    } catch {
      // #WDD-gpt 2026-09-02 - 浏览器禁用持久存储时仍保留当前会话内的实时背景设置。
    }
  }, [backgroundColor]);

  useEffect(() => {
    let active = true;
    loadWorkspaceDraft().then((draft) => {
      if (!active || !draft) return;
      setWorkspaceDraft(draft);
      setWorkspaceSavedAt(draft.savedAt);
      setWorkspaceSaveState('recovery');
      setInspectorPanelVisible(true);
      setInspectorTab('scene');
    }).catch((error) => showAppError(error, 'workspace-load'));
    return () => { active = false; };
    // #WDD-gpt 2026-08-18 - 初次挂载只读取一次恢复点，避免界面状态变化反复覆盖用户当前操作。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status.phase !== 'ready' || sourceFiles.length === 0) return;
    const interval = window.setInterval(() => setWorkspaceSaveTick((value) => value + 1), 8_000);
    return () => window.clearInterval(interval);
  }, [sourceFiles.length, status.phase]);

  useEffect(() => {
    if (!workspaceDraft || !viewportRuntime || status.phase !== 'ready' || sourceFiles.length === 0) return;
    if (!workspaceSourcesMatch(workspaceDraft.sources, sourceFiles)) {
      setWorkspaceSaveState('recovery');
      return;
    }
    const signature = workspaceDraft.sources.map((source) => `${source.name}:${source.size}:${source.lastModified}`).join('|');
    if (restoredWorkspaceSignatureRef.current === signature) return;
    try {
      if (workspaceDraft.edits.length > 0) {
        // #WDD-gpt 2026-08-18 - 重新选择同名文件时先等待运行时接管新的 File 对象，避免旧场景 ready 状态触发一次虚假的编辑快照不匹配错误。
        try {
          viewportRuntime.snapshotRaw4DExportMemory(sourceFiles);
        } catch {
          return;
        }
        viewportRuntime.restoreGaussianEditState(workspaceDraft.edits);
      }
      setSceneName(workspaceDraft.sceneName);
      setCurrentFrame(Math.max(0, Math.min(timelineEndFrame, workspaceDraft.view.currentFrame)));
      setPlaybackFps(workspaceDraft.view.playbackFps);
      setForceSortSync(restoreWorkspaceForceSortSync(workspaceDraft.view));
      setRenderMode(workspaceDraft.view.renderMode);
      if (workspaceDraft.view.backgroundColor) {
        const restoredBackgroundColor = normalizeViewportBackgroundColor(workspaceDraft.view.backgroundColor);
        setBackgroundColor(restoredBackgroundColor);
        viewportRuntime.setBackgroundColor(restoredBackgroundColor);
      }
      setShLevel(workspaceDraft.view.shLevel);
      setShowGrid(workspaceDraft.view.showGrid);
      setShowAxes(workspaceDraft.view.showAxes);
      setShowHeightRuler(workspaceDraft.view.showHeightRuler);
      setShowGaussianEnvelope(workspaceDraft.view.showGaussianEnvelope);
      setGaussianVisible(workspaceDraft.view.gaussianVisible);
      setGS2MeshVisible(workspaceDraft.view.gs2MeshVisible);
      setSceneTransform(workspaceDraft.view.sceneTransform);
      setInspectorTab(workspaceDraft.view.inspectorTab);
      setCameraBookmarks(workspaceDraft.view.cameraBookmarks ?? [null, null, null]);
      if (workspaceDraft.view.camera) viewportRuntime.setCameraState(workspaceDraft.view.camera);
      viewportRuntime.setGaussianVisible(workspaceDraft.view.gaussianVisible);
      viewportRuntime.setGS2MeshVisible(workspaceDraft.view.gs2MeshVisible);
      restoredWorkspaceSignatureRef.current = signature;
      setWorkspaceSaveState('saved');
      setInspectorPanelVisible(true);
    } catch (error) {
      showAppError(error, 'workspace-restore');
    }
  }, [sourceFiles, status.bufferId, status.phase, timelineEndFrame, viewportRuntime, workspaceDraft]);

  useEffect(() => {
    if (!viewportRuntime || status.phase !== 'ready' || sourceFiles.length === 0 || workspaceSaveBusyRef.current) return;
    const timeout = window.setTimeout(() => {
      workspaceSaveBusyRef.current = true;
      setWorkspaceSaveState('saving');
      const savedAt = Date.now();
      const draft: WorkspaceDraft = {
        schemaVersion: 1,
        savedAt,
        sceneName: displaySceneName,
        sources: workspaceSourceIdentities(sourceFiles),
        view: {
          backgroundColor,
          camera: viewportRuntime.getCameraState(),
          cameraBookmarks,
          currentFrame,
          forceSortSync,
          forceSortSyncRevision: FORCE_SORT_SYNC_REVISION,
          gaussianVisible,
          gs2MeshVisible,
          inspectorTab: inspectorTab === 'semantic' ? 'scene' : inspectorTab,
          playbackFps,
          renderMode,
          sceneTransform,
          shLevel,
          showAxes,
          showGaussianEnvelope,
          showGrid,
          showHeightRuler,
        },
        edits: viewportRuntime.snapshotGaussianEditState(),
      };
      saveWorkspaceDraft(draft).then(() => {
        setWorkspaceDraft(draft);
        setWorkspaceSavedAt(savedAt);
        setWorkspaceSaveState('saved');
      }).catch((error) => {
        setWorkspaceSaveState('recovery');
        showAppError(error, 'workspace-save');
      }).finally(() => { workspaceSaveBusyRef.current = false; });
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [
    backgroundColor, cameraBookmarks, currentFrame, displaySceneName, forceSortSync, gaussianVisible, gs2MeshVisible, inspectorTab,
    playbackFps, renderMode, sceneTransform, selectionState.deletedCount, selectionState.selectedCount,
    shLevel, showAxes, showGaussianEnvelope, showGrid, showHeightRuler, sourceFiles, status.bufferId,
    status.phase, viewportRuntime, workspaceSaveTick,
  ]);

  // #WDD-gpt 2026-08-16 - 保存监督框使用主线程时钟持续刷新，即使编码 Worker 正在执行长时间同步压缩也不会看起来卡死。
  useEffect(() => {
    if (exportMonitor?.phase !== 'running') return;
    const update = () => setExportElapsedMs(performance.now() - exportStartedAtRef.current);
    update();
    const handle = window.setInterval(update, 200);
    return () => window.clearInterval(handle);
  }, [exportMonitor?.phase]);

  useEffect(() => {
    if (!viewportRuntime) return;
    setRelightingState(viewportRuntime.setRelightingEditing(
      activePlugin === 'relighting' && relightingWorkflowStep === 'lighting',
    ));
  }, [activePlugin, relightingWorkflowStep, viewportRuntime]);

  const previousGS2MeshStageRef = useRef<GS2MeshState['stage']>(gs2MeshState.stage);
  useEffect(() => {
    const previousStage = previousGS2MeshStageRef.current;
    previousGS2MeshStageRef.current = gs2MeshState.stage;
    // #WDD-gpt 2026-08-17 - Step 1 首次成功后自动进入布光；Mesh 被清除或重建时退回 Step 1。
    const toStatus = (stage: GS2MeshState['stage']): RelightingMeshStatus => stage === 'success'
      ? 'success'
      : stage === 'error' ? 'error' : stage === 'idle' || stage === 'cancelled' ? 'idle' : 'running';
    setRelightingWorkflowStep((current) => reconcileRelightingWorkflowStep(
      current,
      toStatus(previousStage),
      toStatus(gs2MeshState.stage),
    ));
  }, [gs2MeshState.stage]);

  // #WDD-gpt 2026-08-21 - 逐帧网格序列的 Step 1 状态与单帧 GS2Mesh 共用同一推进规则。
  const previousRelightMeshStageRef = useRef<RelightingMeshState['stage']>(relightMeshState.stage);
  useEffect(() => {
    const previousStage = previousRelightMeshStageRef.current;
    previousRelightMeshStageRef.current = relightMeshState.stage;
    const toStatus = (stage: RelightingMeshState['stage']): RelightingMeshStatus => stage === 'success'
      ? 'success'
      : stage === 'error' ? 'error' : stage === 'idle' || stage === 'cancelled' ? 'idle' : 'running';
    setRelightingWorkflowStep((current) => reconcileRelightingWorkflowStep(
      current,
      toStatus(previousStage),
      toStatus(relightMeshState.stage),
    ));
  }, [relightMeshState.stage]);

  useEffect(() => {
    if (status.phase !== 'ready') return;
    setShLevel(status.splatCount > 0 ? status.shBands ?? 0 : 0);
  }, [status.bufferId, status.phase, status.shBands, status.splatCount]);

  useEffect(() => {
    if (semanticClassificationState.stage === 'success' && semanticClassificationState.result) {
      // #WDD-gpt 2026-08-27 - 识别完成后自动打开右侧分类页签，让类别选择与统计脱离插件配置弹窗。
      setInspectorPanelVisible(true);
      setInspectorTab('semantic');
    }
  }, [semanticClassificationState.result, semanticClassificationState.stage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isViewportBrowseShortcut(event)) {
        setOpenMenu(null);
        setActivePlugin(null);
        setActiveTool('select');
        return;
      }
      if (isTextEntryTarget(event.target)) return;
      if (event.key === 'Home') {
        event.preventDefault();
        viewportRuntime?.frameScene();
        setIsPlaying(false);
        return;
      }
      if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        void focusSelection();
        return;
      }
      if (isEditorUndoShortcut(event)) {
        event.preventDefault();
        viewportRuntime?.undo();
        setIsPlaying(false);
        return;
      }
      if (isEditorRedoShortcut(event)) {
        event.preventDefault();
        viewportRuntime?.redo();
        setIsPlaying(false);
        return;
      }
      if (isGaussianDeleteShortcut(event)) {
        event.preventDefault();
        viewportRuntime?.deleteSelectedGaussians();
        setIsPlaying(false);
        return;
      }
      const shortcut = allEditorTools.find((tool) => tool.shortcut.toLowerCase() === event.key.toLowerCase());
      if (shortcut) {
        setActiveTool(shortcut.id);
        if (isGaussianSelectionTool(shortcut.id)) setIsPlaying(false);
        if (isViewportTransformTool(shortcut.id)) {
          setInspectorPanelVisible(true);
          setInspectorTab('transform');
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [language, selectionScope, viewportRuntime]);

  useEffect(() => {
    if (!isPlaying) return;
    if (timelineEndFrame <= 0) {
      setIsPlaying(false);
      return;
    }
    const frameCount = timelineEndFrame + 1;
    if (effectiveForceSortSync) {
      // #WDD-gpt 2026-09-09 - 告知运行时这是连续严格播放会话，使 Windows 全程复用同一个稳定覆盖层。
      viewportRuntime?.beginFramePacing();
      // #WDD-gpt 2026-08-21 - 强制排序播放：等引擎确认当前帧排序提交后再推进下一帧；
      // 排序吞吐不足时播放自动降速，而不是带过期顺序渲染，循环回绕也天然被同一门槛约束。
      let stopped = false;
      let frame = currentFrame;
      const step = async () => {
        while (!stopped) {
          const next = frame + 1;
          if (!isLooping && next >= frameCount) {
            setCurrentFrame(timelineEndFrame);
            setIsPlaying(false);
            return;
          }
          frame = isLooping ? next % frameCount : next;
          const frameStartedAt = performance.now();
          // #WDD-gpt 2026-08-21 - 必须先登记目标再 setState，等待 GaussianViewport 回报该帧已真实提交；
          // 旧实现直接监听任意 frame:ready，常在 React 尚未提交目标帧前就误判完成，导致时间轴/代理独走。
          const displayed = new Promise<boolean>((resolve) => {
            const previous = pendingDisplayedFrameRef.current;
            if (previous) {
              window.clearTimeout(previous.timeoutId);
              previous.resolve(false);
            }
            const timeoutId = window.setTimeout(() => {
              const pending = pendingDisplayedFrameRef.current;
              if (!pending || pending.frame !== frame) return;
              pendingDisplayedFrameRef.current = null;
              resolve(false);
            }, 4_000);
            pendingDisplayedFrameRef.current = { frame, timeoutId, resolve };
          });
          setCurrentFrame((current) => current === frame ? current : frame);
          const committed = await displayed;
          if (stopped) return;
          if (!committed) {
            setIsPlaying(false);
            return;
          }
          const remainingFrameBudgetMs = 1000 / playbackFps - (performance.now() - frameStartedAt);
          if (remainingFrameBudgetMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remainingFrameBudgetMs));
          }
        }
      };
      void step();
      return () => {
        stopped = true;
        // #WDD-gpt 2026-09-08 - 暂停若落在 frame:ready 之前，丢弃旧节拍标记，避免续播把新帧永久排在已结束会话之后。
        viewportRuntime?.cancelFramePacing();
        const pending = pendingDisplayedFrameRef.current;
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingDisplayedFrameRef.current = null;
        pending.resolve(false);
      };
    }
    const startTime = performance.now();
    const startFrame = currentFrame;
    let animationFrame = 0;
    // #WDD-gpt 2026-08-14 - 使用真实时间驱动播放，避免定时器积压导致 RAW4D 越播越卡。
    const updatePlayback = (now: number) => {
      const elapsedFrames = Math.floor((now - startTime) * playbackFps / 1000);
      const absoluteFrame = startFrame + elapsedFrames;
      if (!isLooping && absoluteFrame >= timelineEndFrame) {
        setCurrentFrame(timelineEndFrame);
        setIsPlaying(false);
        return;
      }
      if (isLooping && absoluteFrame >= frameCount) {
        // #WDD-gpt 2026-08-19 - 循环边界先暂停在第 0 帧，等 PlayCanvas 确认新中心已排序并提交后再恢复时钟。
        loopRestartPendingRef.current = true;
        const requestId = loopRestartRequestIdRef.current + 1;
        loopRestartRequestIdRef.current = requestId;
        setIsPlaying(false);
        setLoopSortWaiting(true);
        setCurrentFrame(0);
        setFrameReadyRequestId(requestId);
        return;
      }
      const nextFrame = isLooping ? absoluteFrame % frameCount : Math.min(absoluteFrame, timelineEndFrame);
      setCurrentFrame((frame) => frame === nextFrame ? frame : nextFrame);
      animationFrame = window.requestAnimationFrame(updatePlayback);
    };
    animationFrame = window.requestAnimationFrame(updatePlayback);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [effectiveForceSortSync, isLooping, isPlaying, playbackFps, timelineEndFrame, viewportRuntime]);

  useEffect(() => {
    setCurrentFrame((frame) => Math.min(frame, timelineEndFrame));
  }, [timelineEndFrame]);

  const chooseTool = (id: ViewportEditorTool) => {
    setActiveTool(id);
    if (isGaussianSelectionTool(id)) setIsPlaying(false);
    if (isViewportTransformTool(id)) {
      setInspectorPanelVisible(true);
      setInspectorTab('transform');
    }
  };

  const chooseSelectionScope = (scope: ViewportSelectionScope) => {
    setSelectionScope(scope);
    setIsPlaying(false);
    if (!isGaussianSelectionTool(activeTool)) setActiveTool('select-rect');
  };

  const updateTransformVector = (key: keyof ViewportTransform, axis: number, nextValue: number) => {
    setSceneTransform((current) => {
      const next = { ...current, [key]: [...current[key]] } as ViewportTransform;
      if (key === 'scale' && uniformScale) {
        next.scale = [nextValue, nextValue, nextValue].map((value) => Math.max(0.001, value)) as [number, number, number];
      } else {
        next[key][axis] = key === 'scale' ? Math.max(0.001, nextValue) : nextValue;
      }
      return next;
    });
  };

  const resetTransformVector = (key: keyof ViewportTransform) => {
    const initial = createInitialTransform();
    setSceneTransform((current) => ({ ...current, [key]: initial[key] }));
  };

  const openOriginBakeDialog = () => {
    if (!viewportRuntime || transformDisabled || sceneTransformIsIdentity) return;
    setIsPlaying(false);
    setOriginBakeProgress(null);
    setOriginBakeResult(null);
    setOriginBakeError(null);
    setOriginBakeDialogVisible(true);
  };

  const runOriginBake = async () => {
    if (!viewportRuntime || originBakeBusy || !sceneScaleIsUniform) return;
    setOriginBakeBusy(true);
    setOriginBakeProgress(null);
    setOriginBakeResult(null);
    setOriginBakeError(null);
    setIsPlaying(false);
    setActiveTool('select');
    try {
      const result = await viewportRuntime.bakeSceneTransformIntoGaussianData(setOriginBakeProgress);
      setOriginBakeResult(result);
      setModelHealthReport(null);
    } catch (error) {
      setOriginBakeError(error instanceof Error ? error.message : String(error));
    } finally {
      setOriginBakeBusy(false);
    }
  };

  const runSmartAlignment = () => {
    if (!viewportRuntime || transformDisabled) return;
    setIsPlaying(false);
    void smartAlignmentPluginRef.current?.align(viewportRuntime, setSmartAlignmentState);
  };

  const runGS2Mesh = (options: GS2MeshOptions) => {
    if (!viewportRuntime || transformDisabled) return;
    setIsPlaying(false);
    setGS2MeshVisible(true);
    viewportRuntime.setGS2MeshVisible(true);
    void gs2MeshPluginRef.current?.reconstruct(viewportRuntime, options, setGS2MeshState);
  };

  // #WDD-gpt 2026-08-21 - 帧范围直接使用统一时间轴；Runtime 负责跨片段寻址，避免只计算活动片段。
  const runRelightingMeshSequence = (
    frameStart: number,
    frameEnd: number,
    isoLevel: number,
    maxGaussians: number,
    fieldResolution: number,
  ) => {
    if (!viewportRuntime || transformDisabled) return;
    setIsPlaying(false);
    void relightMeshRef.current?.generate(viewportRuntime, {
      frameStart,
      frameEnd,
      isoLevel,
      maxGaussians,
      fieldResolution,
    }, setRelightMeshState);
  };

  const showDisplayedRelightingFrame = useCallback((frame: number) => {
    const pending = pendingDisplayedFrameRef.current;
    if (pending?.frame === frame) {
      window.clearTimeout(pending.timeoutId);
      pendingDisplayedFrameRef.current = null;
      pending.resolve(true);
    }
    if (viewportRuntime && relightMeshRef.current?.isReady) {
      relightMeshRef.current.showFrame(viewportRuntime, frame);
    }
  }, [viewportRuntime]);

  useEffect(() => {
    if (relightMeshState.stage !== 'success') return;
    // #WDD-gpt 2026-08-21 - 生成完成只校准一次；后续播放只能由 ViewportRuntime 的真实显示提交驱动，禁止目标时间轴提前换 Mesh。
    showDisplayedRelightingFrame(currentFrame);
  }, [relightMeshState.stage, showDisplayedRelightingFrame]);

  const clearGS2Mesh = () => {
    if (!viewportRuntime) return;
    gs2MeshPluginRef.current?.clear(viewportRuntime, setGS2MeshState);
    setGS2MeshVisible(true);
  };

  const changeGS2MeshVisible = (visible: boolean) => {
    setGS2MeshVisible(visible);
    viewportRuntime?.setGS2MeshVisible(visible);
  };

  const changeGaussianVisible = (visible: boolean) => {
    setGaussianVisible(visible);
    viewportRuntime?.setGaussianVisible(visible);
  };

  const runRelightingAction = (action: (runtime: ViewportRuntime) => RelightingState) => {
    if (!viewportRuntime) return;
    try {
      setRelightingState(action(viewportRuntime));
    } catch (error) {
      setRelightingState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const changeRelightingEnabled = (enabled: boolean) => runRelightingAction(
    (runtime) => runtime.setRelightingEnabled(enabled),
  );
  const addRelightingLight = () => runRelightingAction((runtime) => runtime.addRelightingLight());
  const removeRelightingLight = (id: string) => runRelightingAction((runtime) => runtime.removeRelightingLight(id));
  const selectRelightingLight = (id: string) => runRelightingAction((runtime) => runtime.selectRelightingLight(id));
  const updateRelightingLight = (id: string, patch: RelightingLightPatch) => runRelightingAction(
    (runtime) => runtime.updateRelightingLight(id, patch),
  );
  const updateRelightingSettings = (patch: Partial<RelightingSettings>) => runRelightingAction(
    (runtime) => runtime.updateRelightingSettings(patch),
  );

  const toggleMenu = (event: React.MouseEvent, menu: Exclude<MenuName, null>) => {
    event.stopPropagation();
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const toggleInspectorPanel = () => {
    setInspectorPanelVisible((visible) => !visible);
    setOpenMenu(null);
  };

  const openPluginWorkspace = (plugin: PluginId) => {
    if (plugin === 'relighting') setRelightingWorkflowStep(hasGS2Mesh ? 'lighting' : 'mesh');
    setActivePlugin(plugin);
    setPluginWindowMinimized(false);
    setPluginWindowPosition({ x: 0, y: 0 });
    setOpenMenu(null);
  };

  const clampPluginWindowToWorkspace = useCallback(() => {
    const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
    const windowBounds = pluginWindowRef.current?.getBoundingClientRect();
    if (!workspaceBounds || !windowBounds) return;
    setPluginWindowPosition((position) => {
      const next = clampPluginWindowPosition({
        position,
        workspaceWidth: workspaceBounds.width,
        workspaceHeight: workspaceBounds.height,
        windowWidth: windowBounds.width,
        windowHeight: windowBounds.height,
      });
      return next.x === position.x && next.y === position.y ? position : next;
    });
  }, []);

  useEffect(() => {
    if (!activePlugin) return;
    const workspace = workspaceRef.current;
    const pluginWindow = pluginWindowRef.current;
    if (!workspace || !pluginWindow) return;
    const observer = new ResizeObserver(clampPluginWindowToWorkspace);
    observer.observe(workspace);
    observer.observe(pluginWindow);
    window.addEventListener('resize', clampPluginWindowToWorkspace);
    const frame = window.requestAnimationFrame(clampPluginWindowToWorkspace);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', clampPluginWindowToWorkspace);
      observer.disconnect();
    };
  }, [activePlugin, clampPluginWindowToWorkspace, pluginWindowMinimized]);

  // #WDD-gpt  2026-08-15 - 插件对话框以标题栏捕获指针并限制在视口内，避免拖动后窗口丢失。
  const beginPluginWindowDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pluginDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: pluginWindowPosition,
    };
  };

  const movePluginWindow = (event: React.PointerEvent<HTMLElement>) => {
    const drag = pluginDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
    const windowBounds = pluginWindowRef.current?.getBoundingClientRect();
    if (!workspaceBounds || !windowBounds) return;
    setPluginWindowPosition(clampPluginWindowPosition({
      position: {
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      },
      workspaceWidth: workspaceBounds.width,
      workspaceHeight: workspaceBounds.height,
      windowWidth: windowBounds.width,
      windowHeight: windowBounds.height,
    }));
  };

  const endPluginWindowDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (pluginDragRef.current?.pointerId !== event.pointerId) return;
    pluginDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // #WDD-gpt 2026-08-16 - 延后一轮再撤销 Blob URL，避免 Chromium 在下载任务真正读取前看到已失效地址。
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const commitExportBlob = async (
    blob: Blob,
    filename: string,
    fileHandle: FileSystemFileHandle | null = null,
  ) => {
    if (fileHandle) {
      await writeBlobToFileHandle(fileHandle, blob);
      return;
    }
    downloadBlob(blob, filename);
  };

  const openExportCenter = () => {
    setOpenMenu(null);
    setIsPlaying(false);
    if (sourceFiles.length === 0 || status.splatCount <= 0) {
      showAppNotice(
        language === 'zh' ? '当前场景没有可导出的高斯数据，请先导入场景。' : 'The scene has no Gaussian data to export. Import a scene first.',
        language === 'zh' ? '场景为空' : 'Empty scene',
        'warning',
      );
      return;
    }
    setExportCenterVisible(true);
  };

  // #WDD-gpt  2026-08-16 - RAW4D 保存时根据软删除位集输出压实文件；编辑中的源数据保持稳定 ID。
  const exportWorkspace = async (forceFourCgsReencode = false) => {
    setOpenMenu(null);
    // #WDD-gpt 2026-08-17 - 所有场景文件导出在读取当前帧数据前先暂停，避免编码期间时间轴继续变化。
    setIsPlaying(false);
    // #WDD-gpt 2026-08-17 - 空场景在任何文件选择或编码分支前终止，避免下载没有实际高斯内容的工作区 JSON。
    if (sourceFiles.length === 0 || status.splatCount <= 0) {
      showAppNotice(
        language === 'zh'
          ? '当前场景没有可导出的高斯数据，请先从相册或本地文件导入场景。'
          : 'The scene has no Gaussian data to export. Open a gallery item or import a local file first.',
        language === 'zh' ? '场景为空' : 'Empty scene',
        'warning',
      );
      return;
    }
    const canonicalDataDirty = viewportRuntime?.hasCanonicalGaussianDataChanges() ?? false;
    const exportsFourCgs = supportsFourCgsSceneExport(status.format ?? '');
    let fourCgsFileHandle: FileSystemFileHandle | null = null;
    if (exportsFourCgs) {
      if (status.format === '4CGS' && !forceFourCgsReencode && !canonicalDataDirty && !sourceFile) {
        showAppNotice(
          language === 'zh' ? '当前 4CGS 场景缺少可保存的源文件。' : 'The current 4CGS scene has no source file to save.',
          language === 'zh' ? '无法导出 4CGS' : 'Cannot export 4CGS',
        );
        return;
      }
      if (status.format === '4CGS' && !forceFourCgsReencode && !canonicalDataDirty && (viewportRuntime?.getGaussianDeletionCount() ?? 0) > 0) {
        showAppNotice(
          language === 'zh'
            ? '4CGS V2.4 前端当前采用只读压缩载荷。请撤销高斯删除后再无损另存；不会静默丢弃编辑。'
            : 'The current 4CGS V2.4 payload is read-only in the browser. Undo Gaussian deletions before saving; edits will not be discarded silently.',
          language === 'zh' ? '当前编辑无法写入' : 'Current edits cannot be saved',
          'warning',
        );
        return;
      }
      if (typeof window.showSaveFilePicker !== 'function') {
        showAppNotice(
          language === 'zh'
            ? '当前浏览器不支持 4CGS“另存为”文件授权，请使用最新版 Chrome 或 Edge。'
            : 'This browser does not support the 4CGS save-as file permission flow. Use a recent Chrome or Edge release.',
          language === 'zh' ? '浏览器不支持选择保存位置' : 'Save location picker unavailable',
          'warning',
        );
        return;
      }
      const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.(?:4cgs|4gs|raw4d|ply4)$/i, '');
      try {
        // #WDD-gpt 2026-08-17 - 4CGS 是单文件，使用另存为窗口选择目录和文件名，而非申请整个目录权限。
        fourCgsFileHandle = await window.showSaveFilePicker(createFourCgsSavePickerOptions(`${stem}.4cgs`));
      } catch (error) {
        if (isFilePickerAbort(error)) return;
        showAppError(error, '4cgs-save-permission', () => { void exportWorkspace(forceFourCgsReencode); });
        return;
      }
    }
    if (((status.format === 'RAW4D' || status.format === 'PLY4' || status.format === '4GS') && sourceFiles.length > 0)
      // #WDD-gpt 2026-09-07 - 导出中心明确选择 V2.6 时强制重编码，避免把未编辑的 RAW4D ZIP 原样误当成 V2.6 输出。
      || (status.format === '4CGS' && (canonicalDataDirty || forceFourCgsReencode))) {
      // #WDD-gpt 2026-08-16 - RAW4D 默认导出冻结当前 Canonical RAM 与编辑位集，不再回读拖入时的 File 属性载荷。
      const controller = new AbortController();
      exportAbortRef.current = controller;
      exportStartedAtRef.current = performance.now();
      setExportElapsedMs(0);
      setExportProgress(0);
      setExportMonitor({
        kind: 'fourcgs',
        phase: 'running',
        inputBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
        progress: {
          ratio: 0, message: `正在冻结 ${sourceFiles.length} 个 Canonical RAM 片段`,
          stage: '内存快照', stageRatio: 0, workerCount: 1, completedTasks: 0, totalTasks: 8,
        },
        logs: [{ elapsedMs: 0, message: '开始从当前内存生成 4CGS' }],
      });
      try {
        if (!viewportRuntime) throw new Error('视口编辑状态尚未就绪。');
        // #WDD-gpt 2026-08-17 - 4CGS 原点烘焙后必须从已修改 Canonical RAM 重编码；未修改容器仍保留下面的无损快速另存路径。
        const memorySnapshots = status.format === '4CGS' || status.format === '4GS'
          ? viewportRuntime.snapshotResidentSequenceExportMemory()
          : viewportRuntime.snapshotRaw4DExportMemory(sourceFiles);
        const result = await encodeRaw4DMemoryAsFourCgs(memorySnapshots, (progress) => {
          setExportProgress(progress.ratio);
          setExportMonitor((current) => {
            if (!current || current.phase !== 'running') return current;
            const elapsedMs = performance.now() - exportStartedAtRef.current;
            const previousMessage = current.logs.at(-1)?.message;
            const logs = previousMessage === progress.message
              ? current.logs
              : [...current.logs, { elapsedMs, message: progress.message }].slice(-12);
            return { ...current, progress, logs };
          });
        }, controller.signal);
        setExportProgress(0.98);
        setExportMonitor((current) => current ? {
          ...current,
          progress: {
            ratio: 0.98, message: '正在写入场景变换并提交到所选 4CGS 文件', stage: '最终文件提交',
            stageRatio: 0.5, workerCount: result.encodeTimings?.workerCount ?? 1,
            completedTasks: 8, totalTasks: 8,
          },
          logs: [...current.logs, {
            elapsedMs: performance.now() - exportStartedAtRef.current,
            message: '压缩载荷完成，正在写入场景元数据',
          }].slice(-12),
        } : current);
        const blob = await writeFourCgsFile(result.blob, sceneTransform, cameraBookmarks);
        if (controller.signal.aborted) throw new DOMException('4CGS 保存已取消。', 'AbortError');
        setExportProgress(1);
        const outputFilename = fourCgsFileHandle?.name ?? result.filename;
        await commitExportBlob(blob, result.filename, fourCgsFileHandle);
        setExportElapsedMs(performance.now() - exportStartedAtRef.current);
        setExportMonitor((current) => current ? {
          ...current,
          phase: 'success', result, outputBytes: blob.size,
          progress: {
            ratio: 1, message: `已生成并保存 ${outputFilename}`, stage: '完成', stageRatio: 1,
            workerCount: result.encodeTimings?.workerCount ?? current.progress.workerCount,
            completedTasks: 8, totalTasks: 8,
          },
          logs: [...current.logs, {
            elapsedMs: performance.now() - exportStartedAtRef.current,
            message: `完成 · ${(blob.size / 1_000_000).toFixed(3)}M · ${result.compressionRatio.toFixed(2)}×`,
          }].slice(-12),
        } : current);
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === 'AbortError';
        const message = cancelled ? '4CGS 保存已取消。' : error instanceof Error ? error.message : String(error);
        // #WDD-gpt 2026-08-16 - 大文件编码错误和取消原因保留在监督框，避免弹窗被浏览器策略吞掉。
        setExportElapsedMs(performance.now() - exportStartedAtRef.current);
        setExportMonitor((current) => current ? {
          ...current,
          phase: cancelled ? 'cancelled' : 'error', error: message,
          progress: { ...current.progress, message, stage: cancelled ? '已取消' : '失败' },
          logs: [...current.logs, {
            elapsedMs: performance.now() - exportStartedAtRef.current,
            message,
          }].slice(-12),
        } : current);
      } finally {
        if (exportAbortRef.current === controller) exportAbortRef.current = null;
        setExportProgress(null);
      }
      return;
    }
    if (status.format === '4CGS') {
      if (!sourceFile) return;
      setExportProgress(0.05);
      try {
        // #WDD-gpt 2026-09-07 - RAW4D ZIP 版 4CGS 未编辑时原样另存；旧二进制容器仍更新其内嵌变换与书签元数据。
        const blob = status.fourCgsContainer === 'raw4d-zip'
          ? sourceFile
          : await writeFourCgsFile(sourceFile, sceneTransform, cameraBookmarks);
        setExportProgress(1);
        const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.4cgs$/i, '');
        await commitExportBlob(blob, `${stem}.4cgs`, fourCgsFileHandle);
      } catch (error) {
        showAppError(error, '4cgs-export', () => { void exportWorkspace(); });
      } finally {
        setExportProgress(null);
      }
      return;
    }
    if (status.format && status.format !== 'Procedural' && viewportRuntime) {
      setExportProgress(0);
      try {
        const blob = await viewportRuntime.exportCompactedRaw4D((progress) => setExportProgress(progress.ratio));
        const preservePly4Extension = sourceFiles.length === 1 && /\.ply4$/i.test(sourceFiles[0].name);
        const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.(?:raw4d|ply4)$/i, '');
        downloadBlob(blob, `${stem}.${preservePly4Extension ? 'ply4' : 'raw4d'}`);
      } catch (error) {
        showAppError(error, 'scene-export', () => { void exportWorkspace(); });
      } finally {
        setExportProgress(null);
      }
      return;
    }
    const payload = {
      application: 'Dong Editor 3',
      scene: displaySceneName,
      renderer: status.renderer,
      renderMode,
      transform: sceneTransform,
      objects: [
        ...(status.format && status.format !== 'Procedural' ? [{
          name: status.objectName ?? copy.gaussianProperties,
          type: status.format,
          splatCount: status.splatCount,
        }] : []),
        ...(gs2MeshState.stage === 'success' ? [{
          name: `GS2Mesh Frame ${gs2MeshState.frame ?? currentFrame}`,
          type: 'Triangle Mesh',
          vertexCount: gs2MeshState.vertexCount,
          triangleCount: gs2MeshState.triangleCount,
        }] : []),
        { name: 'Grid & Axes', type: 'Scene Guides' },
      ],
    };
    const workspaceBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlob(workspaceBlob, 'dong-editor-3-workspace.json');
  };

  // #WDD-gpt 2026-09-07 - 新 4CGS ZIP 逐段压实 RAW4D 并直接流入单个已授权文件，避免大序列整包驻留 JS 内存。
  const exportFourCgsRaw4DZip = async () => {
    setOpenMenu(null);
    setIsPlaying(false);
    const runtime = viewportRuntime;
    const segments = status.raw4dSequence?.segments ?? [];
    if (!runtime || segments.length < 2) {
      showAppNotice(
        language === 'zh' ? 'RAW4D ZIP 版 4CGS 至少需要两个已驻留的时序片段。' : 'A RAW4D ZIP 4CGS requires at least two resident timeline segments.',
        language === 'zh' ? '无法导出 4CGS ZIP' : 'Cannot export 4CGS ZIP',
        'warning',
      );
      return;
    }
    if (typeof window.showSaveFilePicker !== 'function') {
      showAppNotice(
        language === 'zh' ? '当前浏览器不支持 4CGS ZIP 流式另存，请使用最新版 Chrome 或 Edge。' : 'This browser cannot stream a 4CGS ZIP to a save handle. Use a recent Chrome or Edge release.',
        language === 'zh' ? '浏览器不支持选择保存位置' : 'Save location picker unavailable',
        'warning',
      );
      return;
    }
    const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.(?:4cgs|4gs|raw4d|ply4)$/i, '');
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker(createFourCgsSavePickerOptions(`${stem}.4cgs`));
    } catch (error) {
      if (isFilePickerAbort(error)) return;
      showAppError(error, '4cgs-zip-save-permission', () => { void exportFourCgsRaw4DZip(); });
      return;
    }

    const outputNames = uniqueRaw4DExportFilenames(segments.map((segment) => segment.name));
    const controller = new AbortController();
    exportAbortRef.current = controller;
    exportStartedAtRef.current = performance.now();
    setExportElapsedMs(0);
    setExportProgress(0);
    setExportMonitor({
      kind: 'fourcgs-raw4d-zip',
      phase: 'running',
      inputBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
      progress: {
        ratio: 0, message: `准备写入 ${outputNames.length} 个 RAW4D ZIP 条目`, stage: 'ZIP 初始化',
        stageRatio: 0, workerCount: 1, completedTasks: 0, totalTasks: outputNames.length,
      },
      raw4DStats: {
        completedFiles: 0,
        fileCount: outputNames.length,
        pointCount: 0,
        sourcePreservedCount: 0,
      },
      logs: [{ elapsedMs: 0, message: `开始流式写入 ${handle.name}` }],
    });

    let writable: FileSystemWritableFileStream | null = null;
    let writer: FourCgsRaw4DZipWriter | null = null;
    try {
      writable = await handle.createWritable();
      const output = writable;
      writer = new FourCgsRaw4DZipWriter(async (chunk) => {
        await output.write(chunk.slice().buffer as ArrayBuffer);
      });
      const result = await runtime.exportCompactedRaw4DSegments(outputNames, {
        signal: controller.signal,
        onProgress: (progress) => {
          setExportProgress(progress.ratio);
          setExportMonitor((current) => {
            if (!current || current.kind !== 'fourcgs-raw4d-zip' || current.phase !== 'running') return current;
            const message = progress.stage === 'encoding'
              ? `正在压实 ${progress.segmentIndex + 1}/${progress.segmentCount} · ${progress.filename}`
              : progress.stage === 'writing'
                ? `正在写入 ZIP · ${progress.filename}`
                : `ZIP 条目完成 · ${progress.filename}`;
            const elapsedMs = performance.now() - exportStartedAtRef.current;
            return {
              ...current,
              progress: {
                ratio: progress.ratio,
                message,
                stage: progress.stage === 'encoding' ? 'RAW4D 压实' : 'ZIP 流式写入',
                stageRatio: progress.segmentRatio,
                workerCount: 1,
                completedTasks: progress.completedSegments,
                totalTasks: progress.segmentCount,
              },
              raw4DStats: {
                completedFiles: progress.completedSegments,
                fileCount: progress.segmentCount,
                pointCount: current.raw4DStats?.pointCount ?? 0,
                sourcePreservedCount: current.raw4DStats?.sourcePreservedCount ?? 0,
              },
              logs: current.logs.at(-1)?.message === message
                ? current.logs
                : [...current.logs, { elapsedMs, message }].slice(-12),
            };
          });
        },
        writeSegment: async (file) => {
          if (!writer) throw new Error('4CGS ZIP writer is unavailable.');
          await writer.addRaw4D(file.filename, file.blob, controller.signal);
        },
      });
      const archive = await writer.close();
      await writable.close();
      writable = null;
      setExportProgress(1);
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: 'success',
        outputBytes: archive.outputBytes,
        progress: {
          ratio: 1, message: `已保存 ${handle.name}`, stage: '完成', stageRatio: 1,
          workerCount: 1, completedTasks: archive.fileCount, totalTasks: archive.fileCount,
        },
        raw4DStats: {
          completedFiles: archive.fileCount,
          fileCount: archive.fileCount,
          pointCount: result.pointCount,
          sourcePreservedCount: result.sourcePreservedCount,
        },
        logs: [...current.logs, {
          elapsedMs: performance.now() - exportStartedAtRef.current,
          message: `完成 · ${archive.fileCount} 个 RAW4D · ${(archive.outputBytes / 1_000_000).toFixed(3)}M`,
        }].slice(-12),
      } : current);
    } catch (error) {
      writer?.terminate();
      if (writable) {
        try {
          await writable.abort(error);
        } catch {
          // 原始导出错误优先；浏览器可能已经关闭失败的写入流。
        }
      }
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      const message = cancelled ? '4CGS RAW4D ZIP 保存已取消。' : error instanceof Error ? error.message : String(error);
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: cancelled ? 'cancelled' : 'error',
        error: message,
        progress: { ...current.progress, message, stage: cancelled ? '已取消' : '失败' },
        logs: [...current.logs, { elapsedMs: performance.now() - exportStartedAtRef.current, message }].slice(-12),
      } : current);
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      setExportProgress(null);
    }
  };

  type Raw4DExportDestination =
    | { readonly kind: 'file'; readonly handle: FileSystemFileHandle }
    | { readonly kind: 'directory'; readonly handle: FileSystemDirectoryHandle };

  // #WDD-gpt 2026-09-07 - 单段 RAW4D 使用另存为，多段则逐段写入同一授权目录；每个 Blob 提交后即可释放。
  const runRaw4DExport = async (runtime: ViewportRuntime, destination: Raw4DExportDestination) => {
    const sourceNames = status.raw4dSequence?.segments.map((segment) => segment.name)
      ?? (sourceFiles.length > 0 ? sourceFiles.map((file) => file.name) : [status.sourceName ?? 'segment.raw4d']);
    const outputNames = destination.kind === 'file'
      ? [destination.handle.name]
      : uniqueRaw4DExportFilenames(sourceNames);
    const controller = new AbortController();
    exportAbortRef.current = controller;
    exportStartedAtRef.current = performance.now();
    setExportElapsedMs(0);
    setExportProgress(0);
    setExportMonitor({
      kind: 'raw4d',
      phase: 'running',
      inputBytes: sourceFiles.reduce((sum, file) => sum + file.size, 0),
      progress: {
        ratio: 0,
        message: language === 'zh'
          ? `准备导出 ${outputNames.length} 个 RAW4D 片段`
          : `Preparing ${outputNames.length} RAW4D segment export${outputNames.length === 1 ? '' : 's'}`,
        stage: language === 'zh' ? '内存快照' : 'Memory snapshot',
        stageRatio: 0,
        workerCount: 1,
        completedTasks: 0,
        totalTasks: outputNames.length,
      },
      raw4DStats: {
        completedFiles: 0,
        fileCount: outputNames.length,
        pointCount: 0,
        sourcePreservedCount: 0,
      },
      logs: [{
        elapsedMs: 0,
        message: destination.kind === 'file'
          ? (language === 'zh' ? `开始保存 ${destination.handle.name}` : `Saving ${destination.handle.name}`)
          : (language === 'zh' ? `开始向目录 ${destination.handle.name} 写入 ${outputNames.length} 个片段` : `Writing ${outputNames.length} segments to ${destination.handle.name}`),
      }],
    });
    try {
      const result = await runtime.exportCompactedRaw4DSegments(outputNames, {
        signal: controller.signal,
        onProgress: (progress) => {
          const message = progress.stage === 'encoding'
            ? (language === 'zh'
                ? `正在压实片段 ${progress.segmentIndex + 1}/${progress.segmentCount} · ${progress.filename}`
                : `Compacting segment ${progress.segmentIndex + 1}/${progress.segmentCount} · ${progress.filename}`)
            : progress.stage === 'writing'
              ? (language === 'zh' ? `正在写入 ${progress.filename}` : `Writing ${progress.filename}`)
              : (language === 'zh' ? `已写入 ${progress.filename}` : `Wrote ${progress.filename}`);
          setExportProgress(progress.ratio);
          setExportMonitor((current) => {
            if (!current || current.kind !== 'raw4d' || current.phase !== 'running') return current;
            const elapsedMs = performance.now() - exportStartedAtRef.current;
            const logs = current.logs.at(-1)?.message === message
              ? current.logs
              : [...current.logs, { elapsedMs, message }].slice(-12);
            return {
              ...current,
              progress: {
                ratio: progress.ratio,
                message,
                stage: progress.stage === 'encoding'
                  ? (language === 'zh' ? 'RAW4D 压实' : 'RAW4D compaction')
                  : progress.stage === 'writing'
                    ? (language === 'zh' ? '文件写入' : 'File write')
                    : (language === 'zh' ? '片段完成' : 'Segment complete'),
                stageRatio: progress.segmentRatio,
                workerCount: 1,
                completedTasks: progress.completedSegments,
                totalTasks: progress.segmentCount,
              },
              raw4DStats: {
                completedFiles: progress.completedSegments,
                fileCount: progress.segmentCount,
                pointCount: current.raw4DStats?.pointCount ?? 0,
                sourcePreservedCount: current.raw4DStats?.sourcePreservedCount ?? 0,
              },
              logs,
            };
          });
        },
        writeSegment: async (file) => {
          if (controller.signal.aborted) throw new DOMException('RAW4D export was cancelled.', 'AbortError');
          if (destination.kind === 'file') await writeBlobToFileHandle(destination.handle, file.blob);
          else await writeRaw4DBlobToDirectory(destination.handle, file.filename, file.blob);
          if (controller.signal.aborted) throw new DOMException('RAW4D export was cancelled.', 'AbortError');
        },
      });
      setExportProgress(1);
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: 'success',
        outputBytes: result.outputBytes,
        raw4DStats: {
          completedFiles: result.fileCount,
          fileCount: result.fileCount,
          pointCount: result.pointCount,
          sourcePreservedCount: result.sourcePreservedCount,
        },
        progress: {
          ratio: 1,
          message: language === 'zh'
            ? `已保存 ${result.fileCount} 个 RAW4D 文件`
            : `Saved ${result.fileCount} RAW4D file${result.fileCount === 1 ? '' : 's'}`,
          stage: language === 'zh' ? '完成' : 'Complete',
          stageRatio: 1,
          workerCount: 1,
          completedTasks: result.fileCount,
          totalTasks: result.fileCount,
        },
        logs: [...current.logs, {
          elapsedMs: performance.now() - exportStartedAtRef.current,
          message: language === 'zh'
            ? `完成 · ${result.fileCount} 个文件 · ${result.pointCount.toLocaleString('zh-CN')} 点 · ${(result.outputBytes / 1_000_000).toFixed(3)}M`
            : `Complete · ${result.fileCount} files · ${result.pointCount.toLocaleString('en-US')} points · ${(result.outputBytes / 1_000_000).toFixed(3)}M`,
        }].slice(-12),
      } : current);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      const message = cancelled
        ? (language === 'zh' ? 'RAW4D 导出已取消。已完成写入的文件会保留。' : 'RAW4D export was cancelled. Completed files remain in the destination.')
        : error instanceof Error ? error.message : String(error);
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: cancelled ? 'cancelled' : 'error',
        error: message,
        progress: { ...current.progress, message, stage: cancelled ? (language === 'zh' ? '已取消' : 'Cancelled') : (language === 'zh' ? '失败' : 'Failed') },
        logs: [...current.logs, { elapsedMs: performance.now() - exportStartedAtRef.current, message }].slice(-12),
      } : current);
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      setExportProgress(null);
    }
  };

  const exportRaw4DSegments = async () => {
    setOpenMenu(null);
    setIsPlaying(false);
    const runtime = viewportRuntime;
    if (!runtime || !supportsRaw4DSceneExport(status.format ?? '')) {
      showAppNotice(
        language === 'zh' ? '当前场景没有可导出的 RAW4D 时序数据。' : 'The current scene has no RAW4D timeline data to export.',
        language === 'zh' ? '无法导出 RAW4D' : 'Cannot export RAW4D',
        'warning',
      );
      return;
    }
    const segmentNames = status.raw4dSequence?.segments.map((segment) => segment.name)
      ?? (sourceFiles.length > 0 ? sourceFiles.map((file) => file.name) : [status.sourceName ?? 'segment.raw4d']);
    if (segmentNames.length > 1) {
      if (typeof window.showDirectoryPicker !== 'function') {
        showAppNotice(
          language === 'zh'
            ? '多段 RAW4D 导出需要浏览器目录写入能力，请使用最新版 Chrome 或 Edge。'
            : 'Multi-segment RAW4D export requires directory write access. Use a recent Chrome or Edge release.',
          language === 'zh' ? '浏览器不支持多文件写入' : 'Multi-file writing unavailable',
          'warning',
        );
        return;
      }
      setRaw4DDirectoryError(null);
      setRaw4DDirectoryDialogVisible(true);
      return;
    }
    if (typeof window.showSaveFilePicker !== 'function') {
      showAppNotice(
        language === 'zh'
          ? '当前浏览器不支持 RAW4D“另存为”文件授权，请使用最新版 Chrome 或 Edge。'
          : 'This browser does not support RAW4D save-as permission. Use a recent Chrome or Edge release.',
        language === 'zh' ? '浏览器不支持选择保存位置' : 'Save location picker unavailable',
        'warning',
      );
      return;
    }
    const suggestedName = uniqueRaw4DExportFilenames(segmentNames)[0];
    let handle: FileSystemFileHandle;
    try {
      handle = await window.showSaveFilePicker(createRaw4DSavePickerOptions(suggestedName));
    } catch (error) {
      if (isFilePickerAbort(error)) return;
      showAppError(error, 'raw4d-save-permission', () => { void exportRaw4DSegments(); });
      return;
    }
    await runRaw4DExport(runtime, { kind: 'file', handle });
  };

  const chooseRaw4DDirectory = async () => {
    const runtime = viewportRuntime;
    if (!runtime || typeof window.showDirectoryPicker !== 'function' || raw4DDirectoryPicking) return;
    setRaw4DDirectoryPicking(true);
    setRaw4DDirectoryError(null);
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await window.showDirectoryPicker(RAW4D_SEGMENTS_DIRECTORY_PICKER_OPTIONS);
    } catch (error) {
      if (isDirectoryPickerAbort(error)) {
        setRaw4DDirectoryError(language === 'zh'
          ? '尚未选择输出目录。请在“下载”中新建或进入一个专用子文件夹后再选择。'
          : 'No output folder was selected. Create or enter a dedicated subfolder inside Downloads, then choose it.');
      } else {
        setRaw4DDirectoryError(language === 'zh'
          ? `无法使用所选目录：${error instanceof Error ? error.message : String(error)}`
          : `The selected folder cannot be used: ${error instanceof Error ? error.message : String(error)}`);
      }
      setRaw4DDirectoryPicking(false);
      return;
    }
    setRaw4DDirectoryPicking(false);
    setRaw4DDirectoryDialogVisible(false);
    await runRaw4DExport(runtime, { kind: 'directory', handle: directory });
  };

  // #WDD-gpt 2026-08-17 - 文件菜单导出子菜单的 .ply 序列：获准目录后逐帧直写，不再打包 ZIP。
  const runPlySequenceExport = async (runtime: ViewportRuntime, directory: FileSystemDirectoryHandle) => {
    const controller = new AbortController();
    exportAbortRef.current = controller;
    exportStartedAtRef.current = performance.now();
    setExportElapsedMs(0);
    setExportProgress(0);
    setExportMonitor({
      kind: 'ply-sequence',
      phase: 'running',
      inputBytes: 0,
      progress: {
        ratio: 0, message: `正在冻结 Canonical RAM 片段并规划时间轴，目标目录 ${directory.name}`,
        stage: '内存快照', stageRatio: 0, workerCount: 1, completedTasks: 0, totalTasks: 1,
      },
      logs: [{ elapsedMs: 0, message: `开始向目录 ${directory.name} 导出 .ply 序列` }],
    });
    try {
      const sources = runtime.snapshotResidentSequenceExportMemory();
      const result = await exportRaw4DSequenceAsPlyDirectory(sources, directory, (progress) => {
        setExportProgress(progress.ratio);
        setExportMonitor((current) => {
          if (!current || current.phase !== 'running' || current.kind !== 'ply-sequence') return current;
          const elapsedMs = performance.now() - exportStartedAtRef.current;
          const previousMessage = current.logs.at(-1)?.message;
          const logs = previousMessage === progress.message
            ? current.logs
            : [...current.logs, { elapsedMs, message: progress.message }].slice(-12);
          return {
            ...current,
            progress: {
              ratio: progress.ratio,
              message: progress.message,
              stage: '帧写入',
              stageRatio: progress.ratio,
              workerCount: 1,
              completedTasks: progress.frameIndex,
              totalTasks: progress.frameCount,
            },
            logs,
          };
        });
      }, controller.signal);
      setExportProgress(1);
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: 'success',
        plyStats: result.stats,
        outputBytes: result.stats.outputBytes,
        progress: {
          ratio: 1, message: `已写入 ${result.stats.frameCount} 个 .ply 文件到 ${result.directoryName}/`,
          stage: '完成', stageRatio: 1, workerCount: 1,
          completedTasks: result.stats.frameCount, totalTasks: result.stats.frameCount,
        },
        logs: [...current.logs, {
          elapsedMs: performance.now() - exportStartedAtRef.current,
          message: `完成 · ${result.stats.frameCount} 帧 · ${(result.stats.outputBytes / 1_000_000).toFixed(3)}M`,
        }].slice(-12),
      } : current);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      const message = error instanceof Error ? error.message : String(error);
      // #WDD-gpt 2026-08-17 - 取消会终止 Worker，目录中可能保留已写入的部分帧文件。
      setExportElapsedMs(performance.now() - exportStartedAtRef.current);
      setExportMonitor((current) => current ? {
        ...current,
        phase: cancelled ? 'cancelled' : 'error',
        error: message,
        progress: {
          ...current.progress,
          message: cancelled ? `${message} 目录 ${directory.name}/ 中可能保留部分帧文件。` : message,
          stage: cancelled ? '已取消' : '失败',
        },
        logs: [...current.logs, {
          elapsedMs: performance.now() - exportStartedAtRef.current,
          message: cancelled ? `${message} 已写入的帧保留在目录中。` : message,
        }].slice(-12),
      } : current);
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      setExportProgress(null);
    }
  };

  const exportPlySequence = () => {
    setOpenMenu(null);
    // #WDD-gpt 2026-08-17 - 目录选择也属于导出流程，打开系统选择器前固定当前帧。
    setIsPlaying(false);
    if (!viewportRuntime || !status.format || status.format === 'Procedural') {
      showAppNotice(
        language === 'zh'
          ? '当前场景没有 RAW4D / 4CGS 序列数据，无法导出 .ply 序列。'
          : 'The current scene has no RAW4D / 4CGS sequence data to export as .ply frames.',
        language === 'zh' ? '无法导出 PLY 序列' : 'Cannot export PLY sequence',
      );
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      showAppNotice(
        language === 'zh'
          ? '当前浏览器不支持选择本地写入目录（需要 File System Access API，如 Chrome/Edge）。'
          : 'This browser does not support picking a local output directory (File System Access API).',
        language === 'zh' ? '浏览器不支持目录写入' : 'Directory writing unavailable',
        'warning',
      );
      return;
    }
    setPlyDirectoryError(null);
    setPlyDirectoryDialogVisible(true);
  };

  const choosePlySequenceDirectory = async () => {
    const runtime = viewportRuntime;
    if (!runtime || typeof window.showDirectoryPicker !== 'function' || plyDirectoryPicking) return;
    setPlyDirectoryPicking(true);
    setPlyDirectoryError(null);
    let directory: FileSystemDirectoryHandle;
    try {
      directory = await window.showDirectoryPicker(PLY_SEQUENCE_DIRECTORY_PICKER_OPTIONS);
    } catch (error) {
      if (isDirectoryPickerAbort(error)) {
        setPlyDirectoryError(language === 'zh'
          ? '尚未选择输出目录。如果浏览器提示“包含系统文件”，请在“下载”中新建并进入一个子文件夹后再选择。'
          : 'No output folder was selected. If the browser reports system files, create and enter a subfolder inside Downloads, then choose it.');
      } else {
        setPlyDirectoryError(language === 'zh'
          ? `无法使用所选目录：${error instanceof Error ? error.message : String(error)}`
          : `The selected folder cannot be used: ${error instanceof Error ? error.message : String(error)}`);
      }
      setPlyDirectoryPicking(false);
      return;
    }
    setPlyDirectoryPicking(false);
    setPlyDirectoryDialogVisible(false);
    await runPlySequenceExport(runtime, directory);
  };

  const exportGS2Mesh = () => {
    // #WDD-gpt 2026-08-17 - 插件内 Mesh PLY 导出与主文件导出保持一致，先暂停播放再下载当前结果。
    setIsPlaying(false);
    gs2MeshPluginRef.current?.exportLastResult();
  };

  const runExportTarget = (target: ExportTarget) => {
    setExportCenterVisible(false);
    if (target === 'ply-sequence') exportPlySequence();
    else if (target === 'raw4d') void exportRaw4DSegments();
    else if (target === 'fourcgs-raw4d-zip') void exportFourCgsRaw4DZip();
    else void exportWorkspace(true);
  };

  const cancelExport = () => exportAbortRef.current?.abort();

  const closeExportMonitor = () => {
    if (exportMonitor?.phase === 'running') return;
    setExportMonitor(null);
  };

  const openSourceFiles = (incoming: readonly File[]) => {
    const files = [...incoming];
    if (files.length === 0) return;
    const supported = files.every((file) => /\.(4cgs|4gs|raw4d|ply4|sog|ply)$/i.test(file.name));
    const validMultiRaw4D = files.length === 1 || files.every((file) => /\.(?:raw4d|ply4)$/i.test(file.name));
    if (!supported || !validMultiRaw4D) {
      setStatus({
        phase: 'error', renderer: copy.unsupportedFile, splatCount: 0,
        message: files.length > 1 ? copy.multiRaw4DOnlyMessage : copy.unsupportedFileMessage,
      });
      return;
    }
    if (viewportRuntime) gs2MeshPluginRef.current?.clear(viewportRuntime, setGS2MeshState);
    setSceneName(files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : `RAW4D × ${files.length}`);
    setSceneTransform(createInitialTransform());
    setSmartAlignmentState(INITIAL_SMART_ALIGNMENT_STATE);
    setGS2MeshState(INITIAL_GS2MESH_STATE);
    setRelightingState(INITIAL_RELIGHTING_STATE);
    setRelightingWorkflowStep('mesh');
    setSelectionState(INITIAL_VIEWPORT_SELECTION_STATE);
    setGS2MeshVisible(true);
    setGaussianVisible(true);
    setModelHealthReport(null);
    setOriginBakeDialogVisible(false);
    setOriginBakeProgress(null);
    setOriginBakeResult(null);
    setOriginBakeError(null);
    // #WDD-gpt 2026-08-19 - 打开任何新场景先清空书签；4CGS 解码完成后再以文件内三个槽位恢复。
    setCameraBookmarks([null, null, null]);
    semanticClassificationRef.current?.cancel();
    setSemanticClassificationState(INITIAL_SEMANTIC_CLASSIFICATION_STATE);
    setActiveGalleryId(null);
    setActivePlugin(null);
    setInspectorPanelVisible(!mobilePlayerMode);
    setInspectorTab('scene');
    setCurrentFrame(0);
    setIsPlaying(false);
    setLoopSortWaiting(false);
    loopRestartPendingRef.current = false;
    loopRestartRequestIdRef.current += 1;
    // #WDD-gpt 2026-08-16 - 即使文件名相同也建立新数组，保证再次拖入会取消旧导入并正式重开场景。
    setSourceFiles(files);
  };

  const openGalleryScene = async (
    item: FourCgsGalleryItem,
    onProgress: (ratio: number) => void,
  ) => {
    setIsPlaying(false);
    const file = await fetchFourCgsGalleryFile(item, onProgress);
    openSourceFiles([file]);
    setActiveGalleryId(item.id);
  };

  const openFourCgsGallery = () => {
    setOpenMenu(null);
    setIsPlaying(false);
    setFourCgsGalleryVisible(true);
  };

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    openSourceFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const hasDraggedFiles = (event: React.DragEvent): boolean => Array.from(event.dataTransfer.types).includes('Files');

  const handleFileDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  };

  const handleFileDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleFileDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (fileDragDepthRef.current === 0) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  };

  const handleFileDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    openSourceFiles(Array.from(event.dataTransfer.files));
  };

  const newWorkspace = () => {
    // #WDD-gpt 2026-08-17 - 新建工作区强制刷新当前地址，确保 Worker、WASM、GPU 与大型场景内存全部从浏览器层重新初始化。
    setOpenMenu(null);
    void clearWorkspaceDraft().finally(() => window.location.reload());
  };

  const runModelHealth = async (clean: boolean) => {
    if (!viewportRuntime || modelHealthBusy) return;
    setModelHealthBusy(true);
    try {
      const report = clean
        ? await viewportRuntime.cleanCompletelyInvisibleGaussians()
        : await viewportRuntime.analyzeModelHealth();
      setModelHealthReport(report);
    } catch (error) {
      showAppError(error, 'model-health', () => { void runModelHealth(clean); });
    } finally {
      setModelHealthBusy(false);
    }
  };

  const runSemanticClassification = (options: SemanticClassificationOptions) => {
    if (!viewportRuntime) return;
    setIsPlaying(false);
    if (inspectorTab === 'semantic') setInspectorTab('scene');
    void semanticClassificationRef.current?.classify(
      viewportRuntime,
      options,
      setSemanticClassificationState,
    );
  };

  const selectSemanticClass = (classId: number) => {
    if (!viewportRuntime) return;
    setIsPlaying(false);
    try {
      viewportRuntime.selectSemanticClass(classId);
      // #WDD-gpt 2026-08-27 - 分类结果只更新稳定 ID 选区，保留用户当前浏览、变换或选择工具，不再强制切换矩形选择。
    } catch (error) {
      showAppError(error, 'semantic-classification');
    }
  };

  const frameTimecode = useMemo(() => {
    const seconds = Math.floor(currentFrame / playbackFps);
    const frame = currentFrame % playbackFps;
    return `00:00:${seconds.toString().padStart(2, '0')}:${frame.toString().padStart(2, '0')}`;
  }, [currentFrame, playbackFps]);

  const frameDigits = Math.max(4, String(timelineEndFrame + 1).length);
  const sourceFrame = (status.raw4dSequence?.firstFrame ?? 0) + currentFrame;
  const frameCounter = `${copy.frameShort} [${String(currentFrame).padStart(frameDigits, '0')}] / ${copy.totalFramesShort} [${String(timelineEndFrame + 1).padStart(frameDigits, '0')}]${status.raw4dSequence ? ` · ${language === 'zh' ? '源帧' : 'Source'} [${String(sourceFrame).padStart(frameDigits, '0')}]` : ''}`;

  const focusScene = () => {
    setIsPlaying(false);
    viewportRuntime?.frameScene();
  };
  // #WDD-gpt 2026-08-19 - 快捷键与 Outliner 共用异步聚焦入口，使全局选择可在跨片段取数完成后再构图。
  const focusSelection = async () => {
    setIsPlaying(false);
    try {
      if (!viewportRuntime || await viewportRuntime.frameSelectedGaussians()) return;
      const global = selectionScope === 'global';
      showAppNotice(
        language === 'zh'
          ? (global ? '全局范围内没有选中的 Gaussian。' : '当前活动片段没有选中的 Gaussian。')
          : (global ? 'There are no selected Gaussians in the global scope.' : 'There are no selected Gaussians in the active segment.'),
        language === 'zh' ? '没有可聚焦的选择' : 'Nothing selected to focus',
        'warning',
      );
    } catch (error) {
      showAppError(error, language === 'zh' ? '聚焦选中失败' : 'Focus selection failed');
    }
  };
  const saveCameraBookmark = (index: number) => {
    const camera = viewportRuntime?.getCameraState();
    if (!camera) return;
    setCameraBookmarks((current) => current.map((bookmark, bookmarkIndex) => bookmarkIndex === index ? camera : bookmark));
  };
  const recallCameraBookmark = (index: number) => {
    const camera = cameraBookmarks[index];
    if (camera) viewportRuntime?.transitionCameraState(camera);
  };

  const timelineMarks = useMemo(
    () => [...new Set(Array.from({ length: 5 }, (_, index) => Math.round(timelineEndFrame * index / 4)))],
    [timelineEndFrame],
  );
  const timelineSegmentNodes = status.raw4dSequence?.segmentNodes ?? [];
  const timelineSegmentNodeSet = useMemo(() => new Set(timelineSegmentNodes), [timelineSegmentNodes]);
  const timelineKeyframes = useMemo(
    () => (status.raw4dSequence?.keyframes ?? []).filter((frame) => !timelineSegmentNodeSet.has(frame)),
    [status.raw4dSequence?.keyframes, timelineSegmentNodeSet],
  );
  const timelineSegments = status.raw4dSequence?.segments ?? [];
  const timelineKeyframeTracks = status.raw4dSequence?.keyframeTracks;
  const activeTimelineSegment = status.raw4dSequence
    ? timelineSegments[status.raw4dSequence.segmentIndex]
    : null;
  // #WDD-gpt 2026-08-21 - 直方图面板出现期间，镜头按键说明改由其开关栏承载，左下角独立提示条隐藏以免被面板压住。
  const histogramPanelVisible = !mobilePlayerMode && sourceFiles.length > 0 && status.phase === 'ready';

  return (
    <main
      className={`${sourceFiles.length === 0 ? 'studio-shell welcome-mode' : 'studio-shell'}${mobilePlayerMode ? ' mobile-player-mode' : ''}`}
      data-source-name={status.sourceName ?? ''}
      data-status-phase={status.phase}
      data-raw4d-segments={status.raw4dSequence?.segmentCount ?? 0}
      data-raw4d-permanent-tracks={status.raw4dSequence?.permanentTrackCount ?? 0}
      data-raw4d-sh-updates={status.raw4dSequence?.sharedShUpdateStateCount ?? 0}
      lang={language === 'zh' ? 'zh-CN' : 'en'}
      onClick={() => setOpenMenu(null)}
      onDragStart={(event) => {
        // #WDD-gpt 2026-08-16 - 文本编辑保留选字，但阻止浏览器把选中文字或输入框作为系统拖拽对象。
        if (isTextEntryTarget(event.target)) event.preventDefault();
      }}
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      <GlobalTooltipLayer />
      {fileDragActive && (
        <div aria-label={copy.dropFilesToOpen} className="file-drop-overlay" role="status">
          <div>
            <Icon name="folder" size={30} />
            <strong>{copy.dropFilesToOpen}</strong>
            <span>{copy.dropFilesHint}</span>
          </div>
        </div>
      )}
      <input
        accept=".4cgs,.4gs,.raw4d,.ply4,.sog,.ply"
        aria-label={copy.chooseImportFile}
        className="visually-hidden"
        onChange={handleFileSelection}
        ref={fileInputRef}
        multiple
        type="file"
      />
      <header className="topbar" data-camera-input-block>
        <div className="brand">
          <strong>Dong Editor 3</strong>
          {/* #WDD-gpt 2026-08-16 - 版本徽标同时作为更新信息入口，展示内容仍由 VERSION 与 CHANGELOG 两个发布文件自动驱动。 */}
          <button
            aria-expanded={releaseNotesVisible}
            aria-haspopup="dialog"
            aria-label={`${copy.releaseNotesTip} · v${__APP_VERSION__}`}
            className="app-version-badge has-tip"
            data-tip={copy.releaseNotesTip}
            onClick={(event) => {
              event.stopPropagation();
              setOpenMenu(null);
              setReleaseNotesVisible(true);
            }}
            type="button"
          >v{__APP_VERSION__}</button>
        </div>

        <nav aria-label={copy.mainMenu} className="menu-bar" onClick={(event) => event.stopPropagation()}>
          {!mobilePlayerMode && <div className="menu-anchor">
            <button className={openMenu === 'file' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'file')} type="button">{copy.file}</button>
            {openMenu === 'file' && (
              <div className="dropdown-menu">
                <button onClick={newWorkspace} type="button"><span>{copy.newWorkspace}</span></button>
                {/* #WDD-gpt 2026-08-16 - 文件菜单补齐与顶部按钮一致的导入、导出入口。 */}
                <button onClick={() => { setOpenMenu(null); fileInputRef.current?.click(); }} type="button"><span>{copy.import}</span></button>
                {/* #WDD-gpt 2026-08-18 - 文件菜单只保留一个导出中心入口，格式、范围和检查信息在统一对话框中选择。 */}
                <button disabled={exportProgress !== null} onClick={openExportCenter} type="button"><span>{copy.export}</span></button>
              </div>
            )}
          </div>}
          {!mobilePlayerMode && <div className="menu-anchor">
            <button className={openMenu === 'view' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'view')} type="button">{copy.view}</button>
            {openMenu === 'view' && (
              <div className="dropdown-menu">
                <button onClick={toggleInspectorPanel} type="button"><span>{copy.inspector}</span><b>{inspectorPanelVisible ? '✓' : ''}</b></button>
                <button onClick={() => setShowGrid((visible) => !visible)} type="button"><span>{copy.grid}</span><b>{showGrid ? '✓' : ''}</b></button>
                <button onClick={() => setShowAxes((visible) => !visible)} type="button"><span>{copy.axes}</span><b>{showAxes ? '✓' : ''}</b></button>
                <button onClick={() => setShowHeightRuler((visible) => !visible)} type="button"><span>{copy.heightRuler}</span><b>{showHeightRuler ? '✓' : ''}</b></button>
                <label className="view-background-color">
                  <span>{copy.backgroundColor}</span>
                  <span className="view-background-color-value">
                    <input
                      aria-label={copy.backgroundColorHex}
                      className="view-background-color-hex"
                      maxLength={7}
                      onChange={(event) => {
                        if (isViewportBackgroundColor(event.target.value)) {
                          setBackgroundColor(normalizeViewportBackgroundColor(event.target.value));
                        }
                      }}
                      spellCheck={false}
                      type="text"
                      value={backgroundColor.toUpperCase()}
                    />
                    <input
                      aria-label={copy.backgroundColorPicker}
                      onChange={(event) => setBackgroundColor(normalizeViewportBackgroundColor(event.target.value))}
                      title={copy.backgroundColorTip}
                      type="color"
                      value={backgroundColor}
                    />
                  </span>
                </label>
              </div>
            )}
          </div>}
          {/* #WDD-gpt 2026-08-17 - 相册作为主菜单一级入口展示，不再占用右侧快捷操作区或藏在文件子菜单。 */}
          <button className="menu-trigger" onClick={openFourCgsGallery} type="button">
            {language === 'zh' ? '相册' : 'Gallery'}
          </button>
          {!mobilePlayerMode && <div className="menu-anchor">
            <button
              aria-expanded={openMenu === 'plugins'}
              aria-haspopup="menu"
              className={openMenu === 'plugins' ? 'menu-trigger active' : 'menu-trigger'}
              onClick={(event) => toggleMenu(event, 'plugins')}
              type="button"
            >
              {copy.plugins}
            </button>
            {openMenu === 'plugins' && (
              <div aria-label={copy.pluginMenu} className="dropdown-menu plugin-dropdown" role="menu">
                <div className="plugin-menu-heading">
                  <span>{copy.pluginMenu}</span>
                  <b>{pluginMenuItems.length}</b>
                </div>
                <div className="plugin-menu-list">
                  {pluginMenuItems.map((plugin) => {
                    const tone = pluginStatusById[plugin.id];
                    return (
                      <button
                        className={`plugin-menu-card ${tone}`}
                        key={plugin.id}
                        onClick={() => openPluginWorkspace(plugin.id)}
                        role="menuitem"
                        type="button"
                      >
                        <span aria-hidden="true" className="plugin-menu-mark">{plugin.mark}</span>
                        <span className="plugin-menu-copy">
                          <strong>{copy[plugin.titleKey]}</strong>
                          <small>{copy[plugin.descriptionKey]}</small>
                        </span>
                        <span className="plugin-menu-status"><i />{copy[pluginStatusLabelKeys[tone]]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>}
        </nav>

        {!mobilePlayerMode && <div aria-label={copy.editHistory} className="history-toolbar" onClick={(event) => event.stopPropagation()} role="toolbar">
          <button
            aria-label={copy.undo}
            className="has-tip"
            data-tip={`${copy.undo} · Ctrl/⌘ Z`}
            disabled={!historyState.canUndo}
            onClick={() => {
              viewportRuntime?.undo();
              setIsPlaying(false);
            }}
            type="button"
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            aria-label={copy.redo}
            className="has-tip"
            data-tip={`${copy.redo} · Ctrl/⌘ Shift Z`}
            disabled={!historyState.canRedo}
            onClick={() => {
              viewportRuntime?.redo();
              setIsPlaying(false);
            }}
            type="button"
          >
            <Icon name="redo" size={16} />
          </button>
        </div>}

        {!mobilePlayerMode && <div className="scene-document">
          <span className="status-dot cyan" />
          <strong>{displaySceneName}</strong>
          <span
            className={`unsaved-dot workspace-${workspaceSaveState} has-tip`}
            data-tip={workspaceSaveState === 'saved'
              ? (language === 'zh' ? '工作区已自动保存' : 'Workspace autosaved')
              : workspaceSaveState === 'saving'
                ? (language === 'zh' ? '正在自动保存' : 'Autosaving')
                : workspaceSaveState === 'recovery'
                  ? (language === 'zh' ? '存在可恢复工作区' : 'Recoverable workspace found')
                  : copy.unsaved}
          />
        </div>}

        {!mobilePlayerMode && <div className="top-actions">
          <div aria-label={copy.language} className="language-switch" role="group">
            <button aria-pressed={language === 'zh'} className="has-tip" data-tip={copy.chinese} onClick={() => setLanguage('zh')} type="button">中</button>
            <button aria-pressed={language === 'en'} className="has-tip" data-tip={copy.english} onClick={() => setLanguage('en')} type="button">EN</button>
          </div>
          <button className="quiet-button has-tip" data-tip={copy.chooseImportFile} onClick={() => fileInputRef.current?.click()} type="button">
            <Icon name="folder" />{copy.import}
          </button>
          <button className="primary-button has-tip" data-tip={copy.exportTip} disabled={exportProgress !== null} onClick={openExportCenter} type="button">
            <Icon name="export" />{exportProgress === null ? copy.export : `${copy.savingRaw4D} ${Math.round(exportProgress * 100)}%`}
          </button>
        </div>}
      </header>

      {releaseNotesVisible && (
        <ReleaseNotesDialog
          copy={copy}
          currentVersion={__APP_VERSION__}
          onClose={() => setReleaseNotesVisible(false)}
          releases={releaseNotes}
        />
      )}

      {appNotice && (
        <AppNoticeDialog
          confirmLabel={language === 'zh' ? '确定' : 'OK'}
          details={appNotice.details}
          message={appNotice.message}
          onClose={() => setAppNotice(null)}
          onRetry={appNotice.onRetry ? () => {
            const retry = appNotice.onRetry;
            setAppNotice(null);
            retry?.();
          } : undefined}
          retryLabel={appNotice.retryLabel}
          suggestion={appNotice.suggestion}
          title={appNotice.title}
          tone={appNotice.tone}
        />
      )}

      {exportCenterVisible && (
        <ExportCenterDialog
          deletedCount={statusDeletedCount}
          format={status.format ?? 'Scene'}
          frameCount={timelineEndFrame + 1}
          inputBytes={sourceFiles.reduce((sum, file) => sum + file.size, 0)}
          language={language}
          onClose={() => setExportCenterVisible(false)}
          onExport={runExportTarget}
          sceneName={displaySceneName}
          segmentCount={status.raw4dSequence?.segmentCount ?? 1}
          segments={status.raw4dSequence?.segments}
        />
      )}

      {fourCgsGalleryVisible && (
        <FourCgsGalleryDialog
          activeId={activeGalleryId}
          language={language}
          onClose={() => setFourCgsGalleryVisible(false)}
          onSelect={openGalleryScene}
        />
      )}

      {memoryPressureDialogVisible && (
        <MemoryPressureTestDialog
          availableBudgetBytes={Math.max(0, memoryPolicy.cpuBudgetBytes - memoryUsage.managedCpuBytes)}
          browserDeviceMemoryBytes={memoryUsage.browserDeviceMemoryBytes}
          copy={copy}
          currentResidentBytes={memoryUsage.managedCpuBytes}
          onClose={() => setMemoryPressureDialogVisible(false)}
          onComplete={setLastMemoryPressureResult}
        />
      )}

      {originBakeDialogVisible && (
        <div className="memory-confirm-backdrop origin-bake-backdrop" data-camera-input-block>
          <section aria-label={copy.bakeOriginDialogTitle} aria-modal="true" className="memory-confirm-dialog origin-bake-dialog" role="dialog">
            <header>
              <span>{copy.bakeOriginKicker}</span>
              <strong>{originBakeResult ? copy.bakeOriginComplete : copy.bakeOriginDialogTitle}</strong>
              <p>{copy.bakeOriginDialogDescription}</p>
            </header>
            <dl>
              <div><dt>{copy.bakeOriginPositionRule}</dt><dd>{copy.bakeOriginAllKeys}</dd></div>
              <div><dt>{copy.bakeOriginCovarianceRule}</dt><dd>{copy.bakeOriginAllKeys}</dd></div>
              <div><dt>{copy.bakeOriginShRule}</dt><dd>{sceneRotationIsIdentity ? copy.bakeOriginNoRotation : copy.bakeOriginShSynchronized}</dd></div>
            </dl>
            {!sceneScaleIsUniform && !originBakeResult && (
              <p className="memory-confirm-warning origin-bake-blocked">{copy.bakeOriginNonUniformWarning}</p>
            )}
            {sceneScaleIsUniform && !originBakeResult && !originBakeError && (
              <p className="memory-confirm-warning">{copy.bakeOriginWarning}</p>
            )}
            {originBakeError && <p className="memory-confirm-warning origin-bake-error">{originBakeError}</p>}
            {originBakeBusy && originBakeProgress && (
              <div className="origin-bake-progress">
                <div>
                  <span>{copy.bakeOriginRunning} · {originBakeProgress.stage === 'position' ? copy.position
                    : originBakeProgress.stage === 'rotation' ? copy.rotation
                      : originBakeProgress.stage === 'scale' ? copy.scale
                        : originBakeProgress.stage === 'sh' ? 'SH'
                          : originBakeProgress.stage === 'upload' ? 'GPU'
                            : copy.ready}</span>
                  <b>{Math.round(originBakeProgress.ratio * 100)}%</b>
                </div>
                <div aria-label={copy.bakeOriginRunning} className="origin-bake-progress-track" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(originBakeProgress.ratio * 100)}>
                  <i style={{ width: `${Math.max(0, Math.min(1, originBakeProgress.ratio)) * 100}%` }} />
                </div>
                <small>{copy.bakeOriginSegments} {originBakeProgress.segmentIndex + 1}/{originBakeProgress.segmentCount}</small>
              </div>
            )}
            {originBakeResult && (
              <dl className="origin-bake-result">
                <div><dt>{copy.bakeOriginSegments}</dt><dd>{originBakeResult.segmentCount}</dd></div>
                <div><dt>{copy.bakeOriginPoints}</dt><dd>{originBakeResult.pointCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
                <div><dt>SH</dt><dd>{originBakeResult.shRotated ? `SH${originBakeResult.shBands} ✓` : copy.bakeOriginNoRotation}</dd></div>
              </dl>
            )}
            <footer>
              {!originBakeResult && (
                <button className="quiet-button" disabled={originBakeBusy} onClick={() => setOriginBakeDialogVisible(false)} type="button">{copy.cancel}</button>
              )}
              {originBakeResult
                ? <button autoFocus className="primary-button" onClick={() => setOriginBakeDialogVisible(false)} type="button">{copy.bakeOriginClose}</button>
                : <button autoFocus className="primary-button" disabled={originBakeBusy || !sceneScaleIsUniform} onClick={() => void runOriginBake()} type="button">{originBakeBusy ? copy.bakeOriginRunning : copy.bakeOriginConfirm}</button>}
            </footer>
          </section>
        </div>
      )}

      {plyDirectoryDialogVisible && (
        <div className="memory-confirm-backdrop ply-directory-backdrop" data-camera-input-block>
          <section
            aria-label={language === 'zh' ? '选择 PLY 序列输出目录' : 'Choose PLY sequence output folder'}
            aria-modal="true"
            className="memory-confirm-dialog ply-directory-dialog"
            role="dialog"
          >
            <header>
              <span>PLY SEQUENCE · LOCAL FOLDER</span>
              <strong>{language === 'zh' ? '选择一个“下载”子文件夹' : 'Choose a Downloads subfolder'}</strong>
              <p>{language === 'zh'
                ? 'Chrome / Edge 为防止网页读取整个下载历史，会拒绝“下载”根目录的读写授权。序列导出必须使用其中的专用子文件夹。'
                : 'Chrome and Edge block read/write access to the Downloads root to protect the complete download history. Sequence export must use a dedicated subfolder.'}</p>
            </header>
            <div className="ply-directory-path" aria-label={language === 'zh' ? '推荐目录' : 'Recommended folder'}>
              <span>{language === 'zh' ? '下载' : 'Downloads'}</span>
              <b aria-hidden="true">/</b>
              <strong>DongEditor3-PLY</strong>
            </div>
            <ol className="ply-directory-steps">
              <li>{language === 'zh' ? '在即将打开的“下载”目录中新建或进入一个子文件夹。' : 'Create or enter a subfolder in the Downloads folder that opens.'}</li>
              <li>{language === 'zh' ? '进入该子文件夹后点击“选择文件夹”；不要选择“下载”本身。' : 'Enter that subfolder, then choose it; do not choose Downloads itself.'}</li>
            </ol>
            <p className="memory-confirm-warning">
              {language === 'zh'
                ? '浏览器安全限制无法由网页关闭。首次授权后，后续导出会记住这个专用目录。'
                : 'A webpage cannot disable this browser security rule. After approval, later exports remember this dedicated folder.'}
            </p>
            {plyDirectoryError && <p className="ply-directory-error" role="alert">{plyDirectoryError}</p>}
            <footer>
              <button
                className="quiet-button"
                disabled={plyDirectoryPicking}
                onClick={() => {
                  setPlyDirectoryDialogVisible(false);
                  setPlyDirectoryError(null);
                }}
                type="button"
              >{language === 'zh' ? '取消' : 'Cancel'}</button>
              <button
                autoFocus
                className="primary-button"
                disabled={plyDirectoryPicking}
                onClick={() => void choosePlySequenceDirectory()}
                type="button"
              >{plyDirectoryPicking
                  ? (language === 'zh' ? '正在打开…' : 'Opening…')
                  : (language === 'zh' ? '打开下载目录' : 'Open Downloads')}</button>
            </footer>
          </section>
        </div>
      )}

      {raw4DDirectoryDialogVisible && (
        <div className="memory-confirm-backdrop raw4d-directory-backdrop" data-camera-input-block>
          <section
            aria-label={language === 'zh' ? '选择 RAW4D 多片段输出目录' : 'Choose RAW4D segment output folder'}
            aria-modal="true"
            className="memory-confirm-dialog raw4d-directory-dialog"
            role="dialog"
          >
            <header>
              <span>RAW4D SEGMENTS · LOCAL FOLDER</span>
              <strong>{language === 'zh' ? '选择多片段输出文件夹' : 'Choose a segment output folder'}</strong>
              <p>{language === 'zh'
                ? `当前场景包含 ${status.raw4dSequence?.segmentCount ?? sourceFiles.length} 个片段。导出会保持每段的帧范围和文件边界，不会合并为一个 RAW4D。`
                : `This scene contains ${status.raw4dSequence?.segmentCount ?? sourceFiles.length} segments. Export keeps each frame range and file boundary instead of merging them.`}</p>
            </header>
            <div className="ply-directory-path" aria-label={language === 'zh' ? '推荐目录' : 'Recommended folder'}>
              <span>{language === 'zh' ? '下载' : 'Downloads'}</span>
              <b aria-hidden="true">/</b>
              <strong>DongEditor3-RAW4D</strong>
            </div>
            <ol className="ply-directory-steps">
              <li>{language === 'zh' ? '新建或进入一个专用子文件夹，然后点击“选择文件夹”。' : 'Create or enter a dedicated subfolder, then choose it.'}</li>
              <li>{language === 'zh' ? '每个源片段输出一个同名 .raw4d；同名文件会被本次结果替换。' : 'Each source segment becomes one matching .raw4d file; existing files with the same names are replaced.'}</li>
              <li>{language === 'zh' ? '软删除点逐段物理压实；当前场景与 Canonical 内存不被修改。' : 'Soft-deleted points are compacted per segment; the scene and Canonical memory are not modified.'}</li>
            </ol>
            <p className="memory-confirm-warning">
              {language === 'zh'
                ? '所有编码、压实和文件写入都在浏览器前端完成，不需要本地服务。'
                : 'Encoding, compaction, and file writes all run in the browser with no local service.'}
            </p>
            {raw4DDirectoryError && <p className="ply-directory-error" role="alert">{raw4DDirectoryError}</p>}
            <footer>
              <button
                className="quiet-button"
                disabled={raw4DDirectoryPicking}
                onClick={() => {
                  setRaw4DDirectoryDialogVisible(false);
                  setRaw4DDirectoryError(null);
                }}
                type="button"
              >{language === 'zh' ? '取消' : 'Cancel'}</button>
              <button
                autoFocus
                className="primary-button"
                disabled={raw4DDirectoryPicking}
                onClick={() => void chooseRaw4DDirectory()}
                type="button"
              >{raw4DDirectoryPicking
                  ? (language === 'zh' ? '正在打开…' : 'Opening…')
                  : (language === 'zh' ? '选择输出文件夹' : 'Choose output folder')}</button>
            </footer>
          </section>
        </div>
      )}

      {exportMonitor && (
        <div className="export-monitor-backdrop" data-camera-input-block>
          <section aria-label={exportMonitor.kind === 'ply-sequence'
            ? (language === 'zh' ? 'PLY 序列导出监督' : 'PLY sequence export monitor')
            : exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip'
              ? (language === 'zh' ? 'RAW4D 多片段导出监督' : 'RAW4D segment export monitor')
              : (language === 'zh' ? '4CGS 保存监督' : '4CGS export monitor')} aria-modal="true" className="export-monitor-dialog" role="dialog">
            <header>
              <div>
                <span>{exportMonitor.kind === 'ply-sequence'
                  ? 'RAW4D · PLY 序列'
                  : exportMonitor.kind === 'raw4d'
                    ? 'RAW4D · SEGMENTS'
                    : exportMonitor.kind === 'fourcgs-raw4d-zip'
                      ? '4CGS · RAW4D ZIP'
                      : '4CGS · V2.6'}</span>
                <strong>{exportMonitor.kind === 'ply-sequence'
                  ? (language === 'zh' ? 'PLY 序列导出监督' : 'PLY sequence export monitor')
                  : exportMonitor.kind === 'raw4d'
                    ? (language === 'zh' ? 'RAW4D 分段保存监督' : 'RAW4D segment export monitor')
                    : exportMonitor.kind === 'fourcgs-raw4d-zip'
                      ? (language === 'zh' ? '4CGS ZIP 流式保存监督' : '4CGS ZIP streaming export monitor')
                    : (language === 'zh' ? '压缩保存监督' : 'Compression export monitor')}</strong>
              </div>
              <b className={`export-monitor-state ${exportMonitor.phase}`}>
                {exportMonitor.phase === 'running' ? (language === 'zh' ? '运行中' : 'Running')
                  : exportMonitor.phase === 'success' ? (language === 'zh' ? '已完成' : 'Complete')
                    : exportMonitor.phase === 'cancelled' ? (language === 'zh' ? '已取消' : 'Cancelled')
                      : (language === 'zh' ? '失败' : 'Failed')}
              </b>
            </header>

            <div className="export-monitor-stage">
              <div>
                <span>{exportMonitor.progress.stage ?? (language === 'zh' ? '准备' : 'Preparing')}</span>
                <b>{Math.round(exportMonitor.progress.ratio * 100)}%</b>
              </div>
              <p>{exportMonitor.progress.message}</p>
              <div aria-label={language === 'zh' ? '总体保存进度' : 'Overall export progress'} className="export-monitor-progress" role="progressbar" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(exportMonitor.progress.ratio * 100)}>
                <i style={{ width: `${Math.max(0, Math.min(1, exportMonitor.progress.ratio)) * 100}%` }} />
              </div>
              {exportMonitor.progress.stageRatio !== undefined && (
                <div className="export-monitor-subprogress"><i style={{ width: `${Math.max(0, Math.min(1, exportMonitor.progress.stageRatio)) * 100}%` }} /></div>
              )}
            </div>

            <dl className="export-monitor-stats">
              <div><dt>{exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip' ? (language === 'zh' ? '模式' : 'Mode') : (language === 'zh' ? 'Worker' : 'Workers')}</dt><dd>{exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip' ? (language === 'zh' ? '逐段' : 'Sequential') : exportMonitor.progress.workerCount ?? 1}</dd></div>
              <div><dt>{language === 'zh' ? '任务' : 'Tasks'}</dt><dd>{exportMonitor.progress.completedTasks ?? 0}/{exportMonitor.progress.totalTasks ?? 8}</dd></div>
              <div><dt>{language === 'zh' ? '耗时' : 'Elapsed'}</dt><dd>{(exportElapsedMs / 1000).toFixed(1)} s</dd></div>
              <div><dt>{language === 'zh' ? '输入' : 'Input'}</dt><dd>{exportMonitor.kind === 'ply-sequence'
                ? (exportMonitor.plyStats ? `${exportMonitor.plyStats.segmentCount} 段` : '--')
                : exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip'
                  ? `${exportMonitor.raw4DStats?.fileCount ?? status.raw4dSequence?.segmentCount ?? 1} ${language === 'zh' ? '段' : 'segments'}`
                  : `${(exportMonitor.inputBytes / 1_000_000).toFixed(3)}M`}</dd></div>
              <div><dt>{language === 'zh' ? '输出' : 'Output'}</dt><dd>{exportMonitor.outputBytes === undefined ? '--' : `${(exportMonitor.outputBytes / 1_000_000).toFixed(3)}M`}</dd></div>
              <div><dt>{exportMonitor.kind === 'ply-sequence'
                ? (language === 'zh' ? '帧文件' : 'Frames')
                : exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip'
                  ? (language === 'zh' ? '分段文件' : 'Files')
                  : (language === 'zh' ? '压缩比' : 'Ratio')}</dt><dd>{exportMonitor.kind === 'ply-sequence'
                ? (exportMonitor.plyStats ? `${exportMonitor.plyStats.frameCount}` : `${exportMonitor.progress.completedTasks ?? 0}`)
                : exportMonitor.kind === 'raw4d' || exportMonitor.kind === 'fourcgs-raw4d-zip'
                  ? `${exportMonitor.raw4DStats?.completedFiles ?? 0}/${exportMonitor.raw4DStats?.fileCount ?? exportMonitor.progress.totalTasks ?? 1}`
                  : (exportMonitor.result ? `${exportMonitor.result.compressionRatio.toFixed(2)}×` : '--')}</dd></div>
            </dl>

            {exportMonitor.result?.encodeTimings && (
              <div className="export-monitor-timings">
                {Object.entries(exportMonitor.result.encodeTimings.stageMs).map(([stage, milliseconds]) => (
                  <span key={stage}><b>{stage}</b>{(milliseconds / 1000).toFixed(2)} s</span>
                ))}
              </div>
            )}

            <ol className="export-monitor-log">
              {exportMonitor.logs.map((entry, index) => (
                <li key={`${entry.elapsedMs}-${index}`}><time>{(entry.elapsedMs / 1000).toFixed(1)}s</time><span>{entry.message}</span></li>
              ))}
            </ol>

            <footer>
              <small>{exportMonitor.kind === 'ply-sequence'
                ? (language === 'zh' ? '每帧 PLY 在浏览器 Worker 中直接写入所选目录；取消不修改场景，目录中可能保留已写入的部分帧。' : 'Each PLY frame is written to the chosen directory by a browser worker; cancelling leaves already-written frames in place.')
                : exportMonitor.kind === 'raw4d'
                  ? (language === 'zh' ? '每个 RAW4D 片段在浏览器中独立压实并写入；取消不修改场景，已完成文件会保留。' : 'Each RAW4D segment is compacted and written independently in the browser; cancelling keeps completed files and does not modify the scene.')
                  : exportMonitor.kind === 'fourcgs-raw4d-zip'
                    ? (language === 'zh' ? '每个 RAW4D 片段会逐块流入同一个 ZIP；取消不会修改当前场景。' : 'Each RAW4D segment streams into one ZIP; cancelling does not modify the current scene.')
                  : (language === 'zh' ? '压缩完全在浏览器 Worker 中执行；取消不会修改当前场景。' : 'Compression runs entirely in browser workers; cancelling does not modify the scene.')}</small>
              {exportMonitor.phase === 'running'
                ? <button className="quiet-button export-monitor-cancel" onClick={cancelExport} type="button">{language === 'zh' ? '取消保存' : 'Cancel'}</button>
                : <button className="primary-button" onClick={closeExportMonitor} type="button">{language === 'zh' ? '关闭' : 'Close'}</button>}
            </footer>
          </section>
        </div>
      )}

      {pendingLocalMaximumMode && (
        <div className="memory-confirm-backdrop" data-camera-input-block>
          <section aria-label={copy.localMaximumDialogTitle} aria-modal="true" className="memory-confirm-dialog" role="dialog">
            <header>
              <span>{copy.localMaximumDialogKicker}</span>
              <strong>{copy.localMaximumDialogTitle}</strong>
              <p>{copy.localMaximumDialogDescription}</p>
            </header>
            <dl>
              <div><dt>{copy.cpuGiB}</dt><dd>32 GiB</dd></div>
              <div><dt>{copy.gpuGiB}</dt><dd>12 GiB</dd></div>
              <div><dt>{copy.localMaximumResidency}</dt><dd>{copy.localMaximumAllSegments}</dd></div>
            </dl>
            <p className="memory-confirm-warning">{copy.localMaximumWarning}</p>
            <footer>
              <button className="quiet-button" onClick={() => setPendingLocalMaximumMode(false)} type="button">{copy.cancel}</button>
              <button autoFocus className="primary-button" onClick={activateLocalMaximumMode} type="button">{copy.activateLocalMaximum}</button>
            </footer>
          </section>
        </div>
      )}

      <section className="workspace" ref={workspaceRef}>
        <section className="viewport-stage">
          <GaussianViewport
            activeTool={activeTool}
            backgroundColor={backgroundColor}
            brushRadius={selectionBrushRadius}
            currentFrame={currentFrame}
            forceSortSync={effectiveForceSortSync}
            frameReadyRequestId={frameReadyRequestId}
            memoryPolicy={memoryPolicy}
            onFrameDisplayed={showDisplayedRelightingFrame}
            onFrameRenderReady={handleFrameRenderReady}
            onHistoryChange={setHistoryState}
            onCameraBookmarksChange={setCameraBookmarks}
            onMemoryChange={setMemoryUsage}
            onPerformanceChange={setPerformanceSnapshot}
            onRelightingChange={setRelightingState}
            onRuntimeChange={setViewportRuntime}
            onSelectionChange={setSelectionState}
            onStatusChange={setStatus}
            onTransformChange={setSceneTransform}
            renderMode={renderMode}
            shLevel={shLevel}
            selectionCylinder={selectionCylinder}
            selectionScope={selectionScope}
            showAxes={showAxes}
            showHeightRuler={showHeightRuler}
            showGaussianEnvelope={showGaussianEnvelope}
            showGrid={showGrid}
            showGuides={!mobilePlayerMode}
            sourceFiles={sourceFiles}
            transform={sceneTransform}
            uniformScale={uniformScale}
            viewportLabel={copy.viewportCanvas}
          />
          {sourceFiles.length === 0 && (
            <WelcomePage
              language={language}
              onBrowse={() => fileInputRef.current?.click()}
              onOpenGallery={openFourCgsGallery}
              recoverySources={workspaceDraft?.sources.map((source) => source.name) ?? []}
            />
          )}
          <div className="viewport-toolbar" data-camera-input-block>
            <div aria-label={copy.renderModes} className="render-mode-switch" role="group">
              {gaussianRenderModes.filter((mode) => !mobilePlayerMode || mode.id === 'gaussian' || mode.id === 'point').map((mode) => (
                <button
                  aria-pressed={renderMode === mode.id}
                  className={renderMode === mode.id ? 'render-mode-button active has-tip' : 'render-mode-button has-tip'}
                  data-tip={copy[mode.titleKey]}
                  key={mode.id}
                  onClick={() => setRenderMode(mode.id)}
                  type="button"
                >
                  <i aria-hidden="true" className={`render-mode-glyph ${mode.id}`} />
                  <span>{copy[mode.labelKey]}</span>
                </button>
              ))}
            </div>
            {!mobilePlayerMode && <div aria-label="SH display level" className="sh-level-switch" role="group">
              {[0, 1, 2, 3].map((level) => (
                <button
                  aria-pressed={shLevel === level}
                  className={shLevel === level ? 'active has-tip' : 'has-tip'}
                  data-tip={`SH${level}`}
                  disabled={level > (status.shBands ?? 0)}
                  key={level}
                  onClick={() => setShLevel(level)}
                  type="button"
                >SH{level}</button>
              ))}
            </div>}
            {!mobilePlayerMode && <div className="guide-switches">
              <button aria-pressed={showGrid} className={showGrid ? 'active' : ''} onClick={() => setShowGrid((visible) => !visible)} type="button">{copy.grid}</button>
              <button aria-pressed={showAxes} className={showAxes ? 'active' : ''} onClick={() => setShowAxes((visible) => !visible)} type="button">{copy.axes}</button>
              <button aria-pressed={showHeightRuler} className={showHeightRuler ? 'active' : ''} onClick={() => setShowHeightRuler((visible) => !visible)} type="button">{copy.heightRuler}</button>
            </div>}
            {/* #WDD-gpt 2026-08-16 - 序列摘要并入顶部工具栏，避免单独占用第二行遮挡视口。 */}
            {!mobilePlayerMode && status.phase === 'ready' && status.raw4dSequence && (
              <div className="raw4d-sequence-badge">
                <strong>{status.format} × {status.raw4dSequence.segmentCount}</strong>
                <span>{copy.sequenceSegment} {status.raw4dSequence.segmentIndex + 1}/{status.raw4dSequence.segmentCount}</span>
                {status.format === 'RAW4D' && <span>{copy.sequenceBoundaryMerged} {status.raw4dSequence.boundaryFramesRemoved}</span>}
                <span>{copy.sequenceTracks} {status.raw4dSequence.permanentTrackCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
                <span>SH{status.shBands ?? 0}</span>
                {status.format === 'RAW4D' && <span>{copy.sequenceShSeparated} {(Math.max(0, status.raw4dSequence.sharedShSavedBytes) / 1_000_000).toFixed(3)}M</span>}
              </div>
            )}
          </div>
          {!mobilePlayerMode && !histogramPanelVisible && <div className="camera-help" data-camera-input-block>{copy.cameraMoveHint}</div>}
          {/* #WDD-gpt 2026-08-16 - 使用实时 3D 投影导航立方体同步相机姿态，并隔离主视口的鼠标输入。 */}
          {!mobilePlayerMode && <ViewCube3D
            inspectorOpen={inspectorPanelVisible}
            labels={cameraViewLabels}
            runtime={viewportRuntime}
            title={copy.cameraCubeTip}
          />}
          {status.phase === 'error' && (
            <div className="viewport-error">
              <strong>{viewportErrorDescription?.title ?? copy.viewportFailed}</strong>
              <span>{viewportErrorDescription?.summary ?? localizedStatusMessage}</span>
              {viewportErrorDescription?.suggestion && <p>{viewportErrorDescription.suggestion}</p>}
              {sourceFiles.length > 0 && <button onClick={() => setSourceFiles([...sourceFiles])} type="button">{language === 'zh' ? '重新载入场景' : 'Reload scene'}</button>}
              {viewportErrorDescription?.details && <details><summary>Technical details</summary><code>{viewportErrorDescription.details}</code></details>}
            </div>
          )}
          {status.phase === 'loading' && (
            <div className="viewport-loading" role="status">
              <span className="loading-kicker">{status.format === '4CGS'
                ? status.fourCgsContainer === 'raw4d-zip'
                  ? '4CGS RAW4D ZIP'
                  : status.fourCgsContainer === 'raw4d-bundle' ? '4CGS RAW4D BUNDLE' : '4CGS V2.4'
                : copy.raw4dStream}</span>
              <strong>{localizedStatusMessage}</strong>
              <div className="loading-progress"><i style={{ width: `${(status.progress ?? 0) * 100}%` }} /></div>
              <small>{Math.round((status.progress ?? 0) * 100)}%</small>
            </div>
          )}
        </section>

        {!mobilePlayerMode && <aside className="toolrail operation-toolrail glass-panel" aria-label={copy.operationTools} data-camera-input-block>
          {operationTools.map((tool) => (
            <button
              aria-label={copy[tool.labelKey]}
              aria-pressed={activeTool === tool.id}
              className={`${activeTool === tool.id ? 'tool-button active' : 'tool-button'} has-tip`}
              data-tip={copy[tool.tipKey]}
              data-tool={tool.id}
              key={tool.id}
              onClick={() => chooseTool(tool.id)}
              type="button"
            >
              <Icon name={tool.icon} size={20} />
              <kbd>{tool.shortcut}</kbd>
            </button>
          ))}
        </aside>}

        {/* #WDD-gpt  2026-08-16 - 选择形态默认收成操作栏下方单列，点中后才在右侧展开参数详情。 */}
        {!mobilePlayerMode && <aside className="toolrail selection-toolrail glass-panel" aria-label={copy.selectionPanel} data-camera-input-block>
          {selectionTools.map((tool) => (
            <button
              aria-label={copy[tool.labelKey]}
              aria-pressed={activeTool === tool.id}
              className={`${activeTool === tool.id ? 'tool-button active' : 'tool-button'} has-tip`}
              data-tip={copy[tool.tipKey]}
              data-tool={tool.id}
              key={tool.id}
              onClick={() => chooseTool(tool.id)}
              type="button"
            >
              <Icon name={tool.icon} size={20} />
              <kbd>{tool.shortcut}</kbd>
            </button>
          ))}
        </aside>}

        {!mobilePlayerMode && activeSelectionDescriptor && (
          <aside
            aria-label={`${copy.selectionPanel}: ${copy[activeSelectionDescriptor.labelKey]}`}
            className={`selection-detail-panel glass-panel ${selectionState.phase}`}
            data-camera-input-block
            data-selection-phase={selectionState.phase}
          >
            <header className="selection-panel-heading">
              <strong>{copy[activeSelectionDescriptor.labelKey]}</strong>
              <small>{selectionScope === 'visible' ? copy.selectionVisibleScope : copy.selectionGlobalScope}</small>
            </header>
            <div aria-label={copy.selectionScope} className="selection-scope-switch" role="group">
              <button
                aria-pressed={selectionScope === 'visible'}
                className="has-tip"
                data-tip={copy.selectionVisibleScopeTip}
                onClick={() => chooseSelectionScope('visible')}
                type="button"
              >
                <Icon name="selectVisible" size={13} />{copy.selectionVisibleScope}
              </button>
              <button
                aria-pressed={selectionScope === 'global'}
                className="has-tip"
                data-tip={copy.selectionGlobalScopeTip}
                onClick={() => chooseSelectionScope('global')}
                type="button"
              >
                <Icon name="selectGlobal" size={13} />{copy.selectionGlobalScope}
              </button>
            </div>
            {activeTool === 'select-brush' && (
              <label className="selection-brush-size">
                <span>{copy.selectionBrushSize}</span>
                <input
                  aria-label={copy.selectionBrushSize}
                  max="120"
                  min="12"
                  onChange={(event) => setSelectionBrushRadius(Number(event.target.value))}
                  step="2"
                  type="range"
                  value={selectionBrushRadius}
                />
                <b>{selectionBrushRadius}px</b>
              </label>
            )}
            {activeTool === 'select-cylinder' && (
              <div className="selection-cylinder-controls">
                <div className="selection-cylinder-grid">
                  {([
                    ['centerX', copy.selectionCylinderCenterX, -100_000, 100_000, 0.05],
                    ['centerZ', copy.selectionCylinderCenterZ, -100_000, 100_000, 0.05],
                    ['radius', copy.selectionCylinderRadius, 0.001, 100_000, 0.02],
                    ['height', copy.selectionCylinderHeight, 0.001, 100_000, 0.02],
                    ['groundPadding', copy.selectionCylinderGroundPadding, 0, 100_000, 0.01],
                  ] as const).map(([key, label, min, max, scrubStep]) => (
                    <label key={key}>
                      <span>{label}</span>
                      <ValidatedNumberInput
                        aria-label={label}
                        max={max}
                        min={min}
                        onCommit={(value) => setSelectionCylinder((current) => ({ ...current, [key]: value }))}
                        precision={3}
                        scrub
                        scrubStep={scrubStep}
                        step={scrubStep * 5}
                        value={selectionCylinder[key]}
                      />
                    </label>
                  ))}
                </div>
                <div className="selection-cylinder-actions">
                  <button
                    disabled={selectionState.phase === 'selecting' || status.splatCount === 0}
                    onClick={(event) => void viewportRuntime?.selectGaussiansInCylinder(
                      gaussianSelectionModeFromModifiers(event),
                    )}
                    type="button"
                  >{copy.selectCylinder}</button>
                  <button
                    disabled={selectionState.phase === 'selecting' || status.splatCount === 0}
                    onClick={() => void viewportRuntime?.keepGaussiansInCylinder('inside')}
                    type="button"
                  >{copy.keepCylinderInside}</button>
                  <button
                    disabled={selectionState.phase === 'selecting' || status.splatCount === 0}
                    onClick={() => void viewportRuntime?.keepGaussiansInCylinder('outside')}
                    type="button"
                  >{copy.keepCylinderOutside}</button>
                </div>
              </div>
            )}
            <p className="selection-tool-hint">
              {selectionState.phase === 'selecting'
                ? `${copy.selectionAnalyzing} ${Math.round(selectionState.progress * 100)}%`
                : activeTool === 'select-brush'
                  ? copy.selectionBrushDescription
                  : activeTool === 'select-cylinder'
                    ? copy.selectionCylinderDescription
                  : activeTool === 'select-poly'
                    ? copy.selectionPolyDescription
                    : copy.selectionRectDescription}
            </p>
            {selectionState.phase === 'selecting' && (
              <div aria-hidden="true" className="selection-progress"><i style={{ width: `${selectionState.progress * 100}%` }} /></div>
            )}
            {selectionState.message && <small className="selection-error">{selectionState.message}</small>}
            <div className="selection-summary">
              <span>{copy.selectedGaussians}</span>
              <b>{selectionState.selectedCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</b>
            </div>
            <footer>
              <small>{copy.selectionModifierHint}</small>
              <div className="selection-footer-actions">
                <button
                  className="selection-delete-button"
                  disabled={selectionState.selectedCount === 0 || selectionState.phase === 'selecting'}
                  onClick={() => viewportRuntime?.deleteSelectedGaussians()}
                  type="button"
                >
                  {copy.markSelectedDeleted}<kbd>Del</kbd>
                </button>
                <button
                  disabled={status.splatCount === 0 || selectionState.phase === 'selecting'}
                  onClick={() => viewportRuntime?.invertGaussianSelection(selectionScope)}
                  type="button"
                >
                  {selectionScope === 'visible' ? copy.invertVisibleSelection : copy.invertGlobalSelection}
                </button>
                <button
                  disabled={selectionState.selectedCount === 0 || selectionState.phase === 'selecting'}
                  onClick={() => viewportRuntime?.clearGaussianSelection()}
                  type="button"
                >
                  {copy.clearSelection}
                </button>
              </div>
            </footer>
          </aside>
        )}

        {!mobilePlayerMode && inspectorPanelVisible && <aside aria-label={copy.inspector} className="panel inspector-panel glass-panel" data-camera-input-block>
          {/* #WDD-gpt 2026-08-15 - 检查器按职责分页，避免属性长列表挤压性能图表。 */}
          <nav
            aria-label={copy.inspectorTabs}
            className={semanticClassificationState.result ? 'inspector-tabs semantic-tab-available' : 'inspector-tabs'}
            role="tablist"
          >
            {inspectorTabs.filter((tab) => tab.id !== 'semantic' || Boolean(semanticClassificationState.result)).map((tab) => (
              <button
                aria-controls={`inspector-panel-${tab.id}`}
                aria-selected={inspectorTab === tab.id}
                className={inspectorTab === tab.id ? 'inspector-tab active' : 'inspector-tab'}
                id={`inspector-tab-${tab.id}`}
                key={tab.id}
                onClick={() => setInspectorTab(tab.id)}
                role="tab"
                tabIndex={inspectorTab === tab.id ? 0 : -1}
                type="button"
              >
                {copy[tab.labelKey]}
              </button>
            ))}
          </nav>

          <div className="inspector-tab-content">
            {inspectorTab === 'scene' && (
              <SceneOutliner
                cameraBookmarks={cameraBookmarks}
                gaussianVisible={gaussianVisible}
                gs2MeshVisible={gs2MeshVisible}
                hasMesh={hasGS2Mesh}
                language={language}
                lightCount={relightingState.lights.length}
                onFocusScene={focusScene}
                onFocusSelection={focusSelection}
                onFrameChange={(frame) => { setCurrentFrame(frame); setIsPlaying(false); }}
                onGaussianVisibleChange={changeGaussianVisible}
                onMeshVisibleChange={changeGS2MeshVisible}
                onRecallBookmark={recallCameraBookmark}
                onSaveBookmark={saveCameraBookmark}
                onToggleAxes={() => setShowAxes((visible) => !visible)}
                onToggleEnvelope={() => setShowGaussianEnvelope((visible) => !visible)}
                onToggleGrid={() => setShowGrid((visible) => !visible)}
                onToggleRuler={() => setShowHeightRuler((visible) => !visible)}
                recoverySources={workspaceDraft?.sources.map((source) => source.name) ?? []}
                sceneName={sourceFiles.length === 0 && workspaceDraft ? workspaceDraft.sceneName : displaySceneName}
                showAxes={showAxes}
                showEnvelope={showGaussianEnvelope}
                showGrid={showGrid}
                showRuler={showHeightRuler}
                status={status}
                workspaceSavedAt={workspaceSavedAt}
                workspaceState={workspaceSaveState}
              />
            )}
            {inspectorTab === 'transform' && (
              <section aria-labelledby="inspector-tab-transform" className="inspector-section" id="inspector-panel-transform" role="tabpanel">
                {/* #WDD-gpt 2026-08-16 - 变换统一使用世界空间，移除无实际工作流价值的局部/世界重复开关。 */}
                <TransformVectorEditor disabled={transformControlsDisabled} label={copy.position} max={100_000} min={-100_000} onChange={(axis, value) => updateTransformVector('position', axis, value)} onReset={() => resetTransformVector('position')} precision={3} resetLabel={copy.reset} scrubStep={0.02} step={0.1} values={sceneTransform.position} />
                <TransformVectorEditor disabled={transformControlsDisabled} label={copy.rotation} max={360} min={-360} onChange={(axis, value) => updateTransformVector('rotation', axis, value)} onReset={() => resetTransformVector('rotation')} precision={2} resetLabel={copy.reset} scrubStep={0.5} step={1} values={sceneTransform.rotation} />
                <div className="scale-link-row">
                  <span>{copy.uniformScale}</span>
                  <button aria-pressed={uniformScale} className={uniformScale ? 'scale-link active' : 'scale-link'} disabled={transformControlsDisabled} onClick={() => setUniformScale((linked) => !linked)} type="button">{uniformScale ? '●' : '○'}</button>
                </div>
                <TransformVectorEditor disabled={transformControlsDisabled} label={copy.scale} max={1_000} min={0.001} onChange={(axis, value) => updateTransformVector('scale', axis, value)} onReset={() => resetTransformVector('scale')} precision={3} resetLabel={copy.reset} scrubStep={0.01} step={0.05} values={sceneTransform.scale} />
                {/* #WDD-gpt 2026-08-17 - 原点重设作为独立高风险操作放在变换数值下方，先说明会改写 Canonical 全关键帧再进入确认框。 */}
                <div className="transform-origin-card">
                  <div>
                    <strong>{copy.bakeOriginTitle}</strong>
                    <p>{copy.bakeOriginDescription}</p>
                  </div>
                  <button
                    className="quiet-button has-tip"
                    data-tip={copy.bakeOriginTip}
                    disabled={transformControlsDisabled || sceneTransformIsIdentity}
                    onClick={openOriginBakeDialog}
                    type="button"
                  >
                    <Icon name="move" size={14} />
                    {copy.bakeOriginButton}
                  </button>
                </div>
                {/* #WDD-gpt 2026-08-16 - 未删除点外包络诊断独立于网格和坐标轴，默认关闭以免干扰正常编辑。 */}
                <div className="scale-link-row gaussian-envelope-toggle-row">
                  <span>{copy.gaussianEnvelope}</span>
                  <button
                    aria-label={copy.gaussianEnvelopeTip}
                    aria-pressed={showGaussianEnvelope}
                    className={showGaussianEnvelope ? 'scale-link active has-tip' : 'scale-link has-tip'}
                    data-tip={copy.gaussianEnvelopeTip}
                    disabled={transformDisabled}
                    onClick={() => setShowGaussianEnvelope((visible) => !visible)}
                    type="button"
                  >{showGaussianEnvelope ? '●' : '○'}</button>
                </div>
                {/* #WDD-gpt 2026-08-16 - 在变换检查器复用 GS2Mesh 唯一可见状态，避免与插件窗口的显隐开关失步。 */}
                <div className="scale-link-row mesh-visibility-toggle-row">
                  <span>{copy.meshVisibility}</span>
                  <button
                    aria-label={copy.meshVisibilityTip}
                    aria-pressed={gs2MeshVisible}
                    className={gs2MeshVisible ? 'scale-link active has-tip' : 'scale-link has-tip'}
                    data-tip={copy.meshVisibilityTip}
                    disabled={!hasGS2Mesh}
                    onClick={() => changeGS2MeshVisible(!gs2MeshVisible)}
                    type="button"
                  >{gs2MeshVisible ? '●' : '○'}</button>
                </div>
              </section>
            )}

            {inspectorTab === 'gaussian' && (
              <section aria-labelledby="inspector-tab-gaussian" className="inspector-section" id="inspector-panel-gaussian" role="tabpanel">
                <h3><Icon name="chevron" size={13} />{copy.gaussianProperties}</h3>
                <dl className="property-list">
                  <div><dt>{copy.gaussianCount}</dt><dd>{status.splatCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
                  <div><dt>{copy.activeGaussianCount}</dt><dd>{Math.max(0, (selectionState.pointCount ?? status.splatCount) - (selectionState.deletedCount ?? 0)).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
                  <div><dt>{copy.markedDeletedCount}</dt><dd className={(selectionState.deletedCount ?? 0) > 0 ? 'deleted-text' : ''}>{(selectionState.deletedCount ?? 0).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
                  <div><dt>{copy.shBands}</dt><dd>{status.shBands ?? 0}</dd></div>
                  <div><dt>{copy.renderMode}</dt><dd>{copy[gaussianRenderModes.find((mode) => mode.id === renderMode)?.labelKey ?? 'renderGaussian']}</dd></div>
                  <div><dt>{copy.source}</dt><dd>{status.format === 'Procedural' ? copy.builtIn : status.sourceName ?? copy.builtIn}</dd></div>
                  <div><dt>{copy.status}</dt><dd className="ready-text">● {status.phase === 'loading' ? copy.loading : status.phase === 'error' ? copy.error : copy.ready}</dd></div>
                </dl>
              </section>
            )}

            {inspectorTab === 'semantic' && semanticClassificationState.result && (
              <SemanticClassificationResultsPanel
                language={language}
                onOpenSettings={() => {
                  setActivePlugin('semantic-classification');
                  setPluginWindowMinimized(false);
                }}
                onSelectClass={selectSemanticClass}
                result={semanticClassificationState.result}
              />
            )}

            {inspectorTab === 'performance' && (
              <section aria-labelledby="inspector-tab-performance" className="inspector-section memory-settings" id="inspector-panel-performance" role="tabpanel">
                <h3><Icon name="chevron" size={13} />{copy.memoryAndVram}</h3>
                <PerformanceDiagnosticsPanel snapshot={performanceSnapshot} />
                {/* #WDD-gpt 2026-09-08 - 默认逐帧等待提交版原有排序门闩，避免播放时用旧遮挡顺序；流畅模式保留为显式选择。 */}
                <div className="scale-link-row force-sort-toggle-row">
                  <span>{copy.forceSortSync}</span>
                  <button
                    aria-label={copy.forceSortSyncTip}
                    aria-pressed={forceSortSync}
                    className={forceSortSync ? 'scale-link active has-tip' : 'scale-link has-tip'}
                    data-tip={copy.forceSortSyncTip}
                    onClick={() => setForceSortSync((enabled) => !enabled)}
                    type="button"
                  >{forceSortSync ? '●' : '○'}</button>
                </div>
                <p className="memory-auto-note">
                  {forceSortSync ? copy.forceSortSyncActiveNote : copy.forceSortSyncInactiveNote}
                </p>
                <label className="memory-mode-field">
                  <span>{copy.budgetMode}</span>
                  <select
                    aria-label={copy.memoryModeLabel}
                    className="ui-select"
                    onChange={(event) => requestMemoryMode(event.target.value as Gaussian4DMemoryMode)}
                    value={memoryMode}
                  >
                    <option value="auto">{copy.modeAuto}</option>
                    <option value="mobile">{copy.modeMobile}</option>
                    <option value="compatible">{copy.modeCompatible}</option>
                    <option value="balanced">{copy.modeBalanced}</option>
                    <option value="performance">{copy.modePerformance}</option>
                    <option value="local-maximum">{copy.modeLocalMaximum}</option>
                    <option value="custom">{copy.modeCustom}</option>
                  </select>
                </label>
                {memoryMode === 'auto' && (
                  <p className="memory-auto-note">{copy.autoBudgetNote}</p>
                )}
                {memoryMode === 'mobile' && (
                  <p className="memory-auto-note">{copy.mobileBudgetNote}</p>
                )}
                {memoryMode === 'local-maximum' && (
                  <p className="memory-auto-note local-maximum-active">{copy.localMaximumActiveNote}</p>
                )}
                {memoryMode === 'custom' && (
                  <div className="memory-custom-grid">
                    <label><span>{copy.cpuGiB}</span><ValidatedNumberInput aria-label={copy.cpuGiB} integer max={64} min={1} onCommit={setCustomCpuGiB} precision={0} step={1} value={customCpuGiB} /></label>
                    <label><span>{copy.gpuGiB}</span><ValidatedNumberInput aria-label={copy.gpuGiB} max={32} min={0.5} onCommit={setCustomGpuGiB} precision={1} step={0.5} value={customGpuGiB} /></label>
                  </div>
                )}
                <MemoryTelemetryPanel
                  language={language}
                  lastPressureResult={lastMemoryPressureResult}
                  onOpenPressureTest={() => setMemoryPressureDialogVisible(true)}
                  policy={memoryPolicy}
                  usage={memoryUsage}
                />
                <dl className="property-list memory-details">
                  <div><dt>{copy.transport}</dt><dd>{memoryUsage.transport === 'shared-array-buffer' ? 'SharedArrayBuffer' : 'Transferable'}</dd></div>
                  <div><dt>{copy.loaderWorker}</dt><dd>{status.decodeBackend === 'wasm' ? 'WASM + TypedArray' : status.decodeBackend === 'fp16-bits' ? 'FP16 Bits + TypedArray' : status.decodeBackend === 'image-codebook' ? 'Image Codebook' : status.decodeBackend ? 'TypedArray' : '--'}</dd></div>
                  <div><dt>{copy.gpuDecode}</dt><dd>{status.gpuBackend === 'storage-buffer' ? 'StorageBuffer · WGSL' : status.gpuBackend === 'streaming-texture' ? 'WebGL2 · 滑动关键帧' : status.gpuBackend === 'texture' ? 'Texture · GLSL' : '--'}</dd></div>
                  <div><dt>{copy.bufferId}</dt><dd className="buffer-id has-tip" data-tip={status.bufferId ?? '--'}>{status.bufferId ?? '--'}</dd></div>
                  <div><dt>{copy.sourceResident}</dt><dd>{status.sourceToResidentRatio ? `${status.sourceToResidentRatio.toFixed(2)}×` : '--'}</dd></div>
                </dl>
              </section>
            )}
          </div>

        </aside>}

        {/* #WDD-gpt  2026-08-15 - 插件使用可拖动、可收起的浮动对话框，并阻断框内摄像机输入。 */}
        {activePlugin && activePluginItem && (
          <div className="plugin-workspace-backdrop">
            <section
              aria-label={copy[activePluginItem.titleKey]}
              className={`plugin-workspace glass-panel plugin-workspace-${activePlugin}${pluginWindowMinimized ? ' minimized' : ''}`}
              data-camera-input-block
              ref={pluginWindowRef}
              role="dialog"
              style={{ transform: `translate3d(${pluginWindowPosition.x}px, ${pluginWindowPosition.y}px, 0)` }}
            >
              <header
                className="plugin-workspace-heading"
                onDoubleClick={() => setPluginWindowMinimized((minimized) => !minimized)}
                onPointerCancel={endPluginWindowDrag}
                onPointerDown={beginPluginWindowDrag}
                onPointerMove={movePluginWindow}
                onPointerUp={endPluginWindowDrag}
              >
                <span aria-hidden="true" className="plugin-workspace-mark">{activePluginItem.mark}</span>
                <div>
                  <strong>{copy[activePluginItem.titleKey]}</strong>
                  <small>{copy[activePluginItem.descriptionKey]}</small>
                </div>
                <div className="plugin-window-actions">
                  <button
                    aria-label={pluginWindowMinimized ? copy.restorePlugin : copy.minimizePlugin}
                    className="has-tip"
                    data-tip={pluginWindowMinimized ? copy.restorePlugin : copy.minimizePlugin}
                    onClick={() => setPluginWindowMinimized((minimized) => !minimized)}
                    type="button"
                  >
                    {pluginWindowMinimized ? '□' : '—'}
                  </button>
                  <button aria-label={copy.closePlugin} className="has-tip" data-tip={copy.closePlugin} onClick={() => setActivePlugin(null)} type="button">×</button>
                </div>
              </header>
              {!pluginWindowMinimized && <div className="plugin-workspace-content">
                {activePlugin === 'smart-alignment' && (
                  <SmartAlignmentPanel disabled={transformDisabled} language={language} onRun={runSmartAlignment} state={smartAlignmentState} />
                )}
                {activePlugin === 'relighting' && (
                  <RelightingWorkflowPanel
                    mesh={{
                      disabled: transformDisabled,
                      language,
                      onCancel: () => relightMeshRef.current?.cancel(),
                      onRun: runRelightingMeshSequence,
                      state: relightMeshState,
                      totalFrames: status.totalFrames ?? 0,
                    }}
                    language={language}
                    onStepChange={setRelightingWorkflowStep}
                    relighting={{
                      hasMesh: hasGS2Mesh,
                      language,
                      meshVisible: gs2MeshVisible,
                      onAddLight: addRelightingLight,
                      onEnabledChange: changeRelightingEnabled,
                      onLightChange: updateRelightingLight,
                      onMeshVisibleChange: changeGS2MeshVisible,
                      onRemoveLight: removeRelightingLight,
                      onSelectLight: selectRelightingLight,
                      onSettingsChange: updateRelightingSettings,
                      state: relightingState,
                    }}
                    step={relightingWorkflowStep}
                  />
                )}
                {activePlugin === 'model-health' && (
                  <ModelHealthPanel
                    busy={modelHealthBusy}
                    disabled={transformDisabled}
                    onAnalyze={() => { void runModelHealth(false); }}
                    onClean={() => { void runModelHealth(true); }}
                    report={modelHealthReport}
                  />
                )}
                {activePlugin === 'semantic-classification' && (
                  <SemanticClassificationPanel
                    disabled={transformDisabled}
                    language={language}
                    onCancel={() => {
                      semanticClassificationRef.current?.cancel();
                      setSemanticClassificationState({ stage: 'cancelled', progress: 0 });
                    }}
                    onRun={runSemanticClassification}
                    onShowResults={() => {
                      setInspectorPanelVisible(true);
                      setInspectorTab('semantic');
                    }}
                    state={semanticClassificationState}
                  />
                )}
              </div>}
            </section>
          </div>
        )}
        {histogramPanelVisible && (
          <GaussianHistogramPanel
            bufferId={status.bufferId}
            cameraHint={copy.cameraMoveHint}
            currentFrame={currentFrame}
            deletedCount={selectionState.deletedCount ?? 0}
            inspectorOpen={inspectorPanelVisible}
            language={language}
            onScopeChange={(scope) => {
              setSelectionScope(scope);
              setIsPlaying(false);
            }}
            onSelectionCreated={() => {
              setActiveTool('select-rect');
              setIsPlaying(false);
            }}
            runtime={viewportRuntime}
            scope={selectionScope}
          />
        )}
      </section>

      {sourceFiles.length > 0 && <section aria-label={copy.timeline} className="timeline-panel glass-panel" data-camera-input-block>
        <div className="playback-controls">
          <button aria-label={copy.firstFrame} className="has-tip" data-tip={copy.firstFrame} onClick={() => { setCurrentFrame(0); stopPlayback(); }} type="button"><Icon name="stepBack" size={15} /></button>
          <button aria-label={copy.previousFrame} className="has-tip" data-tip={copy.previousFrame} onClick={() => { setCurrentFrame((frame) => Math.max(0, frame - 1)); stopPlayback(); }} type="button"><span>−1</span></button>
          <button
            aria-label={isPlaying || loopSortWaiting ? copy.pause : copy.play}
            className="play-button has-tip"
            data-tip={isPlaying || loopSortWaiting ? copy.pause : copy.play}
            onClick={() => {
              if (loopSortWaiting) {
                loopRestartPendingRef.current = false;
                loopRestartRequestIdRef.current += 1;
                setLoopSortWaiting(false);
                return;
              }
              setIsPlaying((playing) => !playing);
            }}
            type="button"
          ><Icon name={isPlaying || loopSortWaiting ? 'pause' : 'play'} size={16} /></button>
          <button aria-label={copy.nextFrame} className="has-tip" data-tip={copy.nextFrame} onClick={() => { setCurrentFrame((frame) => Math.min(timelineEndFrame, frame + 1)); stopPlayback(); }} type="button"><span>+1</span></button>
          <button aria-label={copy.lastFrame} className="has-tip" data-tip={copy.lastFrame} onClick={() => { setCurrentFrame(timelineEndFrame); stopPlayback(); }} type="button"><Icon name="stepForward" size={15} /></button>
        </div>

        <div className="timeline-main">
          <div className="timeline-header">
            <div className="timeline-title">
              <span>{copy.masterTimeline}</span>
              {activeTimelineSegment && <small className="timeline-active-segment">{activeTimelineSegment.name}</small>}
            </div>
            <div className="timeline-readout">
              {timelineKeyframeTracks && <button aria-pressed={timelineDetailsVisible} className="timeline-details-toggle" onClick={() => setTimelineDetailsVisible((visible) => !visible)} type="button">{timelineDetailsVisible ? (language === 'zh' ? '收起轨道' : 'Hide tracks') : (language === 'zh' ? '属性轨道' : 'Tracks')}</button>}
              <strong>{frameTimecode}</strong>
              {/* #WDD-gpt 2026-08-16 - 播放时逐帧显示零填充当前帧与总帧数，避免只能从时间码反推帧号。 */}
              <span aria-label={frameCounter} className="timeline-frame-counter">{frameCounter}</span>
            </div>
          </div>
          <div className="timeline-track">
            {status.raw4dSequence && (
              <div aria-hidden="true" className="timeline-segment-bands">
                {timelineSegments.map((segment, index) => {
                  const start = segment.firstFrame - status.raw4dSequence!.firstFrame;
                  const end = segment.lastFrame - status.raw4dSequence!.firstFrame;
                  return <i className={index === status.raw4dSequence!.segmentIndex ? 'active' : ''} key={`${segment.name}-${index}`} style={{ left: `${start / Math.max(1, timelineEndFrame) * 100}%`, width: `${Math.max(0.6, (end - start) / Math.max(1, timelineEndFrame) * 100)}%` }} />;
                })}
              </div>
            )}
            <div
              aria-hidden="true"
              className="timeline-frame-ticks"
              style={{ '--timeline-frame-intervals': Math.max(1, timelineEndFrame) } as React.CSSProperties}
            />
            {status.raw4dSequence && (
              <div aria-hidden="true" className="timeline-annotations">
                {timelineKeyframes.map((frame) => (
                  <i
                    className="timeline-keyframe"
                    key={`key-${frame}`}
                    style={{ left: `${frame / Math.max(1, timelineEndFrame) * 100}%` }}
                  />
                ))}
                {timelineSegmentNodes.map((frame) => (
                  <b
                    className="timeline-segment-node"
                    key={`segment-${frame}`}
                    style={{ left: `${frame / Math.max(1, timelineEndFrame) * 100}%` }}
                  />
                ))}
              </div>
            )}
            <input
              aria-label={copy.currentFrame}
              max={timelineEndFrame}
              min="0"
              onChange={(event) => {
                const frame = Number(event.target.value);
                stopPlayback();
                // #WDD-gpt 2026-09-08 - range 的每个 input 都提交真实帧；运行时单飞排序并用完整帧覆盖中间态。
                setCurrentFrame(frame);
              }}
              onPointerDown={() => {
                // #WDD-gpt 2026-09-08 - 拖动开始只停止自动播放；随后每个滑块值立即驱动实际渲染。
                stopPlayback();
              }}
              style={{ '--timeline-progress': `${(currentFrame / Math.max(1, timelineEndFrame)) * 100}%` } as React.CSSProperties}
              type="range"
              value={currentFrame}
            />
            <div className="timeline-marks" aria-hidden="true">{timelineMarks.map((frame) => <span key={frame}>{frame}</span>)}</div>
          </div>
          {timelineDetailsVisible && timelineKeyframeTracks && (
            <div className="timeline-detail-tracks">
              {([
                ['P', timelineKeyframeTracks.position],
                ['R', timelineKeyframeTracks.rotation],
                ['S', timelineKeyframeTracks.scale],
                ['C', timelineKeyframeTracks.colorDc],
                ['A', timelineKeyframeTracks.opacity],
              ] as const).map(([label, frames]) => (
                <div key={label}><b>{label}</b><span>{frames.map((frame) => <i key={frame} style={{ left: `${frame / Math.max(1, timelineEndFrame) * 100}%` }} />)}</span><small>{frames.length}</small></div>
              ))}
            </div>
          )}
        </div>

        <div className="timeline-options">
          <button aria-label={copy.loop} className={isLooping ? 'loop-button active has-tip' : 'loop-button has-tip'} data-tip={copy.loop} onClick={() => setIsLooping((looping) => !looping)} type="button"><Icon name="loop" size={14} /><span>{copy.loopShort}</span></button>
          {/* #WDD-gpt 2026-08-16 - 固定档位覆盖逐帧检查到 60 FPS 快速预览，避免自由输入产生无效速度。 */}
          <UiSelect
            ariaLabel={copy.playbackSpeed}
            className="fps-select"
            onChange={setPlaybackFps}
            options={playbackFpsOptions.map((fps) => ({ label: `${fps} FPS`, value: fps }))}
            placement="above"
            value={playbackFps}
          />
        </div>
      </section>}

      <footer className="statusbar" data-camera-input-block>
        {!mobilePlayerMode && <span><i className={status.phase === 'ready' ? 'ok' : ''} />{status.phase === 'ready' ? copy.sceneReady : copy.scenePreparing}</span>}
        {/* #WDD-gpt 2026-08-20 - 左下角统计补充所有属性合并后的唯一关键帧数；手机播放器仍只保留高斯总数。 */}
        <dl aria-label={copy.gaussianStatusSummary} className="gaussian-status-summary">
          <div><dt>{mobilePlayerMode ? (language === 'zh' ? '高斯总数' : 'Gaussians') : copy.activeGaussianStatus}</dt><dd>{statusActiveCount.toLocaleString(gaussianCountLocale)}</dd></div>
          {!mobilePlayerMode && <div><dt>{copy.currentFrameGaussianStatus}</dt><dd>{statusCurrentFrameDisplayedCount.toLocaleString(gaussianCountLocale)}</dd></div>}
          {!mobilePlayerMode && <div className={statusDeletedCount > 0 ? 'deleted' : ''}><dt>{copy.deletedGaussianStatus}</dt><dd>{statusDeletedCount.toLocaleString(gaussianCountLocale)}</dd></div>}
          {!mobilePlayerMode && <div className="keyframes"><dt>{copy.keyframeCountStatus}</dt><dd>{statusKeyframeCount.toLocaleString(gaussianCountLocale)}</dd></div>}
        </dl>
        {!mobilePlayerMode && <span
          aria-label={`${copy.memoryUsage}: JS ${formatBytes(memoryUsage.jsHeapBytes)}, 4D ${formatBytes(memoryUsage.managedCpuBytes)}, GPU ${formatBytes(memoryUsage.gpuBytes)}`}
          className="memory-usage has-tip"
          data-tip={`${copy.jsHeapLabel} ${formatBytes(memoryUsage.jsHeapBytes)} / ${formatBytes(memoryUsage.jsHeapLimitBytes)} · ${copy.dataMemoryLabel} ${formatBytes(memoryUsage.managedCpuBytes)} / ${formatBytes(memoryUsage.cpuBudgetBytes)} · ${copy.gpuVramLabel} ${formatBytes(memoryUsage.gpuBytes)} / ${formatBytes(memoryUsage.gpuBudgetBytes)}`}
        >
          <b>MEM</b>
          <em>JS {formatBytes(memoryUsage.jsHeapBytes)}</em>
          <em>4D {formatBytes(memoryUsage.managedCpuBytes)}</em>
          <em>GPU {formatBytes(memoryUsage.gpuBytes)}</em>
        </span>}
      </footer>
    </main>
  );
}
