import { describe, expect, it } from 'vitest';
import { Raw4DWasmExtractor } from './Raw4DWasmExtractor';

describe('RAW4D WASM extractor', () => {
  it('deinterleaves RAW4D rows through the Worker WASM kernel', async () => {
    const extractor = await Raw4DWasmExtractor.create();
    const first = new Float32Array(3);
    const second = new Float32Array(3);
    extractor.extract({
      chunk: new Float32Array([
        10, 11, 12, 13,
        20, 21, 22, 23,
        30, 31, 32, 33,
      ]),
      sourceEncoding: 'float32',
      propertyCount: 4,
      firstRow: 0,
      rowCount: 3,
      properties: [
        { sourceIndex: 2, destination: first },
        { sourceIndex: 0, destination: second },
      ],
    });

    expect([...first]).toEqual([12, 22, 32]);
    expect([...second]).toEqual([10, 20, 30]);
  });

  it('deinterleaves ushort-backed IEEE float16 rows used by the new RAW4D format', async () => {
    const extractor = await Raw4DWasmExtractor.create();
    const first = new Float32Array(2);
    const second = new Float32Array(2);
    extractor.extract({
      chunk: new Uint16Array([
        0x3c00, 0xc000, 0x7c00,
        0x0001, 0x3800, 0xfc00,
      ]),
      sourceEncoding: 'float16',
      propertyCount: 3,
      firstRow: 0,
      rowCount: 2,
      properties: [
        { sourceIndex: 1, destination: first },
        { sourceIndex: 0, destination: second },
      ],
    });

    expect([...first]).toEqual([-2, 0.5]);
    expect(second[0]).toBe(1);
    expect(second[1]).toBe(2 ** -24);
  });

  it('copies float16 payload bits directly into compact canonical storage', async () => {
    const extractor = await Raw4DWasmExtractor.create();
    const destination = new Uint16Array(2);
    extractor.extract({
      chunk: new Uint16Array([0x3c00, 0xc000, 0x3800, 0xfc00]),
      sourceEncoding: 'float16',
      propertyCount: 2,
      firstRow: 0,
      rowCount: 2,
      properties: [{ sourceIndex: 1, destination }],
    });
    expect([...destination]).toEqual([0xc000, 0xfc00]);
  });
});
