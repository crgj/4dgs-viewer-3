import { useEffect, useMemo, useState } from 'react';
import { UI_COPY, type UiLanguage } from '../../../app/i18n';
import { formatBytes } from '../../../core/format/formatBytes';
import type { ViewportMemoryUsage } from '../runtime/ViewportRuntime';

const HISTORY_LENGTH = 60;

interface MemorySample {
  readonly js: number;
  readonly data: number;
  readonly gpu: number;
}

interface MemoryMeterProps {
  readonly budget: number | null;
  readonly budgetLabel: string;
  readonly description: string;
  readonly label: string;
  readonly managedLabel: string;
  readonly managedBytes?: number;
  readonly tone: 'js' | 'data' | 'gpu';
  readonly used: number | null;
}

function usageRatio(used: number | null, budget: number | null): number {
  if (used === null || budget === null || budget <= 0) return 0;
  return Math.max(0, used / budget);
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function chartPoints(history: readonly MemorySample[], key: keyof MemorySample): string {
  if (history.length === 0) return '';
  if (history.length === 1) {
    const y = 56 - Math.min(1, history[0][key]) * 52;
    return `0,${y.toFixed(2)} 200,${y.toFixed(2)}`;
  }
  return history.map((sample, index) => {
    const x = index * 200 / (history.length - 1);
    const y = 56 - Math.min(1, sample[key]) * 52;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function MemoryMeter({
  budget,
  budgetLabel,
  description,
  label,
  managedBytes = 0,
  managedLabel,
  tone,
  used,
}: MemoryMeterProps) {
  const ratio = usageRatio(used, budget);
  const managedRatio = Math.min(1, usageRatio(managedBytes, budget));
  const totalRatio = Math.min(1, ratio);
  const untrackedRatio = Math.max(0, totalRatio - managedRatio);
  return (
    <div className={`memory-meter ${ratio > 1 ? 'over-budget' : ''}`}>
      <div className="memory-meter-heading">
        <span><i className={`memory-dot ${tone}`} />{label}</span>
        <strong>{formatBytes(used)} <em>{used === null || budget === null ? '--' : percent(ratio)}</em></strong>
      </div>
      <p>{description}</p>
      <div aria-hidden="true" className="memory-meter-track">
        {tone === 'gpu' && managedRatio > 0 && (
          <i className="memory-meter-managed" style={{ width: `${managedRatio * 100}%` }} />
        )}
        <i
          className={`memory-meter-fill ${tone}`}
          style={{
            left: tone === 'gpu' ? `${managedRatio * 100}%` : 0,
            width: `${(tone === 'gpu' ? untrackedRatio : totalRatio) * 100}%`,
          }}
        />
      </div>
      <small>
        {tone === 'gpu' && managedBytes > 0 ? `${managedLabel} ${formatBytes(managedBytes)} · ` : ''}
        {budgetLabel} {formatBytes(budget)}
      </small>
    </div>
  );
}

export function MemoryTelemetryPanel({
  language,
  usage,
}: {
  readonly language: UiLanguage;
  readonly usage: ViewportMemoryUsage;
}) {
  const copy = UI_COPY[language];
  const [history, setHistory] = useState<MemorySample[]>([]);
  const current = useMemo<MemorySample>(() => ({
    js: usageRatio(usage.jsHeapBytes, usage.jsHeapLimitBytes),
    data: usageRatio(usage.managedCpuBytes, usage.cpuBudgetBytes),
    gpu: usageRatio(usage.gpuBytes, usage.gpuBudgetBytes),
  }), [
    usage.cpuBudgetBytes,
    usage.gpuBudgetBytes,
    usage.gpuBytes,
    usage.jsHeapBytes,
    usage.jsHeapLimitBytes,
    usage.managedCpuBytes,
  ]);

  useEffect(() => {
    // #WDD-gpt 2026-08-15 - 趋势图只保留 60 个归一化数值样本，不保存任何 Gaussian 数据。
    setHistory((previous) => [...previous.slice(-(HISTORY_LENGTH - 1)), current]);
  }, [current]);

  return (
    <section aria-label={copy.memoryPanelLabel} className="memory-telemetry">
      <div className="memory-meters">
        <MemoryMeter
          budget={usage.jsHeapLimitBytes}
          budgetLabel={copy.budget}
          description={copy.jsHeapDescription}
          label={copy.jsHeapLabel}
          managedLabel={copy.managed4DPool}
          tone="js"
          used={usage.jsHeapBytes}
        />
        <MemoryMeter
          budget={usage.cpuBudgetBytes}
          budgetLabel={copy.budget}
          description={copy.dataMemoryDescription}
          label={copy.dataMemoryLabel}
          managedLabel={copy.managed4DPool}
          tone="data"
          used={usage.managedCpuBytes}
        />
        <MemoryMeter
          budget={usage.gpuBudgetBytes}
          budgetLabel={copy.budget}
          description={copy.gpuVramDescription}
          label={copy.gpuVramLabel}
          managedBytes={usage.managedGpuBytes}
          managedLabel={copy.managed4DPool}
          tone="gpu"
          used={usage.gpuBytes}
        />
      </div>
      <div className="memory-residency-grid">
        <section className="memory-residency-card">
          <strong>{copy.cpuResidencyBreakdown}</strong>
          <dl>
            <div><dt>{copy.cpuCompressedCache}</dt><dd>{formatBytes(usage.cpuCompressedBytes)}</dd></div>
            <div><dt>{copy.cpuDecodedCache}</dt><dd>{formatBytes(usage.cpuDecodedBytes)}</dd></div>
            <div><dt>{copy.cpuEvictableCache}</dt><dd>{formatBytes(usage.cpuEvictableBytes)}</dd></div>
            <div><dt>{copy.cpuEvictions}</dt><dd>{usage.cpuEvictionCount}</dd></div>
          </dl>
        </section>
        <section className="memory-residency-card gpu">
          <strong>{copy.gpuResidencyBreakdown}</strong>
          <dl>
            <div><dt>{copy.gpuActiveResources}</dt><dd>{formatBytes(usage.gpuActiveBytes)}</dd></div>
            <div><dt>{copy.gpuReusableCache}</dt><dd>{formatBytes(usage.gpuCachedBytes)}</dd></div>
            <div><dt>{copy.gpuBufferReuse}</dt><dd>{usage.gpuBufferReuseCount}</dd></div>
            <div><dt>{copy.gpuOverBudget}</dt><dd>{formatBytes(usage.gpuOverBudgetBytes)}</dd></div>
            <div><dt>{copy.transferQueue}</dt><dd>{usage.transferQueuedCount}</dd></div>
            <div><dt>{copy.transferActive}</dt><dd>{usage.transferActiveCount}</dd></div>
            <div><dt>{copy.transferCompleted}</dt><dd>{usage.transferCompletedCount} / {usage.transferCancelledCount}</dd></div>
          </dl>
        </section>
      </div>
      <div className="memory-chart">
        <div className="memory-chart-heading">
          <strong>{copy.last60Seconds}</strong>
          <span><i className="js" />JS<i className="data" />4D<i className="gpu" />GPU</span>
        </div>
        <svg
          aria-label={copy.memoryChartLabel}
          preserveAspectRatio="none"
          role="img"
          viewBox="0 0 200 60"
        >
          <path className="memory-chart-grid" d="M0 4H200 M0 30H200 M0 56H200" />
          <polyline className="memory-chart-line js" points={chartPoints(history, 'js')} />
          <polyline className="memory-chart-line data" points={chartPoints(history, 'data')} />
          <polyline className="memory-chart-line gpu" points={chartPoints(history, 'gpu')} />
        </svg>
        <div className="memory-chart-scale"><span>100%</span><span>50%</span><span>0%</span></div>
      </div>
    </section>
  );
}
