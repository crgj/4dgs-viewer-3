import { describe, expect, it } from 'vitest';
import { TransferScheduler } from './TransferScheduler';

describe('TransferScheduler', () => {
  it('runs current-frame work before queued prefetch work', async () => {
    const scheduler = new TransferScheduler(1);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = scheduler.schedule({
      key: 'current', priority: 'immediate', run: async () => {
        order.push('current');
        await firstGate;
      },
    });
    const background = scheduler.schedule({
      key: 'background', priority: 'background', run: async () => { order.push('background'); },
    });
    const prefetch = scheduler.schedule({
      key: 'next', priority: 'prefetch', run: async () => { order.push('next'); },
    });

    releaseFirst();
    await Promise.all([first, background, prefetch]);

    expect(order).toEqual(['current', 'next', 'background']);
    expect(scheduler.getStats()).toMatchObject({ active: 0, queued: 0, completed: 3 });
  });

  it('cancels a stale queued transfer before it starts', async () => {
    const scheduler = new TransferScheduler(1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = scheduler.schedule({
      key: 'current', priority: 'immediate', run: () => firstGate,
    });
    const controller = new AbortController();
    const stale = scheduler.schedule({
      key: 'stale', priority: 'prefetch', signal: controller.signal, run: async () => 'unused',
    });

    controller.abort();
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    releaseFirst();
    await first;

    expect(scheduler.getStats()).toMatchObject({ cancelled: 1, completed: 1 });
  });
});

// #WDD-gpt 2026-09-20 - 动态提高并发只启动预算允许的任务，恢复单路时等待在途任务结束，不额外启动第四路。
it('bounds preload concurrency and drains safely after returning to one lane', async () => {
  const scheduler = new TransferScheduler();
  const release: Array<() => void> = [];
  const tasks = Array.from({ length: 4 }, (_, i) => scheduler.schedule({
    key: String(i), priority: 'background', run: () => new Promise<void>(resolve => release.push(resolve)),
  }));
  expect(scheduler.getStats()).toMatchObject({ active: 1, queued: 3 });
  scheduler.setConcurrency(99);
  expect(scheduler.getStats()).toMatchObject({ active: 3, queued: 1 });
  scheduler.setConcurrency(1);
  release[0](); release[1]();
  await Promise.all(tasks.slice(0, 2));
  await Promise.resolve();
  expect(release).toHaveLength(3);
  release[2](); await tasks[2]; await Promise.resolve();
  expect(release).toHaveLength(4);
  release[3](); await tasks[3];
});
