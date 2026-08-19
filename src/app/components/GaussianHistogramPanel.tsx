import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { GaussianSelectionMode } from '../../features/gaussian/edit/GaussianEditStore';
import type {
  ViewportGaussianHistogram,
  ViewportRuntime,
  ViewportSelectionScope,
} from '../../features/viewport/runtime/ViewportRuntime';
import type {
  GaussianHistogramAggregation,
  GaussianHistogramMetric,
} from '../../features/viewport/runtime/histogram/GaussianHistogram';
import type { UiLanguage } from '../i18n';
import { UiSelect } from './UiSelect';
import { ValidatedNumberInput } from './ValidatedNumberInput';

interface GaussianHistogramPanelProps {
  readonly bufferId?: string;
  readonly currentFrame: number;
  readonly deletedCount: number;
  readonly language: UiLanguage;
  readonly inspectorOpen: boolean;
  readonly onSelectionCreated: () => void;
  readonly onScopeChange: (scope: ViewportSelectionScope) => void;
  readonly runtime: ViewportRuntime | null;
  readonly scope: ViewportSelectionScope;
}

const metricOptions: readonly { readonly value: GaussianHistogramMetric; readonly zh: string; readonly en: string }[] = [
  { value: 'opacity', zh: '透明度', en: 'Opacity' },
  { value: 'scale-max', zh: '最大尺度', en: 'Max scale' },
  { value: 'volume', zh: '体积', en: 'Volume' },
  { value: 'distance', zh: '距原点', en: 'Origin distance' },
  { value: 'x', zh: '位置 X', en: 'Position X' },
  { value: 'y', zh: '位置 Y', en: 'Position Y' },
  { value: 'z', zh: '位置 Z', en: 'Position Z' },
  { value: 'lifetime-center', zh: '生命周期中心', en: 'Lifetime center' },
  { value: 'lifetime-width', zh: '生命周期半宽', en: 'Lifetime half-width' },
];

const aggregationOptions: readonly { readonly value: GaussianHistogramAggregation; readonly zh: string; readonly en: string }[] = [
  { value: 'maximum', zh: '时间最大值', en: 'Time maximum' },
  { value: 'mean', zh: '时间平均值', en: 'Time mean' },
  { value: 'minimum', zh: '时间最小值', en: 'Time minimum' },
];

function formatHistogramValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 100_000) return value.toExponential(3);
  return value.toLocaleString(undefined, { maximumFractionDigits: absolute < 1 ? 5 : 3 });
}

// #WDD-gpt 2026-08-19 - 底部数据面板把属性分布与稳定 ID 选择合并，拖动范围后直接进入现有选择/删除链路。
export function GaussianHistogramPanel(props: GaussianHistogramPanelProps) {
  const zh = props.language === 'zh';
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<GaussianHistogramMetric>('opacity');
  const [aggregation, setAggregation] = useState<GaussianHistogramAggregation>('maximum');
  const [selectionMode, setSelectionMode] = useState<GaussianSelectionMode>('replace');
  const [analysis, setAnalysis] = useState<ViewportGaussianHistogram | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragRange, setDragRange] = useState<readonly [number, number] | null>(null);
  const [manualRange, setManualRange] = useState<readonly [number, number]>([0, 1]);
  const dragRef = useRef<{ readonly pointerId: number; readonly start: number } | null>(null);

  useEffect(() => {
    if (!open || !props.runtime) return undefined;
    const controller = new AbortController();
    setAnalysis(null);
    setDragRange(null);
    setError(null);
    setProgress(0);
    props.runtime.analyzeGaussianHistogram({
      aggregation,
      metric,
      scope: props.scope,
      signal: controller.signal,
      onProgress: (ratio, message) => {
        setProgress(ratio);
        setProgressMessage(message);
      },
    }).then((result) => {
      if (!controller.signal.aborted) {
        setAnalysis(result);
        setManualRange([result.valueMin, result.valueMax]);
        setProgress(1);
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => controller.abort();
  }, [aggregation, metric, open, props.bufferId, props.currentFrame, props.deletedCount, props.runtime, props.scope]);

  const normalizedPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!analysis) return;
    event.preventDefault();
    const start = normalizedPointer(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, start };
    setDragRange([start, start]);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDragRange([drag.start, normalizedPointer(event)]);
  };
  // #WDD-gpt 2026-08-19 - 拖图与精确数字输入共用同一条稳定 ID 选择路径，避免两种入口行为不一致。
  const applyRangeSelection = (lower: number, upper: number) => {
    if (!analysis || !props.runtime) return;
    try {
      props.runtime.selectGaussiansFromHistogram(analysis.analysisId, Math.min(lower, upper), Math.max(lower, upper), selectionMode);
      props.onSelectionCreated();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !analysis || !props.runtime) return;
    const end = normalizedPointer(event);
    dragRef.current = null;
    const range: readonly [number, number] = [drag.start, end];
    setDragRange(range);
    const span = analysis.rangeMax - analysis.rangeMin;
    const lower = analysis.rangeMin + Math.min(...range) * span;
    const upper = analysis.rangeMin + Math.max(...range) * span;
    setManualRange([lower, upper]);
    applyRangeSelection(lower, upper);
  };

  const maxBin = Math.max(1, ...(analysis?.bins ?? [1]));
  const rangeStart = dragRange ? Math.min(...dragRange) : 0;
  const rangeEnd = dragRange ? Math.max(...dragRange) : 0;
  const rangeValue = analysis && dragRange
    ? `${formatHistogramValue(analysis.rangeMin + rangeStart * (analysis.rangeMax - analysis.rangeMin))} – ${formatHistogramValue(analysis.rangeMin + rangeEnd * (analysis.rangeMax - analysis.rangeMin))}`
    : (zh ? '拖动图表选择数值范围' : 'Drag across the chart to select a value range');

  return (
    <aside className={`gaussian-histogram-panel glass-panel${open ? ' open' : ''}${props.inspectorOpen ? ' inspector-open' : ''}`} data-camera-input-block>
      <button className="gaussian-histogram-toggle" onClick={() => setOpen((value) => !value)} type="button">
        <span><i />{zh ? 'Gaussian 数据' : 'Gaussian Data'}</span>
        <small>{open ? (zh ? '收起' : 'Collapse') : (zh ? '直方图选择' : 'Histogram selection')}</small>
        <b>{open ? '⌄' : '⌃'}</b>
      </button>
      {open && (
        <div className="gaussian-histogram-content">
          <header>
            <UiSelect
              ariaLabel={zh ? '直方图属性' : 'Histogram metric'}
              onChange={setMetric}
              options={metricOptions.map((option) => ({ label: zh ? option.zh : option.en, value: option.value }))}
              placement="above"
              value={metric}
            />
            <div aria-label={zh ? '数据范围' : 'Data scope'} className="histogram-scope" role="group">
              <button aria-pressed={props.scope === 'visible'} onClick={() => props.onScopeChange('visible')} type="button">{zh ? '当前帧可见' : 'Visible frame'}</button>
              <button aria-pressed={props.scope === 'global'} onClick={() => props.onScopeChange('global')} type="button">{zh ? '全部' : 'All'}</button>
            </div>
            <UiSelect
              ariaLabel={zh ? '跨帧统计方式' : 'Time aggregation'}
              disabled={props.scope === 'visible'}
              onChange={setAggregation}
              options={aggregationOptions.map((option) => ({ label: zh ? option.zh : option.en, value: option.value }))}
              placement="above"
              value={aggregation}
            />
            <div aria-label={zh ? '选择方式' : 'Selection mode'} className="histogram-selection-mode" role="group">
              {(['replace', 'add', 'remove'] as const).map((mode) => (
                <button aria-pressed={selectionMode === mode} key={mode} onClick={() => setSelectionMode(mode)} type="button">
                  {zh ? ({ replace: '替换', add: '添加', remove: '移除' }[mode]) : mode}
                </button>
              ))}
            </div>
          </header>
          <div className="histogram-chart-wrap">
            {analysis ? (
              <svg
                aria-label={zh ? 'Gaussian 属性直方图，拖动选择范围' : 'Gaussian property histogram; drag to select'}
                className="histogram-chart"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                preserveAspectRatio="none"
                role="img"
                viewBox="0 0 960 112"
              >
                <g className="histogram-grid"><path d="M0 28H960M0 56H960M0 84H960" /></g>
                {analysis.bins.map((count, index) => {
                  const width = 960 / analysis.bins.length;
                  const height = Math.max(1, count / maxBin * 96);
                  return <rect height={height} key={index} width={Math.max(1, width - 1)} x={index * width} y={104 - height}><title>{count.toLocaleString()}</title></rect>;
                })}
                {dragRange && <rect className="histogram-range" height="112" width={(rangeEnd - rangeStart) * 960} x={rangeStart * 960} y="0" />}
              </svg>
            ) : (
              <div className="histogram-loading">
                <i><b style={{ width: `${Math.round(progress * 100)}%` }} /></i>
                <span>{error ?? `${progressMessage || (zh ? '正在准备数据' : 'Preparing data')} ${Math.round(progress * 100)}%`}</span>
              </div>
            )}
            <div className="histogram-axis"><span>{formatHistogramValue(analysis?.valueMin ?? 0)}</span><b>{rangeValue}</b><span>{formatHistogramValue(analysis?.valueMax ?? 0)}</span></div>
          </div>
          {analysis && (
            <div className="histogram-range-controls">
              <label>
                <span>{zh ? '下限' : 'Minimum'}</span>
                <ValidatedNumberInput
                  aria-label={zh ? '直方图选择下限' : 'Histogram selection minimum'}
                  max={analysis.rangeMax}
                  min={analysis.rangeMin}
                  onCommit={(value) => setManualRange([value, manualRange[1]])}
                  precision={6}
                  step={Math.max((analysis.rangeMax - analysis.rangeMin) / 100, 0.000001)}
                  value={manualRange[0]}
                />
              </label>
              <label>
                <span>{zh ? '上限' : 'Maximum'}</span>
                <ValidatedNumberInput
                  aria-label={zh ? '直方图选择上限' : 'Histogram selection maximum'}
                  max={analysis.rangeMax}
                  min={analysis.rangeMin}
                  onCommit={(value) => setManualRange([manualRange[0], value])}
                  precision={6}
                  step={Math.max((analysis.rangeMax - analysis.rangeMin) / 100, 0.000001)}
                  value={manualRange[1]}
                />
              </label>
              <button onClick={() => applyRangeSelection(manualRange[0], manualRange[1])} type="button">
                {zh ? '选择此范围' : 'Select range'}
              </button>
            </div>
          )}
          <footer>
            <span>{analysis
              ? `${analysis.count.toLocaleString()} ${zh ? '个稳定 Gaussian' : 'stable Gaussians'} · ${props.scope === 'global'
                ? `${analysis.frameCount} ${zh ? '次片段帧采样' : 'segment-frame samples'}`
                : (zh ? '当前帧' : 'current frame')}`
              : '—'}</span>
            <small>{props.scope === 'visible'
              ? (zh ? '仅统计当前片段、当前帧中透明度可见且未删除的点。' : 'Undeleted, opacity-visible points in the active segment and frame.')
              : (zh ? '逐片段逐帧聚合全部未删除稳定 ID；拖动范围会跨片段选择。' : 'Aggregates every undeleted stable ID across every frame and segment.')}</small>
          </footer>
        </div>
      )}
    </aside>
  );
}
