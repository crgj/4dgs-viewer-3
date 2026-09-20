// #WDD-gpt 2026-09-20 - 验证高并发失败的单次降级、旧线程隔离及取消边界。
import { afterEach, expect, it, vi } from 'vitest';
import { FourCgsDecoderClient } from './FourCgsDecoderClient';
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Map<string, ((event: any) => void)[]>();
  requests: any[] = [];
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  addEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(fn => fn !== listener)); }
  postMessage(payload: any) { this.requests.push(payload); }
  emit(type: string, value: any) { this.listeners.get(type)?.forEach((fn) => fn(value)); }
  reply(type: string, value?: unknown) { this.emit('message', { data: { type, requestId: this.requests.at(-1).requestId, value, message: 'decode failed' } }); }
}
const setup = () => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); return new FourCgsDecoderClient(); };
const file = {} as File;
afterEach(() => vi.unstubAllGlobals());
it('uses high concurrency first and keeps successful worker', async () => {
  const client = setup(); const promise = client.open(file); const worker = FakeWorker.instances[0];
  expect(worker.requests[0].background).toBe(false); worker.reply('result', { slotCount: 10 });
  expect(await promise).toEqual({ slotCount: 10 }); expect(FakeWorker.instances).toHaveLength(1); client.close();
});
it('replaces failed worker, retries low once and ignores old events', async () => {
  const client = setup(); const progress = vi.fn(); const promise = client.open(file, progress); const old = FakeWorker.instances[0];
  old.reply('error'); await Promise.resolve(); const next = FakeWorker.instances[1];
  expect(old.terminate).toHaveBeenCalledOnce(); expect(next.requests[0].background).toBe(true);
  old.emit('error', { message: 'late crash' }); old.emit('message', { data: { type: 'progress', message: 'stale', ratio: 1 } });
  expect(progress).toHaveBeenCalledTimes(1); next.reply('result', { slotCount: 20 });
  expect(await promise).toEqual({ slotCount: 20 }); client.close();
});
it('reports both failures without an endless retry', async () => {
  const client = setup(); const promise = client.open(file); const check = expect(promise).rejects.toThrow('低并发重试失败');
  FakeWorker.instances[0].emit('error', { message: 'worker crash' }); await Promise.resolve();
  FakeWorker.instances[1].reply('error'); await check; expect(FakeWorker.instances).toHaveLength(2); client.close();
});
it('does not retry after cancellation', async () => {
  const client = setup(); const promise = client.open(file); const check = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  client.close(); await check; expect(FakeWorker.instances).toHaveLength(1);
});

it('allows a downstream failure to restart directly in low concurrency without another retry', async () => {
  const client = setup(); const promise = client.open(file, undefined, true); const check = expect(promise).rejects.toThrow('decode failed');
  expect(FakeWorker.instances[0].requests[0].background).toBe(true); FakeWorker.instances[0].reply('error'); await check;
  expect(FakeWorker.instances).toHaveLength(1); client.close();
});
// #WDD-gpt 2026-09-20 - 仅无在途请求的成功会话允许复用；清理旧监听并先 reset，避免跨片段结果串线。
it('resets and reuses a successful idle session without stale listeners', async () => {
  setup().close();
  const first = new FourCgsDecoderClient(true); const opened = first.open(file);
  const worker = FakeWorker.instances.at(-1)!; worker.reply('result', { slotCount: 11 }); await opened;
  first.close(); expect(worker.requests.at(-1).type).toBe('reset');
  const second = new FourCgsDecoderClient(true); const next = second.open(file);
  expect(FakeWorker.instances.at(-1)).toBe(worker); expect(worker.listeners.get('message')).toHaveLength(1);
  worker.reply('result', { slotCount: 12 }); expect(await next).toEqual({ slotCount: 12 });
  const pending = second.open(file); const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  second.close(); await cancelled; expect(worker.terminate).toHaveBeenCalledOnce();
});
