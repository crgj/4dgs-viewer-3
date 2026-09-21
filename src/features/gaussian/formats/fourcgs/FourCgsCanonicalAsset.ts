// #WDD-gpt 2026-09-20 - 内部解码行直接转成 Canonical RAM，取消临时 PLY 展开、File 复制和 Loader 再次解析；校验与普通导入共用。
import type { FourCgsSegment } from './FourCgsTypes';
import type { Raw4DAsset, Raw4DTrack } from '../raw4d/Raw4DTypes';
import { fourCgsRaw4DKeyframeStrides, fourCgsShDimensions } from './FourCgsRaw4D';
import { raw4DCanonicalKeyframes, RAW4D_TRACK_DEFINITIONS, raw4DTrackPropertyName } from '../raw4d/Raw4DSchema';
import { calculateRaw4DBounds, validateDecodedRaw4DRows } from '../raw4d/Raw4DParser';

export function createFourCgsCanonicalAsset(segment: FourCgsSegment, names: readonly string[], rows: Uint16Array,
  shared = false, cpuBudgetBytes = Number.MAX_SAFE_INTEGER): Raw4DAsset {
  const count = segment.gaussianCount;
  if (rows.length !== count * names.length) throw new Error('4CGS decoded point count mismatch.');
  if (rows.byteLength > cpuBudgetBytes) throw new Error('RAW4D CPU memory budget exceeded.');
  validateDecodedRaw4DRows(rows, names);
  const backing = new Uint16Array(shared ? new SharedArrayBuffer(rows.byteLength) : new ArrayBuffer(rows.byteLength));
  // 小块转置使输入与输出访问局限在缓存内；所有列原样保留 FP16 位模式。
  for (let first = 0; first < count; first += 256) {
    const end = Math.min(first + 256, count);
    for (let column = 0; column < names.length; column++) {
      const output = column * count;
      for (let row = first, input = first * names.length + column; row < end; row++, input += names.length) backing[output + row] = rows[input];
    }
  }
  return createFourCgsCanonicalAssetFromColumnMajor(segment, names, backing);
}

// #WDD-gpt 2026-09-20 - WebGPU 可直接写出最终列式 FP16 backing；此入口只组装 Track 视图，避免再生成临时 RAW4D 文件及二次转置。
export function createFourCgsCanonicalAssetFromColumnMajor(
  segment: FourCgsSegment,
  names: readonly string[],
  backing: Uint16Array,
): Raw4DAsset {
  const count = segment.gaussianCount;
  if (backing.length !== count * names.length) throw new Error('4CGS canonical column count mismatch.');
  const columns = new Map(names.map((name, index) => [name, backing.subarray(index * count, (index + 1) * count)]));
  const get = (name: string) => { const values = columns.get(name); if (!values) throw new Error(`4CGS missing ${name}`); return values; };
  const strides = fourCgsRaw4DKeyframeStrides(segment);
  const tracks = Object.fromEntries(Object.entries(RAW4D_TRACK_DEFINITIONS).map(([name, definition]) => {
    const key = name as keyof typeof segment.bankCounts;
    const keyframes = raw4DCanonicalKeyframes(segment.totalFrames, strides[key], segment.bankCounts[key]);
    const values = keyframes.flatMap((_frame, bank) => definition.components.map(component => get(raw4DTrackPropertyName(definition, bank, component))));
    return [name, { encoding: 'float16', components: definition.components.length, keyframes, values } satisfies Raw4DTrack];
  })) as unknown as Record<keyof typeof segment.bankCounts, Raw4DTrack>;
  return {
    sourceName: `${segment.name}.raw4d`, sourceEncoding: 'float16', splatCount: count, totalFrames: segment.totalFrames,
    frameRate: segment.frameRate, shBands: segment.shBands ?? 3, ...tracks,
    shRest: Array.from({ length: fourCgsShDimensions(segment) }, (_, i) => get(`f_rest_${i}`)),
    lifetimeMu: get('lifetime_mu'), lifetimeW: get('lifetime_w'), bounds: calculateRaw4DBounds(tracks.position),
    positionTiming: segment.positionTiming === 'per-point-lifetime-endpoints' ? segment.positionTiming : undefined,
    opacityTiming: segment.opacityTiming === 'baked' ? 'baked' : undefined,
    temporalLayout: { schemaVersion: 1,
      interpolation: { position: 'linear', rotation: 'slerp', colorDc: 'linear', scale: 'linear', opacity: 'linear' },
      pointGroups: [{ id: 'dynamic', firstPoint: 0, pointCount: count, sourceElement: 'vertex',
        trackKeyframes: Object.fromEntries(Object.entries(tracks).map(([name, track]) => [name, track.keyframes])) as Record<keyof typeof tracks, readonly number[]> }],
    },
  };
}
