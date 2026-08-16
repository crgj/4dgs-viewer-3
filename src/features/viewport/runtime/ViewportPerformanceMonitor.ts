export interface ViewportLoadTiming {
  readonly label: string;
  readonly milliseconds: number;
}

// #WDD-gpt 2026-08-16 - 仅保留有界采样历史，避免性能诊断本身造成长期内存增长。

export interface ViewportPerformanceSnapshot {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly fpsHistory: readonly number[];
  readonly frameTimeHistory: readonly number[];
  readonly device: {
    readonly backend: string;
    readonly renderer: string;
    readonly logicalCores: number | null;
    readonly deviceMemoryGiB: number | null;
  };
  readonly loadTimings: readonly ViewportLoadTiming[];
  readonly warnings: readonly string[];
}

export class ViewportPerformanceMonitor {
  private readonly frameTimes: number[] = [];
  private readonly fpsHistory: number[] = [];
  private readonly frameTimeHistory: number[] = [];
  private readonly loadTimings: ViewportLoadTiming[] = [];
  private readonly stageStarts = new Map<string, number>();
  private lastFps = 0;
  private lastFrameTime = 0;
  private sampleElapsed = 0;

  recordFrame(deltaMilliseconds: number): void {
    if (!Number.isFinite(deltaMilliseconds) || deltaMilliseconds <= 0 || deltaMilliseconds > 1000) return;
    this.frameTimes.push(deltaMilliseconds);
    this.sampleElapsed += deltaMilliseconds;
    if (this.sampleElapsed < 500) return;
    const sorted = [...this.frameTimes].sort((left, right) => left - right);
    this.lastFrameTime = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    this.lastFps = 1000 / Math.max(0.001, this.frameTimes.reduce((sum, value) => sum + value, 0) / this.frameTimes.length);
    this.fpsHistory.push(this.lastFps);
    this.frameTimeHistory.push(this.lastFrameTime);
    if (this.fpsHistory.length > 60) this.fpsHistory.shift();
    if (this.frameTimeHistory.length > 60) this.frameTimeHistory.shift();
    this.frameTimes.length = 0;
    this.sampleElapsed = 0;
  }

  beginStage(label: string): void {
    this.stageStarts.set(label, performance.now());
  }

  endStage(label: string): void {
    const start = this.stageStarts.get(label);
    if (start === undefined) return;
    this.stageStarts.delete(label);
    this.loadTimings.push({ label, milliseconds: performance.now() - start });
    if (this.loadTimings.length > 8) this.loadTimings.shift();
  }

  snapshot(device: ViewportPerformanceSnapshot['device']): ViewportPerformanceSnapshot {
    const warnings: string[] = [];
    if (this.fpsHistory.length >= 3 && this.lastFps < 24) warnings.push('持续低于 24 FPS，建议降低 SH 阶数或使用点模式。');
    if (this.frameTimeHistory.length >= 3 && this.lastFrameTime > 40) warnings.push('帧耗时超过 40 ms，交互可能出现卡顿。');
    return {
      fps: this.lastFps,
      frameTimeMs: this.lastFrameTime,
      fpsHistory: [...this.fpsHistory],
      frameTimeHistory: [...this.frameTimeHistory],
      device,
      loadTimings: [...this.loadTimings],
      warnings,
    };
  }
}
