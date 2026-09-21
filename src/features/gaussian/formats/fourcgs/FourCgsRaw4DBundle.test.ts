import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { unzlibSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FOUR_CGS_HEADER_BYTES, readFourCgsManifest } from './FourCgsContainer';
import {
  createRaw4DRawBundleFiles,
  paddedEvenLength,
  RAW4D_RAW_BUNDLE_CODEC_NAME,
  raw4DBundleMetadata,
  raw4DBundleOutputName,
  shuffle16WithPadding,
  unshuffle16,
} from './FourCgsRaw4DBundle';
import { encodeRaw4DBundle } from './fourcgs-encoder.worker';
import { encodeRaw4DV26Browser, encodeRaw4DV26BrowserMemory } from './FourCgsV26BrowserEncoder';
import { parseRaw4D, readRaw4DHeader } from '../raw4d/Raw4DParser';
import { floatToHalf } from '../../../../../scripts/fourcgs-prs-codec.mjs';

const nativeFetch = globalThis.fetch;
beforeAll(() => vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('file:') && url.endsWith('.wasm')) {
    return new Response(await readFile(fileURLToPath(url)), { headers: { 'content-type': 'application/wasm' } });
  }
  return nativeFetch(input, init);
}));
afterAll(() => vi.unstubAllGlobals());

function fp16Raw4D(name: string, rows: number): File {
  const properties = [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity', 'scale_0', 'scale_1', 'scale_2', 'lifetime_mu', 'lifetime_w',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
    'rot_bank_0_w', 'rot_bank_0_x', 'rot_bank_0_y', 'rot_bank_0_z',
    'f_dc_bank_0_0', 'f_dc_bank_0_1', 'f_dc_bank_0_2',
    'scale_bank_0_0', 'scale_bank_0_1', 'scale_bank_0_2',
    'opacity_bank_0',
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0',
    'comment total_frames 1',
    'comment xyz_bank_keyframe_stride 1',
    'comment rot_bank_keyframe_stride 1',
    'comment features_dc_bank_keyframe_stride 1',
    'comment scaling_bank_keyframe_stride 1',
    'comment opacity_bank_keyframe_stride 1',
    'comment fp16_quantized 1',
    `element vertex ${rows}`,
    ...properties.map((property) => `property ushort ${property}`),
    'end_header', '',
  ].join('\n');
  const body = new Uint16Array(rows * properties.length);
  for (let index = 0; index < body.length; index += 1) body[index] = index + 1;
  return new File([new TextEncoder().encode(header), body], name);
}

// #WDD-gpt 2026-08-18 - 同一组 V2.6 测试属性可生成 FP16 RAW4D 或 Float32 PLY4，锁定内存精度转换边界。
function compressibleRaw4D(name: string, rows: number, encoding: 'float16' | 'float32'): File {
  const properties = [
    'x', 'y', 'z', 'nx', 'ny', 'nz',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: 45 }, (_, index) => `f_rest_${index}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2', 'lifetime_mu', 'lifetime_w',
    'rot_0', 'rot_1', 'rot_2', 'rot_3',
    'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
    'rot_bank_0_w', 'rot_bank_0_x', 'rot_bank_0_y', 'rot_bank_0_z',
    'f_dc_bank_0_0', 'f_dc_bank_0_1', 'f_dc_bank_0_2',
    'scale_bank_0_0', 'scale_bank_0_1', 'scale_bank_0_2',
    'opacity_bank_0',
  ];
  const header = [
    'ply', 'format binary_little_endian 1.0',
    'comment total_frames 1',
    'comment xyz_bank_keyframe_stride 1',
    'comment rot_bank_keyframe_stride 1',
    'comment features_dc_bank_keyframe_stride 1',
    'comment scaling_bank_keyframe_stride 1',
    'comment opacity_bank_keyframe_stride 1',
    ...(encoding === 'float16' ? ['comment fp16_quantized 1'] : []),
    `element vertex ${rows}`,
    ...properties.map((property) => `property ${encoding === 'float16' ? 'ushort' : 'float'} ${property}`),
    'end_header', '',
  ].join('\n');
  const body = encoding === 'float16'
    ? new Uint16Array(rows * properties.length)
    : new Float32Array(rows * properties.length);
  const index = new Map(properties.map((property, propertyIndex) => [property, propertyIndex]));
  for (let row = 0; row < rows; row += 1) {
    const set = (property: string, value: number) => {
      body[row * properties.length + index.get(property)!] = encoding === 'float16' ? floatToHalf(value) : value;
    };
    const position = [row * 0.002, (row % 5) * 0.003, (row % 7) * -0.002];
    for (const [axis, axisName] of ['x', 'y', 'z'].entries()) {
      set(axisName, position[axis]);
      set(`xyz_bank_0_${axisName}`, position[axis]);
    }
    for (let dimension = 0; dimension < 45; dimension += 1) {
      set(`f_rest_${dimension}`, Math.sin(row * 0.13 + dimension * 0.19) * 0.08);
    }
    for (let component = 0; component < 3; component += 1) {
      set(`f_dc_${component}`, component * 0.03);
      set(`f_dc_bank_0_${component}`, component * 0.03);
      set(`scale_${component}`, -3 + component * 0.1);
      set(`scale_bank_0_${component}`, -3 + component * 0.1);
    }
    set('opacity', 1);
    set('opacity_bank_0', 1);
    set('lifetime_mu', 0.5);
    set('lifetime_w', 0.5);
    set('rot_0', 1);
    set('rot_bank_0_w', 1);
  }
  return new File([new TextEncoder().encode(header), body], name);
}

function compressibleFp16Raw4D(name: string, rows: number): File {
  return compressibleRaw4D(name, rows, 'float16');
}

describe('RAW4D 4CGS bundle helpers', () => {
  it('round-trips even and odd source byte lengths without changing source bytes', () => {
    for (const source of [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6, 7, 8, 9])]) {
      const restored = unshuffle16(shuffle16WithPadding(source));
      expect(restored.byteLength).toBe(paddedEvenLength(source.byteLength));
      expect(restored.subarray(0, source.byteLength)).toEqual(source);
      expect([...restored.subarray(source.byteLength)]).toEqual(source.byteLength % 2 ? [0] : []);
    }
  });

  it('derives the download name from the current dragged source layout', () => {
    expect(raw4DBundleOutputName(['take.raw4d'], 0, 30)).toBe('take.4cgs');
    expect(raw4DBundleOutputName(['segment_180_210.raw4d', 'segment_210_240.raw4d'], 180, 240))
      .toBe('raw4d_sequence_180_240.4cgs');
  });

  it('restores raw bundle segments as source-backed File slices', async () => {
    const payloads = [new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7, 8, 9, 10, 11])];
    const bundleSegments = [
      { name: 'first', firstFrame: 0, lastFrame: 0, gaussianCount: 1, totalFrames: 1, bankCounts: { position: 1, rotation: 1, colorDc: 1, scale: 1, opacity: 1 } },
      { name: 'second', firstFrame: 1, lastFrame: 1, gaussianCount: 1, totalFrames: 1, bankCounts: { position: 1, rotation: 1, colorDc: 1, scale: 1, opacity: 1 } },
    ];
    const manifest = {
      format: '4CGS' as const,
      version: 2,
      codecName: RAW4D_RAW_BUNDLE_CODEC_NAME,
      slotCount: 1,
      firstFrame: 0,
      lastFrame: 1,
      uniqueFrameCount: 2,
      segments: bundleSegments,
      streams: payloads.map((payload, index) => ({
        name: `raw4d_segment:${index}:0`,
        compression: 'raw' as const,
        rawBytes: payload.byteLength,
        storedBytes: payload.byteLength,
        rawSha256: `${index + 1}`.repeat(64),
        storedSha256: `${index + 1}`.repeat(64),
      })),
      crop: { center: [0, 0, 0] as const, halfExtent: 1 },
      prs: { mode: 'raw4d-raw-bundle' },
      metadata: {
        raw4dBundle: {
          version: 1 as const,
          chunkBytes: 8,
          segmentChunkCounts: [1, 1],
          sourceNames: ['first.raw4d', 'nested/second.raw4d'],
          sourceByteLengths: payloads.map((payload) => payload.byteLength),
          sourceSha256: ['a'.repeat(64), 'b'.repeat(64)],
          exactSourceBytes: true as const,
        },
      },
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new Uint8Array(12);
    header.set(new TextEncoder().encode('4CGSPRS2'));
    new DataView(header.buffer).setUint32(8, manifestBytes.byteLength, true);
    const source = new File([header, manifestBytes, ...payloads], 'raw-bundle.4cgs');

    const directory = await readFourCgsManifest(source);
    const files = createRaw4DRawBundleFiles(source, directory.manifest, FOUR_CGS_HEADER_BYTES + directory.manifestBytes);

    expect(files.map((file) => file.name)).toEqual(['first.raw4d', 'second.raw4d']);
    expect(await Promise.all(files.map(async (file) => [...new Uint8Array(await file.arrayBuffer())])))
      .toEqual(payloads.map((payload) => [...payload]));
  });

  it('physically removes deleted stable IDs before compressing the export', async () => {
    const source = fp16Raw4D('segment_0_0.raw4d', 3);
    const deletionWords = new Uint32Array([1 << 1]);
    const result = await encodeRaw4DBundle([source], [deletionWords]);
    const { manifest, manifestBytes } = await readFourCgsManifest(result.blob);
    const bundle = raw4DBundleMetadata(manifest)!;
    const stream = manifest.streams[0];
    const streamOffset = FOUR_CGS_HEADER_BYTES + manifestBytes;
    const stored = new Uint8Array(await result.blob.slice(
      streamOffset,
      streamOffset + stream.storedBytes,
    ).arrayBuffer());
    const restored = unshuffle16(unzlibSync(stored)).subarray(0, bundle.sourceByteLengths[0]);
    const restoredHeader = await readRaw4DHeader(new Blob([restored.slice().buffer as ArrayBuffer]));

    expect(manifest.segments[0].gaussianCount).toBe(2);
    expect(manifest.metadata?.editorBuild?.version).toBe(__APP_VERSION__);
    expect(restoredHeader.vertexCount).toBe(2);
    expect(result.originalPointCount).toBe(3);
    expect(result.encodedPointCount).toBe(2);
    expect(result.deletedPointCount).toBe(1);
    expect(bundle.deletedPointCount).toBe(1);
    expect(result.sourceBytes).toBe(source.size - restoredHeader.recordBytes);
  });

  it('self-trains a generic adaptive SH profile without source hash binding', async () => {
    const source = compressibleFp16Raw4D('unseen_take_0_0.raw4d', 32);
    const result = await encodeRaw4DV26Browser([source], [new Uint32Array(1)]);
    const { manifest, manifestBytes } = await readFourCgsManifest(result.blob);
    const shEntryIndex = manifest.streams.findIndex((stream) => stream.name === 'coresh5r_shared');
    const shOffset = FOUR_CGS_HEADER_BYTES + manifestBytes
      + manifest.streams.slice(0, shEntryIndex).reduce((sum, stream) => sum + stream.storedBytes, 0);
    const magic = new TextDecoder().decode(new Uint8Array(await result.blob.slice(shOffset, shOffset + 8).arrayBuffer()));
    const policy = manifest.compressionV26 as Record<string, any>;

    expect(manifest.codecName).toContain('AdaptivePQ');
    expect(magic).toBe('C5T3SH01');
    expect(['compact-5x9d', 'balanced-10x4-5d', 'quality-15x3d']).toContain(policy.shPolicy.template);
    expect(policy.generalizationPolicy).toContain('no filename/hash/source-profile dependency');
    expect(policy.sourceProfileSha256).toBeUndefined();
    expect(policy.qualityGate.status).toBe('numeric-passed');
    expect(policy.shPolicy.measuredRmse).toBeLessThanOrEqual(0.0130001);
    expect(policy.shPolicy.maximumCoefficientError).toBeLessThanOrEqual(0.0500001);
  }, 30_000);

  it('encodes the current canonical RAM snapshot and its frozen deletion mask', async () => {
    const source = compressibleFp16Raw4D('memory_take_0_0.raw4d', 16);
    const asset = await parseRaw4D(source, { sourceName: source.name });
    const result = await encodeRaw4DV26BrowserMemory([{
      name: source.name,
      asset,
      deletionWords: new Uint32Array([1 << 3]),
    }]);
    const { manifest } = await readFourCgsManifest(result.blob);
    const raw4dExport = manifest.metadata?.raw4dExport as Record<string, unknown>;

    expect(result.originalPointCount).toBe(16);
    expect(result.encodedPointCount).toBe(15);
    expect(result.deletedPointCount).toBe(1);
    expect(manifest.segments[0].gaussianCount).toBe(15);
    expect(manifest.metadata?.editorBuild?.version).toBe(__APP_VERSION__);
    expect(raw4dExport.sourceKind).toBe('canonical-memory-or-file-snapshot');
    expect((raw4dExport.temporalLayouts as Array<{ schemaVersion: number }>)[0].schemaVersion).toBe(1);
    expect(result.sourceSha256[0]).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  // #WDD-gpt 2026-09-20 - 崩溃恢复的单路编码必须保留多容器合并后的显式连续帧范围。
  it('keeps four concatenated container ranges in safe single-worker mode', async () => {
    const source = compressibleFp16Raw4D('memory_take_600_749.raw4d', 16);
    const parsed = await parseRaw4D(source, { sourceName: source.name });
    const asset = { ...parsed, totalFrames: 150 };
    const names = [
      'music_600_749.raw4d', 'music_750_899.raw4d',
      'music_900_1049.raw4d', 'music_1050_1199.raw4d',
    ];
    const result = await encodeRaw4DV26BrowserMemory(names.map((name) => ({
      name, asset, deletionWords: new Uint32Array(1),
    })), undefined, { shLevel: 3, maximumEffectiveAlpha: 0 }, true);
    const { manifest } = await readFourCgsManifest(result.blob);
    expect(manifest.segments.map((segment) => [segment.firstFrame, segment.lastFrame])).toEqual([
      [600, 749], [750, 899], [900, 1049], [1050, 1199],
    ]);
    expect(manifest.firstFrame).toBe(600);
    expect(manifest.lastFrame).toBe(1199);
    expect(manifest.uniqueFrameCount).toBe(600);
    expect((manifest.compressionV26 as Record<string, any>).layoutPolicy.lowMemoryMode).toBe(true);
  }, 30_000);

  // #WDD-gpt 2026-09-20 - 同时回归 SH1 真实 9D 载荷与全整数帧最大有效 Alpha 剪除统计。
  it('writes true SH1 dimensions and prunes only points below the effective Alpha gate', async () => {
    const source = compressibleFp16Raw4D('sh1_alpha_take_0_0.raw4d', 16);
    const asset = await parseRaw4D(source, { sourceName: source.name });
    for (const values of asset.opacity.values) (values as Uint16Array)[0] = floatToHalf(-20);
    const result = await encodeRaw4DV26BrowserMemory([{
      name: source.name,
      asset,
      deletionWords: new Uint32Array(1),
    }], undefined, { shLevel: 1, maximumEffectiveAlpha: 0.1 });
    const { manifest, manifestBytes } = await readFourCgsManifest(result.blob);
    const policy = manifest.compressionV26 as Record<string, any>;
    const shEntryIndex = manifest.streams.findIndex((stream) => stream.name === 'coresh5r_shared');
    const shOffset = FOUR_CGS_HEADER_BYTES + manifestBytes
      + manifest.streams.slice(0, shEntryIndex).reduce((sum, stream) => sum + stream.storedBytes, 0);
    const header = new Uint8Array(await result.blob.slice(shOffset, shOffset + 20).arrayBuffer());

    expect(new TextDecoder().decode(header.subarray(0, 8))).toBe('C5T3SH01');
    expect(header[18]).toBe(9);
    expect(manifest.segments[0].shBands).toBe(1);
    expect(manifest.segments[0].gaussianCount).toBe(15);
    expect(policy.alphaPrunedPointCount).toBe(1);
    expect(policy.maximumEffectiveAlpha).toBe(0.1);
    expect(policy.shPolicy).toMatchObject({ level: 1, dimensions: 9 });
  }, 30_000);

  it('encodes multi-frame Float32 PLY4 memory and expands static fallback tracks', async () => {
    const source = compressibleRaw4D('float32_memory_take.ply4', 16, 'float32');
    const asset = await parseRaw4D(source, { sourceName: source.name });
    const position = asset.position.values[0];
    const firstPosition = position[1];
    const multiFrameAsset = {
      ...asset,
      totalFrames: 3,
      position: {
        ...asset.position,
        keyframes: [0, 2],
        values: [...asset.position.values, ...asset.position.values],
      },
    };
    const result = await encodeRaw4DV26BrowserMemory([{
      name: source.name,
      asset: multiFrameAsset,
      deletionWords: new Uint32Array(1),
    }]);
    const { manifest } = await readFourCgsManifest(result.blob);
    const raw4dExport = manifest.metadata?.raw4dExport as Record<string, unknown>;

    expect(asset.sourceEncoding).toBe('float32');
    expect(position).toBeInstanceOf(Float32Array);
    expect(position[1]).toBe(firstPosition);
    expect(result.encodedPointCount).toBe(16);
    expect(manifest.segments[0].bankCounts).toEqual({ position: 2, rotation: 2, colorDc: 2, scale: 2, opacity: 2 });
    expect(manifest.segments[0].keyframeStrides).toEqual({ position: 2, rotation: 2, colorDc: 2, scale: 2, opacity: 2 });
    expect(raw4dExport.sourceScalarEncodings).toEqual(['float32']);
    expect(raw4dExport.encodedScalarEncoding).toBe('float16');
    expect(raw4dExport.precisionPolicy).toBe('explicit-float32-to-float16-worker-copy-before-v2.6');
  }, 30_000);

  it('round-trips an independently wrapped Scale-axis stream', async () => {
    const [attributeCodec, structuredCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-temporal-attribute-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
    ]);
    const names = ['scale_bank_0_0', 'scale_bank_1_0'];
    const segment = {
      path: 'scale-axis.raw4d', count: 2, propertyNames: names,
      propertyIndex: new Map(names.map((name, index) => [name, index])),
      comments: new Map(),
      rows: Uint16Array.from([
        floatToHalf(-3), floatToHalf(-2.75),
        floatToHalf(-2.5), floatToHalf(-2.25),
      ]),
    };
    const layout = {
      slotCount: 2,
      activeSlots: [Int32Array.from([0, 1])],
      slotToLocal: [Int32Array.from([0, 1])],
    };
    const encoded = attributeCodec.encodeTemporalAttribute([segment], layout, {
      prefix: 'scale_bank', components: ['0'], bankCounts: [2], exactHalf: false, step: 0.0078125,
    });
    const stored = await structuredCodec.encodeV22StructuredStream(
      'tattr_scale_0', encoded.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    const direct = await structuredCodec.decodeV22ScaleReaders(stored.encoded, 'tattr_scale_0');
    const output = new Uint16Array(4);
    const manifest = {
      slotCount: 2,
      segments: [{ gaussianCount: 2, bankCounts: { scale: 2 } }],
    };
    attributeCodec.decodeTemporalAttributeReaders(
      direct.metadata, direct.readers, manifest,
      [layout.activeSlots[0]], [output], [new Map(names.map((name, index) => [name, index]))],
    );

    expect(Array.from(output)).toEqual(Array.from(segment.rows));
  });

  it('round-trips Position when its Brotli contexts are compressed in parallel', async () => {
    const [prsCodec, structuredCodec, brotliImport] = await Promise.all([
      import('../../../../../scripts/fourcgs-prs-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
      import('brotli-wasm'),
    ]);
    const brotli = await brotliImport.default;
    const names = [
      'xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z',
      'xyz_bank_1_x', 'xyz_bank_1_y', 'xyz_bank_1_z',
    ];
    const rows = Uint16Array.from([
      0, 0, 0, 0.01, 0, 0,
      0.1, 0.2, 0.3, 0.11, 0.19, 0.31,
    ].map(prsCodec.floatToHalf));
    const segment = {
      path: 'position-parallel.raw4d', count: 2, propertyNames: names,
      propertyIndex: new Map(names.map((name, index) => [name, index])),
      comments: new Map(), rows,
    };
    const layout = {
      slotCount: 2,
      activeSlots: [Int32Array.from([0, 1])],
      slotToLocal: [Int32Array.from([0, 1])],
    };
    const manifest = { segments: [{ gaussianCount: 2, bankCounts: { position: 2 } }] };
    const encoded = prsCodec.encodePositions([segment], layout, [2], {
      center: [0, 0, 0], halfExtent: 1, step: 0.00045, maximumError: 0.0005, cellSize: 0.5,
    });
    const raw = prsCodec.encodePositionRaw([segment], layout, [2], {
      center: [0, 0, 0], halfExtent: 1, step: 0.00045, maximumError: 0.0005, cellSize: 0.5,
    });
    const compressionOptions = {
      blockCompression: 'brotli', brotliQuality: 9,
      compressPositionParts: async (parts: readonly Uint8Array[], quality: number) => Promise.all(
        parts.map(async (part) => brotli.compress(part, { quality })),
      ),
    };
    const stored = await structuredCodec.encodeV21StructuredStream(
      'prs_position', encoded.encoded, manifest, compressionOptions,
    );
    // #WDD-gpt 2026-08-16 - 原始 Position 上下文必须生成与旧临时 rANS 往返完全一致的正式封装字节。
    const storedRaw = await structuredCodec.encodeV21StructuredStream(
      'prs_position', { mainRaw: raw.mainRaw, exceptionRaw: raw.exceptionRaw }, manifest, compressionOptions,
    );
    expect(storedRaw.encoded.byteLength).toBeGreaterThan(0);
    const restored = await structuredCodec.decodeV21StructuredStream('prs_position', stored.encoded, manifest);
    expect(restored).toEqual(encoded.encoded);
    const restoredRaw = await structuredCodec.decodeV21StructuredStream('prs_position', storedRaw.encoded, manifest);
    expect(restoredRaw).toEqual(encoded.encoded);
  });

  // #WDD-gpt 2026-09-20 - Rotation 双 Worker 的分区局部状态和零 Map 例外游标必须与单路解码逐位一致。
  it('decodes shared Rotation partitions byte-identically with partition-local state', async () => {
    const [rotationCodec, structuredCodec, prsCodec] = await Promise.all([
      import('../../../../../scripts/fourcgs-so3-temporal-codec.mjs'),
      import('../../../../../scripts/fourcgs-v21-lossless-codec.mjs'),
      import('../../../../../scripts/fourcgs-prs-codec.mjs'),
    ]);
    const names = Array.from({ length: 2 }, (_, bank) => (
      ['w', 'x', 'y', 'z'].map((component) => `rot_bank_${bank}_${component}`)
    )).flat();
    const quaternion = (angle: number) => [Math.cos(angle / 2), 0, Math.sin(angle / 2), 0];
    const segment = (path: string, angles: readonly (readonly [number, number])[]) => ({
      path,
      count: angles.length,
      propertyNames: names,
      propertyIndex: new Map(names.map((name, index) => [name, index])),
      comments: new Map<string, string>(),
      rows: Uint16Array.from(angles.flatMap((pair) => pair.flatMap((angle) => quaternion(angle))).map(prsCodec.floatToHalf)),
    });
    const segments = [
      segment('rotation_0.raw4d', [[0, 0.03], [0.1, 0.13], [0.2, 0.23]]),
      segment('rotation_1.raw4d', [[0.04, 0.07], [0.24, 0.27], [0.3, 0.33]]),
    ];
    const activeSlots = [Int32Array.from([0, 1, 2]), Int32Array.from([0, 2, 3])];
    const layout = {
      slotCount: 4,
      activeSlots,
      slotToLocal: [Int32Array.from([0, 1, 2, -1]), Int32Array.from([0, -1, 1, 2])],
    };
    const descriptors = segments.map((value, index) => ({
      name: value.path,
      firstFrame: index,
      lastFrame: index + 1,
      gaussianCount: value.count,
      totalFrames: 2,
      shBands: 3,
      bankCounts: { position: 1, rotation: 2, colorDc: 1, scale: 1, opacity: 1 },
      keyframeStrides: { position: 1, rotation: 1, colorDc: 1, scale: 1, opacity: 1 },
    }));
    const manifest = { slotCount: 4, segments: descriptors };
    const encoded = rotationCodec.encodeSo3Rotations(segments, layout, [2, 2], {
      bits: 12, stepDegrees: 0.05, maximumAngleDegrees: 0.1,
    });
    const stored = await structuredCodec.encodeV22StructuredStream(
      'so3_rotation', encoded.encoded, { blockCompression: 'brotli', brotliQuality: 9 },
    );
    const direct = await structuredCodec.decodeV22StructuredParts('so3_rotation', stored.encoded);
    const sharedActive = activeSlots.map((slots) => {
      const output = new Int32Array(new SharedArrayBuffer(slots.byteLength));
      output.set(slots);
      return output;
    });
    const indices = descriptors.map(() => new Map(names.map((name, index) => [name, index])));
    const singleRows = descriptors.map((descriptor) => new Uint16Array(descriptor.gaussianCount * names.length));
    rotationCodec.decodeSo3RotationStreams(
      direct.metadata, direct.streams, manifest, activeSlots, singleRows, indices,
    );
    const partitionRows = descriptors.map((descriptor) => (
      new Uint16Array(new SharedArrayBuffer(descriptor.gaussianCount * names.length * 2))
    ));
    // #WDD-gpt 2026-09-20 - 直读 Rice 的分区结果必须和旧 Varint 解码路径逐位相同。
    const fast = await structuredCodec.decodeV22RotationReaders(stored.encoded);
    const prepared = rotationCodec.prepareSo3RotationStreams(
      fast.metadata, fast.streams, manifest, sharedActive, true, fast.readers,
    );
    for (let partitionIndex = 0; partitionIndex < 2; partitionIndex += 1) {
      rotationCodec.decodeSo3RotationPartition(
        prepared, manifest, sharedActive, partitionRows, indices, partitionIndex, 2,
      );
    }
    expect(partitionRows.map((row) => Array.from(row))).toEqual(singleRows.map((row) => Array.from(row)));
  });

  // #WDD-gpt 2026-09-19 - 大序列导出必须以活跃 slot/local 对替代 segmentCount×slotCount 稠密反表，并保持 Position 码流一致。
  it('builds sparse Morton active pairs with the same ordering and Position bytes as the dense layout', async () => {
    const prsCodec = await import('../../../../../scripts/fourcgs-prs-codec.mjs');
    const names = ['xyz_bank_0_x', 'xyz_bank_0_y', 'xyz_bank_0_z'];
    const segment = (path: string, positions: readonly (readonly [number, number, number])[]) => ({
      path,
      count: positions.length,
      propertyNames: names,
      propertyIndex: new Map(names.map((name, index) => [name, index])),
      comments: new Map<string, string>(),
      rows: Uint16Array.from(positions.flat().map(prsCodec.floatToHalf)),
    });
    const segments = [
      segment('segment_0_0.raw4d', [[0.5, 0, 0], [-0.5, 0, 0], [0, 0.5, 0]]),
      segment('segment_1_1.raw4d', [[-0.5, 0, 0], [0, -0.5, 0]]),
    ];
    const permanent = {
      slotCount: 4,
      maps: [Int32Array.from([0, 1, 2]), Int32Array.from([1, 3])],
      continuedLocal: [new Uint8Array(3), Uint8Array.from([1, 0])],
      matches: [],
    };
    const options = { positionsAlreadyInside: true };
    const dense = prsCodec.buildCroppedMortonLayout(segments, permanent, [0, 0, 0], 1, options);
    const sparse = prsCodec.buildCroppedMortonLayout(
      segments, permanent, [0, 0, 0], 1, { ...options, sparseInverse: true, retainRemap: false },
    );

    expect(sparse.slotToLocal).toEqual([]);
    expect(sparse.maps).toEqual([]);
    expect(sparse.order).toEqual(new Int32Array(0));
    expect(sparse.oldToNew).toEqual(new Int32Array(0));
    expect(sparse.continuedLocal).toEqual([]);
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      expect(Array.from(sparse.activeSlots[segmentIndex])).toEqual(Array.from(dense.activeSlots[segmentIndex]));
      expect(Array.from(sparse.activeLocals[segmentIndex])).toEqual(Array.from(
        dense.activeSlots[segmentIndex], (slot: number) => dense.slotToLocal[segmentIndex][slot],
      ));
    }
    const encodeOptions = { center: [0, 0, 0], halfExtent: 1, step: 0.00045, maximumError: 0.0005, cellSize: 0.5 };
    const densePosition = prsCodec.encodePositionRaw(segments, dense, [1, 1], encodeOptions);
    const sparsePosition = prsCodec.encodePositionRaw(segments, sparse, [1, 1], encodeOptions);
    expect(sparsePosition.mainRaw).toEqual(densePosition.mainRaw);
    expect(sparsePosition.exceptionRaw).toEqual(densePosition.exceptionRaw);
    expect(sparsePosition.metrics).toEqual(densePosition.metrics);
  });
});
