import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticClassificationWorkerClient } from './SemanticClassificationWorkerClient';

class FakeWorker {
  static current: FakeWorker | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  requestId = 0;

  constructor() {
    FakeWorker.current = this;
  }

  postMessage(message: { requestId?: number }): void {
    if (message.requestId) this.requestId = message.requestId;
  }

  terminate(): void {}

  progress(): void {
    this.onmessage?.({
      data: {
        type: 'progress',
        requestId: this.requestId,
        status: 'progress',
        loaded: 1,
        total: 2,
      },
    } as MessageEvent);
  }

  ready(): void {
    this.onmessage?.({
      data: { type: 'ready', requestId: this.requestId, backend: 'wasm-q8' },
    } as MessageEvent);
  }
}

describe('SemanticClassificationWorkerClient download watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWorker.current = null;
  });

  it('renews the idle deadline whenever download progress arrives', async () => {
    const client = new SemanticClassificationWorkerClient();
    const initialized = client.initialize();
    const worker = FakeWorker.current!;
    await vi.advanceTimersByTimeAsync(299_000);
    worker.progress();
    await vi.advanceTimersByTimeAsync(299_000);
    worker.ready();
    await expect(initialized).resolves.toBe('wasm-q8');
    client.dispose();
  });

  it('still rejects a genuinely stalled model initialization', async () => {
    const client = new SemanticClassificationWorkerClient();
    const initialized = client.initialize();
    const rejected = expect(initialized).rejects.toThrow('连续 5 分钟没有进度');
    await vi.advanceTimersByTimeAsync(300_001);
    await rejected;
    client.dispose();
  });
});
