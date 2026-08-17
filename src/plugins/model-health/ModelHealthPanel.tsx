import type { ModelHealthReport } from './ModelHealth';

// #WDD-gpt 2026-08-16 - 健康检查作为独立可关闭插件呈现，保持右侧属性检查器精简。

export function ModelHealthPanel({
  busy,
  disabled,
  onAnalyze,
  onClean,
  report,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAnalyze: () => void;
  readonly onClean: () => void;
  readonly report: ModelHealthReport | null;
}) {
  const issueCount = report?.issues.reduce((sum, issue) => sum + issue.count, 0) ?? 0;
  const hasSafeDeletionCandidates = (report?.safeDeletionCandidates ?? 0) > 0;
  return (
    <section className="model-health-panel">
      <p>检查非有限值、四元数、缩放、透明度、生命周期和包围盒。透明度 Logit 的 <code>-Infinity</code> 是合法的“完全透明”表示，不属于属性异常，也不会被改写。</p>

      {/* #WDD-gpt 2026-08-17 - 明示 ALL 颜色与安全删除证据的边界，禁止用户把红色诊断点误当成可批量删除点。 */}
      <div className="model-health-all-legend">
        <strong>ALL 诊断说明</strong>
        <span><i className="valid" />绿色：当前解码的位置和颜色数值可用，透明点也属于绿色。</span>
        <span><i className="invalid" />红色：当前解码出现 NaN、Infinity 或超范围坐标；仅用于定位，绝不自动删除。</span>
        <small>旧版还会把当前帧 Alpha &lt; 1/255 的正常时序点染红，本版已取消这一误判。</small>
      </div>

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
          disabled={disabled || busy || !report || !hasSafeDeletionCandidates}
          onClick={onClean}
          type="button"
        >安全清理完全透明点</button>
      </div>
      {busy && <p role="status">正在检查全部片段并核对透明度证据…</p>}
      {report && (
        <div className={report.healthy ? 'model-health-result healthy' : 'model-health-result warning'}>
          <small>
            已检查 {report.checkedSegments.toLocaleString()} 个片段、{report.checkedPoints.toLocaleString()} 个高斯点
          </small>
          <strong>{report.healthy ? '模型属性正常' : `发现 ${issueCount.toLocaleString()} 项属性异常`}</strong>
          {hasSafeDeletionCandidates && (
            <small className="model-health-safe-candidates">
              发现 {report.safeDeletionCandidates.toLocaleString()} 个最安全删除候选：全部 opacity 关键帧均为 −∞
            </small>
          )}
          {report.markedDeletedPoints > 0 && <small>已标记删除 {report.markedDeletedPoints.toLocaleString()} 个 Alpha 恒为 0 的点（可撤销，保存时才正式删除）</small>}
          {report.issues.length > 0 && <ul>{report.issues.map((issue) => <li key={issue.code}>{issue.label}：{issue.count.toLocaleString()}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}
