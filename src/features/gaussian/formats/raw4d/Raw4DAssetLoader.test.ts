import { afterEach, describe, expect, it, vi } from 'vitest';
import { Raw4DAssetLoader } from './Raw4DAssetLoader';
import type { Raw4DLoaderWorkerRequest, Raw4DLoaderWorkerResponse } from './Raw4DLoaderWorkerProtocol';
import type { Raw4DAsset } from './Raw4DTypes';

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent<Raw4DLoaderWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: Raw4DLoaderWorkerRequest[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: Raw4DLoaderWorkerRequest): void {
    this.messages.push(message);
  }

  respond(response: Raw4DLoaderWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<Raw4DLoaderWorkerResponse>);
  }

  terminate(): void {}
}

function loaded(requestId: number, bufferId: string): Raw4DLoaderWorkerResponse {
  return {
    type: 'loaded',
    requestId,
    bufferId,
    asset: {} as Raw4DAsset,
    cpuResidentBytes: 16,
    transport: 'shared-array-buffer',
    decodeBackend: 'fp16-bits',
  };
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe('Raw4DAssetLoader residency identity', () => {
  it('names identical worker-local buffer ids uniquely and releases each worker by its original id', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const first = new Raw4DAssetLoader('loader-a');
    const second = new Raw4DAssetLoader('loader-b');

    const firstPending = first.load(new File(['a'], 'segment-a.raw4d'), 1_000);
    const secondPending = second.load(new File(['b'], 'segment-b.raw4d'), 1_000);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[0].respond(loaded(1, 'raw4d-same-millisecond-10'));
    FakeWorker.instances[1].respond(loaded(1, 'raw4d-same-millisecond-10'));

    const [firstLoaded, secondLoaded] = await Promise.all([firstPending, secondPending]);
    expect(firstLoaded.bufferId).toBe('loader-a:raw4d-same-millisecond-10');
    expect(secondLoaded.bufferId).toBe('loader-b:raw4d-same-millisecond-10');
    expect(firstLoaded.bufferId).not.toBe(secondLoaded.bufferId);

    firstLoaded.releaseBacking();
    secondLoaded.releaseBacking();
    expect(FakeWorker.instances[0].messages.at(-1)).toEqual({
      type: 'release', bufferId: 'raw4d-same-millisecond-10',
    });
    expect(FakeWorker.instances[1].messages.at(-1)).toEqual({
      type: 'release', bufferId: 'raw4d-same-millisecond-10',
    });
    first.destroy();
    second.destroy();
  });
});
