import type { Application, Entity } from 'playcanvas';

/**
 * 先把 GSplat placement 从 Layer 移除，等 PlayCanvas 的每个 GSplatWorld
 * 至少完成一次 reconcile 后，再销毁 placement 和它引用的资源。
 */
export function disposeGSplatAfterRendererSync(
  app: Application,
  entity: Entity,
  destroyResources: () => void,
): void {
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    app.off('frameend', armFinalRender);
    app.off('postrender', finalize);
    app.off('destroy', finalize);
    destroyResources();
  };

  const armFinalRender = () => {
    if (finalized) return;
    // #WDD-gpt 2026-08-25 - 如果释放发生在 postrender 内，当前帧的 GSplatWorld 已经完成更新；再要求一帧，确保旧 placement 已从所有摄像机快照移除。
    app.once('postrender', finalize);
    app.renderNextFrame = true;
  };

  // onDisable 只从 Layer 移除 placement，不会提前把 placement.resource 清空。
  entity.enabled = false;
  app.once('frameend', armFinalRender);
  // 应用在等待同步帧期间销毁时，必须在 GraphicsDevice 销毁前完成资源回收。
  app.once('destroy', finalize);
  app.renderNextFrame = true;
}
