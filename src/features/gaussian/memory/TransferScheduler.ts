export type TransferPriority = 'immediate' | 'prefetch' | 'background';

export interface TransferSchedulerStats {
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly cancelled: number;
}

interface TransferJob {
  readonly id: number;
  readonly key: string;
  readonly priority: number;
  readonly signal?: AbortSignal;
  readonly run: (signal?: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  removeAbortListener(): void;
}

const priorityValues: Readonly<Record<TransferPriority, number>> = {
  immediate: 0,
  prefetch: 1,
  background: 2,
};

export class TransferScheduler {
  private readonly queue: TransferJob[] = [];
  private nextId = 1;
  private active = 0;
  private completed = 0;
  private cancelled = 0;
  private destroyed = false;

  constructor(private readonly concurrency = 1) {}

  schedule<T>(input: {
    readonly key: string;
    readonly priority: TransferPriority;
    readonly signal?: AbortSignal;
    readonly run: (signal?: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (this.destroyed) return Promise.reject(new Error('Transfer scheduler has been destroyed.'));
    if (input.signal?.aborted) return Promise.reject(new DOMException('Transfer was cancelled.', 'AbortError'));

    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const abort = () => {
        const index = this.queue.findIndex((job) => job.id === id);
        if (index < 0) return;
        const [job] = this.queue.splice(index, 1);
        job.removeAbortListener();
        this.cancelled += 1;
        reject(new DOMException('Transfer was cancelled.', 'AbortError'));
      };
      const removeAbortListener = () => input.signal?.removeEventListener('abort', abort);
      input.signal?.addEventListener('abort', abort, { once: true });
      // #WDD-gpt 2026-08-15 - 当前帧上传优先于下一段预取，拖动时间轴时可取消尚未开始的旧任务。
      this.queue.push({
        id,
        key: input.key,
        priority: priorityValues[input.priority],
        signal: input.signal,
        run: input.run,
        resolve: resolve as (value: unknown) => void,
        reject,
        removeAbortListener,
      });
      this.queue.sort((left, right) => left.priority - right.priority || left.id - right.id);
      this.drain();
    });
  }

  getStats(): TransferSchedulerStats {
    return {
      active: this.active,
      queued: this.queue.length,
      completed: this.completed,
      cancelled: this.cancelled,
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const job of this.queue.splice(0)) {
      job.removeAbortListener();
      job.reject(new DOMException('Transfer scheduler was destroyed.', 'AbortError'));
      this.cancelled += 1;
    }
  }

  private drain(): void {
    while (!this.destroyed && this.active < Math.max(1, this.concurrency) && this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.removeAbortListener();
      if (job.signal?.aborted) {
        this.cancelled += 1;
        job.reject(new DOMException('Transfer was cancelled.', 'AbortError'));
        continue;
      }
      this.active += 1;
      void job.run(job.signal).then(
        (value) => {
          this.completed += 1;
          job.resolve(value);
        },
        (error) => job.reject(error),
      ).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}
