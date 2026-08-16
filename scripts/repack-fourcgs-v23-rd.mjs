import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, sha256 } from './fourcgs-prs-codec.mjs';
import { encodeSo3Rotations } from './fourcgs-so3-temporal-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';
import { decodeV21StructuredStream, encodeV22StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const TARGETS = new Set(['so3_rotation', 'tattr_scale', 'tattr_dc']);

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS source.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const stored = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const payload = bytes.subarray(offset, offset + entry.storedBytes);
    if (payload.length !== entry.storedBytes || sha256(payload) !== entry.storedSha256) {
      throw new Error(`Stored stream validation failed: ${entry.name}.`);
    }
    stored.set(entry.name, payload);
    offset += entry.storedBytes;
  }
  if (offset !== bytes.length) throw new Error(`Unexpected source trailing bytes: ${bytes.length - offset}.`);
  return { manifest, stored };
}

function packContainer(manifest, streams) {
  const directory = Buffer.from(JSON.stringify(manifest), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
}

async function readSegments(directory) {
  const names = (await readdir(directory))
    .filter((name) => SEGMENT_PATTERN.test(name))
    .sort((left, right) => Number(SEGMENT_PATTERN.exec(left)[1]) - Number(SEGMENT_PATTERN.exec(right)[1]));
  if (names.length !== 6) throw new Error(`Expected six RAW4D segments, found ${names.length}.`);
  const segments = [];
  for (const name of names) segments.push(await readSegment(join(directory, name)));
  return segments;
}

async function wrapAndVerify(name, inner, manifest) {
  const wrapped = await encodeV22StructuredStream(name, inner);
  const restored = await decodeV21StructuredStream(name, wrapped.encoded, manifest);
  if (!restored.equals(inner)) throw new Error(`${name} V2.3 structured round-trip failed.`);
  return wrapped;
}

// #WDD-gpt 2026-08-16 - V2.3 保留全部高斯、CoReSH-5R 和质量敏感 Opacity，只对 Scale/Rotation/DC 采用实测通过 60M 预算的分属性有界量化组合。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_lossless_v2_2.4cgs');
  const sourceDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_3.4cgs');
  const started = performance.now();
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  const segments = await readSegments(sourceDirectory);
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, source.manifest.crop.center, source.manifest.crop.halfExtent);
  if (layout.slotCount !== source.manifest.slotCount) throw new Error('V2.3 permanent Track layout mismatch.');

  process.stderr.write('V2.3 encode Rotation...\n');
  const rotation = encodeSo3Rotations(segments, layout, segments.map((segment) => bankCount(segment, 'rot_bank')), {
    bits: 12,
    stepDegrees: 0.1,
    maximumAngleDegrees: 0.25,
  });
  const rotationStored = await wrapAndVerify('so3_rotation', rotation.encoded, source.manifest);

  process.stderr.write('V2.3 encode Scale...\n');
  const scale = encodeTemporalAttribute(segments, layout, {
    prefix: 'scale_bank',
    components: ['0', '1', '2'],
    bankCounts: segments.map((segment) => bankCount(segment, 'scale_bank')),
    exactHalf: false,
    step: 0.0234375,
  });
  const scaleStored = await wrapAndVerify('tattr_scale', scale.encoded, source.manifest);

  process.stderr.write('V2.3 encode DC...\n');
  const dc = encodeTemporalAttribute(segments, layout, {
    prefix: 'f_dc_bank',
    components: ['0', '1', '2'],
    bankCounts: segments.map((segment) => bankCount(segment, 'f_dc_bank')),
    exactHalf: false,
    step: 0.03125,
  });
  const dcStored = await wrapAndVerify('tattr_dc', dc.encoded, source.manifest);

  const replacement = new Map([
    ['so3_rotation', { stored: rotationStored.encoded, inner: rotation.encoded }],
    ['tattr_scale', { stored: scaleStored.encoded, inner: scale.encoded }],
    ['tattr_dc', { stored: dcStored.encoded, inner: dc.encoded }],
  ]);
  const outputStreams = new Map();
  const streamMetrics = [];
  for (const entry of source.manifest.streams) {
    const selected = replacement.get(entry.name);
    if (!selected) {
      outputStreams.set(entry.name, source.stored.get(entry.name));
      streamMetrics.push({ name: entry.name, sourceBytes: entry.storedBytes, storedBytes: entry.storedBytes, savedBytes: 0, preservedStoredBytes: true });
      continue;
    }
    outputStreams.set(entry.name, selected.stored);
    streamMetrics.push({
      name: entry.name,
      sourceBytes: entry.storedBytes,
      storedBytes: selected.stored.length,
      savedBytes: entry.storedBytes - selected.stored.length,
      storedSha256: sha256(selected.stored),
      innerBytes: selected.inner.length,
      innerSha256: sha256(selected.inner),
    });
  }

  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V23TargetRateAttributeBudget`,
    prs: {
      ...source.manifest.prs,
      rotation: {
        ...source.manifest.prs.rotation,
        stepDegrees: rotation.metrics.stepDegrees,
        maximumAngleDegrees: 0.25,
        measuredAngularRmseDegrees: rotation.metrics.measuredAngularRmseDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scale: {
        ...source.manifest.prs.scale,
        mode: 'v23-temporal-linear-residual-quantized-predictive-rice64',
        step: 0.0234375,
        maximumLogError: scale.metrics.measuredMaximumError,
        maximumRelativeRadiusError: Math.expm1(scale.metrics.measuredMaximumError),
        selectedBytes: scaleStored.encoded.length,
        exceptionPolicy: 'uniform log-scale quantization; every source key is retained',
      },
      so3RotationMetrics: rotation.metrics,
      scaleCandidateMetrics: scale.metrics,
    },
    temporalAttributes: {
      ...source.manifest.temporalAttributes,
      scale: scale.metrics,
      colorDc: dc.metrics,
      selected: { scale: true, colorDc: true },
    },
    mintMixRq: source.manifest.mintMixRq,
    compressionV23: {
      version: '2.3',
      parentContainer: sourcePath,
      parentSha256: sha256(sourceBytes),
      targetBytes: 60_000_000,
      pruning: false,
      gaussianInstances: segments.reduce((sum, segment) => sum + segment.count, 0),
      permanentTracks: layout.slotCount,
      unchangedStoredStreams: source.manifest.streams.filter((entry) => !TARGETS.has(entry.name)).map((entry) => entry.name),
      unchangedPolicies: ['Position', 'Lifetime', 'Active Mask', 'CoReSH-5R shared SH'],
      rateControl: 'discrete per-attribute candidates selected by actual stored bytes under a 60M target',
      bounds: {
        rotationDegrees: rotation.metrics.measuredMaximumAngleDegrees,
        scaleLog: scale.metrics.measuredMaximumError,
        scaleRelativeRadius: Math.expm1(scale.metrics.measuredMaximumError),
        dcCoefficient: dc.metrics.measuredMaximumError,
        dcRgb: dc.metrics.measuredMaximumError * 0.28209479177387814,
        opacityAlpha: source.manifest.mintMixRq?.opacity?.measuredMaximumError,
      },
    },
    streams: source.manifest.streams.map((entry) => {
      const selected = replacement.get(entry.name);
      if (!selected) return entry;
      return {
        ...entry,
        compression: 'raw',
        rawBytes: selected.stored.length,
        rawSha256: sha256(selected.stored),
        storedBytes: selected.stored.length,
        storedSha256: sha256(selected.stored),
        ...(entry.name === 'mixsc_opacity' ? {} : {
          v21DecodedBytes: selected.inner.length,
          v21DecodedSha256: sha256(selected.inner),
          structuredDecodedBytes: selected.inner.length,
          structuredDecodedSha256: sha256(selected.inner),
        }),
      };
    }),
  };
  const container = packContainer(nextManifest, outputStreams);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, container);
  const report = {
    version: 'Compression V2.3',
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceBytesM: sourceBytes.length / 1_000_000,
    sourceSha256: sha256(sourceBytes),
    outputPath,
    outputBytes: container.length,
    outputBytesM: container.length / 1_000_000,
    outputSha256: sha256(container),
    savedBytes: sourceBytes.length - container.length,
    savedBytesM: (sourceBytes.length - container.length) / 1_000_000,
    meets60M: container.length <= 60_000_000,
    ratioToSixRaw4d: source.manifest.sourceBytes / container.length,
    gaussianInstances: nextManifest.compressionV23.gaussianInstances,
    permanentTracks: layout.slotCount,
    bounds: nextManifest.compressionV23.bounds,
    metrics: { rotation: rotation.metrics, scale: scale.metrics, dc: dc.metrics, opacity: source.manifest.mintMixRq?.opacity },
    streams: streamMetrics,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
