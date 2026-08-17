import { useEffect, useMemo, useRef, useState } from 'react';
import changeLogMarkdown from '../../CHANGELOG.md?raw';
import { formatBytes } from '../core/format/formatBytes';
import {
  isEditorRedoShortcut,
  isEditorUndoShortcut,
  isGaussianDeleteShortcut,
  isViewportBrowseShortcut,
} from '../features/editor/tools/EditorKeyboardShortcuts';
import {
  DEFAULT_GAUSSIAN_4D_MEMORY_MODE,
  createGaussian4DMemoryPolicy,
  type Gaussian4DMemoryMode,
} from '../features/gaussian/memory/Gaussian4DMemoryPolicy';
import type { GaussianRenderMode } from '../features/gaussian/runtime/GaussianRenderMode';
import { writeFourCgsFile } from '../features/gaussian/formats/fourcgs/FourCgsContainer';
import {
  encodeRaw4DMemoryAsFourCgs,
  type FourCgsEncodeResult,
} from '../features/gaussian/formats/fourcgs/FourCgsEncoderClient';
import type { FourCgsProgress } from '../features/gaussian/formats/fourcgs/FourCgsTypes';
import { exportRaw4DSequenceAsPlyDirectory } from '../features/gaussian/formats/raw4d/Raw4DPlySequenceExportClient';
import { GaussianViewport } from '../features/viewport/components/GaussianViewport';
import { MemoryTelemetryPanel } from '../features/viewport/components/MemoryTelemetryPanel';
import { PerformanceDiagnosticsPanel } from '../features/viewport/components/PerformanceDiagnosticsPanel';
import type { ViewportPerformanceSnapshot } from '../features/viewport/runtime/ViewportPerformanceMonitor';
import type { GaussianCylinderSelectionRegion } from '../features/viewport/runtime/selection/GaussianCylinderSelection';
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
  INITIAL_GS2MESH_STATE,
  type GS2MeshOptions,
  type GS2MeshState,
} from '../plugins/gs2mesh/GS2MeshTypes';
import {
  reconcileRelightingWorkflowStep,
  RelightingWorkflowPanel,
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
  readonly kind: 'fourcgs' | 'ply-sequence';
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

const initialMemoryPolicy = createGaussian4DMemoryPolicy(DEFAULT_GAUSSIAN_4D_MEMORY_MODE);
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
type InspectorTab = 'transform' | 'gaussian' | 'performance';
type PluginId = 'smart-alignment' | 'relighting' | 'model-health';
type PluginStatusTone = 'idle' | 'running' | 'success' | 'error';
type PluginWindowPosition = { readonly x: number; readonly y: number };

const inspectorTabs: ReadonlyArray<{ readonly id: InspectorTab; readonly labelKey: keyof UiCopy }> = [
  { id: 'transform', labelKey: 'tabTransform' },
  { id: 'gaussian', labelKey: 'tabGaussian' },
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
];

const pluginStatusLabelKeys: Readonly<Record<PluginStatusTone, keyof UiCopy>> = {
  idle: 'pluginStatusIdle',
  running: 'pluginStatusRunning',
  success: 'pluginStatusSuccess',
  error: 'pluginStatusError',
};

export function App() {
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('performance');
  const [language, setLanguage] = useState<UiLanguage>('zh');
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [sourceFiles, setSourceFiles] = useState<readonly File[]>([]);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  // #WDD-gpt 2026-08-16 - 播放速率独立于文件元数据并默认 30 FPS，允许用户按检查需求降速或加速。
  const [playbackFps, setPlaybackFps] = useState(30);
  const [renderMode, setRenderMode] = useState<GaussianRenderMode>('gaussian');
  const [shLevel, setShLevel] = useState(3);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showHeightRuler, setShowHeightRuler] = useState(false);
  const [showGaussianEnvelope, setShowGaussianEnvelope] = useState(false);
  const [sceneTransform, setSceneTransform] = useState<ViewportTransform>(createInitialTransform);
  const [uniformScale, setUniformScale] = useState(true);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [exportMonitor, setExportMonitor] = useState<ExportMonitorState | null>(null);
  const [exportElapsedMs, setExportElapsedMs] = useState(0);
  const [viewportRuntime, setViewportRuntime] = useState<ViewportRuntime | null>(null);
  const [smartAlignmentState, setSmartAlignmentState] = useState<SmartAlignmentState>(INITIAL_SMART_ALIGNMENT_STATE);
  const [gs2MeshState, setGS2MeshState] = useState<GS2MeshState>(INITIAL_GS2MESH_STATE);
  const [relightingState, setRelightingState] = useState<RelightingState>(INITIAL_RELIGHTING_STATE);
  const [relightingWorkflowStep, setRelightingWorkflowStep] = useState<RelightingWorkflowStep>('mesh');
  const [gs2MeshVisible, setGS2MeshVisible] = useState(true);
  const [gaussianVisible, setGaussianVisible] = useState(true);
  const [modelHealthReport, setModelHealthReport] = useState<ModelHealthReport | null>(null);
  const [modelHealthBusy, setModelHealthBusy] = useState(false);
  const [originBakeDialogVisible, setOriginBakeDialogVisible] = useState(false);
  const [originBakeBusy, setOriginBakeBusy] = useState(false);
  const [originBakeProgress, setOriginBakeProgress] = useState<ViewportTransformBakeProgress | null>(null);
  const [originBakeResult, setOriginBakeResult] = useState<ViewportTransformBakeResult | null>(null);
  const [originBakeError, setOriginBakeError] = useState<string | null>(null);
  // #WDD-gpt 2026-08-17 - Chromium 禁止网页直接获准“下载”根目录，导出前先引导选择可写子目录。
  const [plyDirectoryDialogVisible, setPlyDirectoryDialogVisible] = useState(false);
  const [plyDirectoryPicking, setPlyDirectoryPicking] = useState(false);
  const [plyDirectoryError, setPlyDirectoryError] = useState<string | null>(null);
  const [appNotice, setAppNotice] = useState<{
    readonly message: string;
    readonly title: string;
    readonly tone: AppNoticeTone;
  } | null>(null);
  const [memoryMode, setMemoryMode] = useState<Gaussian4DMemoryMode>(DEFAULT_GAUSSIAN_4D_MEMORY_MODE);
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
  const smartAlignmentPluginRef = useRef<SmartAlignmentPlugin | null>(null);
  const gs2MeshPluginRef = useRef<GS2MeshPlugin | null>(null);
  if (!smartAlignmentPluginRef.current) smartAlignmentPluginRef.current = new SmartAlignmentPlugin();
  if (!gs2MeshPluginRef.current) gs2MeshPluginRef.current = new GS2MeshPlugin();
  const memoryPolicy = useMemo(
    () => createGaussian4DMemoryPolicy(memoryMode, customCpuGiB, customGpuGiB),
    [customCpuGiB, customGpuGiB, memoryMode],
  );
  const timelineEndFrame = Math.max(0, (status.totalFrames ?? 121) - 1);
  const copy = UI_COPY[language];
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
  const hasGS2Mesh = gs2MeshState.stage === 'success';
  const statusDeletedCount = selectionState.deletedCount ?? 0;
  const statusActiveCount = Math.max(0, (selectionState.pointCount ?? status.splatCount) - statusDeletedCount);
  const statusCurrentFrameDisplayedCount = selectionState.currentFrameDisplayedCount
    ?? Math.max(0, status.splatCount - Math.min(status.splatCount, statusDeletedCount));
  const gaussianCountLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const sourceFile = sourceFiles.length === 1 ? sourceFiles[0] : null;
  const localizedStatusMessage = localizeRuntimeMessage(language, status.message);
  const showAppNotice = (message: string, title?: string, tone: AppNoticeTone = 'error') => {
    setAppNotice({
      message,
      title: title ?? (language === 'zh' ? '操作未完成' : 'Operation not completed'),
      tone,
    });
  };
  const pluginStatusById: Readonly<Record<PluginId, PluginStatusTone>> = {
    'smart-alignment': smartAlignmentState.stage === 'success'
      ? 'success'
      : smartAlignmentState.stage === 'error'
        ? 'error'
        : smartAlignmentState.stage === 'idle' ? 'idle' : 'running',
    relighting: relightingState.error || gs2MeshState.stage === 'error'
      ? 'error'
      : ['capturing', 'matching', 'fusing', 'installing'].includes(gs2MeshState.stage)
        ? 'running'
        : relightingState.enabled ? 'success' : 'idle',
    'model-health': modelHealthBusy ? 'running' : modelHealthReport?.healthy ? 'success' : modelHealthReport ? 'error' : 'idle',
  };
  const activePluginItem = pluginMenuItems.find((plugin) => plugin.id === activePlugin) ?? null;

  useEffect(() => () => {
    exportAbortRef.current?.abort();
    smartAlignmentPluginRef.current?.dispose();
    gs2MeshPluginRef.current?.dispose();
  }, []);

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
    setRelightingWorkflowStep((current) => reconcileRelightingWorkflowStep(
      current,
      previousStage,
      gs2MeshState.stage,
    ));
  }, [gs2MeshState.stage]);

  useEffect(() => {
    if (status.phase !== 'ready') return;
    setShLevel(status.splatCount > 0 ? status.shBands ?? 0 : 0);
  }, [status.bufferId, status.phase, status.shBands, status.splatCount]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isViewportBrowseShortcut(event)) {
        setOpenMenu(null);
        setActivePlugin(null);
        setActiveTool('select');
        return;
      }
      if (isTextEntryTarget(event.target)) return;
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
  }, [viewportRuntime]);

  useEffect(() => {
    if (!isPlaying) return;
    if (timelineEndFrame <= 0) {
      setIsPlaying(false);
      return;
    }
    const startTime = performance.now();
    const startFrame = currentFrame;
    const frameCount = timelineEndFrame + 1;
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
      const nextFrame = isLooping ? absoluteFrame % frameCount : Math.min(absoluteFrame, timelineEndFrame);
      setCurrentFrame((frame) => frame === nextFrame ? frame : nextFrame);
      animationFrame = window.requestAnimationFrame(updatePlayback);
    };
    animationFrame = window.requestAnimationFrame(updatePlayback);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [isLooping, isPlaying, playbackFps, timelineEndFrame]);

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
    const horizontalLimit = Math.max(0, (workspaceBounds.width - windowBounds.width) / 2 - 8);
    const verticalLimit = Math.max(0, (workspaceBounds.height - windowBounds.height) / 2 - 8);
    setPluginWindowPosition({
      x: Math.max(-horizontalLimit, Math.min(horizontalLimit, drag.origin.x + event.clientX - drag.startX)),
      y: Math.max(-verticalLimit, Math.min(verticalLimit, drag.origin.y + event.clientY - drag.startY)),
    });
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

  // #WDD-gpt  2026-08-16 - RAW4D 保存时根据软删除位集输出压实文件；编辑中的源数据保持稳定 ID。
  const exportWorkspace = async () => {
    setOpenMenu(null);
    // #WDD-gpt 2026-08-17 - 所有场景文件导出在读取当前帧数据前先暂停，避免编码期间时间轴继续变化。
    setIsPlaying(false);
    const canonicalDataDirty = viewportRuntime?.hasCanonicalGaussianDataChanges() ?? false;
    const exportsFourCgs = status.format === 'RAW4D' || status.format === '4CGS';
    let fourCgsFileHandle: FileSystemFileHandle | null = null;
    if (exportsFourCgs) {
      if (status.format === '4CGS' && !canonicalDataDirty && !sourceFile) {
        showAppNotice(
          language === 'zh' ? '当前 4CGS 场景缺少可保存的源文件。' : 'The current 4CGS scene has no source file to save.',
          language === 'zh' ? '无法导出 4CGS' : 'Cannot export 4CGS',
        );
        return;
      }
      if (status.format === '4CGS' && !canonicalDataDirty && (viewportRuntime?.getGaussianDeletionCount() ?? 0) > 0) {
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
      const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.(?:4cgs|raw4d|ply4)$/i, '');
      try {
        // #WDD-gpt 2026-08-17 - 4CGS 是单文件，使用另存为窗口选择目录和文件名，而非申请整个目录权限。
        fourCgsFileHandle = await window.showSaveFilePicker(createFourCgsSavePickerOptions(`${stem}.4cgs`));
      } catch (error) {
        if (isFilePickerAbort(error)) return;
        showAppNotice(
          error instanceof Error ? error.message : String(error),
          language === 'zh' ? '无法选择 4CGS 保存位置' : 'Cannot choose a 4CGS save location',
        );
        return;
      }
    }
    if ((status.format === 'RAW4D' && sourceFiles.length > 0)
      || (status.format === '4CGS' && canonicalDataDirty)) {
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
        const memorySnapshots = status.format === '4CGS'
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
        const blob = await writeFourCgsFile(result.blob, sceneTransform);
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
        const blob = await writeFourCgsFile(sourceFile, sceneTransform);
        setExportProgress(1);
        const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.4cgs$/i, '');
        await commitExportBlob(blob, `${stem}.4cgs`, fourCgsFileHandle);
      } catch (error) {
        showAppNotice(
          error instanceof Error ? error.message : String(error),
          language === 'zh' ? '4CGS 保存失败' : '4CGS save failed',
        );
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
        showAppNotice(
          error instanceof Error ? error.message : String(error),
          language === 'zh' ? '场景导出失败' : 'Scene export failed',
        );
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

  const cancelExport = () => exportAbortRef.current?.abort();

  const closeExportMonitor = () => {
    if (exportMonitor?.phase === 'running') return;
    setExportMonitor(null);
  };

  const openSourceFiles = (incoming: readonly File[]) => {
    const files = [...incoming];
    if (files.length === 0) return;
    const supported = files.every((file) => /\.(4cgs|raw4d|ply4|sog|ply)$/i.test(file.name));
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
    setActivePlugin(null);
    setInspectorPanelVisible(true);
    setInspectorTab('transform');
    setCurrentFrame(0);
    setIsPlaying(false);
    // #WDD-gpt 2026-08-16 - 即使文件名相同也建立新数组，保证再次拖入会取消旧导入并正式重开场景。
    setSourceFiles(files);
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
    if (viewportRuntime) gs2MeshPluginRef.current?.clear(viewportRuntime, setGS2MeshState);
    setSceneName(null);
    setSourceFiles([]);
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
    setActivePlugin(null);
    setCurrentFrame(0);
    setIsPlaying(false);
    setOpenMenu(null);
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
      showAppNotice(
        error instanceof Error ? error.message : String(error),
        language === 'zh' ? '模型健康操作失败' : 'Model health operation failed',
      );
    } finally {
      setModelHealthBusy(false);
    }
  };

  const frameTimecode = useMemo(() => {
    const seconds = Math.floor(currentFrame / playbackFps);
    const frame = currentFrame % playbackFps;
    return `00:00:${seconds.toString().padStart(2, '0')}:${frame.toString().padStart(2, '0')}`;
  }, [currentFrame, playbackFps]);

  const frameDigits = Math.max(4, String(timelineEndFrame + 1).length);
  const frameCounter = `${copy.frameShort} [${String(currentFrame).padStart(frameDigits, '0')}] / ${copy.totalFramesShort} [${String(timelineEndFrame + 1).padStart(frameDigits, '0')}]`;

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

  return (
    <main
      className="studio-shell"
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
        accept=".4cgs,.raw4d,.ply4,.sog,.ply"
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
          <div className="menu-anchor">
            <button className={openMenu === 'file' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'file')} type="button">{copy.file}</button>
            {openMenu === 'file' && (
              <div className="dropdown-menu">
                <button onClick={newWorkspace} type="button"><span>{copy.newWorkspace}</span></button>
                {/* #WDD-gpt 2026-08-16 - 文件菜单补齐与顶部按钮一致的导入、导出入口。 */}
                <button onClick={() => { setOpenMenu(null); fileInputRef.current?.click(); }} type="button"><span>{copy.import}</span></button>
                {/* #WDD-gpt 2026-08-17 - 导出提供 .4cgs 文件与 .ply 序列二级子菜单，悬停展开。 */}
                <div className="submenu-anchor">
                  <button disabled={exportProgress !== null} type="button">
                    <span>{copy.export}</span>
                    <b aria-hidden="true">▸</b>
                  </button>
                  <div className="dropdown-menu export-submenu">
                    <button disabled={exportProgress !== null} onClick={() => void exportWorkspace()} type="button">
                      <span>{copy.exportFourCgsFile}</span>
                    </button>
                    <button disabled={exportProgress !== null} onClick={exportPlySequence} type="button">
                      <span>{copy.exportPlySequence}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="menu-anchor">
            <button className={openMenu === 'view' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'view')} type="button">{copy.view}</button>
            {openMenu === 'view' && (
              <div className="dropdown-menu">
                <button onClick={toggleInspectorPanel} type="button"><span>{copy.inspector}</span><b>{inspectorPanelVisible ? '✓' : ''}</b></button>
                <button onClick={() => setShowGrid((visible) => !visible)} type="button"><span>{copy.grid}</span><b>{showGrid ? '✓' : ''}</b></button>
                <button onClick={() => setShowAxes((visible) => !visible)} type="button"><span>{copy.axes}</span><b>{showAxes ? '✓' : ''}</b></button>
                <button onClick={() => setShowHeightRuler((visible) => !visible)} type="button"><span>{copy.heightRuler}</span><b>{showHeightRuler ? '✓' : ''}</b></button>
              </div>
            )}
          </div>
          <div className="menu-anchor">
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
          </div>
        </nav>

        <div aria-label={copy.editHistory} className="history-toolbar" onClick={(event) => event.stopPropagation()} role="toolbar">
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
        </div>

        <div className="scene-document">
          <span className="status-dot cyan" />
          <strong>{displaySceneName}</strong>
          <span className="unsaved-dot has-tip" data-tip={copy.unsaved} />
        </div>

        <div className="top-actions">
          <div aria-label={copy.language} className="language-switch" role="group">
            <button aria-pressed={language === 'zh'} className="has-tip" data-tip={copy.chinese} onClick={() => setLanguage('zh')} type="button">中</button>
            <button aria-pressed={language === 'en'} className="has-tip" data-tip={copy.english} onClick={() => setLanguage('en')} type="button">EN</button>
          </div>
          <button className="quiet-button has-tip" data-tip={copy.chooseImportFile} onClick={() => fileInputRef.current?.click()} type="button">
            <Icon name="folder" />{copy.import}
          </button>
          <button className="primary-button has-tip" data-tip={copy.exportTip} disabled={exportProgress !== null} onClick={() => void exportWorkspace()} type="button">
            <Icon name="export" />{exportProgress === null ? copy.export : `${copy.savingRaw4D} ${Math.round(exportProgress * 100)}%`}
          </button>
        </div>
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
          message={appNotice.message}
          onClose={() => setAppNotice(null)}
          title={appNotice.title}
          tone={appNotice.tone}
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

      {exportMonitor && (
        <div className="export-monitor-backdrop" data-camera-input-block>
          <section aria-label={exportMonitor.kind === 'ply-sequence'
            ? (language === 'zh' ? 'PLY 序列导出监督' : 'PLY sequence export monitor')
            : (language === 'zh' ? '4CGS 保存监督' : '4CGS export monitor')} aria-modal="true" className="export-monitor-dialog" role="dialog">
            <header>
              <div>
                <span>{exportMonitor.kind === 'ply-sequence' ? 'RAW4D · PLY 序列' : '4CGS · V2.6'}</span>
                <strong>{exportMonitor.kind === 'ply-sequence'
                  ? (language === 'zh' ? 'PLY 序列导出监督' : 'PLY sequence export monitor')
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
              <div><dt>{language === 'zh' ? 'Worker' : 'Workers'}</dt><dd>{exportMonitor.progress.workerCount ?? 1}</dd></div>
              <div><dt>{language === 'zh' ? '任务' : 'Tasks'}</dt><dd>{exportMonitor.progress.completedTasks ?? 0}/{exportMonitor.progress.totalTasks ?? 8}</dd></div>
              <div><dt>{language === 'zh' ? '耗时' : 'Elapsed'}</dt><dd>{(exportElapsedMs / 1000).toFixed(1)} s</dd></div>
              <div><dt>{language === 'zh' ? '输入' : 'Input'}</dt><dd>{exportMonitor.kind === 'ply-sequence'
                ? (exportMonitor.plyStats ? `${exportMonitor.plyStats.segmentCount} 段` : '--')
                : `${(exportMonitor.inputBytes / 1_000_000).toFixed(3)}M`}</dd></div>
              <div><dt>{language === 'zh' ? '输出' : 'Output'}</dt><dd>{exportMonitor.outputBytes === undefined ? '--' : `${(exportMonitor.outputBytes / 1_000_000).toFixed(3)}M`}</dd></div>
              <div><dt>{exportMonitor.kind === 'ply-sequence' ? (language === 'zh' ? '帧文件' : 'Frames') : (language === 'zh' ? '压缩比' : 'Ratio')}</dt><dd>{exportMonitor.kind === 'ply-sequence'
                ? (exportMonitor.plyStats ? `${exportMonitor.plyStats.frameCount}` : `${exportMonitor.progress.completedTasks ?? 0}`)
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
            brushRadius={selectionBrushRadius}
            currentFrame={currentFrame}
            memoryPolicy={memoryPolicy}
            onHistoryChange={setHistoryState}
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
            showGuides
            sourceFiles={sourceFiles}
            transform={sceneTransform}
            uniformScale={uniformScale}
            viewportLabel={copy.viewportCanvas}
          />
          <div className="viewport-toolbar" data-camera-input-block>
            <div aria-label={copy.renderModes} className="render-mode-switch" role="group">
              {gaussianRenderModes.map((mode) => (
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
            <div aria-label="SH display level" className="sh-level-switch" role="group">
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
            </div>
            <div className="guide-switches">
              <button aria-pressed={showGrid} className={showGrid ? 'active' : ''} onClick={() => setShowGrid((visible) => !visible)} type="button">{copy.grid}</button>
              <button aria-pressed={showAxes} className={showAxes ? 'active' : ''} onClick={() => setShowAxes((visible) => !visible)} type="button">{copy.axes}</button>
              <button aria-pressed={showHeightRuler} className={showHeightRuler ? 'active' : ''} onClick={() => setShowHeightRuler((visible) => !visible)} type="button">{copy.heightRuler}</button>
            </div>
            {/* #WDD-gpt 2026-08-16 - 序列摘要并入顶部工具栏，避免单独占用第二行遮挡视口。 */}
            {status.phase === 'ready' && status.raw4dSequence && (
              <div className="raw4d-sequence-badge">
                <strong>RAW4D × {status.raw4dSequence.segmentCount}</strong>
                <span>{copy.sequenceSegment} {status.raw4dSequence.segmentIndex + 1}/{status.raw4dSequence.segmentCount}</span>
                <span>{copy.sequenceBoundaryMerged} {status.raw4dSequence.boundaryFramesRemoved}</span>
                <span>{copy.sequenceTracks} {status.raw4dSequence.permanentTrackCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</span>
                <span>SH{status.shBands ?? 0} · {status.raw4dSequence.sharedShCoefficientCount}D</span>
                <span>{copy.sequenceShSeparated} {(Math.max(0, status.raw4dSequence.sharedShSavedBytes) / 1_000_000).toFixed(3)}M</span>
              </div>
            )}
          </div>
          <div className="camera-help" data-camera-input-block>{copy.cameraMoveHint}</div>
          {/* #WDD-gpt 2026-08-16 - 使用实时 3D 投影导航立方体同步相机姿态，并隔离主视口的鼠标输入。 */}
          <ViewCube3D
            inspectorOpen={inspectorPanelVisible}
            labels={cameraViewLabels}
            runtime={viewportRuntime}
            title={copy.cameraCubeTip}
          />
          {status.phase === 'error' && (
            <div className="viewport-error">
              <strong>{copy.viewportFailed}</strong>
              <span>{localizedStatusMessage}</span>
            </div>
          )}
          {status.phase === 'loading' && (
            <div className="viewport-loading" role="status">
              <span className="loading-kicker">{status.format === '4CGS' ? '4CGS V2.4' : copy.raw4dStream}</span>
              <strong>{localizedStatusMessage}</strong>
              <div className="loading-progress"><i style={{ width: `${(status.progress ?? 0) * 100}%` }} /></div>
              <small>{Math.round((status.progress ?? 0) * 100)}%</small>
            </div>
          )}
        </section>

        <aside className="toolrail operation-toolrail glass-panel" aria-label={copy.operationTools} data-camera-input-block>
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
        </aside>

        {/* #WDD-gpt  2026-08-16 - 选择形态默认收成操作栏下方单列，点中后才在右侧展开参数详情。 */}
        <aside className="toolrail selection-toolrail glass-panel" aria-label={copy.selectionPanel} data-camera-input-block>
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
        </aside>

        {activeSelectionDescriptor && (
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
                    onClick={() => void viewportRuntime?.selectGaussiansInCylinder('replace')}
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

        {inspectorPanelVisible && <aside aria-label={copy.inspector} className="panel inspector-panel glass-panel" data-camera-input-block>
          {/* #WDD-gpt 2026-08-15 - 检查器按职责分页，避免属性长列表挤压性能图表。 */}
          <nav aria-label={copy.inspectorTabs} className="inspector-tabs" role="tablist">
            {inspectorTabs.map((tab) => (
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

            {inspectorTab === 'performance' && (
              <section aria-labelledby="inspector-tab-performance" className="inspector-section memory-settings" id="inspector-panel-performance" role="tabpanel">
                <h3><Icon name="chevron" size={13} />{copy.memoryAndVram}</h3>
                <PerformanceDiagnosticsPanel snapshot={performanceSnapshot} />
                <label className="memory-mode-field">
                  <span>{copy.budgetMode}</span>
                  <select
                    aria-label={copy.memoryModeLabel}
                    className="ui-select"
                    onChange={(event) => requestMemoryMode(event.target.value as Gaussian4DMemoryMode)}
                    value={memoryMode}
                  >
                    <option value="auto">{copy.modeAuto}</option>
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
                  <div><dt>{copy.gpuDecode}</dt><dd>{status.gpuBackend === 'storage-buffer' ? 'StorageBuffer · WGSL' : status.gpuBackend === 'texture' ? 'Texture · WGSL' : '--'}</dd></div>
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
                    gs2mesh={{
                      canExport: gs2MeshPluginRef.current?.canExport ?? false,
                      disabled: transformDisabled,
                      gaussianVisible,
                      language,
                      meshVisible: gs2MeshVisible,
                      onCancel: () => gs2MeshPluginRef.current?.cancel(),
                      onClear: clearGS2Mesh,
                      onExport: exportGS2Mesh,
                      onGaussianVisibleChange: changeGaussianVisible,
                      onMeshVisibleChange: changeGS2MeshVisible,
                      onRun: runGS2Mesh,
                      state: gs2MeshState,
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
              </div>}
            </section>
          </div>
        )}
      </section>


      <section aria-label={copy.timeline} className="timeline-panel glass-panel" data-camera-input-block>
        <div className="playback-controls">
          <button aria-label={copy.firstFrame} className="has-tip" data-tip={copy.firstFrame} onClick={() => { setCurrentFrame(0); setIsPlaying(false); }} type="button"><Icon name="stepBack" size={15} /></button>
          <button aria-label={copy.previousFrame} className="has-tip" data-tip={copy.previousFrame} onClick={() => { setCurrentFrame((frame) => Math.max(0, frame - 1)); setIsPlaying(false); }} type="button"><span>−1</span></button>
          <button aria-label={isPlaying ? copy.pause : copy.play} className="play-button has-tip" data-tip={isPlaying ? copy.pause : copy.play} onClick={() => setIsPlaying((playing) => !playing)} type="button"><Icon name={isPlaying ? 'pause' : 'play'} size={16} /></button>
          <button aria-label={copy.nextFrame} className="has-tip" data-tip={copy.nextFrame} onClick={() => { setCurrentFrame((frame) => Math.min(timelineEndFrame, frame + 1)); setIsPlaying(false); }} type="button"><span>+1</span></button>
          <button aria-label={copy.lastFrame} className="has-tip" data-tip={copy.lastFrame} onClick={() => { setCurrentFrame(timelineEndFrame); setIsPlaying(false); }} type="button"><Icon name="stepForward" size={15} /></button>
        </div>

        <div className="timeline-main">
          <div className="timeline-header">
            <div className="timeline-title">
              <span>{copy.masterTimeline}</span>
              {status.raw4dSequence && (
                <small><i className="keyframe-swatch" />{copy.timelineKeyframes}<i className="segment-swatch" />{copy.timelineSegments}</small>
              )}
            </div>
            <div className="timeline-readout">
              <strong>{frameTimecode}</strong>
              {/* #WDD-gpt 2026-08-16 - 播放时逐帧显示零填充当前帧与总帧数，避免只能从时间码反推帧号。 */}
              <span aria-label={frameCounter} className="timeline-frame-counter">{frameCounter}</span>
            </div>
          </div>
          <div className="timeline-track">
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
              onChange={(event) => { setCurrentFrame(Number(event.target.value)); setIsPlaying(false); }}
              style={{ '--timeline-progress': `${(currentFrame / Math.max(1, timelineEndFrame)) * 100}%` } as React.CSSProperties}
              type="range"
              value={currentFrame}
            />
            <div className="timeline-marks" aria-hidden="true">{timelineMarks.map((frame) => <span key={frame}>{frame}</span>)}</div>
          </div>
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
      </section>

      <footer className="statusbar" data-camera-input-block>
        <span><i className={status.phase === 'ready' ? 'ok' : ''} />{status.phase === 'ready' ? copy.sceneReady : copy.scenePreparing}</span>
        {/* #WDD-gpt 2026-08-16 - 左下角同时展示全局有效点、当前活动片段显示点和全局软删除点。 */}
        <dl aria-label={copy.gaussianStatusSummary} className="gaussian-status-summary">
          <div><dt>{copy.activeGaussianStatus}</dt><dd>{statusActiveCount.toLocaleString(gaussianCountLocale)}</dd></div>
          <div><dt>{copy.currentFrameGaussianStatus}</dt><dd>{statusCurrentFrameDisplayedCount.toLocaleString(gaussianCountLocale)}</dd></div>
          <div className={statusDeletedCount > 0 ? 'deleted' : ''}><dt>{copy.deletedGaussianStatus}</dt><dd>{statusDeletedCount.toLocaleString(gaussianCountLocale)}</dd></div>
        </dl>
        <span
          aria-label={`${copy.memoryUsage}: JS ${formatBytes(memoryUsage.jsHeapBytes)}, 4D ${formatBytes(memoryUsage.managedCpuBytes)}, GPU ${formatBytes(memoryUsage.gpuBytes)}`}
          className="memory-usage has-tip"
          data-tip={`${copy.jsHeapLabel} ${formatBytes(memoryUsage.jsHeapBytes)} / ${formatBytes(memoryUsage.jsHeapLimitBytes)} · ${copy.dataMemoryLabel} ${formatBytes(memoryUsage.managedCpuBytes)} / ${formatBytes(memoryUsage.cpuBudgetBytes)} · ${copy.gpuVramLabel} ${formatBytes(memoryUsage.gpuBytes)} / ${formatBytes(memoryUsage.gpuBudgetBytes)}`}
        >
          <b>MEM</b>
          <em>JS {formatBytes(memoryUsage.jsHeapBytes)}</em>
          <em>4D {formatBytes(memoryUsage.managedCpuBytes)}</em>
          <em>GPU {formatBytes(memoryUsage.gpuBytes)}</em>
        </span>
      </footer>
    </main>
  );
}
