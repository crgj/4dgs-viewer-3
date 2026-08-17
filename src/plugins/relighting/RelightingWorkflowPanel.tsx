import type { ComponentProps } from 'react';
import type { UiLanguage } from '../../app/i18n';
import { GS2MeshPanel } from '../gs2mesh/GS2MeshPanel';
import type { GS2MeshStage } from '../gs2mesh/GS2MeshTypes';
import { RelightingPanel } from './RelightingPanel';
import './RelightingWorkflowPanel.css';

export type RelightingWorkflowStep = 'mesh' | 'lighting';

export function reconcileRelightingWorkflowStep(
  current: RelightingWorkflowStep,
  previousMeshStage: GS2MeshStage,
  nextMeshStage: GS2MeshStage,
): RelightingWorkflowStep {
  if (nextMeshStage === 'success' && previousMeshStage !== 'success') return 'lighting';
  if (nextMeshStage !== 'success' && current === 'lighting') return 'mesh';
  return current;
}

type GS2MeshPanelProps = ComponentProps<typeof GS2MeshPanel>;
type RelightingPanelProps = ComponentProps<typeof RelightingPanel>;

interface RelightingWorkflowPanelProps {
  readonly language: UiLanguage;
  readonly step: RelightingWorkflowStep;
  readonly gs2mesh: GS2MeshPanelProps;
  readonly relighting: RelightingPanelProps;
  readonly onStepChange: (step: RelightingWorkflowStep) => void;
}

const COPY = {
  zh: {
    label: 'GS2Mesh 重光照工作流',
    step: 'STEP',
    meshTitle: '生成 GS2Mesh',
    meshDescription: '从当前帧重建表面与法线代理',
    lightingTitle: 'Gaussian 重光照',
    lightingDescription: '添加光源并把光照传递到高斯',
    pending: '待开始',
    running: '生成中',
    complete: '已完成',
    error: '需检查',
    locked: '等待 Step 1',
    ready: '可布光',
    enabled: '已启用',
  },
  en: {
    label: 'GS2Mesh relighting workflow',
    step: 'STEP',
    meshTitle: 'Build GS2Mesh',
    meshDescription: 'Reconstruct a surface and normal proxy from the current frame',
    lightingTitle: 'Gaussian Relighting',
    lightingDescription: 'Add lights and transfer illumination to the Gaussians',
    pending: 'Pending',
    running: 'Building',
    complete: 'Complete',
    error: 'Check required',
    locked: 'Waiting for Step 1',
    ready: 'Ready to light',
    enabled: 'Enabled',
  },
} as const;

const runningStages: ReadonlySet<GS2MeshPanelProps['state']['stage']> = new Set([
  'capturing', 'matching', 'fusing', 'installing',
]);

// #WDD-gpt 2026-08-17 - 将 GS2Mesh 重建与 Gaussian 重光照组合为一个保留子面板状态的两步前端工作流。
export function RelightingWorkflowPanel({
  language,
  step,
  gs2mesh,
  relighting,
  onStepChange,
}: RelightingWorkflowPanelProps) {
  const copy = COPY[language];
  const meshReady = gs2mesh.state.stage === 'success';
  const meshRunning = runningStages.has(gs2mesh.state.stage);
  const meshTone = gs2mesh.state.stage === 'error'
    ? 'error'
    : meshRunning
      ? 'running'
      : meshReady ? 'complete' : 'pending';
  const meshStatus = meshTone === 'error'
    ? copy.error
    : meshTone === 'running'
      ? copy.running
      : meshTone === 'complete' ? copy.complete : copy.pending;
  const lightingTone = relighting.state.error
    ? 'error'
    : relighting.state.enabled
      ? 'complete'
      : meshReady ? 'ready' : 'locked';
  const lightingStatus = lightingTone === 'error'
    ? copy.error
    : lightingTone === 'complete'
      ? copy.enabled
      : lightingTone === 'ready' ? copy.ready : copy.locked;

  return (
    <section className="relighting-workflow" data-camera-input-block>
      <nav aria-label={copy.label} className="relighting-workflow-steps">
        <button
          aria-current={step === 'mesh' ? 'step' : undefined}
          className={`${step === 'mesh' ? 'active ' : ''}${meshTone}`}
          onClick={() => onStepChange('mesh')}
          type="button"
        >
          <b><small>{copy.step}</small>1</b>
          <span><strong>{copy.meshTitle}</strong><small>{copy.meshDescription}</small></span>
          <em>{meshStatus}</em>
        </button>
        <i aria-hidden="true" className={meshReady ? 'complete' : ''}>→</i>
        <button
          aria-current={step === 'lighting' ? 'step' : undefined}
          className={`${step === 'lighting' ? 'active ' : ''}${lightingTone}`}
          disabled={!meshReady}
          onClick={() => onStepChange('lighting')}
          type="button"
        >
          <b><small>{copy.step}</small>2</b>
          <span><strong>{copy.lightingTitle}</strong><small>{copy.lightingDescription}</small></span>
          <em>{lightingStatus}</em>
        </button>
      </nav>

      <div className="relighting-workflow-body" hidden={step !== 'mesh'}>
        <GS2MeshPanel {...gs2mesh} />
      </div>
      <div className="relighting-workflow-body" hidden={step !== 'lighting'}>
        <RelightingPanel {...relighting} />
      </div>
    </section>
  );
}
