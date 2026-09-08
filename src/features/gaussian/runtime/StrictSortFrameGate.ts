// #WDD-gpt 2026-09-08 - 正确性优先播放只控制提交节拍：每帧仍完整调用 Git 基线的 setFrame，
// 禁止拆分 uniform、动态中心与 WorkBuffer；调用方在目标 frame:ready 且已 postrender 后才放行下一帧。
export interface StrictSortFrameGateHost {
  /** 使用 Git 基线未经拆分的 setFrame 路径提交完整帧。 */
  applyFrameDirect(frame: number): void;
}

interface StrictSortFrameRequest {
  readonly frame: number;
  readonly onDisplayed?: () => void;
}

export class StrictSortFrameGate {
  private submittedRequest: StrictSortFrameRequest | null = null;
  private queuedRequest: StrictSortFrameRequest | null = null;
  private enabled = false;

  constructor(private readonly host: StrictSortFrameGateHost) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 返回当前已提交或排队的最新帧，供播放状态诊断。 */
  get heldFrame(): number | null {
    return this.queuedRequest?.frame ?? this.submittedRequest?.frame ?? null;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  // #WDD-gpt 2026-09-08 - 首个请求完整提交；排序在途时只保留最新目标，避免播放时多个 WorkBuffer 版本相互覆盖。
  request(frame: number, onDisplayed?: () => void): void {
    if (!this.enabled) {
      this.host.applyFrameDirect(frame);
      onDisplayed?.();
      return;
    }
    const request = { frame, onDisplayed };
    if (this.submittedRequest !== null) {
      this.queuedRequest = request;
      return;
    }
    this.submittedRequest = request;
    this.host.applyFrameDirect(frame);
  }

  /** 调用方确认当前完整帧已排序且真正绘制后回调，并在需要时提交唯一最新目标。 */
  onSorted(): boolean {
    if (!this.enabled || this.submittedRequest === null) return false;
    const submitted = this.submittedRequest;
    this.submittedRequest = null;
    if (this.queuedRequest !== null && this.queuedRequest.frame !== submitted.frame) {
      const next = this.queuedRequest;
      this.queuedRequest = null;
      this.submittedRequest = next;
      this.host.applyFrameDirect(next.frame);
    } else {
      this.queuedRequest = null;
      submitted.onDisplayed?.();
    }
    return true;
  }

  /** 关闭节拍门槛时只补交尚未提交的最新排队帧；不得重复提交当前在途帧。 */
  flush(): void {
    const queued = this.queuedRequest;
    const target = queued ?? this.submittedRequest;
    this.submittedRequest = null;
    this.queuedRequest = null;
    if (target !== null) {
      if (queued !== null) this.host.applyFrameDirect(target.frame);
      target.onDisplayed?.();
    }
  }

  /** 活跃数据集被整体替换/重烤时清空门槛状态；调用方负责直接应用新帧。 */
  reset(): void {
    this.submittedRequest = null;
    this.queuedRequest = null;
  }
}
