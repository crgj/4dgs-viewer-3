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
  const issueCount = report?.issues.reduce((sum, issue) => sum + issue.count, 0) ?? 0;
  const hasSafeDeletionCandidates = (report?.safeDeletionCandidates ?? 0) > 0;
  return (
    <section className="model-health-panel">
      <p>检查非有限值、四元数、缩放、透明度、生命周期和包围盒。透明度 Logit 的 <code>-Infinity</code> 是合法的“完全透明”表示，不属于异常，也不会被改写。</p>

      {/* #WDD-gpt 2026-08-17 - 在插件内直接展示严格删除证明，让用户能区分精确零贡献与仅低于阈值。 */}
      <figure aria-label="最安全点删除判定流程" className="model-health-proof">
        <figcaption>
          <span>最安全删除证明</span>
          <strong>只接受全时间轴精确 Alpha = 0</strong>
        </figcaption>
        <div className="model-health-proof-step">
          <b>1</b>
          <span><strong>检查该点全部 opacity 关键帧</strong><small>必须每个值都严格等于 −∞</small></span>
        </div>
        <div className="model-health-proof-branch">
          <span className="pass">全部 −∞ ↓</span>
          <span className="keep">任一值不是 −∞ → 保留</span>
        </div>
        <div className="model-health-proof-step">
          <b>2</b>
          <span><strong>渲染器扩展插值仍为 −∞</strong><small>关键帧之间不会变成有限透明度</small></span>
        </div>
        <div aria-hidden="true" className="model-health-proof-arrow">↓</div>
        <div className="model-health-proof-formula">
          sigmoid(−∞) × lifetime gate = <strong>0</strong>
        </div>
        <div aria-hidden="true" className="model-health-proof-arrow">↓</div>
        <div className="model-health-proof-result">所有播放帧对画面贡献严格为 0 → 可撤销软删除</div>
      </figure>

      <ul className="model-health-guards">
        <li>有限但很小的透明度（包括 −20）一律保留，不再依据渲染阈值删除。</li>
        <li>NaN、+Infinity、缺失关键帧或无效生命周期都视为证据不足，一律保留。</li>
        <li>不使用当前帧、相机遮挡、视锥外、尺寸过小或生命周期暂时关闭作为删除依据。</li>
        <li>这里只写入可撤销删除标记；保存导出时才正式压实数据。</li>
      </ul>

      <div className="model-health-actions">
        <button disabled={disabled || busy} onClick={onAnalyze} type="button">检查模型</button>
        <button
          disabled={disabled || busy || !report || (report.healthy && !hasSafeDeletionCandidates)}
          onClick={onRepair}
          type="button"
        >最安全自动修复</button>
      </div>
      {busy && <p role="status">正在检查并刷新 GPU 数据…</p>}
      {report && (
        <div className={report.healthy ? 'model-health-result healthy' : 'model-health-result warning'}>
          <strong>{report.healthy ? '模型属性正常' : `发现 ${issueCount.toLocaleString()} 项属性异常`}</strong>
          {hasSafeDeletionCandidates && (
            <small className="model-health-safe-candidates">
              发现 {report.safeDeletionCandidates.toLocaleString()} 个最安全删除候选：全部 opacity 关键帧均为 −∞
            </small>
          )}
          {report.fixedValues > 0 && <small>已安全修复 {report.fixedValues.toLocaleString()} 个数值</small>}
          {report.markedDeletedPoints > 0 && <small>已标记删除 {report.markedDeletedPoints.toLocaleString()} 个 Alpha 恒为 0 的点（可撤销，保存时才正式删除）</small>}
          {report.issues.length > 0 && <ul>{report.issues.map((issue) => <li key={issue.code}>{issue.label}：{issue.count.toLocaleString()}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
