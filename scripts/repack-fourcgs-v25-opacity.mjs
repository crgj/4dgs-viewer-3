import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { sha256 } from './fourcgs-prs-codec.mjs';
import { decodeScalarRq } from './fourcgs-scalar-rq-codec.mjs';

const MAGIC = '4CGSPRS2';

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS source.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const payload = bytes.subarray(offset, offset + entry.storedBytes);
    if (payload.length !== entry.storedBytes || sha256(payload) !== entry.storedSha256) {
      throw new Error(`Stored stream validation failed: ${entry.name}.`);
    }
    streams.set(entry.name, payload);
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected trailing bytes: ${bytes.length - offset}.`);
  return { manifest, streams };
}

function packContainer(manifest, streams) {
  const directory = Buffer.from(JSON.stringify(manifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
}

// #WDD-gpt 2026-08-16 - V2.5 只提升 Opacity 首关键帧精度，以全帧快速运动质量门禁替代旧 0/15/30 抽样门禁。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const probePath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/V25_OPACITY_RD.json');
  const candidateName = process.argv[4] ?? 'a0015-b9x12';
  const outputPath = resolve(process.argv[5] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_5.4cgs');
  const started = performance.now();
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  const probe = JSON.parse(await readFile(probePath, 'utf8'));
  const candidate = probe.candidates.find((item) => item.name === candidateName);
  if (!candidate) throw new Error(`Unknown V2.5 Opacity candidate ${candidateName}.`);
  const opacity = await readFile(candidate.streamPath);
  if (opacity.length !== candidate.streamBytes || sha256(opacity) !== candidate.sha256) {
    throw new Error('V2.5 Opacity candidate checksum mismatch.');
  }
  const decoded = decodeScalarRq(opacity);
  if (decoded.metrics.maximumError > candidate.maximumError + 1e-7) {
    throw new Error('V2.5 Opacity candidate exceeds its alpha error bound.');
  }
  const oldEntry = source.manifest.streams.find((entry) => entry.name === 'mixsc_opacity');
  if (!oldEntry) throw new Error('V2.4 mixsc_opacity stream is missing.');
  source.streams.set('mixsc_opacity', opacity);
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V25FullFrameOpacityGuard`,
    mintMixRq: {
      ...source.manifest.mintMixRq,
      opacity: candidate.metrics,
    },
    compressionV23: source.manifest.compressionV23 ? {
      ...source.manifest.compressionV23,
      bounds: {
        ...source.manifest.compressionV23.bounds,
        opacityAlpha: candidate.metrics.measuredMaximumError,
      },
    } : undefined,
    compressionV25: {
      version: '2.5',
      parentContainer: sourcePath,
      parentSha256: sha256(sourceBytes),
      pruning: false,
      changedStreams: ['mixsc_opacity'],
      opacityPolicy: {
        name: candidate.name,
        bitsByDimension: candidate.bitsByDimension,
        maximumAllowedAlphaError: candidate.maximumError,
        measuredMaximumAlphaError: candidate.metrics.measuredMaximumError,
        measuredAlphaRmse: candidate.metrics.measuredRmse,
        rationale: 'full-frame fast-motion audit found coherent alpha accumulation artifacts at V2.4 0.003 bound',
      },
      qualityGate: {
        segments: 6,
        uniqueTimelineFrames: 180,
        camerasPerFrame: 3,
        samples: 540,
        status: 'pending',
      },
    },
    streams: source.manifest.streams.map((entry) => entry.name !== 'mixsc_opacity' ? entry : {
      ...entry,
      compression: 'raw',
      rawBytes: opacity.length,
      rawSha256: sha256(opacity),
      storedBytes: opacity.length,
      storedSha256: sha256(opacity),
    }),
  };
  const container = packContainer(nextManifest, source.streams);
  const reopened = readContainer(container);
  if (reopened.streams.get('mixsc_opacity').length !== opacity.length) throw new Error('V2.5 container reopen failed.');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, container);
  const report = {
    version: 'Compression V2.5 Opacity full-frame guard candidate',
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceSha256: sha256(sourceBytes),
    outputPath,
    outputBytes: container.length,
    outputBytesM: container.length / 1_000_000,
    outputSha256: sha256(container),
    meets60M: container.length <= 60_000_000,
    changedStream: {
      name: 'mixsc_opacity',
      sourceBytes: oldEntry.storedBytes,
      outputBytes: opacity.length,
      addedBytes: opacity.length - oldEntry.storedBytes,
    },
    opacityPolicy: nextManifest.compressionV25.opacityPolicy,
    qualityGate: nextManifest.compressionV25.qualityGate,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
