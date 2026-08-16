import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../core/format/formatBytes';
import {
  isEditorRedoShortcut,
  isEditorUndoShortcut,
  isGaussianDeleteShortcut,
  isViewportBrowseShortcut,
} from '../features/editor/tools/EditorKeyboardShortcuts';
import {
  createGaussian4DMemoryPolicy,
  detectAutomaticGaussian4DMemoryPolicy,
  type Gaussian4DMemoryMode,
} from '../features/gaussian/memory/Gaussian4DMemoryPolicy';
import type { GaussianRenderMode } from '../features/gaussian/runtime/GaussianRenderMode';
import { GaussianViewport } from '../features/viewport/components/GaussianViewport';
import { MemoryTelemetryPanel } from '../features/viewport/components/MemoryTelemetryPanel';
import {
  INITIAL_EDITOR_HISTORY_STATE,
  INITIAL_VIEWPORT_SELECTION_STATE,
  ViewportRuntime,
  type ViewportEditorTool,
  type ViewportHistoryState,
  type ViewportMemoryUsage,
  type ViewportSelectionState,
  type ViewportSelectionScope,
  type ViewportSelectionTool,
  type ViewportStatus,
  type ViewportTransform,
  type ViewportTransformTool,
  type ViewportTransformSpace,
} from '../features/viewport/runtime/ViewportRuntime';
import { SmartAlignmentPanel } from '../plugins/smart-alignment/SmartAlignmentPanel';
import { SmartAlignmentPlugin } from '../plugins/smart-alignment/SmartAlignmentPlugin';
import {
  INITIAL_SMART_ALIGNMENT_STATE,
  type SmartAlignmentState,
} from '../plugins/smart-alignment/SmartAlignmentTypes';
import { GS2MeshPanel } from '../plugins/gs2mesh/GS2MeshPanel';
import { GS2MeshPlugin } from '../plugins/gs2mesh/GS2MeshPlugin';
import {
  INITIAL_GS2MESH_STATE,
  type GS2MeshOptions,
  type GS2MeshState,
} from '../plugins/gs2mesh/GS2MeshTypes';
import { RelightingPanel } from '../plugins/relighting/RelightingPanel';
import {
  INITIAL_RELIGHTING_STATE,
  type RelightingLightPatch,
  type RelightingSettings,
  type RelightingState,
} from '../plugins/relighting/RelightingTypes';
import {
  UI_COPY,
  localizeRuntimeMessage,
  type UiCopy,
  type UiLanguage,
} from './i18n';

type IconName =
  | 'cursor'
  | 'selectVisible'
  | 'selectGlobal'
  | 'brush'
  | 'rect'
  | 'poly'
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
  return tool === 'select-brush' || tool === 'select-rect' || tool === 'select-poly';
}

const createInitialTransform = (): ViewportTransform => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
});

const transformAxes = ['x', 'y', 'z'] as const;

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

function TransformNumberField({
  axis,
  disabled,
  label,
  onChange,
  step,
  value,
}: {
  axis: typeof transformAxes[number];
  disabled: boolean;
  label: string;
  onChange: (value: number) => void;
  step: number;
  value: number;
}) {
  const formattedValue = String(Math.round(value * 1000) / 1000);
  const [draft, setDraft] = useState(formattedValue);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(formattedValue);
  }, [formattedValue]);

  return (
    <label>
      <b className={`axis-${axis}`}>{axis.toUpperCase()}</b>
      <input
        aria-label={`${label} ${axis.toUpperCase()}`}
        disabled={disabled}
        inputMode="decimal"
        onBlur={() => {
          focused.current = false;
          const next = Number(draft);
          if (draft.trim() === '' || !Number.isFinite(next)) setDraft(formattedValue);
        }}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          const next = Number(nextDraft);
          if (nextDraft.trim() !== '' && Number.isFinite(next)) onChange(next);
        }}
        onFocus={(event) => {
          focused.current = true;
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        onWheel={(event) => event.currentTarget.blur()}
        step={step}
        type="number"
        value={draft}
      />
    </label>
  );
}

function TransformVectorEditor({
  disabled,
  label,
  onChange,
  onReset,
  resetLabel,
  step,
  values,
}: {
  disabled: boolean;
  label: string;
  onChange: (axis: number, value: number) => void;
  onReset: () => void;
  resetLabel: string;
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
          <TransformNumberField axis={axis} disabled={disabled} key={axis} label={label} onChange={(value) => onChange(index, value)} step={step} value={values[index]} />
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

const initialMemoryPolicy = detectAutomaticGaussian4DMemoryPolicy();

const initialMemoryUsage: ViewportMemoryUsage = {
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

const gaussianRenderModes: Array<{
  id: GaussianRenderMode;
  labelKey: keyof UiCopy;
  titleKey: keyof UiCopy;
}> = [
  { id: 'gaussian', labelKey: 'renderGaussian', titleKey: 'renderGaussianTitle' },
  { id: 'point', labelKey: 'renderPoint', titleKey: 'renderPointTitle' },
  { id: 'ellipse', labelKey: 'renderEllipse', titleKey: 'renderEllipseTitle' },
];

type MenuName = 'file' | 'view' | 'plugins' | null;
type InspectorTab = 'transform' | 'gaussian' | 'performance';
type PluginId = 'smart-alignment' | 'gs2mesh' | 'relighting';
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
  { id: 'gs2mesh', mark: '△', titleKey: 'pluginGS2Mesh', descriptionKey: 'pluginGS2MeshDescription' },
  { id: 'relighting', mark: '☀', titleKey: 'pluginRelighting', descriptionKey: 'pluginRelightingDescription' },
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
  const [historyState, setHistoryState] = useState<ViewportHistoryState>(INITIAL_EDITOR_HISTORY_STATE);
  const [status, setStatus] = useState<ViewportStatus>(initialStatus);
  const [memoryUsage, setMemoryUsage] = useState<ViewportMemoryUsage>(initialMemoryUsage);
  const [openMenu, setOpenMenu] = useState<MenuName>(null);
  const [activePlugin, setActivePlugin] = useState<PluginId | null>(null);
  const [pluginWindowMinimized, setPluginWindowMinimized] = useState(false);
  const [pluginWindowPosition, setPluginWindowPosition] = useState<PluginWindowPosition>({ x: 0, y: 0 });
  //WDD-gpt 2026-08-15 - 默认收起低频检查器，把启动后的主要空间完整留给4DGS视口。
  const [inspectorPanelVisible, setInspectorPanelVisible] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('performance');
  const [language, setLanguage] = useState<UiLanguage>('zh');
  const [sceneName, setSceneName] = useState<string | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(true);
  const [renderMode, setRenderMode] = useState<GaussianRenderMode>('gaussian');
  const [sceneTransform, setSceneTransform] = useState<ViewportTransform>(createInitialTransform);
  const [transformSpace, setTransformSpace] = useState<ViewportTransformSpace>('world');
  const [uniformScale, setUniformScale] = useState(true);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [viewportRuntime, setViewportRuntime] = useState<ViewportRuntime | null>(null);
  const [smartAlignmentState, setSmartAlignmentState] = useState<SmartAlignmentState>(INITIAL_SMART_ALIGNMENT_STATE);
  const [gs2MeshState, setGS2MeshState] = useState<GS2MeshState>(INITIAL_GS2MESH_STATE);
  const [relightingState, setRelightingState] = useState<RelightingState>(INITIAL_RELIGHTING_STATE);
  const [gs2MeshVisible, setGS2MeshVisible] = useState(true);
  const [gaussianVisible, setGaussianVisible] = useState(true);
  const [memoryMode, setMemoryMode] = useState<Gaussian4DMemoryMode>('auto');
  const [customCpuGiB, setCustomCpuGiB] = useState(12);
  const [customGpuGiB, setCustomGpuGiB] = useState(6);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const pluginWindowRef = useRef<HTMLElement>(null);
  const pluginDragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly startY: number;
    readonly origin: PluginWindowPosition;
  } | null>(null);
  const smartAlignmentPluginRef = useRef<SmartAlignmentPlugin | null>(null);
  const gs2MeshPluginRef = useRef<GS2MeshPlugin | null>(null);
  if (!smartAlignmentPluginRef.current) smartAlignmentPluginRef.current = new SmartAlignmentPlugin();
  if (!gs2MeshPluginRef.current) gs2MeshPluginRef.current = new GS2MeshPlugin();
  const memoryPolicy = useMemo(
    () => createGaussian4DMemoryPolicy(memoryMode, customCpuGiB, customGpuGiB),
    [customCpuGiB, customGpuGiB, memoryMode],
  );
  const timelineEndFrame = Math.max(0, (status.totalFrames ?? 121) - 1);
  const timelineFps = status.fps ?? 30;
  const copy = UI_COPY[language];
  const activeSelectionDescriptor = isGaussianSelectionTool(activeTool)
    ? selectionTools.find((tool) => tool.id === activeTool) ?? null
    : null;
  const displaySceneName = sceneName ?? copy.untitledScene;

  const transformDisabled = status.phase !== 'ready' || status.splatCount === 0;
  const localizedStatusMessage = localizeRuntimeMessage(language, status.message);
  const pluginStatusById: Readonly<Record<PluginId, PluginStatusTone>> = {
    'smart-alignment': smartAlignmentState.stage === 'success'
      ? 'success'
      : smartAlignmentState.stage === 'error'
        ? 'error'
        : smartAlignmentState.stage === 'idle' ? 'idle' : 'running',
    gs2mesh: gs2MeshState.stage === 'success'
      ? 'success'
      : gs2MeshState.stage === 'error'
        ? 'error'
        : gs2MeshState.stage === 'idle' || gs2MeshState.stage === 'cancelled' ? 'idle' : 'running',
    relighting: relightingState.error ? 'error' : relightingState.enabled ? 'success' : 'idle',
  };
  const activePluginItem = pluginMenuItems.find((plugin) => plugin.id === activePlugin) ?? null;

  useEffect(() => () => {
    smartAlignmentPluginRef.current?.dispose();
    gs2MeshPluginRef.current?.dispose();
  }, []);

  useEffect(() => {
    if (!viewportRuntime) return;
    setRelightingState(viewportRuntime.setRelightingEditing(activePlugin === 'relighting'));
  }, [activePlugin, viewportRuntime]);

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
      const elapsedFrames = Math.floor((now - startTime) * timelineFps / 1000);
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
  }, [isLooping, isPlaying, timelineEndFrame, timelineFps]);

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

  const resetTransform = () => setSceneTransform(createInitialTransform());

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
    anchor.click();
    URL.revokeObjectURL(url);
  };

  // #WDD-gpt  2026-08-16 - RAW4D 保存时根据软删除位集输出压实文件；编辑中的源数据保持稳定 ID。
  const exportWorkspace = async () => {
    setOpenMenu(null);
    if (status.format === 'RAW4D' && viewportRuntime) {
      setExportProgress(0);
      try {
        const blob = await viewportRuntime.exportCompactedRaw4D((progress) => setExportProgress(progress.ratio));
        const stem = (sceneName ?? status.objectName ?? 'dong-editor-3').replace(/\.raw4d$/i, '');
        downloadBlob(blob, `${stem}.raw4d`);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
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
        ...(status.format === 'RAW4D' ? [{
          name: status.objectName ?? copy.gaussianProperties,
          type: 'RAW4D',
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
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'dong-editor-3-workspace.json');
  };

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.raw4d')) {
      setStatus({
        phase: 'error', renderer: copy.unsupportedFile, splatCount: 0,
        message: copy.unsupportedFileMessage,
      });
      event.target.value = '';
      return;
    }
    if (viewportRuntime) gs2MeshPluginRef.current?.clear(viewportRuntime, setGS2MeshState);
    setSceneName(file.name.replace(/\.[^.]+$/, ''));
    setSceneTransform(createInitialTransform());
    setSmartAlignmentState(INITIAL_SMART_ALIGNMENT_STATE);
    setGS2MeshState(INITIAL_GS2MESH_STATE);
    setRelightingState(INITIAL_RELIGHTING_STATE);
    setSelectionState(INITIAL_VIEWPORT_SELECTION_STATE);
    setGS2MeshVisible(true);
    setGaussianVisible(true);
    setActivePlugin(null);
    setInspectorPanelVisible(true);
    setInspectorTab('transform');
    setCurrentFrame(0);
    setIsPlaying(false);
    setSourceFile(file);
    event.target.value = '';
  };

  const newWorkspace = () => {
    if (viewportRuntime) gs2MeshPluginRef.current?.clear(viewportRuntime, setGS2MeshState);
    setSceneName(null);
    setSourceFile(null);
    setSceneTransform(createInitialTransform());
    setSmartAlignmentState(INITIAL_SMART_ALIGNMENT_STATE);
    setGS2MeshState(INITIAL_GS2MESH_STATE);
    setRelightingState(INITIAL_RELIGHTING_STATE);
    setSelectionState(INITIAL_VIEWPORT_SELECTION_STATE);
    setGS2MeshVisible(true);
    setGaussianVisible(true);
    setActivePlugin(null);
    setCurrentFrame(0);
    setIsPlaying(false);
    setOpenMenu(null);
  };

  const frameTimecode = useMemo(() => {
    const seconds = Math.floor(currentFrame / timelineFps);
    const frame = currentFrame % timelineFps;
    return `00:00:${seconds.toString().padStart(2, '0')}:${frame.toString().padStart(2, '0')}`;
  }, [currentFrame, timelineFps]);

  const timelineMarks = useMemo(
    () => [...new Set(Array.from({ length: 5 }, (_, index) => Math.round(timelineEndFrame * index / 4)))],
    [timelineEndFrame],
  );

  return (
    <main
      className="studio-shell"
      data-source-name={status.sourceName ?? ''}
      data-status-phase={status.phase}
      lang={language === 'zh' ? 'zh-CN' : 'en'}
      onClick={() => setOpenMenu(null)}
    >
      <input
        accept=".raw4d"
        aria-label={copy.chooseImportFile}
        className="visually-hidden"
        onChange={handleFileSelection}
        ref={fileInputRef}
        type="file"
      />
      <header className="topbar" data-camera-input-block>
        <div className="brand">
          <strong>Dong Editor 3</strong>
        </div>

        <nav aria-label={copy.mainMenu} className="menu-bar" onClick={(event) => event.stopPropagation()}>
          <div className="menu-anchor">
            <button className={openMenu === 'file' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'file')} type="button">{copy.file}</button>
            {openMenu === 'file' && (
              <div className="dropdown-menu">
                <button onClick={newWorkspace} type="button"><span>{copy.newWorkspace}</span></button>
              </div>
            )}
          </div>
          <div className="menu-anchor">
            <button className={openMenu === 'view' ? 'menu-trigger active' : 'menu-trigger'} onClick={(event) => toggleMenu(event, 'view')} type="button">{copy.view}</button>
            {openMenu === 'view' && (
              <div className="dropdown-menu">
                <button onClick={toggleInspectorPanel} type="button"><span>{copy.inspector}</span><b>{inspectorPanelVisible ? '✓' : ''}</b></button>
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
            disabled={!historyState.canUndo}
            onClick={() => {
              viewportRuntime?.undo();
              setIsPlaying(false);
            }}
            title={`${copy.undo} · Ctrl/⌘ Z`}
            type="button"
          >
            <Icon name="undo" size={16} />
          </button>
          <button
            aria-label={copy.redo}
            disabled={!historyState.canRedo}
            onClick={() => {
              viewportRuntime?.redo();
              setIsPlaying(false);
            }}
            title={`${copy.redo} · Ctrl/⌘ Shift Z`}
            type="button"
          >
            <Icon name="redo" size={16} />
          </button>
        </div>

        <div className="scene-document">
          <span className="status-dot cyan" />
          <strong>{displaySceneName}</strong>
          <span className="unsaved-dot" title={copy.unsaved} />
        </div>

        <div className="top-actions">
          <div aria-label={copy.language} className="language-switch" role="group">
            <button aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')} title={copy.chinese} type="button">中</button>
            <button aria-pressed={language === 'en'} onClick={() => setLanguage('en')} title={copy.english} type="button">EN</button>
          </div>
          <button className="quiet-button" onClick={() => fileInputRef.current?.click()} title={copy.chooseImportFile} type="button">
            <Icon name="folder" />{copy.import}
          </button>
          <button className="primary-button" disabled={exportProgress !== null} onClick={() => void exportWorkspace()} title={copy.exportWorkspace} type="button">
            <Icon name="export" />{exportProgress === null ? copy.export : `${copy.savingRaw4D} ${Math.round(exportProgress * 100)}%`}
          </button>
        </div>
      </header>

      <section className="workspace" ref={workspaceRef}>
        <section className="viewport-stage">
          <GaussianViewport
            activeTool={activeTool}
            brushRadius={selectionBrushRadius}
            currentFrame={currentFrame}
            memoryPolicy={memoryPolicy}
            onHistoryChange={setHistoryState}
            onMemoryChange={setMemoryUsage}
            onRelightingChange={setRelightingState}
            onRuntimeChange={setViewportRuntime}
            onSelectionChange={setSelectionState}
            onStatusChange={setStatus}
            onTransformChange={setSceneTransform}
            renderMode={renderMode}
            selectionScope={selectionScope}
            showGuides
            sourceFile={sourceFile}
            transform={sceneTransform}
            transformSpace={transformSpace}
            uniformScale={uniformScale}
            viewportLabel={copy.viewportCanvas}
          />
          <div className="viewport-toolbar" data-camera-input-block>
            <div aria-label={copy.renderModes} className="render-mode-switch" role="group">
              {gaussianRenderModes.map((mode) => (
                <button
                  aria-pressed={renderMode === mode.id}
                  className={renderMode === mode.id ? 'render-mode-button active' : 'render-mode-button'}
                  key={mode.id}
                  onClick={() => setRenderMode(mode.id)}
                  title={copy[mode.titleKey]}
                  type="button"
                >
                  <i aria-hidden="true" className={`render-mode-glyph ${mode.id}`} />
                  <span>{copy[mode.labelKey]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="camera-help" data-camera-input-block>{copy.cameraMoveHint}</div>
          {status.phase === 'error' && (
            <div className="viewport-error">
              <strong>{copy.viewportFailed}</strong>
              <span>{localizedStatusMessage}</span>
            </div>
          )}
          {status.phase === 'loading' && (
            <div className="viewport-loading" role="status">
              <span className="loading-kicker">{copy.raw4dStream}</span>
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
            <p className="selection-tool-hint">
              {selectionState.phase === 'selecting'
                ? `${copy.selectionAnalyzing} ${Math.round(selectionState.progress * 100)}%`
                : activeTool === 'select-brush'
                  ? copy.selectionBrushDescription
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
                <div className="transform-panel-heading">
                  <h3><Icon name="chevron" size={13} />{copy.transform}</h3>
                  <button className="transform-reset-button" disabled={transformDisabled} onClick={resetTransform} title={copy.resetTransform} type="button">{copy.reset}</button>
                </div>
                <div className={transformDisabled ? 'transform-target empty' : 'transform-target'}>
                  <i aria-hidden="true" />
                  <span>{transformDisabled ? copy.transformTargetEmpty : copy.transformTargetReady}</span>
                </div>
                <div className="transform-control-bar">
                  <div aria-label={copy.editorTools} className="transform-mode-switch" role="group">
                    {operationTools.filter((tool) => isViewportTransformTool(tool.id)).map((tool) => (
                      <button aria-pressed={activeTool === tool.id} disabled={transformDisabled} key={tool.id} onClick={() => chooseTool(tool.id)} type="button">
                        <Icon name={tool.icon} size={14} />{copy[tool.labelKey]}
                      </button>
                    ))}
                  </div>
                  <div aria-label={copy.coordinateSpace} className="transform-space-switch" role="group">
                    <button aria-pressed={transformSpace === 'world'} onClick={() => setTransformSpace('world')} type="button">{copy.worldSpace}</button>
                    <button aria-pressed={transformSpace === 'local'} onClick={() => setTransformSpace('local')} type="button">{copy.localSpace}</button>
                  </div>
                </div>
                <TransformVectorEditor disabled={transformDisabled} label={copy.position} onChange={(axis, value) => updateTransformVector('position', axis, value)} onReset={() => resetTransformVector('position')} resetLabel={copy.reset} step={0.1} values={sceneTransform.position} />
                <TransformVectorEditor disabled={transformDisabled} label={copy.rotation} onChange={(axis, value) => updateTransformVector('rotation', axis, value)} onReset={() => resetTransformVector('rotation')} resetLabel={copy.reset} step={1} values={sceneTransform.rotation} />
                <div className="scale-link-row">
                  <span>{copy.uniformScale}</span>
                  <button aria-pressed={uniformScale} className={uniformScale ? 'scale-link active' : 'scale-link'} onClick={() => setUniformScale((linked) => !linked)} type="button">{uniformScale ? '●' : '○'}</button>
                </div>
                <TransformVectorEditor disabled={transformDisabled} label={copy.scale} onChange={(axis, value) => updateTransformVector('scale', axis, value)} onReset={() => resetTransformVector('scale')} resetLabel={copy.reset} step={0.05} values={sceneTransform.scale} />
                <p className="transform-hint">{copy.transformHint}</p>
              </section>
            )}

            {inspectorTab === 'gaussian' && (
              <section aria-labelledby="inspector-tab-gaussian" className="inspector-section" id="inspector-panel-gaussian" role="tabpanel">
                <h3><Icon name="chevron" size={13} />{copy.gaussianProperties}</h3>
                <dl className="property-list">
                  <div><dt>{copy.gaussianCount}</dt><dd>{status.splatCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
                  <div><dt>{copy.activeGaussianCount}</dt><dd>{Math.max(0, status.splatCount - (selectionState.deletedCount ?? 0)).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}</dd></div>
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
                <label className="memory-mode-field">
                  <span>{copy.budgetMode}</span>
                  <select
                    aria-label={copy.memoryModeLabel}
                    onChange={(event) => setMemoryMode(event.target.value as Gaussian4DMemoryMode)}
                    value={memoryMode}
                  >
                    <option value="auto">{copy.modeAuto}</option>
                    <option value="compatible">{copy.modeCompatible}</option>
                    <option value="balanced">{copy.modeBalanced}</option>
                    <option value="performance">{copy.modePerformance}</option>
                    <option value="custom">{copy.modeCustom}</option>
                  </select>
                </label>
                {memoryMode === 'auto' && (
                  <p className="memory-auto-note">{copy.autoBudgetNote}</p>
                )}
                {memoryMode === 'custom' && (
                  <div className="memory-custom-grid">
                    <label><span>{copy.cpuGiB}</span><input max="64" min="1" onChange={(event) => setCustomCpuGiB(Number(event.target.value))} step="1" type="number" value={customCpuGiB} /></label>
                    <label><span>{copy.gpuGiB}</span><input max="32" min="0.5" onChange={(event) => setCustomGpuGiB(Number(event.target.value))} step="0.5" type="number" value={customGpuGiB} /></label>
                  </div>
                )}
                <MemoryTelemetryPanel language={language} usage={memoryUsage} />
                <dl className="property-list memory-details">
                  <div><dt>{copy.transport}</dt><dd>{memoryUsage.transport === 'shared-array-buffer' ? 'SharedArrayBuffer' : 'Transferable'}</dd></div>
                  <div><dt>{copy.loaderWorker}</dt><dd>{status.decodeBackend === 'wasm' ? 'WASM + TypedArray' : status.decodeBackend === 'fp16-bits' ? 'FP16 Bits + TypedArray' : status.format === 'RAW4D' ? 'TypedArray' : '--'}</dd></div>
                  <div><dt>{copy.gpuDecode}</dt><dd>{status.gpuBackend === 'storage-buffer' ? 'StorageBuffer · WGSL' : status.format === 'RAW4D' ? 'Texture · WGSL' : '--'}</dd></div>
                  <div><dt>{copy.bufferId}</dt><dd className="buffer-id" title={status.bufferId}>{status.bufferId ?? '--'}</dd></div>
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
                    onClick={() => setPluginWindowMinimized((minimized) => !minimized)}
                    title={pluginWindowMinimized ? copy.restorePlugin : copy.minimizePlugin}
                    type="button"
                  >
                    {pluginWindowMinimized ? '□' : '—'}
                  </button>
                  <button aria-label={copy.closePlugin} onClick={() => setActivePlugin(null)} title={copy.closePlugin} type="button">×</button>
                </div>
              </header>
              {!pluginWindowMinimized && <div className="plugin-workspace-content">
                {activePlugin === 'smart-alignment' && (
                  <SmartAlignmentPanel disabled={transformDisabled} language={language} onRun={runSmartAlignment} state={smartAlignmentState} />
                )}
                {activePlugin === 'gs2mesh' && (
                  <GS2MeshPanel
                    canExport={gs2MeshPluginRef.current?.canExport ?? false}
                    disabled={transformDisabled}
                    gaussianVisible={gaussianVisible}
                    language={language}
                    meshVisible={gs2MeshVisible}
                    onCancel={() => gs2MeshPluginRef.current?.cancel()}
                    onClear={clearGS2Mesh}
                    onExport={() => gs2MeshPluginRef.current?.exportLastResult()}
                    onGaussianVisibleChange={changeGaussianVisible}
                    onMeshVisibleChange={changeGS2MeshVisible}
                    onRun={runGS2Mesh}
                    state={gs2MeshState}
                  />
                )}
                {activePlugin === 'relighting' && (
                  <RelightingPanel
                    hasMesh={gs2MeshState.stage === 'success'}
                    language={language}
                    onAddLight={addRelightingLight}
                    onEnabledChange={changeRelightingEnabled}
                    onLightChange={updateRelightingLight}
                    onRemoveLight={removeRelightingLight}
                    onSelectLight={selectRelightingLight}
                    onSettingsChange={updateRelightingSettings}
                    state={relightingState}
                  />
                )}
              </div>}
            </section>
          </div>
        )}
      </section>


      <section aria-label={copy.timeline} className="timeline-panel glass-panel" data-camera-input-block>
        <div className="playback-controls">
          <button aria-label={copy.firstFrame} onClick={() => { setCurrentFrame(0); setIsPlaying(false); }} title={copy.firstFrame} type="button"><Icon name="stepBack" size={15} /></button>
          <button aria-label={copy.previousFrame} onClick={() => { setCurrentFrame((frame) => Math.max(0, frame - 1)); setIsPlaying(false); }} title={copy.previousFrame} type="button"><span>−1</span></button>
          <button aria-label={isPlaying ? copy.pause : copy.play} className="play-button" onClick={() => setIsPlaying((playing) => !playing)} title={isPlaying ? copy.pause : copy.play} type="button"><Icon name={isPlaying ? 'pause' : 'play'} size={16} /></button>
          <button aria-label={copy.nextFrame} onClick={() => { setCurrentFrame((frame) => Math.min(timelineEndFrame, frame + 1)); setIsPlaying(false); }} title={copy.nextFrame} type="button"><span>+1</span></button>
          <button aria-label={copy.lastFrame} onClick={() => { setCurrentFrame(timelineEndFrame); setIsPlaying(false); }} title={copy.lastFrame} type="button"><Icon name="stepForward" size={15} /></button>
        </div>

        <div className="timeline-main">
          <div className="timeline-header">
            <span>{copy.masterTimeline}</span>
            <strong>{frameTimecode}</strong>
          </div>
          <div className="timeline-track">
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
          <button aria-label={copy.loop} className={isLooping ? 'loop-button active' : 'loop-button'} onClick={() => setIsLooping((looping) => !looping)} title={copy.loop} type="button"><Icon name="loop" size={14} /><span>{copy.loopShort}</span></button>
          <span className="fps-badge">{timelineFps} FPS</span>
        </div>
      </section>

      <footer className="statusbar" data-camera-input-block>
        <span><i className={status.phase === 'ready' ? 'ok' : ''} />{status.phase === 'ready' ? copy.sceneReady : copy.scenePreparing}</span>
        <span>{status.splatCount.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')} {copy.splats}</span>
        <span
          aria-label={`${copy.memoryUsage}: JS ${formatBytes(memoryUsage.jsHeapBytes)}, 4D ${formatBytes(memoryUsage.managedCpuBytes)}, GPU ${formatBytes(memoryUsage.gpuBytes)}`}
          className="memory-usage"
          title={`${copy.jsHeapLabel} ${formatBytes(memoryUsage.jsHeapBytes)} / ${formatBytes(memoryUsage.jsHeapLimitBytes)} · ${copy.dataMemoryLabel} ${formatBytes(memoryUsage.managedCpuBytes)} / ${formatBytes(memoryUsage.cpuBudgetBytes)} · ${copy.gpuVramLabel} ${formatBytes(memoryUsage.gpuBytes)} / ${formatBytes(memoryUsage.gpuBudgetBytes)}`}
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
