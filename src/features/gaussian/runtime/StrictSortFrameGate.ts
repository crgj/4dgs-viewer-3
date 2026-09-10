// #WDD-gpt 2026-09-09 - 正确性优先播放先准备目标排序中心；目标 uniform、WorkBuffer 与 orderData
// 在 PlayCanvas onSorted 的同一次 WebGL update 内原子提交，postrender 后才放行下一帧。
export interface StrictSortFrameGateHost {
  /** 非严格路径立即提交完整帧。 */
  applyFrameDirect(frame: number): void;
  /** 严格路径只准备目标数据和排序中心，返回钳制后的实际帧。 */
  prepareFrame(frame: number): number;
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

  // #WDD-gpt 2026-09-09 - 首个请求只准备排序；排序在途时保留唯一最新目标。
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
    this.submittedRequest = { ...request, frame: this.host.prepareFrame(frame) };
  }

  /** 调用方确认当前完整帧已排序且真正绘制后回调，并在需要时提交唯一最新目标。 */
  onSorted(): boolean {
    if (!this.enabled || this.submittedRequest === null) return false;
    const submitted = this.submittedRequest;
    this.submittedRequest = null;
    if (this.queuedRequest !== null && this.queuedRequest.frame !== submitted.frame) {
      const next = this.queuedRequest;
      this.queuedRequest = null;
      this.submittedRequest = { ...next, frame: this.host.prepareFrame(next.frame) };
    } else {
      this.queuedRequest = null;
      submitted.onDisplayed?.();
    }
    return true;
  }

  /** 关闭节拍门槛时立即落地最新目标；prepared 帧尚未可见，必须走直接提交路径。 */
  flush(): void {
    const queued = this.queuedRequest;
    const target = queued ?? this.submittedRequest;
    this.submittedRequest = null;
    this.queuedRequest = null;
    if (target !== null) {
      this.host.applyFrameDirect(target.frame);
      target.onDisplayed?.();
    }
  }

  /** 活跃数据集被整体替换/重烤时清空门槛状态；调用方负责直接应用新帧。 */
  reset(): void {
    this.submittedRequest = null;
    this.queuedRequest = null;
  }
}
