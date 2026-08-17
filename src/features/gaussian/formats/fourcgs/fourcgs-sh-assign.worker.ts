/// <reference lib="webworker" />

import wasmUrl from './wasm/fourcgs_sh_assign.wasm?url';

interface ShAssignRequest {
  readonly requestId: number;
  readonly rows: Uint16Array;
  readonly count: number;
  readonly stride: number;
  readonly shIndices: Uint32Array;
  readonly levelDimensions: Uint32Array;
  readonly dimensionCounts: Uint32Array;
  readonly nodeSplits: Float32Array;
  readonly centers: Float32Array;
  readonly levelCount: number;
  readonly maximumDimensions: number;
}

interface ShAssignCore extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly reset: () => void;
  readonly alloc: (bytes: number) => number;
  readonly assign_sh: (...parameters: number[]) => void;
}

async function instantiateCore(): Promise<ShAssignCore> {
  const response = await fetch(wasmUrl);
  let source: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    source = await WebAssembly.instantiateStreaming(response.clone(), {});
  } catch {
    source = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  }
  return source.instance.exports as ShAssignCore;
}

const corePromise = instantiateCore();

function allocateAndRun(core: ShAssignCore, request: ShAssignRequest): {
  readonly labels: ArrayBuffer;
  readonly squaredErrors: ArrayBuffer;
  readonly maximumErrors: ArrayBuffer;
  readonly copyInMs: number;
  readonly wasmMs: number;
  readonly copyOutMs: number;
} {
  const copyInStartedAt = performance.now();
  core.reset();
  const rowsPointer = core.alloc(request.rows.byteLength);
  const shIndicesPointer = core.alloc(request.shIndices.byteLength);
  const levelDimensionsPointer = core.alloc(request.levelDimensions.byteLength);
  const dimensionCountsPointer = core.alloc(request.dimensionCounts.byteLength);
  const nodeSplitsPointer = core.alloc(request.nodeSplits.byteLength);
  const centersPointer = core.alloc(request.centers.byteLength);
  const labelBytes = request.count * request.levelCount;
  const labelsPointer = core.alloc(labelBytes);
  const squaredErrorsPointer = core.alloc(request.count * Float64Array.BYTES_PER_ELEMENT);
  const maximumErrorsPointer = core.alloc(request.count * Float32Array.BYTES_PER_ELEMENT);
  new Uint16Array(core.memory.buffer, rowsPointer, request.rows.length).set(request.rows);
  new Uint32Array(core.memory.buffer, shIndicesPointer, request.shIndices.length).set(request.shIndices);
  new Uint32Array(core.memory.buffer, levelDimensionsPointer, request.levelDimensions.length).set(request.levelDimensions);
  new Uint32Array(core.memory.buffer, dimensionCountsPointer, request.dimensionCounts.length).set(request.dimensionCounts);
  new Float32Array(core.memory.buffer, nodeSplitsPointer, request.nodeSplits.length).set(request.nodeSplits);
  new Float32Array(core.memory.buffer, centersPointer, request.centers.length).set(request.centers);
  const copyInMs = performance.now() - copyInStartedAt;

  const wasmStartedAt = performance.now();
  core.assign_sh(
    rowsPointer,
    request.count,
    request.stride,
    shIndicesPointer,
    levelDimensionsPointer,
    dimensionCountsPointer,
    nodeSplitsPointer,
    centersPointer,
    request.levelCount,
    request.maximumDimensions,
    labelsPointer,
    squaredErrorsPointer,
    maximumErrorsPointer,
  );
  const wasmMs = performance.now() - wasmStartedAt;

  const copyOutStartedAt = performance.now();
  const labels = new Uint8Array(core.memory.buffer, labelsPointer, labelBytes).slice().buffer;
  const squaredErrors = new Float64Array(core.memory.buffer, squaredErrorsPointer, request.count).slice().buffer;
  const maximumErrors = new Float32Array(core.memory.buffer, maximumErrorsPointer, request.count).slice().buffer;
  return {
    labels,
    squaredErrors,
    maximumErrors,
    copyInMs,
    wasmMs,
    copyOutMs: performance.now() - copyOutStartedAt,
  };
}

self.addEventListener('message', (event: MessageEvent<ShAssignRequest>) => {
  const startedAt = performance.now();
  void corePromise.then((core) => {
    self.postMessage({ type: 'started', requestId: event.data.requestId });
    const result = allocateAndRun(core, event.data);
    self.postMessage({
      type: 'result',
      requestId: event.data.requestId,
      ...result,
      elapsedMs: performance.now() - startedAt,
    }, [result.labels, result.squaredErrors, result.maximumErrors]);
  }, (error: unknown) => self.postMessage({
    type: 'error',
    requestId: event.data.requestId,
    message: error instanceof Error ? error.message : String(error),
  }));
});

export {};
