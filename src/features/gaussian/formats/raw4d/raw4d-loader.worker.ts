import { measureRaw4DAssetBytes } from './Raw4DMemoryMetrics';
import { parseRaw4D } from './Raw4DParser';
import type { Raw4DAsset, Raw4DScalarArray } from './Raw4DTypes';
import { Raw4DWasmExtractor } from './Raw4DWasmExtractor';
import type {
  Raw4DLoaderWorkerLoadedResponse,
  Raw4DLoaderWorkerRequest,
  Raw4DLoaderWorkerResponse,
} from './Raw4DLoaderWorkerProtocol';

interface CodecWorkerScope {
  crossOriginIsolated?: boolean;
  onmessage: ((event: MessageEvent<Raw4DLoaderWorkerRequest>) => void) | null;
  postMessage(message: Raw4DLoaderWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as CodecWorkerScope;
const controllers = new Map<number, AbortController>();
const sharedAssets = new Map<string, Raw4DAsset>();
let nextBufferId = 1;

function assetArrayBuffers(asset: Raw4DAsset): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (values: ArrayLike<Raw4DScalarArray>) => {
    for (let index = 0; index < values.length; index += 1) {
      const buffer = values[index].buffer;
      if (buffer instanceof ArrayBuffer) buffers.add(buffer);
    }
  };
  add(asset.position.values);
  add(asset.rotation.values);
  add(asset.colorDc.values);
  add(asset.scale.values);
  add(asset.opacity.values);
  add(asset.shRest);
  add([asset.lifetimeMu, asset.lifetimeW]);
  return [...buffers];
}

async function loadRaw4D(request: Extract<Raw4DLoaderWorkerRequest, { type: 'load' }>): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  let allocatedBytes = 0;
  const shared = Boolean(
    request.preferSharedMemory
    && workerScope.crossOriginIsolated
    && typeof SharedArrayBuffer !== 'undefined',
  );

  try {
    let wasmExtractor: Raw4DWasmExtractor | null = null;
    try {
      wasmExtractor = await Raw4DWasmExtractor.create();
    } catch {
      wasmExtractor = null;
    }
    const asset = await parseRaw4D(request.file, {
      sourceName: request.file.name,
      signal: controller.signal,
      // #WDD-gpt 2026-08-15 - RAW4D 解码完全留在 Codec Worker，并优先直接写入共享 TypedArray。
      createStorage: (length, encoding) => {
        const bytesPerElement = encoding === 'float16'
          ? Uint16Array.BYTES_PER_ELEMENT
          : Float32Array.BYTES_PER_ELEMENT;
        const byteLength = length * bytesPerElement;
        if (allocatedBytes + byteLength > request.cpuBudgetBytes) {
          throw new Error(
            `RAW4D CPU memory budget exceeded (${Math.round(request.cpuBudgetBytes / 1024 ** 2)} MiB).`,
          );
        }
        allocatedBytes += byteLength;
        const buffer = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
        return encoding === 'float16' ? new Uint16Array(buffer) : new Float32Array(buffer);
      },
      extractChunk: wasmExtractor?.extract,
      onProgress: (progress) => {
        workerScope.postMessage({ type: 'progress', requestId: request.requestId, progress });
      },
    });
    if (controller.signal.aborted) {
      throw new DOMException('RAW4D import was cancelled.', 'AbortError');
    }

    const bufferId = `raw4d-${Date.now().toString(36)}-${nextBufferId++}`;
    const response: Raw4DLoaderWorkerLoadedResponse = {
      type: 'loaded',
      requestId: request.requestId,
      bufferId,
      asset,
      cpuResidentBytes: measureRaw4DAssetBytes(asset),
      transport: shared ? 'shared-array-buffer' : 'transferable',
      // #WDD-gpt 2026-08-16 - FP16 位模式直接进入 Canonical backing store，不再伪装成查表展开路径。
      decodeBackend: asset.sourceEncoding === 'float16'
        ? 'fp16-bits'
        : wasmExtractor ? 'wasm' : 'typed-array',
    };
    if (shared) {
      sharedAssets.set(bufferId, asset);
      workerScope.postMessage(response);
    } else {
      workerScope.postMessage(response, assetArrayBuffers(asset));
    }
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    workerScope.postMessage({
      type: 'error',
      requestId: request.requestId,
      name: value.name,
      message: value.message,
    });
  } finally {
    controllers.delete(request.requestId);
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'load') {
    void loadRaw4D(request);
  } else if (request.type === 'cancel') {
    controllers.get(request.requestId)?.abort();
  } else {
    sharedAssets.delete(request.bufferId);
  }
};
