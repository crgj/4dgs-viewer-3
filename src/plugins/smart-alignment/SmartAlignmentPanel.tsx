import type { UiLanguage } from '../../app/i18n';
import type { SmartAlignmentState } from './SmartAlignmentTypes';
import './SmartAlignmentPanel.css';

const COPY = {
  zh: {
    title: '智能人物对齐',
    description: '先用当前摄像机把人物放在屏幕合适位置；本地姿态与人脸模型会以此为起点多视角扶正角色并对齐站立中心。',
    action: '分析并对齐',
    retry: '重新分析',
    running: '正在分析…',
    local: '本地推理 · 不上传图像',
    people: '人物',
    views: '有效视角',
    confidence: '置信度',
    idle: '先调整摄像机让人物清晰完整，再开始分析；低置信度结果不会写入变换。',
    success: '对齐完成，角色朝上且站立中心已归零。',
    stages: {
      'loading-model': '正在加载本地姿态模型',
      'capturing-orientation': '正以当前摄像机为起点渲染十六个环绕视图',
      'analyzing-orientation': '正在融合人物朝向',
      'analyzing-ground': '正在计算多人站立中心',
      applying: '正在写入场景变换',
      verifying: '正在复检对齐后的残余倾角',
      refining: '正在校正残余倾角并重新锁定脚点',
    },
  },
  en: {
    title: 'Smart Character Alignment',
    description: 'Frame the character clearly with the current camera first. Local pose and face models then use that view as the multi-view starting point.',
    action: 'Analyze & align',
    retry: 'Run again',
    running: 'Analyzing…',
    local: 'On-device inference · no image upload',
    people: 'People',
    views: 'Valid views',
    confidence: 'Confidence',
    idle: 'Frame the complete character clearly, then start analysis. Low-confidence results are never applied.',
    success: 'Alignment complete. Characters are upright and their standing center is at the origin.',
    stages: {
      'loading-model': 'Loading the local pose model',
      'capturing-orientation': 'Rendering sixteen orbit views from the current camera',
      'analyzing-orientation': 'Fusing character orientation',
      'analyzing-ground': 'Solving the multi-person standing center',
      applying: 'Applying the scene transform',
      verifying: 'Checking the residual tilt after alignment',
      refining: 'Correcting residual tilt and re-locking feet',
    },
  },
} as const;

interface SmartAlignmentPanelProps {
  readonly disabled: boolean;
  readonly language: UiLanguage;
  readonly onRun: () => void;
  readonly state: SmartAlignmentState;
}

const isRunning = (state: SmartAlignmentState): boolean => (
  state.stage !== 'idle' && state.stage !== 'success' && state.stage !== 'error'
);

export function SmartAlignmentPanel({
  disabled,
  language,
  onRun,
  state,
}: SmartAlignmentPanelProps) {
  const copy = COPY[language];
  const running = isRunning(state);
  const stageText = state.stage === 'success'
    ? copy.success
    : state.stage === 'error'
      ? state.error
      : state.stage === 'idle'
        ? copy.idle
        : copy.stages[state.stage];

  return (
    <section className={`smart-alignment-card ${state.stage}`} data-camera-input-block>
      <div className="smart-alignment-heading">
        <span aria-hidden="true" className="smart-alignment-mark">✦</span>
        <div>
          <strong>{copy.title}</strong>
          <small>{copy.local}</small>
        </div>
      </div>
      <p>{copy.description}</p>
      <div aria-live="polite" className="smart-alignment-status" role="status">
        <span>{stageText}</span>
        {running && <div className="smart-alignment-progress"><i style={{ width: `${Math.round(state.progress * 100)}%` }} /></div>}
      </div>
      {(state.peopleCount !== undefined || state.confidence !== undefined) && (
        <dl className="smart-alignment-metrics">
          <div><dt>{copy.people}</dt><dd>{state.peopleCount ?? 0}</dd></div>
          <div><dt>{copy.views}</dt><dd>{state.viewsUsed ?? 0}</dd></div>
          <div><dt>{copy.confidence}</dt><dd>{Math.round((state.confidence ?? 0) * 100)}%</dd></div>
        </dl>
      )}
      <button disabled={disabled || running} onClick={onRun} type="button">
        <span aria-hidden="true">◎</span>
        {running ? copy.running : state.stage === 'idle' ? copy.action : copy.retry}
      </button>
    </section>
  );
}
