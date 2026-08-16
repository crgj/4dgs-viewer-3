export interface EditorKeyboardShortcutEvent {
  readonly code: string;
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

// #WDD-gpt  2026-08-16 - 兼容标准 Delete 以及部分键盘上报的 Del 键名，物理 Delete 键始终可用。
export function isGaussianDeleteShortcut(event: EditorKeyboardShortcutEvent): boolean {
  const key = event.key.toLowerCase();
  return key === 'delete' || key === 'del' || event.code === 'Delete';
}

// #WDD-gpt  2026-08-16 - Esc 是全局返回浏览命令，即使选择面板的滑条或输入框聚焦也必须生效。
export function isViewportBrowseShortcut(event: EditorKeyboardShortcutEvent): boolean {
  const key = event.key.toLowerCase();
  return key === 'escape' || key === 'esc' || event.code === 'Escape';
}

// #WDD-gpt  2026-08-16 - 同时支持 Windows/Linux Ctrl 与 macOS Command，并把 Shift+Z 留给重做。
export function isEditorUndoShortcut(event: EditorKeyboardShortcutEvent): boolean {
  return Boolean(event.ctrlKey || event.metaKey)
    && !event.shiftKey
    && event.key.toLowerCase() === 'z';
}

// #WDD-gpt  2026-08-16 - 重做兼容 Ctrl/Cmd+Shift+Z 以及 Windows 常用的 Ctrl+Y。
export function isEditorRedoShortcut(event: EditorKeyboardShortcutEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key.toLowerCase();
  return key === 'y' || (key === 'z' && Boolean(event.shiftKey));
}
