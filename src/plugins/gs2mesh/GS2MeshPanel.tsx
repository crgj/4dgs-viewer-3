import { useState } from 'react';
import { ValidatedNumberInput } from '../../app/components/ValidatedNumberInput';
import type { UiLanguage } from '../../app/i18n';
import type { GS2MeshOptions, GS2MeshState } from './GS2MeshTypes';
import './GS2MeshPanel.css';

const COPY = {
  zh: {
    title: 'GS2Mesh 当前帧重建',
    local: 'WebGPU 快速预览 · GOF 后台细化 · 纯前端',
    // #WDD-gpt 2026-08-15 - Explain that high modes use real active bricks and recycled buffers rather than a full cubic allocation.
    description: '第一层快速生成预览；第二层按真实毫米尺寸计算活动 GOF 分区，并执行特征保持平滑与等值面约束。',
    resolution: '快速预览精度',
    unitScale: '每场景单位（mm）',
    targetVoxel: '目标叶子体素',
    smoothing: '特征保持平滑',
    isoLevel: '表面阈值',
    maxGaussians: 'Gaussian 上限',
    views: 'Visual Hull 视角',
    meshVisible: '显示 Mesh',
    gaussianVisible: '显示 Gaussian',
    run: '将当前帧转换为 Mesh',
    retry: '重新生成',
    cancel: '取消',
    clear: '清除 Mesh',
    export: '导出 PLY',
    idle: '请固定到需要重建的帧，并让当前摄像机中心对准目标表面。',
    cancelled: '重建已取消。',
    success: 'Mesh 已加入当前场景。',
    frame: '帧',
    vertices: '顶点',
    triangles: '三角形',
    gaussians: '参与 Gaussian',
    backend: '重建后端',
    previewBackend: '快速预览',
    stages: {
      capturing: '正在采样当前帧 Gaussian 几何与 opacity',
      matching: 'WebGPU 正在计算稀疏有向占据场与 Visual Hull',
      fusing: '预览 Mesh 已生成，正在计算毫米级 GOF 分区、回投与特征保持平滑',
      installing: '正在把三角网格加入 PlayCanvas 场景',
    },
  },
  en: {
    title: 'GS2Mesh Current Frame',
    local: 'WebGPU preview · GOF refinement · frontend only',
    description: 'Layer one builds a fast preview. Layer two evaluates metric GOF bricks, then applies feature-preserving smoothing with level-set constraints.',
    resolution: 'Preview quality',
    unitScale: 'Millimeters per unit',
    targetVoxel: 'Target leaf voxel',
    smoothing: 'Feature smoothing',
    isoLevel: 'Surface threshold',
    maxGaussians: 'Gaussian limit',
    views: 'Visual Hull views',
    meshVisible: 'Show mesh',
    gaussianVisible: 'Show Gaussian',
    run: 'Convert current frame to mesh',
    retry: 'Rebuild',
    cancel: 'Cancel',
    clear: 'Clear mesh',
    export: 'Export PLY',
    idle: 'Stop on the frame to reconstruct and aim the camera center at the target surface.',
    cancelled: 'Reconstruction cancelled.',
    success: 'The mesh is now in the current scene.',
    frame: 'Frame',
    vertices: 'Vertices',
    triangles: 'Triangles',
    gaussians: 'Input Gaussians',
    backend: 'Reconstruction backend',
    previewBackend: 'Fast preview',
    stages: {
      capturing: 'Sampling current-frame Gaussian geometry and opacity',
      matching: 'WebGPU is evaluating sparse oriented occupancy and the Visual Hull',
      fusing: 'The preview is ready; processing metric GOF bricks, projection, and feature-preserving smoothing',
      installing: 'Adding the triangle mesh to the PlayCanvas scene',
    },
  },
} as const;

interface GS2MeshPanelProps {
  readonly disabled: boolean;
  readonly language: UiLanguage;
  readonly state: GS2MeshState;
  readonly meshVisible: boolean;
  readonly gaussianVisible: boolean;
  readonly canExport: boolean;
  readonly onRun: (options: GS2MeshOptions) => void;
  readonly onCancel: () => void;
  readonly onClear: () => void;
  readonly onExport: () => void;
  readonly onMeshVisibleChange: (visible: boolean) => void;
  readonly onGaussianVisibleChange: (visible: boolean) => void;
}

const runningStages = new Set<GS2MeshState['stage']>(['capturing', 'matching', 'fusing', 'installing']);

export function GS2MeshPanel({
  disabled,
  language,
  state,
  meshVisible,
  gaussianVisible,
  canExport,
  onRun,
  onCancel,
  onClear,
  onExport,
  onMeshVisibleChange,
  onGaussianVisibleChange,
}: GS2MeshPanelProps) {
  const copy = COPY[language];
  const [fieldResolution, setFieldResolution] = useState(96);
  const [isoLevel, setIsoLevel] = useState(0.28);
  const [maxGaussians, setMaxGaussians] = useState(80_000);
  const [viewCount, setViewCount] = useState(8);
  const [sceneUnitMillimeters, setSceneUnitMillimeters] = useState(1000);
  // #WDD-gpt 2026-08-15 - Default to the browser-safe metric preset validated on the full RAW4D scene; sub-millimeter modes remain explicit opt-ins.
  const [targetVoxelMillimeters, setTargetVoxelMillimeters] = useState(2);
  const [smoothingIterations, setSmoothingIterations] = useState(3);
  const running = runningStages.has(state.stage);
  const message = state.stage === 'idle'
    ? copy.idle
    : state.stage === 'success'
      ? state.warning ?? copy.success
      : state.stage === 'cancelled'
        ? copy.cancelled
        : state.stage === 'error'
          ? state.error
          : copy.stages[state.stage];

  return (
    <section className={`gs2mesh-card ${state.stage}${state.warning ? ' warning' : ''}`} data-camera-input-block>
      <div className="gs2mesh-heading">
        <span aria-hidden="true">△</span>
        <div><strong>{copy.title}</strong><small>{copy.local}</small></div>
      </div>
      <p>{copy.description}</p>
      <div className="gs2mesh-config-grid">
        <label><span>{copy.resolution}</span><select className="ui-select" onChange={(event) => setFieldResolution(Number(event.target.value))} value={fieldResolution}><option value="64">64³ · Fast</option><option value="96">96³ · Balanced</option><option value="128">128³ · Fine</option><option value="160">160³ · Dense Ultra</option><option value="256">256³ · Sparse</option><option value="512">512³ · Sparse Fine</option><option value="1024">1024³ · Sparse Max</option></select></label>
        <label><span>{copy.unitScale}</span><ValidatedNumberInput aria-label={copy.unitScale} max={1_000_000} min={0.001} onCommit={setSceneUnitMillimeters} precision={3} step={1} value={sceneUnitMillimeters} /></label>
        <label><span>{copy.targetVoxel}</span><select className="ui-select" onChange={(event) => setTargetVoxelMillimeters(Number(event.target.value))} value={targetVoxelMillimeters}><option value="0.25">0.25 mm · Extreme</option><option value="0.5">0.5 mm · Ultra</option><option value="1">1.0 mm · Fine</option><option value="2">2.0 mm · Recommended</option></select></label>
        <label><span>{copy.smoothing}</span><select className="ui-select" onChange={(event) => setSmoothingIterations(Number(event.target.value))} value={smoothingIterations}><option value="0">Off</option><option value="2">2× · Light</option><option value="3">3× · Recommended</option><option value="5">5× · Smooth</option></select></label>
        <label><span>{copy.isoLevel}</span><ValidatedNumberInput aria-label={copy.isoLevel} max={0.7} min={0.08} onCommit={setIsoLevel} precision={2} step={0.01} value={isoLevel} /></label>
        <label><span>{copy.maxGaussians}</span><select className="ui-select" onChange={(event) => setMaxGaussians(Number(event.target.value))} value={maxGaussians}><option value="40000">40K</option><option value="80000">80K</option><option value="120000">120K</option><option value="160000">160K</option></select></label>
        <label><span>{copy.views}</span><ValidatedNumberInput aria-label={copy.views} integer max={16} min={4} onCommit={setViewCount} precision={0} step={1} value={viewCount} /></label>
      </div>
      <div aria-live="polite" className="gs2mesh-status" role="status">
        <span>{message}</span>
        {running && <div><i style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>}
      </div>
      {state.stage === 'success' && (
        <dl className="gs2mesh-metrics">
          <div><dt>{copy.frame}</dt><dd>{state.frame}</dd></div>
          <div><dt>{copy.vertices}</dt><dd>{state.vertexCount?.toLocaleString()}</dd></div>
          <div><dt>{copy.triangles}</dt><dd>{state.triangleCount?.toLocaleString()}</dd></div>
          <div><dt>{copy.gaussians}</dt><dd>{state.gaussianCount?.toLocaleString()}</dd></div>
          <div><dt>{copy.previewBackend}</dt><dd>{state.previewBackend ?? '--'}</dd></div>
          <div><dt>{copy.backend}</dt><dd>{state.backend ?? '--'}</dd></div>
        </dl>
      )}
      <div className="gs2mesh-visibility">
        <label><input checked={meshVisible} disabled={!canExport} onChange={(event) => onMeshVisibleChange(event.target.checked)} type="checkbox" />{copy.meshVisible}</label>
        <label><input checked={gaussianVisible} onChange={(event) => onGaussianVisibleChange(event.target.checked)} type="checkbox" />{copy.gaussianVisible}</label>
      </div>
      <div className="gs2mesh-actions">
        {running ? (
          <button className="danger" onClick={onCancel} type="button">{copy.cancel}</button>
        ) : (
          <button className="primary" disabled={disabled} onClick={() => onRun({
            fieldResolution,
            isoLevel,
            maxGaussians,
            viewCount,
            sceneUnitMillimeters,
            targetVoxelMillimeters,
            smoothingIterations,
          })} type="button">{state.stage === 'idle' ? copy.run : copy.retry}</button>
        )}
        <button disabled={!canExport} onClick={onClear} type="button">{copy.clear}</button>
        <button disabled={!canExport} onClick={onExport} type="button">{copy.export}</button>
      </div>
    </section>
  );
}
