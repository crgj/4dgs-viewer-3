import type {
  SemanticClassificationHost,
  SemanticClassificationState,
  SemanticTag,
  SemanticViewMask,
} from './SemanticClassificationTypes';
import { SemanticClassificationWorkerClient } from './SemanticClassificationWorkerClient';

export interface SemanticClassificationOptions {
  readonly tags: readonly SemanticTag[];
  readonly viewCount: number;
  readonly seed: number;
  readonly threshold: number;
}

export class SemanticClassificationPlugin {
  private worker = new SemanticClassificationWorkerClient();
  private runId = 0;
  private running = false;

  async classify(
    host: SemanticClassificationHost,
    options: SemanticClassificationOptions,
    onStateChange: (state: SemanticClassificationState) => void,
  ): Promise<void> {
    if (this.running) return;
    if (options.tags.length === 0) throw new Error('请至少添加一个分类 Tag。');
    if (new Set(options.tags.map((tag) => tag.prompt.trim().toLowerCase())).size !== options.tags.length) {
      throw new Error('分类 Prompt 不能重复。');
    }
    const runId = ++this.runId;
    this.running = true;
    let captures: Awaited<ReturnType<SemanticClassificationHost['captureSemanticClassificationViews']>> = [];
    try {
      // #WDD-gpt 2026-08-26 - 先完成视口抓帧再装载大模型，避免 q8/WASM 内存峰值让 WebGL 上下文在抓帧前被浏览器回收。
      onStateChange({ stage: 'capturing', progress: 0.01, totalViews: options.viewCount });
      captures = await host.captureSemanticClassificationViews({
        viewCount: options.viewCount,
        seed: options.seed,
        onProgress: (completed, total) => {
          if (runId !== this.runId) return;
          onStateChange({
            stage: 'capturing',
            progress: 0.01 + (completed / Math.max(1, total)) * 0.19,
            currentView: completed,
            totalViews: total,
          });
        },
      });
      this.assertActive(runId);

      onStateChange({ stage: 'loading-model', progress: 0.21 });
      const backend = await this.worker.initialize((download) => {
        if (runId !== this.runId) return;
        const ratio = download.total && download.loaded
          ? Math.max(0, Math.min(1, download.loaded / download.total))
          : Math.max(0, Math.min(1, (download.progress ?? 0) / 100));
        onStateChange({
          stage: 'loading-model',
          progress: 0.21 + ratio * 0.19,
          downloadedBytes: download.loaded,
          totalBytes: download.total,
        });
      });
      this.assertActive(runId);

      const masks: SemanticViewMask[] = [];
      for (let index = 0; index < captures.length; index += 1) {
        const capture = captures[index];
        onStateChange({
          stage: 'classifying',
          progress: 0.41 + (index / captures.length) * 0.46,
          currentView: index + 1,
          totalViews: captures.length,
          backend,
        });
        const mask = await this.worker.classify(capture.bitmap, options.tags.map((tag) => tag.prompt));
        masks.push({
          id: capture.id,
          frame: capture.frame,
          center: capture.center,
          right: capture.right,
          up: capture.up,
          forward: capture.forward,
          horizontalSpan: capture.horizontalSpan,
          verticalSpan: capture.verticalSpan,
          ...mask,
        });
        this.assertActive(runId);
      }

      onStateChange({
        stage: 'projecting',
        progress: 0.91,
        currentView: captures.length,
        totalViews: captures.length,
        backend,
      });
      const result = host.applySemanticClassification({
        tags: options.tags,
        masks,
        threshold: options.threshold,
        seed: options.seed,
      });
      this.assertActive(runId);
      onStateChange({ stage: 'success', progress: 1, result, backend });
    } catch (error) {
      captures.forEach(({ bitmap }) => bitmap.close());
      if (runId !== this.runId) {
        onStateChange({ stage: 'cancelled', progress: 0 });
      } else {
        onStateChange({
          stage: 'error',
          progress: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (runId === this.runId) {
        this.running = false;
        // #WDD-gpt 2026-08-26 - 权重仍由 Cache Storage 持久缓存；每次任务后释放 ONNX Session，归还 q8/WASM 峰值内存并保护 WebGL 场景。
        this.worker.dispose();
        this.worker = new SemanticClassificationWorkerClient();
      }
    }
  }

  cancel(): void {
    if (!this.running) return;
    this.runId += 1;
    this.running = false;
    this.worker.dispose();
    this.worker = new SemanticClassificationWorkerClient();
  }

  dispose(): void {
    this.runId += 1;
    this.running = false;
    this.worker.dispose();
  }

  private assertActive(runId: number): void {
    if (runId !== this.runId) throw new DOMException('Semantic classification cancelled.', 'AbortError');
  }
}
