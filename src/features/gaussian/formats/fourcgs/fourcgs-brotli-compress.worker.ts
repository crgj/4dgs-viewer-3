/// <reference lib="webworker" />

import brotliPromise from 'brotli-wasm';

interface BrotliCompressRequest {
  readonly requestId: number;
  readonly bytes: ArrayBuffer;
  readonly quality: number;
}

self.addEventListener('message', (event: MessageEvent<BrotliCompressRequest>) => {
  const startedAt = performance.now();
  void brotliPromise.then((brotli) => {
    const compressed = brotli.compress(new Uint8Array(event.data.bytes), { quality: event.data.quality });
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    self.postMessage({
      type: 'result', requestId: event.data.requestId,
      bytes: copy.buffer, elapsedMs: performance.now() - startedAt,
    }, [copy.buffer]);
  }, (error: unknown) => self.postMessage({
    type: 'error', requestId: event.data.requestId,
    message: error instanceof Error ? error.message : String(error),
  }));
});

export {};
