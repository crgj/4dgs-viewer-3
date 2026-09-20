import {
  GSplatFormat,
  GSplatResourceBase,
  PIXELFORMAT_R32U,
  PIXELFORMAT_RGBA16F,
  PIXELFORMAT_RGBA32U,
  type BoundingBox,
  type GraphicsDevice,
  Vec3,
} from 'playcanvas';
import type { Raw4DAsset } from '../formats/raw4d/Raw4DTypes';

interface Raw4DResourceMetadata {
  readonly numSplats: number;
  readonly shBands: number;
  calcAabb(result: BoundingBox): boolean;
}

export { raw4DShPackingMaximum } from './Raw4DTexturePacking';
import { fillRaw4DColorTransform, fillRaw4DSH } from './Raw4DTexturePacking';
import type { Raw4DPreparationClient } from './Raw4DPreparationClient';
export class Raw4DResource extends GSplatResourceBase {
  readonly shBands: number;
  readonly gpuByteSize: number;
  private displayShBands: number;

  constructor(
    device: GraphicsDevice,
    private readonly asset: Raw4DAsset,
    maxShBands = asset.shBands,
    private readonly releaseCpuUploadSources = false,
    deferPreparation = false,
  ) {
    const residentShBands = Math.max(0, Math.min(asset.shBands, Math.round(maxShBands)));
    const metadata: Raw4DResourceMetadata = {
      numSplats: asset.splatCount,
      shBands: residentShBands,
      calcAabb: (result) => {
        result.setMinMax(new Vec3(...asset.bounds.min), new Vec3(...asset.bounds.max));
        return true;
      },
    };
    super(device, metadata as never, { prepareCenters: false });
    // #WDD-gpt 2026-09-07 - 显存驻留级别可低于 Canonical SH 级别，CPU 仍保留全系数供导出和后续编辑。
    this.shBands = residentShBands;
    this.displayShBands = residentShBands;
    const streams: Array<{ name: string; format: number }> = [
      { name: 'splatColor', format: PIXELFORMAT_RGBA16F },
      { name: 'transformA', format: PIXELFORMAT_RGBA32U },
      { name: 'transformB', format: PIXELFORMAT_RGBA16F },
    ];
    if (this.shBands > 0) {
      streams.push({ name: 'splatSH_1to3', format: PIXELFORMAT_RGBA32U });
      if (this.shBands > 1) {
        streams.push({ name: 'splatSH_4to7', format: PIXELFORMAT_RGBA32U });
        streams.push({
          name: 'splatSH_8to11',
          format: this.shBands > 2 ? PIXELFORMAT_RGBA32U : PIXELFORMAT_R32U,
        });
        if (this.shBands > 2) streams.push({ name: 'splatSH_12to15', format: PIXELFORMAT_RGBA32U });
      }
    }
    this._format = new GSplatFormat(device, streams, {
      readGLSL: '#include "gsplatUncompressedVS"',
      readWGSL: '#include "gsplatUncompressedVS"',
    });
    this.streams.init(this.format, asset.splatCount);
    // #WDD-gpt 2026-08-16 - 直接从位保持 Canonical 数组生成 PlayCanvas 纹理，避免为一次性上传常驻解码 59 个 Float32Array。
    if (!deferPreparation) {
      this.uploadColorAndTransform();
      if (this.shBands > 0) this.uploadSH();
      this.releaseUploadedCpuSources();
    }

    const texels = this.streams.textureDimensions.x * this.streams.textureDimensions.y;
    const shBytes = this.shBands === 0 ? 0 : this.shBands === 1 ? 16 : this.shBands === 2 ? 36 : 64;
    this.gpuByteSize = texels * (32 + shBytes);
  }

  // #WDD-gpt 2026-09-20 - 每批仅复制少量已打包点；所有 SH/变换计算在 Worker，纹理逐张让出绘制机会。
  async prepareInWorker(client: Raw4DPreparationClient): Promise<void> {
    const names = ['splatColor', 'transformA', 'transformB', ...(this.shBands > 0 ? ['splatSH_1to3'] : []),
      ...(this.shBands > 1 ? ['splatSH_4to7', 'splatSH_8to11'] : []), ...(this.shBands > 2 ? ['splatSH_12to15'] : [])];
    const arrays = Object.fromEntries(names.map((name) => [name, this.streams.getTexture(name)!.lock() as Uint16Array | Uint32Array]));
    await client.resource(this.asset, this.shBands, (first, packed) => {
      for (const name of names) arrays[name].set(packed[name], first * (name === 'splatSH_8to11' && this.shBands === 2 ? 1 : 4));
    });
    for (const name of names) {
      await client.yieldToRenderer();
      const texture = this.streams.getTexture(name)!;
      texture.unlock();
      if (this.releaseCpuUploadSources) texture._clearLevels();
    }
  }

  override configureMaterialDefines(defines: Map<string, string | number | boolean>): void {
    defines.set('SH_BANDS', String(this.displayShBands));
  }

  setDisplayShBands(level: number): number {
    this.displayShBands = Math.max(0, Math.min(this.shBands, Math.round(level)));
    return this.displayShBands;
  }

  refreshSourceData(): void {
    this.uploadColorAndTransform();
    if (this.shBands > 0) this.uploadSH();
    this.releaseUploadedCpuSources();
    this.aabb.setMinMax(new Vec3(...this.asset.bounds.min), new Vec3(...this.asset.bounds.max));
  }

  private releaseUploadedCpuSources(): void {
    if (!this.releaseCpuUploadSources) return;
    for (const texture of this.streams.getTexturesInOrder()) texture._clearLevels();
  }

  private uploadColorAndTransform(): void {
    const color = this.streams.getTexture('splatColor')!.lock() as Uint16Array;
    const transformA = this.streams.getTexture('transformA')!.lock() as Uint32Array;
    const transformB = this.streams.getTexture('transformB')!.lock() as Uint16Array;
    fillRaw4DColorTransform(this.asset, color, transformA, transformB);

    this.streams.getTexture('splatColor')!.unlock();
    this.streams.getTexture('transformA')!.unlock();
    this.streams.getTexture('transformB')!.unlock();
  }

  private uploadSH(): void {
    const sh1to3Texture = this.streams.getTexture('splatSH_1to3')!;
    const sh4to7Texture = this.streams.getTexture('splatSH_4to7');
    const sh8to11Texture = this.streams.getTexture('splatSH_8to11');
    const sh12to15Texture = this.streams.getTexture('splatSH_12to15');
    const sh1to3 = sh1to3Texture.lock() as Uint32Array;
    const sh4to7 = sh4to7Texture?.lock() as Uint32Array | undefined;
    const sh8to11 = sh8to11Texture?.lock() as Uint32Array | undefined;
    const sh12to15 = sh12to15Texture?.lock() as Uint32Array | undefined;
    fillRaw4DSH(this.asset, this.shBands, sh1to3, sh4to7, sh8to11, sh12to15);
    sh1to3Texture.unlock();
    sh4to7Texture?.unlock();
    sh8to11Texture?.unlock();
    sh12to15Texture?.unlock();
  }
}
