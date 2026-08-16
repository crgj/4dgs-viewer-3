import { describe, expect, it } from 'vitest';
import { sourceLayoutMatchesV24Preset } from './FourCgsPresetExport';

const sources = [
  { name: 'segment_180_210.raw4d', size: 68_978_297 },
  { name: 'segment_210_240.raw4d', size: 70_141_631 },
  { name: 'segment_240_270.raw4d', size: 51_069_989 },
  { name: 'segment_270_300.raw4d', size: 45_666_845 },
  { name: 'segment_300_330.raw4d', size: 50_695_823 },
  { name: 'segment_330_359.raw4d', size: 48_670_259 },
];

describe('FourCgsPresetExport', () => {
  it('accepts the six quality-gated RAW4D sources in any picker order', () => {
    expect(sourceLayoutMatchesV24Preset([...sources].reverse())).toBe(true);
  });

  it('rejects a renamed, missing, or byte-different source', () => {
    expect(sourceLayoutMatchesV24Preset(sources.slice(1))).toBe(false);
    expect(sourceLayoutMatchesV24Preset(sources.map((source, index) => (
      index === 2 ? { ...source, size: source.size + 1 } : source
    )))).toBe(false);
  });
});
