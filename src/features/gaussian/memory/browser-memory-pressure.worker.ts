/// <reference lib="webworker" />

import type {
  BrowserMemoryPressureWorkerRequest,
  BrowserMemoryPressureWorkerResponse,
} from './BrowserMemoryPressureTest';

const PAGE_BYTES = 4096;
let activeRunId: number | null = null;
let cancelRequested = false;

function post(response: BrowserMemoryPressureWorkerResponse): void {
  self.postMessage(response);
}

const yieldToMessages = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// #WDD-gpt 2026-08-16 - 每 4KiB 写入一个非固定字节以实际提交物理页，避免只保留未落地的虚拟 ArrayBuffer 地址空间。
async function runPressureTest(request: Extract<BrowserMemoryPressureWorkerRequest, { readonly type: 'start' }>): Promise<void> {
  if (activeRunId !== null) return;
  activeRunId = request.runId;
  cancelRequested = false;
  const startedAt = performance.now();
  const allocations: Uint8Array[] = [];
  let confirmedBytes = 0;

  try {
    while (confirmedBytes < request.targetBytes) {
      if (cancelRequested) {
        post({
          type: 'complete', runId: request.runId, status: 'cancelled', confirmedBytes,
          targetBytes: request.targetBytes, elapsedMs: performance.now() - startedAt,
        });
        return;
      }
      const byteLength = Math.min(request.chunkBytes, request.targetBytes - confirmedBytes);
      try {
        const allocation = new Uint8Array(byteLength);
        const chunkIndex = allocations.length + 1;
        for (let offset = 0, page = 0; offset < byteLength; offset += PAGE_BYTES, page += 1) {
          allocation[offset] = (page * 31 + chunkIndex * 17) & 0xff;
        }
        allocation[byteLength - 1] ^= chunkIndex & 0xff;
        allocations.push(allocation);
        confirmedBytes += byteLength;
      } catch (error) {
        post({
          type: 'complete', runId: request.runId, status: 'allocation-failed', confirmedBytes,
          targetBytes: request.targetBytes, elapsedMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      post({
        type: 'progress', runId: request.runId, confirmedBytes,
        targetBytes: request.targetBytes, elapsedMs: performance.now() - startedAt,
      });
      await yieldToMessages();
    }

    post({
      type: 'complete', runId: request.runId, status: 'success', confirmedBytes,
      targetBytes: request.targetBytes, elapsedMs: performance.now() - startedAt,
    });
  } finally {
    allocations.length = 0;
    activeRunId = null;
    cancelRequested = false;
  }
}

self.addEventListener('message', (event: MessageEvent<BrowserMemoryPressureWorkerRequest>) => {
  if (event.data.type === 'cancel') {
    if (event.data.runId === activeRunId) cancelRequested = true;
    return;
  }
  void runPressureTest(event.data);
});
