export interface EditorHistoryCommand {
  readonly label: string;
  readonly undo: () => void;
  readonly redo: () => void;
}

export interface EditorHistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
}

export const INITIAL_EDITOR_HISTORY_STATE: EditorHistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
};

// #WDD-gpt  2026-08-16 - 用有界命令栈统一管理前端编辑历史，避免大文件编辑时历史无限占用内存。
export class EditorHistory {
  private readonly past: EditorHistoryCommand[] = [];
  private readonly future: EditorHistoryCommand[] = [];

  constructor(
    private readonly onChange?: (state: EditorHistoryState) => void,
    private readonly limit = 64,
  ) {}

  getState(): EditorHistoryState {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoLabel: this.past.at(-1)?.label ?? null,
      redoLabel: this.future.at(-1)?.label ?? null,
    };
  }

  pushApplied(command: EditorHistoryCommand): void {
    this.past.push(command);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future.length = 0;
    this.publish();
  }

  undo(): boolean {
    const command = this.past.pop();
    if (!command) return false;
    try {
      command.undo();
      this.future.push(command);
      this.publish();
      return true;
    } catch (error) {
      this.past.push(command);
      throw error;
    }
  }

  redo(): boolean {
    const command = this.future.pop();
    if (!command) return false;
    try {
      command.redo();
      this.past.push(command);
      this.publish();
      return true;
    } catch (error) {
      this.future.push(command);
      throw error;
    }
  }

  clear(): void {
    if (this.past.length === 0 && this.future.length === 0) return;
    this.past.length = 0;
    this.future.length = 0;
    this.publish();
  }

  private publish(): void {
    this.onChange?.(this.getState());
  }
}
