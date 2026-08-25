import { describe, expect, it, vi } from 'vitest';
import { StrictSortFrameGate, type StrictSortFrameGateHost } from './StrictSortFrameGate';

function createHost() {
  const host: StrictSortFrameGateHost = {
    prepareFrame: vi.fn((frame: number) => Math.max(0, Math.min(9, frame))),
    revealFrame: vi.fn(),
    applyFrameDirect: vi.fn(),
  };
  return host;
}

describe('StrictSortFrameGate', () => {
  it('applies frames directly while disabled', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    gate.request(3);
    gate.request(5);
    expect(host.applyFrameDirect).toHaveBeenCalledTimes(2);
    expect(host.prepareFrame).not.toHaveBeenCalled();
    expect(gate.heldFrame).toBeNull();
  });

  it('prepares without revealing and keeps only the newest queued request', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    gate.setEnabled(true);
    gate.request(4);
    expect(host.prepareFrame).toHaveBeenCalledWith(4);
    expect(host.revealFrame).not.toHaveBeenCalled();
    expect(gate.heldFrame).toBe(4);
    gate.request(7);
    gate.request(8);
    expect(host.prepareFrame).toHaveBeenCalledTimes(1);
    expect(gate.heldFrame).toBe(8);
  });

  it('drops an obsolete sorted frame and reveals only the latest queued frame', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    gate.setEnabled(true);
    gate.request(4);
    gate.request(6);
    expect(gate.onSorted()).toBe(true);
    expect(host.revealFrame).not.toHaveBeenCalled();
    expect(host.prepareFrame).toHaveBeenLastCalledWith(6);
    expect(gate.heldFrame).toBe(6);
    expect(gate.onSorted()).toBe(true);
    expect(host.revealFrame).toHaveBeenLastCalledWith(6);
    expect(gate.heldFrame).toBeNull();
    expect(gate.onSorted()).toBe(false);
  });

  it('flushes the held frame immediately when strict mode is disabled', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    gate.setEnabled(true);
    gate.request(2);
    gate.request(5);
    gate.setEnabled(false);
    expect(host.applyFrameDirect).toHaveBeenCalledWith(5);
    expect(gate.heldFrame).toBeNull();
    expect(host.revealFrame).not.toHaveBeenCalled();
  });

  it('drops stale gate state when the active dataset is replaced', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    gate.setEnabled(true);
    gate.request(2);
    gate.reset();
    expect(gate.heldFrame).toBeNull();
    expect(gate.onSorted()).toBe(false);
  });

  it('commits the matching derived frame only when that Gaussian frame becomes visible', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    const displayed: number[] = [];
    gate.setEnabled(true);
    gate.request(2, () => displayed.push(2));
    gate.request(5, () => displayed.push(5));
    expect(displayed).toEqual([]);
    gate.onSorted();
    expect(displayed).toEqual([]);
    gate.onSorted();
    expect(displayed).toEqual([5]);
  });

  it('commits a derived frame immediately and flushes only the newest held pair', () => {
    const host = createHost();
    const gate = new StrictSortFrameGate(host);
    const displayed: number[] = [];
    gate.request(1, () => displayed.push(1));
    expect(displayed).toEqual([1]);
    gate.setEnabled(true);
    gate.request(3, () => displayed.push(3));
    gate.request(7, () => displayed.push(7));
    gate.setEnabled(false);
    expect(displayed).toEqual([1, 7]);
    expect(host.applyFrameDirect).toHaveBeenLastCalledWith(7);
  });
});
