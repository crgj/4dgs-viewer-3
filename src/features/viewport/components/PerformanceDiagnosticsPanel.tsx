import type { ViewportPerformanceSnapshot } from '../runtime/ViewportPerformanceMonitor';

// #WDD-gpt 2026-08-16 - 轻量 SVG 曲线与加载阶段指标共享运行时采样，不引入图表运行库。

function graphPath(values: readonly number[], width = 260, height = 54): string {
  if (values.length === 0) return '';
  const maximum = Math.max(1, ...values);
  return values.map((value, index) => {
    const x = values.length === 1 ? width : index * width / (values.length - 1);
    const y = height - Math.min(height, value / maximum * height);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export function PerformanceDiagnosticsPanel({ snapshot }: { readonly snapshot: ViewportPerformanceSnapshot }) {
  return (
    <section className="performance-diagnostics">
      <div className="performance-metrics">
        <div><span>FPS</span><strong>{snapshot.fps > 0 ? snapshot.fps.toFixed(1) : '--'}</strong></div>
        <div><span>Frame Time</span><strong>{snapshot.frameTimeMs > 0 ? `${snapshot.frameTimeMs.toFixed(2)} ms` : '--'}</strong></div>
      </div>
      <svg aria-label="FPS curve" className="performance-chart" preserveAspectRatio="none" viewBox="0 0 260 54">
        <path d={graphPath(snapshot.fpsHistory)} />
      </svg>
      <dl className="property-list performance-device">
        <div><dt>后端</dt><dd>{snapshot.device.backend}</dd></div>
        <div><dt>设备</dt><dd className="has-tip" data-tip={snapshot.device.renderer}>{snapshot.device.renderer}</dd></div>
        <div><dt>CPU</dt><dd>{snapshot.device.logicalCores ? `${snapshot.device.logicalCores} threads` : '--'}</dd></div>
        <div><dt>设备内存</dt><dd>{snapshot.device.deviceMemoryGiB ? `${snapshot.device.deviceMemoryGiB} GiB` : '--'}</dd></div>
      </dl>
      {snapshot.loadTimings.length > 0 && <div className="load-timings"><strong>最近加载阶段</strong>{snapshot.loadTimings.slice(-4).map((timing, index) => <span key={`${timing.label}-${index}`}>{timing.label}<b>{timing.milliseconds.toFixed(1)} ms</b></span>)}</div>}
      {snapshot.warnings.length > 0 && <ul className="performance-warnings">{snapshot.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    </section>
  );
}
