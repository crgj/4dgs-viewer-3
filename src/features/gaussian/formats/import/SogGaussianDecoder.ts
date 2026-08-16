import type { GaussianAssetDecodeOptions, ImportedGaussianAsset } from './GaussianImportTypes';
import {
  abortIfRequested,
  finalizeImportedAsset,
  makeStaticAsset,
  SH_COEFFICIENTS_BY_BAND,
} from './GaussianImportUtils';

// #WDD-gpt 2026-08-16 - 在浏览器内展开 ZIP 和图像码本，SOG 不依赖独立服务或第二套 GPU 资源。

interface ZipEntry { readonly name: string; readonly compression: number; readonly bytes: Uint8Array; }
interface SogChannelMeta {
  readonly files: readonly string[];
  readonly mins?: readonly number[] | number;
  readonly maxs?: readonly number[] | number;
  readonly codebook?: readonly (number | null)[];
}
interface SogMeta {
  readonly version?: number;
  readonly count: number;
  readonly means: SogChannelMeta;
  readonly quats: SogChannelMeta;
  readonly scales: SogChannelMeta;
  readonly sh0: SogChannelMeta;
  readonly shN?: SogChannelMeta & { readonly bands?: number };
}
interface RgbaImage { readonly data: Uint8ClampedArray; readonly width: number; readonly height: number; }

function findEndOfCentralDirectory(view: DataView): number {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('Invalid SOG bundle: ZIP directory was not found.');
}

function parseZip(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset === 0xffffffff) throw new Error('SOG Zip64 bundles are not supported.');
  const decoder = new TextDecoder();
  const result: ZipEntry[] = [];
  let offset = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Invalid SOG central directory record.');
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
    if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error(`Invalid SOG local record for ${name}.`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    result.push({ name, compression, bytes: new Uint8Array(buffer, dataOffset, compressedSize) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return result;
}

async function inflateEntry(entry: ZipEntry): Promise<Uint8Array> {
  if (entry.compression === 0) return entry.bytes;
  if (entry.compression !== 8 || typeof DecompressionStream === 'undefined') {
    throw new Error(`SOG ZIP compression method ${entry.compression} is not supported by this browser.`);
  }
  const copy = entry.bytes.slice();
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeRgba(bytes: Uint8Array, fileName: string): Promise<RgbaImage> {
  if (typeof createImageBitmap === 'undefined') throw new Error('This browser cannot decode SOG image codebooks.');
  const extension = fileName.split('.').pop()?.toLowerCase();
  const mime = extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const bitmap = await createImageBitmap(new Blob([bytes.slice()], { type: mime }), {
    colorSpaceConversion: 'none', premultiplyAlpha: 'none', resizeQuality: 'pixelated',
  });
  try {
    let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (typeof OffscreenCanvas !== 'undefined') {
      context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d', { willReadFrequently: true });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      context = canvas.getContext('2d', { willReadFrequently: true });
    }
    if (!context) throw new Error('Cannot create a 2D canvas for SOG decoding.');
    context.drawImage(bitmap, 0, 0);
    return { data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

function mapSignedLog(value: number): number {
  return Math.sign(value) * Math.expm1(Math.abs(value));
}

function lerp(minimum: number, maximum: number, alpha: number): number {
  return minimum + (maximum - minimum) * alpha;
}

function numericArray(value: readonly number[] | number | undefined, count: number, fallback: number): number[] {
  if (Array.isArray(value)) return Array.from({ length: count }, (_, index) => Number(value[index] ?? fallback));
  return Array(count).fill(typeof value === 'number' ? value : fallback);
}

function safeCodebook(meta: SogChannelMeta): Float32Array | null {
  if (!meta.codebook) return null;
  const result = Float32Array.from(meta.codebook, (value) => typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN);
  for (let index = 0; index < result.length; index += 1) {
    if (Number.isFinite(result[index])) continue;
    const next = result.subarray(index + 1).find((value) => Number.isFinite(value));
    result[index] = next ?? (index > 0 ? result[index - 1] : 0);
  }
  return result;
}

function requirePixels(image: RgbaImage, count: number, label: string): void {
  if (image.data.length < count * 4) throw new Error(`SOG ${label} texture is smaller than meta.count.`);
}

export async function decodeSogGaussian(
  file: File,
  options: GaussianAssetDecodeOptions,
): Promise<ImportedGaussianAsset> {
  abortIfRequested(options.signal);
  options.onProgress?.({ ratio: 0.02, stage: 'archive', message: '正在读取 SOG 压缩包' });
  const archive = parseZip(await file.arrayBuffer());
  const expanded = new Map<string, Uint8Array>();
  for (let index = 0; index < archive.length; index += 1) {
    abortIfRequested(options.signal);
    const entry = archive[index];
    expanded.set(entry.name, await inflateEntry(entry));
    options.onProgress?.({ ratio: 0.04 + 0.12 * (index + 1) / archive.length, stage: 'archive', message: `正在展开 ${entry.name}` });
  }
  const metaBytes = expanded.get('meta.json');
  if (!metaBytes) throw new Error('SOG bundle misses meta.json.');
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as SogMeta;
  if (!Number.isSafeInteger(meta.count) || meta.count <= 0) throw new Error('SOG meta.count is invalid.');
  const count = meta.count;
  const requestedBands = Math.max(0, Math.min(3, Math.round(meta.shN?.bands ?? 3))) as 0 | 1 | 2 | 3;
  const estimatedBytes = count * (16 + SH_COEFFICIENTS_BY_BAND[requestedBands] * 3) * 4;
  if (estimatedBytes > options.cpuBudgetBytes) {
    throw new Error(`SOG 解码预计需要 ${(estimatedBytes / 1e9).toFixed(2)} GB，超过统一内存预算。`);
  }
  const image = async (name: string | undefined, label: string) => {
    if (!name) throw new Error(`SOG meta misses ${label} filename.`);
    const bytes = expanded.get(name);
    if (!bytes) throw new Error(`SOG bundle misses ${name}.`);
    return decodeRgba(bytes, name);
  };
  options.onProgress?.({ ratio: 0.2, stage: 'images', message: '正在解码 SOG 量化纹理' });
  const [meansL, meansU, quats, scales, sh0] = await Promise.all([
    image(meta.means.files[0], 'means low'), image(meta.means.files[1], 'means high'),
    image(meta.quats.files[0], 'quaternions'), image(meta.scales.files[0], 'scales'),
    image(meta.sh0.files[0], 'SH0'),
  ]);
  for (const [decoded, label] of [[meansL, 'means_l'], [meansU, 'means_u'], [quats, 'quats'], [scales, 'scales'], [sh0, 'sh0']] as const) {
    requirePixels(decoded, count, label);
  }
  abortIfRequested(options.signal);
  let shCentroids: RgbaImage | null = null;
  let shLabels: RgbaImage | null = null;
  if (meta.shN?.files?.length && expanded.has(meta.shN.files[0]) && expanded.has(meta.shN.files[1])) {
    [shCentroids, shLabels] = await Promise.all([
      image(meta.shN.files[0], 'SH centroids'), image(meta.shN.files[1], 'SH labels'),
    ]);
    requirePixels(shLabels, count, 'SH labels');
  }
  const inferredBands = shCentroids ? ({ 192: 1, 512: 2, 960: 3 } as Record<number, 1 | 2 | 3>)[shCentroids.width] ?? requestedBands : 0;
  const coefficientCount = SH_COEFFICIENTS_BY_BAND[inferredBands];
  const x = new Float32Array(count); const y = new Float32Array(count); const z = new Float32Array(count);
  const qw = new Float32Array(count); const qx = new Float32Array(count); const qy = new Float32Array(count); const qz = new Float32Array(count);
  const sx = new Float32Array(count); const sy = new Float32Array(count); const sz = new Float32Array(count);
  const dc0 = new Float32Array(count); const dc1 = new Float32Array(count); const dc2 = new Float32Array(count);
  const opacity = new Float32Array(count);
  const shRest = Array.from({ length: coefficientCount * 3 }, () => new Float32Array(count));
  const meanMins = numericArray(meta.means.mins, 3, -1); const meanMaxs = numericArray(meta.means.maxs, 3, 1);
  const scaleMins = numericArray(meta.scales.mins, 3, -6); const scaleMaxs = numericArray(meta.scales.maxs, 3, 0);
  const sh0Mins = numericArray(meta.sh0.mins, 4, -1); const sh0Maxs = numericArray(meta.sh0.maxs, 4, 1);
  const scaleBook = safeCodebook(meta.scales); const sh0Book = safeCodebook(meta.sh0); const shBook = meta.shN ? safeCodebook(meta.shN) : null;
  const shMins = numericArray(meta.shN?.mins, 1, -1)[0]; const shMaxs = numericArray(meta.shN?.maxs, 1, 1)[0];
  const sqrt2 = Math.SQRT2;
  options.onProgress?.({ ratio: 0.55, stage: 'canonical', message: '正在还原 SOG Gaussian 属性' });
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4;
    x[index] = mapSignedLog(lerp(meanMins[0], meanMaxs[0], ((meansU.data[offset] << 8) + meansL.data[offset]) / 65535));
    y[index] = mapSignedLog(lerp(meanMins[1], meanMaxs[1], ((meansU.data[offset + 1] << 8) + meansL.data[offset + 1]) / 65535));
    z[index] = mapSignedLog(lerp(meanMins[2], meanMaxs[2], ((meansU.data[offset + 2] << 8) + meansL.data[offset + 2]) / 65535));
    const a = (quats.data[offset] / 255 - 0.5) * sqrt2;
    const b = (quats.data[offset + 1] / 255 - 0.5) * sqrt2;
    const c = (quats.data[offset + 2] / 255 - 0.5) * sqrt2;
    const d = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    switch (quats.data[offset + 3] - 252) {
      case 0: qw[index] = d; qx[index] = a; qy[index] = b; qz[index] = c; break;
      case 1: qw[index] = a; qx[index] = d; qy[index] = b; qz[index] = c; break;
      case 2: qw[index] = a; qx[index] = b; qy[index] = d; qz[index] = c; break;
      case 3: qw[index] = a; qx[index] = b; qy[index] = c; qz[index] = d; break;
      default: qw[index] = 1; break;
    }
    sx[index] = scaleBook?.[scales.data[offset]] ?? lerp(scaleMins[0], scaleMaxs[0], scales.data[offset] / 255);
    sy[index] = scaleBook?.[scales.data[offset + 1]] ?? lerp(scaleMins[1], scaleMaxs[1], scales.data[offset + 1] / 255);
    sz[index] = scaleBook?.[scales.data[offset + 2]] ?? lerp(scaleMins[2], scaleMaxs[2], scales.data[offset + 2] / 255);
    dc0[index] = sh0Book?.[sh0.data[offset]] ?? lerp(sh0Mins[0], sh0Maxs[0], sh0.data[offset] / 255);
    dc1[index] = sh0Book?.[sh0.data[offset + 1]] ?? lerp(sh0Mins[1], sh0Maxs[1], sh0.data[offset + 1] / 255);
    dc2[index] = sh0Book?.[sh0.data[offset + 2]] ?? lerp(sh0Mins[2], sh0Maxs[2], sh0.data[offset + 2] / 255);
    const alpha = meta.version === 2 ? sh0.data[offset + 3] / 255 : 1 / (1 + Math.exp(-lerp(sh0Mins[3], sh0Maxs[3], sh0.data[offset + 3] / 255)));
    opacity[index] = alpha <= 0 ? -20 : alpha >= 1 ? 20 : Math.log(alpha / (1 - alpha));
    if (shCentroids && shLabels && coefficientCount > 0) {
      const label = shLabels.data[offset] + (shLabels.data[offset + 1] << 8);
      const u = (label % 64) * coefficientCount;
      const v = Math.floor(label / 64);
      for (let channel = 0; channel < 3; channel += 1) {
        for (let coefficient = 0; coefficient < coefficientCount; coefficient += 1) {
          const code = shCentroids.data[((v * shCentroids.width + u + coefficient) * 4) + channel];
          shRest[channel * coefficientCount + coefficient][index] = shBook?.[code] ?? lerp(shMins, shMaxs, code / 255);
        }
      }
    }
    if ((index & 0x3fff) === 0) abortIfRequested(options.signal);
  }
  const asset = makeStaticAsset({
    sourceName: file.name,
    position: [x, y, z], rotation: [qw, qx, qy, qz], colorDc: [dc0, dc1, dc2],
    scale: [sx, sy, sz], opacity, shRest,
  });
  options.onProgress?.({ ratio: 1, stage: 'finalizing', message: 'SOG 解码完成' });
  return finalizeImportedAsset(file, 'SOG', asset, options, 'image-codebook');
}
