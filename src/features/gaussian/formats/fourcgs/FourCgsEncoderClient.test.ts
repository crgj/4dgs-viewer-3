// #WDD-gpt 2026-09-20 - 锁定总控 Worker 崩溃只会触发一次单路重试，编码校验错误不得隐藏。
import { afterEach, expect, it, vi } from 'vitest';
import { encodeRaw4DMemoryAsFourCgs, type FourCgsEncodeResult } from './FourCgsEncoderClient';
import type { Raw4DMemorySnapshot } from '../raw4d/Raw4DTypes';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly requests: any[] = [];
  readonly listeners = new Map<string, ((event: any) => void)[]>();
  readonly terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }
  postMessage(payload: unknown) { this.requests.push(payload); }
  emit(type: string, event: unknown) { this.listeners.get(type)?.forEach((listener) => listener(event)); }
  reply(data: unknown) { this.emit('message', { data }); }
}

const source = (): Raw4DMemorySnapshot => ({
  name: 'segment_0_0.raw4d', asset: {} as Raw4DMemorySnapshot['asset'], deletionWords: new Uint32Array(0),
});
const result = (): FourCgsEncodeResult => ({
  blob: new Blob(), filename: 'result.4cgs', sourceBytes: 1, outputBytes: 1, compressionRatio: 1,
  sourceSha256: [], originalPointCount: 1, encodedPointCount: 1, deletedPointCount: 0,
});

afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances.length = 0; });

it('restarts a crashed encoder once with GPU and nested parallel work disabled', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const progress = vi.fn();
  const promise = encodeRaw4DMemoryAsFourCgs([source()], progress);
  expect(FakeWorker.instances[0].requests[0].safeMode).toBe(false);
  FakeWorker.instances[0].emit('error', { message: '' });
  await vi.waitFor(() => expect(FakeWorker.instances).toHaveLength(2));
  expect(FakeWorker.instances[1].requests[0].safeMode).toBe(true);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: '安全重试', workerCount: 1 }));
  FakeWorker.instances[1].reply({ type: 'result', result: result() });
  await expect(promise).resolves.toMatchObject({ filename: 'result.4cgs' });
  expect(FakeWorker.instances).toHaveLength(2);
});

it('does not retry a deterministic encoder validation error', async () => {
  vi.stubGlobal('Worker', FakeWorker);
  const promise = encodeRaw4DMemoryAsFourCgs([source()]);
  FakeWorker.instances[0].reply({ type: 'error', message: '属性布局无效' });
  await expect(promise).rejects.toThrow('属性布局无效');
  expect(FakeWorker.instances).toHaveLength(1);
});
