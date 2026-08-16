import type { Application } from 'playcanvas';

export interface RenderExtensionContext {
  app: Application;
  canvas: HTMLCanvasElement;
}

export interface RenderExtension {
  id: string;
  attach(context: RenderExtensionContext): void | (() => void);
}

export class RenderExtensionRegistry {
  private readonly extensions = new Map<string, RenderExtension>();
  private disposers: Array<() => void> = [];

  register(extension: RenderExtension): void {
    if (this.extensions.has(extension.id)) {
      throw new Error(`Render extension "${extension.id}" is already registered.`);
    }
    this.extensions.set(extension.id, extension);
  }

  attachAll(context: RenderExtensionContext): void {
    this.disposeAttached();
    this.disposers = [...this.extensions.values()]
      .map((extension) => extension.attach(context))
      .filter((dispose): dispose is () => void => typeof dispose === 'function');
  }

  disposeAttached(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      dispose();
    }
  }
}
