import type { UiLanguage } from '../../app/i18n';
import type { SemanticClassificationResult } from './SemanticClassificationTypes';
import './SemanticClassificationPanel.css';

const COPY = {
  zh: {
    title: '语义分类结果',
    description: '点击类别即可选择对应的 Gaussian。',
    coverage: '安全覆盖',
    classified: '已分类',
    unclassified: '未识别',
    confidence: '平均置信度',
    direct: '直接证据',
    propagated: '三维补全',
    deleted: '已删除',
    points: '个',
    select: '选择此类别',
    views: '视角',
    frames: '时间帧',
    seed: '种子',
    settings: '重新打开识别设置',
    noSeed: '没有找到可靠的直接证据，本次未启动三维补全。请先把主体放大并置于视口中央，或适当降低可信种子概率。',
  },
  en: {
    title: 'Semantic results',
    description: 'Select a class to select its Gaussians.',
    coverage: 'Safe coverage',
    classified: 'Classified',
    unclassified: 'Unclassified',
    confidence: 'Mean confidence',
    direct: 'Direct evidence',
    propagated: '3D completion',
    deleted: 'Deleted',
    points: 'points',
    select: 'Select this class',
    views: 'Views',
    frames: 'Frames',
    seed: 'Seed',
    settings: 'Open classification settings',
    noSeed: 'No reliable direct evidence was found, so 3D completion was not started. Center and enlarge the subject, or lower the reliable seed probability.',
  },
} as const;

interface SemanticClassificationResultsPanelProps {
  readonly language: UiLanguage;
  readonly result: SemanticClassificationResult;
  readonly onOpenSettings: () => void;
  readonly onSelectClass: (classId: number) => void;
}

export function SemanticClassificationResultsPanel({
  language,
  onOpenSettings,
  onSelectClass,
  result,
}: SemanticClassificationResultsPanelProps) {
  const copy = COPY[language];
  return (
    <section aria-label={copy.title} className="inspector-section semantic-results-inspector">
      {/* #WDD-gpt 2026-08-27 - 分类结果独立进入右侧检查器，避免运行参数与长结果列表继续争抢插件弹窗空间。 */}
      <header className="semantic-results-heading">
        <span aria-hidden="true">◈</span>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <b>{Math.round(result.coverage * 100)}%</b>
      </header>
      {result.directCount === 0 && <p className="semantic-no-seed-warning">{copy.noSeed}</p>}
      <dl className="semantic-result-stats">
        <div><dt>{copy.coverage}</dt><dd>{(result.coverage * 100).toFixed(1)}%</dd></div>
        <div><dt>{copy.classified}</dt><dd>{result.classifiedCount.toLocaleString()}</dd></div>
        <div><dt>{copy.unclassified}</dt><dd>{result.unclassifiedCount.toLocaleString()}</dd></div>
        <div><dt>{copy.confidence}</dt><dd>{Math.round(result.meanConfidence * 100)}%</dd></div>
        <div><dt>{copy.direct}</dt><dd>{result.directCount.toLocaleString()}</dd></div>
        <div><dt>{copy.propagated}</dt><dd>{result.propagatedCount.toLocaleString()}</dd></div>
        <div><dt>{copy.deleted}</dt><dd>{result.deletedPointCount.toLocaleString()}</dd></div>
      </dl>
      <div className="semantic-class-results semantic-class-results-docked">
        {result.classes.map((item) => (
          <button disabled={item.count === 0} key={item.id} onClick={() => onSelectClass(item.id)} title={copy.select} type="button">
            <i style={{ background: item.color }} />
            <span><strong>{item.name}</strong><small>{item.prompt}</small></span>
            <b>{item.count.toLocaleString()} {copy.points}<small>{Math.round(item.meanConfidence * 100)}%</small></b>
          </button>
        ))}
      </div>
      <div className="semantic-result-meta">
        <span>{copy.views}<b>{result.viewCount}</b></span>
        <span>{copy.frames}<b>{result.frameCount}</b></span>
        <span>{copy.seed}<b>{result.seed}</b></span>
      </div>
      <button className="semantic-open-settings" onClick={onOpenSettings} type="button">{copy.settings}</button>
    </section>
  );
}
