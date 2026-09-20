/// <reference lib="webworker" />

import brotliPromise from 'brotli-wasm';
import { shuffle16WithPadding } from './FourCgsRaw4DBundle';

interface BrotliCompressRequest {
  readonly requestId: number;
  readonly bytes: ArrayBuffer;
  readonly quality: number;
  readonly shuffle16?: boolean;
}

self.addEventListener('message', (event: MessageEvent<BrotliCompressRequest>) => {
  const startedAt = performance.now();
  const reportError = (error: unknown) => self.postMessage({
    type: 'error', requestId: event.data.requestId,
    message: error instanceof Error ? error.message : String(error),
  });
  void brotliPromise.then((brotli) => {
    // #WDD-gpt 2026-09-19 - 超大辅助流把可转移原始缓冲区交给独立 Worker；shuffle 也在此完成，避免总控 Worker 同时保留两份数百 MB 输入。
    self.postMessage({ type: 'started', requestId: event.data.requestId });
    const raw = new Uint8Array(event.data.bytes);
    const source = event.data.shuffle16 ? shuffle16WithPadding(raw) : raw;
    const compressed = brotli.compress(source, { quality: event.data.quality });
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    self.postMessage({
      type: 'result', requestId: event.data.requestId,
      bytes: copy.buffer, elapsedMs: performance.now() - startedAt,
    }, [copy.buffer]);
  }).catch(reportError);
});

export {};
