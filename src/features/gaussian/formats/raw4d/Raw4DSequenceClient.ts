import type { Raw4DSequenceDescriptor, Raw4DSequenceProgress } from './Raw4DSequenceTypes';
import type { Raw4DSequenceWorkerRequest, Raw4DSequenceWorkerResponse } from './Raw4DSequenceWorkerProtocol';

interface PendingOpen {
  readonly onProgress?: (progress: Raw4DSequenceProgress) => void;
  readonly resolve: (descriptor: Raw4DSequenceDescriptor) => void;
  readonly reject: (error: Error) => void;
}

export class Raw4DSequenceClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingOpen>();
  private nextRequestId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL('./raw4d-sequence.worker.ts', import.meta.url), {
      name: 'raw4d-sequence-worker',
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<Raw4DSequenceWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'RAW4D 序列预处理 Worker 意外停止。');
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  open(files: readonly File[], onProgress?: (progress: Raw4DSequenceProgress) => void): Promise<Raw4DSequenceDescriptor> {
    if (this.closed) return Promise.reject(new Error('RAW4D 序列预处理器已经关闭。'));
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { onProgress, resolve, reject });
      this.post({ type: 'open', requestId, files });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, entry] of this.pending) {
      this.worker.postMessage({ type: 'cancel', requestId } satisfies Raw4DSequenceWorkerRequest);
      entry.reject(new DOMException('RAW4D 序列预处理已取消。', 'AbortError'));
    }
    this.pending.clear();
    this.worker.terminate();
  }

  private handleMessage(response: Raw4DSequenceWorkerResponse): void {
    const entry = this.pending.get(response.requestId);
    if (!entry) return;
    if (response.type === 'progress') {
      entry.onProgress?.(response.progress);
      return;
    }
    this.pending.delete(response.requestId);
    if (response.type === 'opened') entry.resolve(response.descriptor);
    else {
      const error = response.name === 'AbortError'
        ? new DOMException(response.message, 'AbortError')
        : Object.assign(new Error(response.message), { name: response.name });
      entry.reject(error);
    }
  }

  private post(request: Raw4DSequenceWorkerRequest): void {
    if (!this.closed) this.worker.postMessage(request);
  }
}
