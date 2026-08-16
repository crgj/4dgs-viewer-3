import type { FourCgsDescriptor, FourCgsProgress } from './FourCgsTypes';

interface WorkerProgressMessage {
  readonly type: 'progress';
  readonly ratio: number;
  readonly message: string;
}

interface WorkerResultMessage {
  readonly type: 'result';
  readonly requestId: number;
  readonly value: unknown;
}

interface WorkerErrorMessage {
  readonly type: 'error';
  readonly requestId: number;
  readonly message: string;
}

type WorkerResponse = WorkerProgressMessage | WorkerResultMessage | WorkerErrorMessage;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
}

export class FourCgsDecoderClient {
  private readonly worker = new Worker(new URL('./fourcgs-decoder.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private closed = false;
  private progressListener: ((progress: FourCgsProgress) => void) | null = null;

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data));
    this.worker.addEventListener('error', (event) => this.failAll(new Error(event.message || '4CGS 解码 Worker 崩溃。')));
  }

  async open(file: File, onProgress?: (progress: FourCgsProgress) => void): Promise<FourCgsDescriptor> {
    this.progressListener = onProgress ?? null;
    return await this.request<FourCgsDescriptor>({ type: 'open', file });
  }

  async getSegment(segmentIndex: number): Promise<File> {
    const result = await this.request<{ name: string; bytes: ArrayBuffer }>({ type: 'segment', segmentIndex });
    return new File([result.bytes], `${result.name}.raw4d`, {
      type: 'application/octet-stream',
      lastModified: Date.now(),
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    this.failAll(new DOMException('4CGS decoder was closed.', 'AbortError'));
  }

  private request<T>(payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new DOMException('4CGS decoder is closed.', 'AbortError'));
    const requestId = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...payload, requestId });
    });
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'progress') {
      this.progressListener?.({ ratio: message.ratio, message: message.message });
      return;
    }
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') request.reject(new Error(message.message));
    else request.resolve(message.value);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
}
