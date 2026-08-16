import { describe, expect, it } from 'vitest';
import {
  FOUR_CGS_MAGIC,
  locateFourCgsFrame,
  readFourCgsManifest,
  writeFourCgsFile,
} from './FourCgsContainer';
import type { FourCgsManifest, FourCgsSegment } from './FourCgsTypes';

const segments: FourCgsSegment[] = [
  { name: 'segment_180_210', firstFrame: 180, lastFrame: 210, gaussianCount: 2, totalFrames: 31, bankCounts: { position: 11, rotation: 2, colorDc: 2, scale: 4, opacity: 4 } },
  { name: 'segment_210_240', firstFrame: 210, lastFrame: 240, gaussianCount: 3, totalFrames: 31, bankCounts: { position: 11, rotation: 2, colorDc: 2, scale: 4, opacity: 4 } },
  { name: 'segment_240_259', firstFrame: 240, lastFrame: 259, gaussianCount: 2, totalFrames: 20, bankCounts: { position: 8, rotation: 2, colorDc: 2, scale: 3, opacity: 3 } },
];

function fixture(): File {
  const names = ['active_masks', 'prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc', 'mixsc_opacity', 'lifetime_mu', 'lifetime_w', 'coresh5r_shared'];
  const manifest: FourCgsManifest = {
    format: '4CGS', version: 2, codecName: 'fixture-v24', slotCount: 3,
    firstFrame: 180, lastFrame: 259, uniqueFrameCount: 80, segments,
    streams: names.map((name) => ({
      name, compression: 'raw', rawBytes: 1, storedBytes: 1,
      rawSha256: '0'.repeat(64), storedSha256: '0'.repeat(64),
    })),
    crop: { center: [0, 0, 0], halfExtent: 2.5 }, prs: {},
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(FOUR_CGS_MAGIC));
  new DataView(header.buffer).setUint32(8, manifestBytes.length, true);
  return new File([header, manifestBytes, new Uint8Array(names.length)], 'fixture.4cgs');
}

describe('4CGS container', () => {
  it('maps duplicate boundary frames to the following segment', () => {
    expect(locateFourCgsFrame(segments, 29)).toEqual({ segmentIndex: 0, localFrame: 29, sourceFrame: 209 });
    expect(locateFourCgsFrame(segments, 30)).toEqual({ segmentIndex: 1, localFrame: 0, sourceFrame: 210 });
    expect(locateFourCgsFrame(segments, 79)).toEqual({ segmentIndex: 2, localFrame: 19, sourceFrame: 259 });
  });

  it('validates and writes an exact-byte Save As container', async () => {
    const source = fixture();
    const { manifest } = await readFourCgsManifest(source);
    expect(manifest.codecName).toBe('fixture-v24');
    const output = await writeFourCgsFile(source);
    expect(new Uint8Array(await output.arrayBuffer())).toEqual(new Uint8Array(await source.arrayBuffer()));
  });
});
