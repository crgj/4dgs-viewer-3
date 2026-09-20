// #WDD-gpt 2026-09-20 - 后台准备协议保持 FP16 位模式和原始纹理布局，输出数组通过 Transferable 返回。
import { FloatPacking } from 'playcanvas';
import type { Raw4DAsset, Raw4DTrack } from '../formats/raw4d/Raw4DTypes';
import { RAW4D_FLOAT16_DECODE_TABLE } from '../formats/raw4d/Raw4DFloat16';
// #WDD-gpt 2026-09-20 - FP16 到纹理 FP16 的原 round-trip 结果预计算，保持 NaN/负零规则而消除逐点重复转换。
const textureHalf = Uint16Array.from(RAW4D_FLOAT16_DECODE_TABLE, FloatPacking.float2Half);
import { fillRaw4DColorTransform, fillRaw4DSH } from './Raw4DTexturePacking';
export type PreparedArray = Uint16Array | Uint32Array | Float32Array;
export type PreparationTrackRequest = { kind: 'track'; track: Raw4DTrack; components: readonly number[]; half: boolean; layout: 'vector' | 'opacity' | 'scalar'; preserveHalf: boolean };
export type PreparationRequest =
  | { kind: 'resource'; asset: Raw4DAsset; shBands: number }
  | PreparationTrackRequest
  | { kind: 'tracks'; tracks: PreparationTrackRequest[] };
export function prepareRaw4D(request: PreparationRequest): Record<string, PreparedArray> {
  // #WDD-gpt 2026-09-20 - 多个独立 StorageBuffer 槽位合批处理，减少线程往返而保持各布局逐位一致。
  if (request.kind === 'tracks') return Object.fromEntries(request.tracks.map((track, index) => [String(index), prepareRaw4D(track).data]));
  if (request.kind === 'resource') {
    const { asset, shBands } = request, count = asset.splatCount;
    const result: Record<string, Uint16Array | Uint32Array> = {
      splatColor: new Uint16Array(count * 4), transformA: new Uint32Array(count * 4), transformB: new Uint16Array(count * 4),
    };
    fillRaw4DColorTransform(asset, result.splatColor as Uint16Array, result.transformA as Uint32Array, result.transformB as Uint16Array);
    if (shBands > 0) result.splatSH_1to3 = new Uint32Array(count * 4);
    if (shBands > 1) { result.splatSH_4to7 = new Uint32Array(count * 4); result.splatSH_8to11 = new Uint32Array(count * (shBands > 2 ? 4 : 1)); }
    if (shBands > 2) result.splatSH_12to15 = new Uint32Array(count * 4);
    if (shBands > 0) fillRaw4DSH(asset, shBands, result.splatSH_1to3 as Uint32Array, result.splatSH_4to7 as Uint32Array, result.splatSH_8to11 as Uint32Array, result.splatSH_12to15 as Uint32Array);
    return result;
  }
  const { track, half, layout, components, preserveHalf } = request;
  const count = track.values[0].length, keys = track.keyframes.length;
  const stride = layout === 'vector' ? keys * 4 : layout === 'opacity' ? Math.ceil(keys / 4) * 4 : 1;
  const length = count * stride;
  const result = half ? new Uint16Array(layout === 'scalar' ? Math.ceil(length / 2) * 2 : length) : new Float32Array(length);
  if (layout === 'opacity') result.fill(FloatPacking.float2Half(-20));
  // #WDD-gpt 2026-09-20 - 按列固定源数组和转换分支，使点循环只做读取与写出。
  for (let key = 0; key < keys; key++) for (let component = 0; component < components.length; component++) {
    const source = track.values[key * track.components + components[component]];
    let output = layout === 'vector' ? key * 4 + component : layout === 'opacity' ? key : 0;
    if (track.encoding === 'float16') {
      if (!half) for (let point = 0; point < count; point++, output += stride) result[output] = RAW4D_FLOAT16_DECODE_TABLE[source[point]];
      else if (preserveHalf) for (let point = 0; point < count; point++, output += stride) result[output] = source[point];
      else for (let point = 0; point < count; point++, output += stride) result[output] = textureHalf[source[point]];
    } else if (half) {
      for (let point = 0; point < count; point++, output += stride) result[output] = FloatPacking.float2Half(source[point]);
    } else {
      for (let point = 0; point < count; point++, output += stride) result[output] = source[point];
    }
  }
  return { data: result };
}
