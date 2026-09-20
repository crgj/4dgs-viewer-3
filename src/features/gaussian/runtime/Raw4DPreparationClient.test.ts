// #WDD-gpt 2026-09-20 - 验证分块并行输出逐位一致、单线程重放和取消不遗留请求。
import { afterEach, expect, it, vi } from 'vitest';
import { Raw4DPreparationClient } from './Raw4DPreparationClient';
import { prepareRaw4D } from './Raw4DPreparation';
import type { Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
class WorkerStub {
  static instances: WorkerStub[] = [];
  static failNext = false;
  terminated = false;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  constructor() { WorkerStub.instances.push(this); }
  terminate() { this.terminated = true; }
  postMessage(data: any) {
    const fail = WorkerStub.failNext; WorkerStub.failNext = false;
    queueMicrotask(() => { if (this.terminated) return; if (fail) this.onerror?.({ message: 'simulated worker crash' });
      else this.onmessage?.({ data: { id: data.id, result: prepareRaw4D(data.request) } }); });
  }
}
function setup() { (Raw4DPreparationClient as unknown as { idle: Worker[] }).idle = []; WorkerStub.instances = []; WorkerStub.failNext = false; vi.stubGlobal('Worker', WorkerStub); vi.stubGlobal('navigator', { hardwareConcurrency: 32 }); return new Raw4DPreparationClient(); }
afterEach(() => vi.unstubAllGlobals());
const source: Raw4DTrack = { encoding: 'float16', keyframes: [0, 10], components: 3,
  values: Array.from({ length: 6 }, (_, k) => Uint16Array.from({ length: 35001 }, (_, i) => (i * 17 + k * 101) & 65535)) };
async function compare(client: Raw4DPreparationClient) {
  const reference = prepareRaw4D({ kind: 'track', track: source, components: [0, 1, 2], half: true, layout: 'vector', preserveHalf: true }).data;
  const output = new Uint16Array(reference.length);
  await client.track(source, [0, 1, 2], true, 'vector', (first, packed) => output.set(packed, first * 8), true);
  expect(output).toEqual(reference);
}
it('parallel blocks preserve every half bit and odd final point', async () => { const client = setup(); await compare(client); expect(WorkerStub.instances).toHaveLength(3); client.close(); const reused = new Raw4DPreparationClient(); await compare(reused); expect(WorkerStub.instances).toHaveLength(3); reused.close(); });
it('replays pending blocks in one worker after a pool failure', async () => { const client = setup(); WorkerStub.failNext = true; await compare(client); expect(WorkerStub.instances).toHaveLength(4); expect(WorkerStub.instances.slice(0, 3).every(w => w.terminated)).toBe(true); client.close(); });
it('rejects in-flight work on close', async () => { const client = setup(); const promise = compare(client); const check = expect(promise).rejects.toMatchObject({ name: 'AbortError' }); client.close(); await check; });
// #WDD-gpt 2026-09-20 - 混合向量与奇数标量批次保持位模式，覆盖合批线程故障重放。
it('batches vector and scalar slots without changing bits, including fallback', async () => {
  const client = setup(); WorkerStub.failNext = true;
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const tasks = [
    { kind: 'track' as const, track: source, components: [2, 0, 1], half: true, layout: 'vector' as const, preserveHalf: true },
    { kind: 'track' as const, track: { ...source, components: 1, keyframes: [0], values: [source.values[0]] }, components: [0], half: true, layout: 'scalar' as const, preserveHalf: true },
  ];
  const expected = tasks.map(task => prepareRaw4D(task).data);
  const actual = expected.map(array => new Uint16Array(array.length));
  await client.tracks(tasks, (index, first, packed) => actual[index].set(packed, first * (index === 0 ? 8 : 1)));
  expect(actual).toEqual(expected); client.close();
});
