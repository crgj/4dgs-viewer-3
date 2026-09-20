// #WDD-gpt 2026-09-09 - v3.0.122 正确性优先播放恢复为串行完整 setFrame：
// 每次只提交一个目标，等 frame:ready 且 postrender 后才放行最新排队帧。
export interface StrictSortFrameGateHost {
  /** 使用资源原有 setFrame 路径提交完整帧。 */
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

  // #WDD-gpt 2026-09-09 - 首个请求完整提交；排序在途时只保留唯一最新目标。
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

  /** 关闭节拍门槛时只补交尚未提交的最新排队帧，不重复提交当前在途帧。 */
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
