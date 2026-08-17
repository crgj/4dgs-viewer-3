import type { Raw4DMemorySnapshot } from './Raw4DTypes';
import type {
  Raw4DPlySequenceExportWorkerProgress,
  Raw4DPlySequenceExportWorkerRequest,
  Raw4DPlySequenceExportWorkerResponse,
  Raw4DPlySequenceExportWorkerResult,
} from './Raw4DPlySequenceWorkerProtocol';

// #WDD-gpt 2026-08-17 - PLY 序列导出在独立 Worker 内克隆 Canonical 快照并逐帧直写用户选择的目录；
// 只转移删除位集副本，主线程的驻留属性数组和撤销状态不受影响。
export function exportRaw4DSequenceAsPlyDirectory(
  sources: readonly Raw4DMemorySnapshot[],
  directory: FileSystemDirectoryHandle,
  onProgress?: (progress: Raw4DPlySequenceExportWorkerProgress) => void,
  signal?: AbortSignal,
): Promise<Raw4DPlySequenceExportWorkerResult> {
  if (sources.length === 0) return Promise.reject(new Error('没有可导出的 RAW4D 序列数据。'));
  const snapshots = sources.map((source) => ({
    ...source,
    deletionWords: source.deletionWords.slice(),
  }));
  const request: Raw4DPlySequenceExportWorkerRequest = {
    type: 'export',
    requestId: 1,
    sources: snapshots,
    directory,
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('./raw4d-ply-sequence.worker.ts', import.meta.url),
      { type: 'module' },
    );
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      reject(new DOMException('PLY 序列导出已取消。', 'AbortError'));
    };
    worker.addEventListener('message', (event: MessageEvent<Raw4DPlySequenceExportWorkerResponse>) => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.progress);
        return;
      }
      if (!finish()) return;
      if (message.type === 'error') reject(new Error(message.message));
      else resolve(message.result);
    });
    worker.addEventListener('error', (event) => {
      if (!finish()) return;
      reject(new Error(event.message || 'PLY 序列导出 Worker 崩溃。'));
    }, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage(request, snapshots.map((source) => source.deletionWords.buffer as ArrayBuffer));
  });
}
