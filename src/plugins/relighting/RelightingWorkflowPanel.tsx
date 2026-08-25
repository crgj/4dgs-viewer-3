import { useEffect, useRef, useState } from 'react';
import type { UiLanguage } from '../../app/i18n';
import { ValidatedNumberInput } from '../../app/components/ValidatedNumberInput';
import { RelightingPanel, type RelightingPanelProps } from './RelightingPanel';
import type { RelightingMeshState } from './RelightingMeshSequence';
import '../gs2mesh/GS2MeshPanel.css';
import './RelightingWorkflowPanel.css';

export type RelightingWorkflowStep = 'mesh' | 'lighting';
export type RelightingMeshStatus = 'idle' | 'running' | 'success' | 'error';

// #WDD-gpt 2026-08-21 - Step 1 使用逐帧原始 Gaussian 独立重建，状态归并为 idle/running/success/error。
export function reconcileRelightingWorkflowStep(
  current: RelightingWorkflowStep,
  previousMeshStage: RelightingMeshStatus,
  nextMeshStage: RelightingMeshStatus,
): RelightingWorkflowStep {
  if (nextMeshStage === 'success' && previousMeshStage !== 'success') return 'lighting';
  if (nextMeshStage !== 'success' && current === 'lighting') return 'mesh';
  return current;
}

interface RelightingMeshPanelProps {
  readonly disabled: boolean;
  readonly language: UiLanguage;
  readonly state: RelightingMeshState;
  readonly totalFrames: number;
  readonly onRun: (
    frameStart: number,
    frameEnd: number,
    isoLevel: number,
    maxGaussians: number,
    fieldResolution: number,
  ) => void;
  readonly onCancel: () => void;
}

const MESH_COPY = {
  zh: {
    title: '逐帧代理 Mesh',
    kicker: '原始 GS · 跨片段 · 不做时序平均',
    description: '逐帧读取当前真实可见的 Gaussian，使用该帧位置、旋转、尺度、颜色与透明度独立重建；统一时间轴可跨 4CGS/RAW4D 片段。',
    frameRange: '帧范围（起-止）',
    isoLevel: '表面阈值',
    maxGaussians: '每帧 Gaussian 上限',
    resolution: '体素分辨率',
    run: '生成逐帧代理',
    retry: '重新生成',
    cancel: '取消',
    currentFrame: '当前帧',
    frameCount: '帧数',
    frameMs: '单帧耗时',
    gaussians: '本帧 GS',
    vertices: '顶点',
    triangles: '三角形',
    backend: '计算后端',
    idle: '选择时间范围和质量后生成。播放会自动切换对应帧的 Mesh 代理。',
    cancelled: '生成已取消。',
    success: '逐帧代理已就绪，可进入 Step 2 布光。',
    stages: {
      capturing: '正在读取当前帧真实 Gaussian',
      rebuilding: '正在使用完整选中集重建当前帧 Mesh',
    },
  },
  en: {
    title: 'Per-frame Proxy Mesh',
    kicker: 'raw GS · cross-segment · no temporal averaging',
    description: 'Rebuild every frame from its actual visible Gaussian positions, rotations, scales, colors, and opacity across the unified 4CGS/RAW4D timeline.',
    frameRange: 'Frame range (start-end)',
    isoLevel: 'Surface threshold',
    maxGaussians: 'Per-frame Gaussian limit',
    resolution: 'Voxel resolution',
    run: 'Build frame proxies',
    retry: 'Rebuild',
    cancel: 'Cancel',
    currentFrame: 'Frame',
    frameCount: 'Frames',
    frameMs: 'Per-frame time',
    gaussians: 'Frame GS',
    vertices: 'Vertices',
    triangles: 'Triangles',
    backend: 'Backend',
    idle: 'Choose a time range and quality. Playback will switch the matching proxy automatically.',
    cancelled: 'Generation cancelled.',
    success: 'Frame proxies are ready. Continue to Step 2 to light the scene.',
    stages: {
      capturing: 'Reading the current frame’s true Gaussians',
      rebuilding: 'Rebuilding the current mesh from the full selected set',
    },
  },
} as const;

function RelightingMeshPanel({
  disabled,
  language,
  state,
  totalFrames,
  onRun,
  onCancel,
}: RelightingMeshPanelProps) {
  const copy = MESH_COPY[language];
  const lastFrame = Math.max(0, totalFrames - 1);
  const [frameStart, setFrameStart] = useState(0);
  const [frameEnd, setFrameEnd] = useState(lastFrame);
  const [isoLevel, setIsoLevel] = useState(0.28);
  const [maxGaussians, setMaxGaussians] = useState(80_000);
  const [fieldResolution, setFieldResolution] = useState(96);
  const lastFrameRef = useRef(lastFrame);
  useEffect(() => {
    if (lastFrame === lastFrameRef.current) return;
    lastFrameRef.current = lastFrame;
    setFrameStart((start) => Math.min(start, lastFrame));
    setFrameEnd(lastFrame);
  }, [lastFrame]);
  const running = state.stage === 'capturing' || state.stage === 'rebuilding';
  const message = state.stage === 'idle'
    ? copy.idle
    : state.stage === 'success'
      ? copy.success
      : state.stage === 'cancelled'
        ? copy.cancelled
        : state.stage === 'error'
          ? state.error
          : copy.stages[state.stage];

  return (
    <section className={`relighting-mesh-card ${state.stage}`} data-camera-input-block>
      <div className="gs2mesh-heading">
        <span aria-hidden="true">◇</span>
        <div><strong>{copy.title}</strong><small>{copy.kicker}</small></div>
      </div>
      <p>{copy.description}</p>
      <div aria-label={copy.kicker} className="relighting-mesh-facts">
        <span>RAW GS</span><span>FRAME EXACT</span><span>FRONTEND</span>
      </div>
      <div className="gs2mesh-config-grid">
        <label className="relighting-mesh-range"><span>{copy.frameRange}</span>
          <span className="relighting-mesh-frame-range">
            <ValidatedNumberInput aria-label={`${copy.frameRange} start`} integer max={lastFrame} min={0} onCommit={setFrameStart} precision={0} step={1} value={Math.min(frameStart, lastFrame)} />
            <ValidatedNumberInput aria-label={`${copy.frameRange} end`} integer max={lastFrame} min={0} onCommit={setFrameEnd} precision={0} step={1} value={Math.min(Math.max(frameEnd, frameStart), lastFrame)} />
          </span>
        </label>
        <label><span>{copy.isoLevel}</span><ValidatedNumberInput aria-label={copy.isoLevel} max={0.7} min={0.08} onCommit={setIsoLevel} precision={2} step={0.01} value={isoLevel} /></label>
        <label><span>{copy.maxGaussians}</span><select aria-label={copy.maxGaussians} className="ui-select" onChange={(event) => setMaxGaussians(Number(event.target.value))} value={maxGaussians}><option value="40000">40K</option><option value="80000">80K</option><option value="120000">120K</option></select></label>
        <label><span>{copy.resolution}</span><select aria-label={copy.resolution} className="ui-select" onChange={(event) => setFieldResolution(Number(event.target.value))} value={fieldResolution}><option value="72">72³ · Fast</option><option value="96">96³ · Balanced</option><option value="128">128³ · Detail</option></select></label>
      </div>
      <div aria-live="polite" className="gs2mesh-status" role="status">
        <span>{message}</span>
        {running && <div><i style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>}
      </div>
      {(running || state.stage === 'success') && (
        <dl className="gs2mesh-metrics relighting-mesh-metrics">
          <div><dt>{copy.currentFrame}</dt><dd>{state.currentFrame ?? '--'}</dd></div>
          <div><dt>{copy.frameCount}</dt><dd>{state.frameCount ?? '--'}</dd></div>
          <div><dt>{copy.frameMs}</dt><dd>{state.frameMs !== undefined ? `${state.frameMs.toFixed(1)} ms` : '--'}</dd></div>
          <div><dt>{copy.gaussians}</dt><dd>{state.gaussianCount?.toLocaleString() ?? '--'}</dd></div>
          <div><dt>{copy.vertices}</dt><dd>{state.vertexCount?.toLocaleString() ?? '--'}</dd></div>
          <div><dt>{copy.triangles}</dt><dd>{state.triangleCount?.toLocaleString() ?? '--'}</dd></div>
          <div className="relighting-mesh-backend"><dt>{copy.backend}</dt><dd>{state.backend ?? '--'}</dd></div>
        </dl>
      )}
      <div className="gs2mesh-actions">
        {running ? (
          <button className="danger" onClick={onCancel} type="button">{copy.cancel}</button>
        ) : (
          <button className="primary" disabled={disabled} onClick={() => onRun(
            Math.min(frameStart, lastFrame),
            Math.min(Math.max(frameEnd, frameStart), lastFrame),
            isoLevel,
            maxGaussians,
            fieldResolution,
          )} type="button">{state.stage === 'idle' ? copy.run : copy.retry}</button>
        )}
      </div>
    </section>
  );
}

interface RelightingWorkflowPanelProps {
  readonly language: UiLanguage;
  readonly step: RelightingWorkflowStep;
  readonly mesh: RelightingMeshPanelProps;
  readonly relighting: RelightingPanelProps;
  readonly onStepChange: (step: RelightingWorkflowStep) => void;
}

const COPY = {
  zh: {
    label: 'GS2Mesh 重光照工作流', step: 'STEP', meshTitle: '生成逐帧代理',
    meshDescription: '原始 Gaussian 逐帧重建，跨片段跟随时间轴',
    lightingTitle: 'Gaussian 重光照', lightingDescription: '添加光源并把光照传递到高斯',
    pending: '待开始', running: '生成中', complete: '已完成', error: '需检查', locked: '等待 Step 1', ready: '可布光', enabled: '已启用',
  },
  en: {
    label: 'GS2Mesh relighting workflow', step: 'STEP', meshTitle: 'Build Frame Proxies',
    meshDescription: 'Exact per-frame Gaussian rebuild across the unified timeline',
    lightingTitle: 'Gaussian Relighting', lightingDescription: 'Add lights and transfer illumination to the Gaussians',
    pending: 'Pending', running: 'Building', complete: 'Complete', error: 'Check required', locked: 'Waiting for Step 1', ready: 'Ready to light', enabled: 'Enabled',
  },
} as const;

const runningStages: ReadonlySet<RelightingMeshState['stage']> = new Set(['capturing', 'rebuilding']);

export function RelightingWorkflowPanel({ language, step, mesh, relighting, onStepChange }: RelightingWorkflowPanelProps) {
  const copy = COPY[language];
  const meshReady = mesh.state.stage === 'success';
  const meshRunning = runningStages.has(mesh.state.stage);
  const meshTone = mesh.state.stage === 'error' ? 'error' : meshRunning ? 'running' : meshReady ? 'complete' : 'pending';
  const meshStatus = meshTone === 'error' ? copy.error : meshTone === 'running' ? copy.running : meshTone === 'complete' ? copy.complete : copy.pending;
  const lightingTone = relighting.state.error ? 'error' : relighting.state.enabled ? 'complete' : meshReady ? 'ready' : 'locked';
  const lightingStatus = lightingTone === 'error' ? copy.error : lightingTone === 'complete' ? copy.enabled : lightingTone === 'ready' ? copy.ready : copy.locked;

  return (
    <section className="relighting-workflow" data-camera-input-block>
      <nav aria-label={copy.label} className="relighting-workflow-steps">
        <button aria-current={step === 'mesh' ? 'step' : undefined} className={`${step === 'mesh' ? 'active ' : ''}${meshTone}`} onClick={() => onStepChange('mesh')} type="button">
          <b><small>{copy.step}</small>1</b><span><strong>{copy.meshTitle}</strong><small>{copy.meshDescription}</small></span><em>{meshStatus}</em>
        </button>
        <i aria-hidden="true" className={meshReady ? 'complete' : ''}>→</i>
        <button aria-current={step === 'lighting' ? 'step' : undefined} className={`${step === 'lighting' ? 'active ' : ''}${lightingTone}`} disabled={!meshReady} onClick={() => onStepChange('lighting')} type="button">
          <b><small>{copy.step}</small>2</b><span><strong>{copy.lightingTitle}</strong><small>{copy.lightingDescription}</small></span><em>{lightingStatus}</em>
        </button>
      </nav>
      <div className="relighting-workflow-body" hidden={step !== 'mesh'}><RelightingMeshPanel {...mesh} /></div>
      <div className="relighting-workflow-body" hidden={step !== 'lighting'}><RelightingPanel {...relighting} /></div>
    </section>
  );
}
