// #WDD-gpt 2026-08-21 - 强制排序门槛：新帧先 prepare（上传关键帧并刷新 CPU 排序中心），
// 引擎确认该版本排序提交后再 reveal 显示 uniform，保证渲染出的每一帧都携带匹配的深度顺序。
export interface StrictSortFrameGateHost {
  /** 上传目标帧数据并刷新排序中心；返回实际可用的（钳制后）帧号。 */
  prepareFrame(frame: number): number;
  /** 排序完成后切换渲染 uniform，使已准备帧对观众可见。 */
  revealFrame(frame: number): void;
  /** 非严格路径：准备并立即显示。 */
  applyFrameDirect(frame: number): void;
}

interface StrictSortFrameRequest {
  readonly frame: number;
  readonly onDisplayed?: () => void;
}

export class StrictSortFrameGate {
  private preparedRequest: StrictSortFrameRequest | null = null;
  private queuedRequest: StrictSortFrameRequest | null = null;
  private enabled = false;

  constructor(private readonly host: StrictSortFrameGateHost) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 严格模式下未排序帧只会滞留在 prepared/queued 状态，渲染继续显示旧帧。 */
  get heldFrame(): number | null {
    return this.queuedRequest?.frame ?? this.preparedRequest?.frame ?? null;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  // #WDD-gpt 2026-08-21 - 将派生 Mesh 更新回调绑到真正显示提交，而不是 React 的目标帧；排序滞留时二者不会错开。
  request(frame: number, onDisplayed?: () => void): void {
    if (!this.enabled) {
      this.host.applyFrameDirect(frame);
      onDisplayed?.();
      return;
    }
    const request = { frame, onDisplayed };
    if (this.preparedRequest !== null) {
      this.queuedRequest = request;
      return;
    }
    this.preparedRequest = { ...request, frame: this.host.prepareFrame(frame) };
  }

  /** 引擎 frame:ready(ready=true) 时调用；揭示已准备帧并衔接排队中的最新请求。 */
  onSorted(): boolean {
    if (!this.enabled || this.preparedRequest === null) return false;
    const prepared = this.preparedRequest;
    this.preparedRequest = null;
    // #WDD-gpt 2026-08-21 - 排序期间若已有更新请求，当前结果已经过时：不揭示也不回调，直接准备最新帧。
    // 禁止“揭示当前帧后立刻上传下一帧”在同一次绘制前覆盖 WorkBuffer，造成 Mesh 在动而 Gaussian 停留。
    if (this.queuedRequest !== null && this.queuedRequest.frame !== prepared.frame) {
      const next = this.queuedRequest;
      this.queuedRequest = null;
      this.preparedRequest = { ...next, frame: this.host.prepareFrame(next.frame) };
    } else {
      this.queuedRequest = null;
      this.host.revealFrame(prepared.frame);
      prepared.onDisplayed?.();
    }
    return true;
  }

  /** 关闭强制排序或整体重建场景时把滞留帧立即落地，不停留在未显示的中间态。 */
  flush(): void {
    const target = this.queuedRequest ?? this.preparedRequest;
    this.preparedRequest = null;
    this.queuedRequest = null;
    if (target !== null) {
      this.host.applyFrameDirect(target.frame);
      target.onDisplayed?.();
    }
  }

  /** 活跃数据集被整体替换/重烤时清空门槛状态；调用方负责直接应用新帧。 */
  reset(): void {
    this.preparedRequest = null;
    this.queuedRequest = null;
  }
}
