/// <reference lib="webworker" />
import { measureRaw4DAssetBytes } from '../raw4d/Raw4DMemoryMetrics';
import type { Raw4DAsset, Raw4DScalarArray } from '../raw4d/Raw4DTypes';
import { parseFourGs } from './FourGsParser';
import type { FourGsLoaderWorkerRequest, FourGsLoaderWorkerResponse } from './FourGsLoaderWorkerProtocol';

interface WorkerScope {
  readonly crossOriginIsolated?: boolean;
  onmessage: ((event: MessageEvent<FourGsLoaderWorkerRequest>) => void) | null;
  postMessage(message: FourGsLoaderWorkerResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
const controllers = new Map<number, AbortController>();
const sharedAssets = new Map<string, Raw4DAsset>();
let nextBufferId = 1;

function assetBuffers(asset: Raw4DAsset): ArrayBuffer[] {
  const result = new Set<ArrayBuffer>();
  const add = (values: readonly Raw4DScalarArray[]) => values.forEach((value) => {
    if (value.buffer instanceof ArrayBuffer) result.add(value.buffer);
  });
  add(asset.position.values); add(asset.rotation.values); add(asset.colorDc.values);
  add(asset.scale.values); add(asset.opacity.values); add(asset.shRest);
  add([asset.lifetimeMu, asset.lifetimeW]);
  return [...result];
}

async function load(request: Extract<FourGsLoaderWorkerRequest, { type: 'load' }>): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  let allocatedBytes = 0;
  const shared = Boolean(request.preferSharedMemory && scope.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined');
  try {
    const asset = await parseFourGs(request.file, {
      sourceName: request.file.name,
      signal: controller.signal,
      createStorage: (length, encoding) => {
        if (encoding !== 'float32') throw new Error('4GS Canonical RAM 必须使用 Float32。');
        const byteLength = length * Float32Array.BYTES_PER_ELEMENT;
        if (allocatedBytes + byteLength > request.cpuBudgetBytes) {
          throw new Error(`4GS 解码需要超过 ${(request.cpuBudgetBytes / 1e9).toFixed(2)} GB 的统一 CPU 内存预算。`);
        }
        allocatedBytes += byteLength;
        return new Float32Array(shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength));
      },
      onProgress: (progress) => scope.postMessage({ type: 'progress', requestId: request.requestId, progress }),
    });
    if (controller.signal.aborted) throw new DOMException('4GS import was cancelled.', 'AbortError');
    const bufferId = `fourgs-${Date.now().toString(36)}-${nextBufferId++}`;
    const response: FourGsLoaderWorkerResponse = {
      type: 'loaded', requestId: request.requestId, bufferId, asset,
      cpuResidentBytes: measureRaw4DAssetBytes(asset), transport: shared ? 'shared-array-buffer' : 'transferable',
    };
    if (shared) {
      sharedAssets.set(bufferId, asset);
      scope.postMessage(response);
    } else {
      scope.postMessage(response, assetBuffers(asset));
    }
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ type: 'error', requestId: request.requestId, name: value.name, message: value.message });
  } finally {
    controllers.delete(request.requestId);
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'load') void load(request);
  else if (request.type === 'cancel') controllers.get(request.requestId)?.abort();
  else sharedAssets.delete(request.bufferId);
};
