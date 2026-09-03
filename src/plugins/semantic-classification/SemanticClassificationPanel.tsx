import { useMemo, useState } from 'react';
import { ValidatedNumberInput } from '../../app/components/ValidatedNumberInput';
import type { UiLanguage } from '../../app/i18n';
import type { SemanticClassificationOptions } from './SemanticClassificationPlugin';
import type {
  SemanticClassificationState,
  SemanticTag,
} from './SemanticClassificationTypes';
import './SemanticClassificationPanel.css';

const TAG_COLORS = ['#55aaff', '#55dd99', '#ffbf5f', '#d985ff', '#ff6f7d', '#68dbe8', '#c8df60', '#9c8cff'];

const INITIAL_TAGS: readonly SemanticTag[] = [
  { id: 1, name: '人物', prompt: 'person', color: TAG_COLORS[0] },
  { id: 2, name: '地面', prompt: 'ground or floor', color: TAG_COLORS[1] },
  { id: 3, name: '背景', prompt: 'background', color: TAG_COLORS[2] },
];

const COPY = {
  zh: {
    intro: 'CLIPSeg 会在浏览器本地分析均匀时空视角：动态场景自动覆盖多个时间点，只给获得安全时空证据的 Gaussian 分类。',
    model: '模型', views: '时空采样数', threshold: '可信种子概率', seed: '复现种子（仅顺序）', tags: '分类 Tag',
    add: '添加 Tag', run: '开始多视角分类', rerun: '重新分类', cancel: '取消', remove: '移除',
    name: '类别名称', prompt: '模型 Prompt', loading: '正在加载并缓存模型', capturing: '正在生成并抓取均匀视角',
    classifying: 'CLIPSeg 正在分割', projecting: '正在把概率映射回 Gaussian', success: '分类完成',
    cancelled: '已取消', idle: '等待开始', classified: '已分类', unclassified: '未分类', confidence: '平均置信度',
    resultReady: '分类结果已在右侧“分类”面板中打开。', showResult: '查看分类结果',
    cache: '首次下载：WebGPU q4f16 约 116 MB；CPU q8 约 139 MB。按模型 revision 缓存在本站。',
    cacheClear: '只在连续 5 分钟没有下载进度时超时；缓存按完整网址（包括端口）隔离。', points: '个',
  },
  en: {
    intro: 'CLIPSeg analyzes uniform space-time views. Dynamic scenes cover multiple frames and only Gaussians with safe temporal evidence receive a class.',
    model: 'Model', views: 'Space-time samples', threshold: 'Reliable seed probability', seed: 'Replay seed (order only)', tags: 'Class tags',
    add: 'Add tag', run: 'Start multi-view classification', rerun: 'Classify again', cancel: 'Cancel', remove: 'Remove',
    name: 'Class name', prompt: 'Model prompt', loading: 'Loading and caching model', capturing: 'Generating and capturing uniform views',
    classifying: 'CLIPSeg segmentation', projecting: 'Projecting probabilities to Gaussians', success: 'Classification complete',
    cancelled: 'Cancelled', idle: 'Ready', classified: 'Classified', unclassified: 'Unclassified', confidence: 'Mean confidence',
    resultReady: 'Results are open in the Classification inspector tab.', showResult: 'View classification results',
    cache: 'First download: about 116 MB for WebGPU q4f16 or 139 MB for CPU q8, cached by model revision.',
    cacheClear: 'Timeout occurs only after 5 minutes without progress. Cache is isolated by the full origin, including port.', points: 'points',
  },
} as const;

interface SemanticClassificationPanelProps {
  readonly disabled: boolean;
  readonly language: UiLanguage;
  readonly state: SemanticClassificationState;
  readonly onRun: (options: SemanticClassificationOptions) => void;
  readonly onCancel: () => void;
  readonly onShowResults: () => void;
}

export function SemanticClassificationPanel({
  disabled,
  language,
  onCancel,
  onRun,
  onShowResults,
  state,
}: SemanticClassificationPanelProps) {
  const copy = COPY[language];
  const [tags, setTags] = useState<readonly SemanticTag[]>(INITIAL_TAGS);
  const [viewCount, setViewCount] = useState(16);
  const [threshold, setThreshold] = useState(0.55);
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0xffff_ffff));
  const running = ['loading-model', 'capturing', 'classifying', 'projecting'].includes(state.stage);
  const validTags = useMemo(() => tags.filter((tag) => tag.name.trim() && tag.prompt.trim()), [tags]);
  const statusLabel = state.stage === 'loading-model' ? copy.loading
    : state.stage === 'capturing' ? copy.capturing
      : state.stage === 'classifying' ? copy.classifying
        : state.stage === 'projecting' ? copy.projecting
          : state.stage === 'success' ? copy.success
            : state.stage === 'cancelled' ? copy.cancelled
              : state.stage === 'error' ? state.error ?? 'Error' : copy.idle;
  const backendLabel = state.backend === 'webgpu-q4f16'
    ? 'WebGPU · q4f16'
    : state.backend === 'wasm-q8'
      ? 'CPU/WASM · q8'
      : 'WebGPU q4f16 · CPU q8 fallback';
  const updateTag = (id: number, patch: Partial<SemanticTag>) => {
    setTags((current) => current.map((tag) => tag.id === id ? { ...tag, ...patch } : tag));
  };
  const addTag = () => {
    if (tags.length >= 8) return;
    const used = new Set(tags.map((tag) => tag.id));
    let id = 1;
    while (used.has(id)) id += 1;
    setTags((current) => [...current, {
      id,
      name: language === 'zh' ? `类别 ${id}` : `Class ${id}`,
      prompt: '',
      color: TAG_COLORS[(id - 1) % TAG_COLORS.length],
    }]);
  };

  return (
    <section className={`semantic-classification-panel ${state.stage}`}>
      <p className="semantic-intro">{copy.intro}</p>
      <div className="semantic-model-card">
        <span>{copy.model}</span>
        <strong>CLIPSeg RD64 Refined</strong>
        <small>Xenova/clipseg-rd64-refined<br />revision 924dc94 · {backendLabel}</small>
      </div>
      <div className="semantic-settings-grid">
        <label><span>{copy.views}</span><ValidatedNumberInput aria-label={copy.views} disabled={running} integer max={24} min={2} onCommit={setViewCount} precision={0} step={1} value={viewCount} /></label>
        <label><span>{copy.threshold}</span><ValidatedNumberInput aria-label={copy.threshold} disabled={running} max={0.95} min={0.05} onCommit={setThreshold} precision={2} step={0.05} value={threshold} /></label>
        <label className="semantic-seed"><span>{copy.seed}</span><ValidatedNumberInput aria-label={copy.seed} disabled={running} integer max={0xffff_ffff} min={0} onCommit={setSeed} precision={0} step={1} value={seed} /></label>
      </div>
      <div className="semantic-tags-heading"><strong>{copy.tags}</strong><small>{validTags.length}/8</small></div>
      <div className="semantic-tag-list">
        {tags.map((tag) => (
          <div className="semantic-tag-row" key={tag.id}>
            <input aria-label={`${copy.name} ${tag.id}`} disabled={running} draggable={false} onChange={(event) => updateTag(tag.id, { name: event.target.value })} value={tag.name} />
            <input aria-label={`${copy.prompt} ${tag.id}`} disabled={running} draggable={false} onChange={(event) => updateTag(tag.id, { prompt: event.target.value })} placeholder={copy.prompt} value={tag.prompt} />
            <input aria-label={`Color ${tag.id}`} disabled={running} onChange={(event) => updateTag(tag.id, { color: event.target.value })} type="color" value={tag.color} />
            <button aria-label={copy.remove} disabled={running || tags.length <= 1} onClick={() => setTags((current) => current.filter((item) => item.id !== tag.id))} type="button">×</button>
          </div>
        ))}
      </div>
      <button className="semantic-add-tag" disabled={running || tags.length >= 8} onClick={addTag} type="button">＋ {copy.add}</button>
      <div className="semantic-progress" aria-label={statusLabel}>
        <span><strong>{statusLabel}</strong>{state.totalViews ? <small>{state.currentView ?? 0}/{state.totalViews}</small> : null}</span>
        <i><b style={{ width: `${Math.round(state.progress * 100)}%` }} /></i>
        {state.totalBytes ? <small>{(state.downloadedBytes ?? 0) / 1_000_000 < 0.1 ? '0' : ((state.downloadedBytes ?? 0) / 1_000_000).toFixed(1)} / {(state.totalBytes / 1_000_000).toFixed(1)} MB</small> : null}
      </div>
      {state.result && (
        <div className="semantic-result-ready">
          <span><i aria-hidden="true">✓</i>{copy.resultReady}</span>
          <button onClick={onShowResults} type="button">{copy.showResult}</button>
        </div>
      )}
      <div className="semantic-actions">
        {running
          ? <button className="secondary" onClick={onCancel} type="button">{copy.cancel}</button>
          : <button disabled={disabled || validTags.length === 0} onClick={() => onRun({ tags: validTags, viewCount, threshold, seed })} type="button">{state.stage === 'success' ? copy.rerun : copy.run}</button>}
      </div>
      <footer><span>{copy.cache}</span><small>{copy.cacheClear}</small></footer>
    </section>
  );
}
