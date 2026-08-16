import type { EditorTool, EditorToolContext } from './EditorTool';

export class EditorToolRegistry {
  private readonly tools = new Map<string, EditorTool>();
  private activeTool: EditorTool | null = null;

  register(tool: EditorTool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Editor tool "${tool.id}" is already registered.`);
    }
    this.tools.set(tool.id, tool);
  }

  activate(id: string, context: EditorToolContext): void {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new Error(`Unknown editor tool "${id}".`);
    }
    if (tool === this.activeTool) {
      return;
    }
    this.activeTool?.deactivate();
    tool.activate(context);
    this.activeTool = tool;
  }

  deactivate(): void {
    this.activeTool?.deactivate();
    this.activeTool = null;
  }

  get activeId(): string | null {
    return this.activeTool?.id ?? null;
  }
}
