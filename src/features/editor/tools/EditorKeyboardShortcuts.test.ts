import { describe, expect, it } from 'vitest';
import {
  isEditorRedoShortcut,
  isEditorUndoShortcut,
  isGaussianDeleteShortcut,
  isViewportBrowseShortcut,
} from './EditorKeyboardShortcuts';

describe('EditorKeyboardShortcuts', () => {
  it('recognizes Delete and Del keyboard reports', () => {
    expect(isGaussianDeleteShortcut({ key: 'Delete', code: 'Delete' })).toBe(true);
    expect(isGaussianDeleteShortcut({ key: 'Del', code: '' })).toBe(true);
    expect(isGaussianDeleteShortcut({ key: 'Unidentified', code: 'Delete' })).toBe(true);
    expect(isGaussianDeleteShortcut({ key: 'Backspace', code: 'Backspace' })).toBe(false);
  });

  it('recognizes Escape and legacy Esc keyboard reports', () => {
    expect(isViewportBrowseShortcut({ key: 'Escape', code: 'Escape' })).toBe(true);
    expect(isViewportBrowseShortcut({ key: 'Esc', code: '' })).toBe(true);
    expect(isViewportBrowseShortcut({ key: 'Unidentified', code: 'Escape' })).toBe(true);
    expect(isViewportBrowseShortcut({ key: 'Delete', code: 'Delete' })).toBe(false);
  });

  it('recognizes cross-platform undo and redo shortcuts', () => {
    expect(isEditorUndoShortcut({ key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(true);
    expect(isEditorUndoShortcut({ key: 'Z', code: 'KeyZ', metaKey: true })).toBe(true);
    expect(isEditorUndoShortcut({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isEditorRedoShortcut({ key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true })).toBe(true);
    expect(isEditorRedoShortcut({ key: 'y', code: 'KeyY', ctrlKey: true })).toBe(true);
    expect(isEditorRedoShortcut({ key: 'y', code: 'KeyY' })).toBe(false);
  });
});
