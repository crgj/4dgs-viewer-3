import { describe, expect, it, vi } from 'vitest';
import { EditorToolRegistry } from './EditorToolRegistry';
import type { EditorTool } from './EditorTool';

function tool(id: string): EditorTool {
  return {
    id,
    label: id,
    activate: vi.fn(),
    deactivate: vi.fn(),
  };
}

describe('EditorToolRegistry', () => {
  it('deactivates the previous tool when switching', () => {
    const registry = new EditorToolRegistry();
    const select = tool('select');
    const move = tool('move');
    const context = { requestRender: vi.fn() };
    registry.register(select);
    registry.register(move);

    registry.activate('select', context);
    registry.activate('move', context);

    expect(select.deactivate).toHaveBeenCalledOnce();
    expect(move.activate).toHaveBeenCalledWith(context);
    expect(registry.activeId).toBe('move');
  });
});
