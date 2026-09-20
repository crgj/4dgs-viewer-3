function positionEnvelopeWorkerCount(limit = Number.POSITIVE_INFINITY): number {
  const hardwareConcurrency = navigator.hardwareConcurrency || 4;
  const preferred = hardwareConcurrency >= 12 ? 4 : hardwareConcurrency >= 8 ? 3 : 2;
  return Math.max(1, Math.min(preferred, limit));
}

// #WDD-gpt 2026-09-20 - 普通与大序列导出共用有界 Position Brotli Worker 池；大序列可将 limit 固定为 2，避免恢复多属性并发的内存峰值。
export async function compressFourCgsPositionParts(
  parts: readonly Uint8Array[],
  quality: number,
  workerLimit = Number.POSITIVE_INFINITY,
): Promise<readonly Uint8Array[]> {
  const workerCount = Math.min(parts.length, positionEnvelopeWorkerCount(workerLimit));
  const output = new Array<Uint8Array>(parts.length);
  let nextPart = 0;
  const runLane = async (): Promise<void> => {
    const worker = new Worker(new URL('./fourcgs-brotli-compress.worker.ts', import.meta.url), { type: 'module' });
    try {
      for (;;) {
        const partIndex = nextPart++;
        if (partIndex >= parts.length) return;
        const source = new Uint8Array(parts[partIndex].byteLength);
        source.set(parts[partIndex]);
        output[partIndex] = await new Promise<Uint8Array>((resolve, reject) => {
          const cleanup = () => {
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
            worker.removeEventListener('messageerror', onMessageError);
          };
          const onMessage = (event: MessageEvent<{
            readonly type: 'started' | 'result' | 'error';
            readonly requestId: number;
            readonly bytes?: ArrayBuffer;
            readonly message?: string;
          }>) => {
            if (event.data.requestId !== partIndex || event.data.type === 'started') return;
            cleanup();
            if (event.data.type === 'error' || !event.data.bytes) reject(new Error(event.data.message ?? 'Position Brotli Worker 失败。'));
            else resolve(new Uint8Array(event.data.bytes));
          };
          const onError = (event: ErrorEvent) => {
            cleanup();
            reject(new Error(event.message || 'Position Brotli Worker 崩溃。'));
          };
          const onMessageError = () => {
            cleanup();
            reject(new Error('Position Brotli Worker 的结果消息无法解析。'));
          };
          worker.addEventListener('message', onMessage);
          worker.addEventListener('error', onError);
          worker.addEventListener('messageerror', onMessageError);
          try {
            worker.postMessage({ requestId: partIndex, bytes: source.buffer, quality }, [source.buffer]);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      }
    } finally {
      worker.terminate();
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => runLane()));
  return output;
}

export function fourCgsPositionEnvelopeWorkerCount(limit = Number.POSITIVE_INFINITY): number {
  return positionEnvelopeWorkerCount(limit);
}
