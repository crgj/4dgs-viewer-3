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

function fixture(metadata?: unknown): File {
  const names = ['active_masks', 'prs_position', 'so3_rotation', 'tattr_scale', 'tattr_dc', 'mixsc_opacity', 'lifetime_mu', 'lifetime_w', 'coresh5r_shared'];
  const manifest: FourCgsManifest = {
    format: '4CGS', version: 2, codecName: 'fixture-v24', slotCount: 3,
    firstFrame: 180, lastFrame: 259, uniqueFrameCount: 80, segments,
    streams: names.map((name) => ({
      name, compression: 'raw', rawBytes: 1, storedBytes: 1,
      rawSha256: '0'.repeat(64), storedSha256: '0'.repeat(64),
    })),
    crop: { center: [0, 0, 0], halfExtent: 2.5 }, prs: {},
    ...(metadata === undefined ? {} : { metadata: metadata as FourCgsManifest['metadata'] }),
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

  it('round-trips the complete scene transform while preserving compressed stream bytes', async () => {
    const source = fixture({ producer: 'fixture-editor' });
    const sourceDirectory = await readFourCgsManifest(source);
    const sourceStreams = new Uint8Array(await source.slice(12 + sourceDirectory.manifestBytes).arrayBuffer());
    const output = await writeFourCgsFile(source, {
      position: [1.25, -2.5, 3.75],
      rotation: [12, 34, -56],
      scale: [0.5, 1.5, 2],
    });
    const outputDirectory = await readFourCgsManifest(output);
    expect(outputDirectory.manifest.metadata?.sceneTransform).toEqual({
      schemaVersion: 1,
      coordinateSystem: 'playcanvas-y-up',
      units: 'meter',
      position: [1.25, -2.5, 3.75],
      rotationEulerDegrees: [12, 34, -56],
      scale: [0.5, 1.5, 2],
    });
    expect(outputDirectory.manifest.metadata?.producer).toBe('fixture-editor');
    expect(new Uint8Array(await output.slice(12 + outputDirectory.manifestBytes).arrayBuffer())).toEqual(sourceStreams);

    const secondOutput = await writeFourCgsFile(output, {
      position: [-4, 5, 6],
      rotation: [-90, 180, 45],
      scale: [3, 2, 1],
    });
    const secondDirectory = await readFourCgsManifest(secondOutput);
    expect(secondDirectory.manifest.metadata?.sceneTransform).toMatchObject({
      position: [-4, 5, 6],
      rotationEulerDegrees: [-90, 180, 45],
      scale: [3, 2, 1],
    });
    expect(secondDirectory.manifest.metadata?.producer).toBe('fixture-editor');
    expect(new Uint8Array(await secondOutput.slice(12 + secondDirectory.manifestBytes).arrayBuffer())).toEqual(sourceStreams);
  });

  it('rejects malformed metadata and non-positive transform scales', async () => {
    await expect(readFourCgsManifest(fixture('invalid metadata'))).rejects.toThrow('metadata 必须是对象');
    await expect(writeFourCgsFile(fixture(), {
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 0, 1],
    })).rejects.toThrow('三个正有限数值');
  });
});
