export interface PluginWindowPosition {
  readonly x: number;
  readonly y: number;
}

export interface PluginWindowBoundsInput {
  readonly position: PluginWindowPosition;
  readonly workspaceWidth: number;
  readonly workspaceHeight: number;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly margin?: number;
}

// #WDD-gpt 2026-08-27 - 插件内容异步变高或工作区缩小时重新夹紧位移，避免已拖动窗口在结果展开后越出屏幕。
export function clampPluginWindowPosition(input: PluginWindowBoundsInput): PluginWindowPosition {
  const margin = Math.max(0, input.margin ?? 8);
  const horizontalLimit = Math.max(0, (input.workspaceWidth - input.windowWidth) * 0.5 - margin);
  const verticalLimit = Math.max(0, (input.workspaceHeight - input.windowHeight) * 0.5 - margin);
  return {
    x: horizontalLimit === 0 ? 0 : Math.max(-horizontalLimit, Math.min(horizontalLimit, input.position.x)),
    y: verticalLimit === 0 ? 0 : Math.max(-verticalLimit, Math.min(verticalLimit, input.position.y)),
  };
}
