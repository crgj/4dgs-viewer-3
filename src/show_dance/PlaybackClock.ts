// #WDD-gpt 2026-09-20 - 截止时间独立于后台状态，按绘制确认推进且不在阻塞后跳帧追赶。
export class PlaybackClock {
  private deadline: number | null = null;
  constructor(private readonly interval: number) {}
  take(now: number, ready: boolean): boolean {
    if (!ready || (this.deadline !== null && now + 0.5 < this.deadline)) return false;
    this.deadline = this.deadline === null || now - this.deadline > this.interval ? now + this.interval : this.deadline + this.interval;
    return true;
  }
}
