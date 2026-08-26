import { describe, expect, it, vi } from 'vitest';
import type { Application, Entity } from 'playcanvas';
import { disposeGSplatAfterRendererSync } from './disposeGSplatAfterRendererSync';

type EventName = 'frameend' | 'postrender' | 'destroy';

class FakeApplication {
  renderNextFrame = false;
  private readonly listeners = new Map<EventName, Set<() => void>>();

  once(name: EventName, callback: () => void): void {
    const onceCallback = () => {
      this.off(name, onceCallback);
      callback();
    };
    const callbacks = this.listeners.get(name) ?? new Set<() => void>();
    callbacks.add(onceCallback);
    this.listeners.set(name, callbacks);
  }

  off(name: EventName, callback: () => void): void {
    this.listeners.get(name)?.delete(callback);
  }

  fire(name: EventName): void {
    for (const callback of [...(this.listeners.get(name) ?? [])]) callback();
  }
}

describe('disposeGSplatAfterRendererSync', () => {
  it('keeps the placement resource alive until a later render reconciles the layer', () => {
    const app = new FakeApplication();
    const entity = { enabled: true };
    const destroyResources = vi.fn();

    disposeGSplatAfterRendererSync(
      app as unknown as Application,
      entity as unknown as Entity,
      destroyResources,
    );

    expect(entity.enabled).toBe(false);
    expect(app.renderNextFrame).toBe(true);
    expect(destroyResources).not.toHaveBeenCalled();

    app.renderNextFrame = false;
    app.fire('frameend');
    expect(app.renderNextFrame).toBe(true);
    expect(destroyResources).not.toHaveBeenCalled();

    app.fire('postrender');
    expect(destroyResources).toHaveBeenCalledTimes(1);
  });

  it('flushes exactly once when the application is destroyed before the sync render', () => {
    const app = new FakeApplication();
    const entity = { enabled: true };
    const destroyResources = vi.fn();

    disposeGSplatAfterRendererSync(
      app as unknown as Application,
      entity as unknown as Entity,
      destroyResources,
    );
    app.fire('destroy');
    app.fire('frameend');
    app.fire('postrender');

    expect(destroyResources).toHaveBeenCalledTimes(1);
  });
});
