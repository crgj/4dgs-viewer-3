import type { ModelHealthReport } from './ModelHealth';

// #WDD-gpt 2026-08-16 - 健康检查作为独立可关闭插件呈现，保持右侧属性检查器精简。

export function ModelHealthPanel({
  busy,
  disabled,
  onAnalyze,
  onRepair,
  report,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAnalyze: () => void;
  readonly onRepair: () => void;
  readonly report: ModelHealthReport | null;
}) {
  return (
    <section className="model-health-panel">
      <p>检查非有限值、四元数、缩放、透明度、生命周期和包围盒。仅当点在完整时间轴的每一帧都低于实际渲染阈值时才软删除；当前帧不可见或证据不足的点一律保留。</p>
      <div className="model-health-actions">
        <button disabled={disabled || busy} onClick={onAnalyze} type="button">检查模型</button>
        <button disabled={disabled || busy || !report || report.healthy} onClick={onRepair} type="button">安全自动修复</button>
      </div>
      {busy && <p role="status">正在检查并刷新 GPU 数据…</p>}
      {report && (
        <div className={report.healthy ? 'model-health-result healthy' : 'model-health-result warning'}>
          <strong>{report.healthy ? '模型健康' : `发现 ${report.issues.reduce((sum, issue) => sum + issue.count, 0)} 项异常`}</strong>
          {report.fixedValues > 0 && <small>已安全修复 {report.fixedValues.toLocaleString()} 个数值</small>}
          {report.markedDeletedPoints > 0 && <small>已标记删除 {report.markedDeletedPoints.toLocaleString()} 个全程完全不可见点（可撤销，保存时才正式删除）</small>}
          {report.issues.length > 0 && <ul>{report.issues.map((issue) => <li key={issue.code}>{issue.label}：{issue.count.toLocaleString()}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
