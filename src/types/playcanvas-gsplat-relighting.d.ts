declare module 'playcanvas/scripts/esm/gsplat/gsplat-relighting.mjs' {
  import type { Layer, Material, Script, Texture } from 'playcanvas';

  export class GSplatRelighting extends Script {
    textureScale: number;
    priority: number;
    layerName: string;
    blend: number;
    brightness: number;
    background: number;
    readonly layer: Layer | null;
    readonly texture: Texture | null;
    configureMaterial(material: Material): void;
  }
}
