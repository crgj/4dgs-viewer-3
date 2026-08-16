import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GS2MeshGaussianFieldInput } from './GS2MeshTypes';
import {
  GS2MeshOpacityWorkerClient,
  GS2MeshOpacityWorkerCrashError,
} from './GS2MeshOpacityWorkerClient';
import type { GS2MeshOpacityWorkerResponse } from './GS2MeshOpacityWorkerProtocol';

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<GS2MeshOpacityWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }

  readonly postMessage = vi.fn();

  emit(message: GS2MeshOpacityWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<GS2MeshOpacityWorkerResponse>);
  }

  crash(message = ''): void {
    this.onerror?.({
      message,
      filename: '',
      lineno: 0,
      colno: 0,
      preventDefault: vi.fn(),
    } as unknown as ErrorEvent);
  }
}

function input(): GS2MeshGaussianFieldInput {
  return {
    frame: 0,
    focus: [0, 0, 0],
    boundsMin: [-1, -1, -1],
    boundsMax: [1, 1, 1],
    positions: new Float32Array([0, 0, 0]),
    rotations: new Float32Array([0, 0, 0, 1]),
    scales: new Float32Array([0.1, 0.1, 0.1]),
    colors: new Uint8Array([255, 255, 255, 255]),
    opacities: new Float32Array([0.9]),
    views: [],
    fieldResolution: 96,
    isoLevel: 0.28,
    targetVoxelMillimeters: 0.5,
    targetVoxelSize: 0.0005,
  };
}

describe('GS2MeshOpacityWorkerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.instances.length = 0;
  });

  it('distinguishes a module startup failure from reconstruction memory pressure', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new GS2MeshOpacityWorkerClient();
    const promise = client.reconstruct(input(), new AbortController().signal, vi.fn(), vi.fn());
    FakeWorker.instances[0].crash();
    // #WDD-gpt 2026-08-15 - A dependency 504 occurs before the ready handshake and must not be mislabeled as Gaussian memory exhaustion.
    await expect(promise).rejects.toMatchObject({
      name: 'GS2MeshOpacityWorkerCrashError',
      previewReceived: false,
    });
    await expect(promise).rejects.toThrow(/Worker \u6a21\u5757.*Vite \u4f9d\u8d56\u7f13\u5b58/);
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it('transfers the frame only after ready and retains the memory diagnostic for a later crash', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new GS2MeshOpacityWorkerClient();
    const promise = client.reconstruct(input(), new AbortController().signal, vi.fn(), vi.fn());
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.emit({ type: 'ready' });
    expect(worker.postMessage).toHaveBeenCalledOnce();
    worker.crash();
    // #WDD-gpt 2026-08-15 - Once ready was confirmed, an empty browser crash remains a computation-stage memory diagnostic.
    await expect(promise).rejects.toThrow(/\u5185\u5b58\u4e0a\u9650.*72³ \/ 12K Gaussian/);
  });

  it('records that a valid preview arrived before refinement crashed', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const client = new GS2MeshOpacityWorkerClient();
    const onPreview = vi.fn();
    const promise = client.reconstruct(input(), new AbortController().signal, vi.fn(), onPreview);
    FakeWorker.instances[0].emit({ type: 'ready' });
    FakeWorker.instances[0].emit({
      type: 'preview',
      requestId: 1,
      positions: new Float32Array([0, 0, 0]),
      normals: new Float32Array([0, 1, 0]),
      colors: new Uint8Array([255, 255, 255, 255]),
      indices: new Uint32Array([0, 0, 0]),
      backend: 'preview',
      elapsedMs: 10,
    });
    FakeWorker.instances[0].crash();
    const error = await promise.catch((reason: unknown) => reason);
    // #WDD-gpt 2026-08-15 - The plugin uses this signal to retain the already-installed preview instead of deleting the only usable mesh.
    expect(error).toBeInstanceOf(GS2MeshOpacityWorkerCrashError);
    expect(error).toMatchObject({ previewReceived: true });
    expect(onPreview).toHaveBeenCalledOnce();
  });
});
