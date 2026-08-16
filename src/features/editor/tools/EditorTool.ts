export interface EditorToolContext {
  requestRender(): void;
}

export interface EditorTool {
  id: string;
  label: string;
  shortcut?: string;
  activate(context: EditorToolContext): void;
  deactivate(): void;
}
