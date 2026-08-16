import { describe, expect, it, vi } from 'vitest';
import { EditorHistory } from './EditorHistory';

describe('EditorHistory', () => {
  it('undoes and redoes applied commands while publishing toolbar state', () => {
    let value = 2;
    const onChange = vi.fn();
    const history = new EditorHistory(onChange);
    history.pushApplied({
      label: 'transform',
      undo: () => { value = 1; },
      redo: () => { value = 2; },
    });

    expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoLabel: 'transform', redoLabel: null });
    expect(history.undo()).toBe(true);
    expect(value).toBe(1);
    expect(history.getState()).toEqual({ canUndo: false, canRedo: true, undoLabel: null, redoLabel: 'transform' });
    expect(history.redo()).toBe(true);
    expect(value).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('clears redo after a new edit and enforces the history limit', () => {
    const history = new EditorHistory(undefined, 2);
    const command = (label: string) => ({ label, undo: vi.fn(), redo: vi.fn() });
    history.pushApplied(command('one'));
    history.pushApplied(command('two'));
    history.undo();
    history.pushApplied(command('three'));
    history.pushApplied(command('four'));

    expect(history.getState()).toEqual({ canUndo: true, canRedo: false, undoLabel: 'four', redoLabel: null });
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(true);
    expect(history.undo()).toBe(false);
  });
});
