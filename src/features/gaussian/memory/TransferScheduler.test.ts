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
