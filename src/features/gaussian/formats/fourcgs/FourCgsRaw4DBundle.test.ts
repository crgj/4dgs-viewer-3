import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { unzlibSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FOUR_CGS_HEADER_BYTES, readFourCgsManifest } from './FourCgsContainer';
import {
  paddedEvenLength,
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

function compressibleFp16Raw4D(name: string, rows: number): File {
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
    'comment fp16_quantized 1',
    `element vertex ${rows}`,
    ...properties.map((property) => `property ushort ${property}`),
    'end_header', '',
  ].join('\n');
  const body = new Uint16Array(rows * properties.length);
  const index = new Map(properties.map((property, propertyIndex) => [property, propertyIndex]));
  for (let row = 0; row < rows; row += 1) {
    const set = (property: string, value: number) => { body[row * properties.length + index.get(property)!] = floatToHalf(value); };
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
    expect(magic).toBe('C5T2SH01');
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
    expect(raw4dExport.sourceKind).toBe('canonical-memory-or-file-snapshot');
    expect(result.sourceSha256[0]).toMatch(/^[0-9a-f]{64}$/);
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
});
