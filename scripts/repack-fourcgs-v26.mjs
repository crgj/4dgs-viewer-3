import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bankCount, buildExactBoundaryPermanentTrackMaps, readSegment } from './probe-fourcgs-lossless-rate.mjs';
import { buildCroppedMortonLayout, encodePositions, sha256 } from './fourcgs-prs-codec.mjs';
import { encodeTemporalAttribute } from './fourcgs-temporal-attribute-codec.mjs';
import { encodeSo3Rotations } from './fourcgs-so3-temporal-codec.mjs';
import { decodeV21StructuredStream, encodeV21StructuredStream, encodeV22StructuredStream } from './fourcgs-v21-lossless-codec.mjs';

const MAGIC = '4CGSPRS2';
const SEGMENT_PATTERN = /^segment_(\d+)_(\d+)\.raw4d$/;
const TARGET_BYTES = 70_000_000;

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
  const header = Buffer.alloc(12);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(directory.length, 8);
  return Buffer.concat([header, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
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

async function wrapAndVerify(name, inner, manifest, version) {
  const wrapped = version === 21
    ? await encodeV21StructuredStream(name, inner, manifest)
    : await encodeV22StructuredStream(name, inner);
  const restored = await decodeV21StructuredStream(name, wrapped.encoded, manifest);
  if (!restored.equals(inner)) throw new Error(`V2.6 ${name} structured round-trip failed.`);
  return wrapped;
}

// #WDD-gpt 2026-08-16 - V2.6 用统一的 70M 高精度档收紧 P/R/Scale/DC；对象速度只能增加码率，不能触发降质。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_5.4cgs');
  const sourceDirectory = resolve(process.argv[3] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_6_candidate.4cgs');
  const positionStep = Number(process.argv[5] ?? 0.0005);
  const positionMaximumError = Number(process.argv[6] ?? 0.00075);
  const rotationStepDegrees = Number(process.argv[7] ?? 0.05);
  const rotationMaximumAngleDegrees = Number(process.argv[8] ?? 0.1);
  const scaleStep = Number(process.argv[9] ?? 0.0078125);
  const dcStep = Number(process.argv[10] ?? 0.00390625);
  if (![positionStep, positionMaximumError, rotationStepDegrees, rotationMaximumAngleDegrees, scaleStep, dcStep]
    .every((value) => Number.isFinite(value) && value > 0)) throw new Error('V2.6 steps and bounds must be positive finite values.');

  const started = performance.now();
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  if (!source.manifest.compressionV25?.opacityPolicy?.baseBank?.bitExactFp16
    || !source.manifest.compressionV25?.opacityPolicy?.temporalBanks?.bitExactFp16) {
    throw new Error('V2.6 requires a V2.5 parent with all four Opacity banks stored bit-exactly.');
  }
  const segments = await readSegments(sourceDirectory);
  const permanent = buildExactBoundaryPermanentTrackMaps(segments);
  const layout = buildCroppedMortonLayout(segments, permanent, source.manifest.crop.center, source.manifest.crop.halfExtent);
  if (layout.slotCount !== source.manifest.slotCount) throw new Error('V2.6 permanent Track layout mismatch.');

  process.stderr.write('V2.6 encode Position...\n');
  const position = encodePositions(segments, layout, segments.map((segment) => bankCount(segment, 'xyz_bank')), {
    center: source.manifest.crop.center,
    halfExtent: source.manifest.crop.halfExtent,
    step: positionStep,
    maximumError: positionMaximumError,
    cellSize: 0.5,
  });
  const positionStored = await wrapAndVerify('prs_position', position.encoded, source.manifest, 21);

  process.stderr.write('V2.6 encode Rotation...\n');
  const rotation = encodeSo3Rotations(segments, layout, segments.map((segment) => bankCount(segment, 'rot_bank')), {
    bits: 12,
    stepDegrees: rotationStepDegrees,
    maximumAngleDegrees: rotationMaximumAngleDegrees,
  });
  const rotationStored = await wrapAndVerify('so3_rotation', rotation.encoded, source.manifest, 22);

  process.stderr.write('V2.6 encode Scale...\n');
  const scale = encodeTemporalAttribute(segments, layout, {
    prefix: 'scale_bank', components: ['0', '1', '2'],
    bankCounts: segments.map((segment) => bankCount(segment, 'scale_bank')),
    exactHalf: false, step: scaleStep,
  });
  const scaleStored = await wrapAndVerify('tattr_scale', scale.encoded, source.manifest, 22);

  process.stderr.write('V2.6 encode DC...\n');
  const dc = encodeTemporalAttribute(segments, layout, {
    prefix: 'f_dc_bank', components: ['0', '1', '2'],
    bankCounts: segments.map((segment) => bankCount(segment, 'f_dc_bank')),
    exactHalf: false, step: dcStep,
  });
  const dcStored = await wrapAndVerify('tattr_dc', dc.encoded, source.manifest, 22);

  const replacements = new Map([
    ['prs_position', { stored: positionStored.encoded, inner: position.encoded }],
    ['so3_rotation', { stored: rotationStored.encoded, inner: rotation.encoded }],
    ['tattr_scale', { stored: scaleStored.encoded, inner: scale.encoded }],
    ['tattr_dc', { stored: dcStored.encoded, inner: dc.encoded }],
  ]);
  const outputStreams = new Map(source.streams);
  for (const [name, replacement] of replacements) outputStreams.set(name, replacement.stored);
  const maximumScaleRelativeError = Math.expm1(scale.metrics.measuredMaximumError);
  const maximumDcRgbError = dc.metrics.measuredMaximumError * 0.28209479177387814;
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V26FixedHighPrecision70M`,
    prs: {
      ...source.manifest.prs,
      position: {
        ...source.manifest.prs.position,
        step: positionStep,
        maximumEuclideanError: positionMaximumError,
        measuredRmse: position.metrics.measuredRmse,
        measuredMaximumEuclideanError: position.metrics.measuredMaximumEuclideanError,
      },
      rotation: {
        ...source.manifest.prs.rotation,
        stepDegrees: rotationStepDegrees,
        maximumAngleDegrees: rotationMaximumAngleDegrees,
        measuredAngularRmseDegrees: rotation.metrics.measuredAngularRmseDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scale: {
        ...source.manifest.prs.scale,
        mode: 'v26-bounded-temporal-linear-residual-rans',
        step: scaleStep,
        maximumLogError: scale.metrics.measuredMaximumError,
        maximumRelativeRadiusError: maximumScaleRelativeError,
        selectedBytes: scaleStored.encoded.length,
        exceptionPolicy: 'fixed log-scale step; every source key is retained',
      },
      scaleCandidateMetrics: scale.metrics,
    },
    temporalAttributes: {
      ...source.manifest.temporalAttributes,
      scale: scale.metrics,
      colorDc: dc.metrics,
      selected: { ...source.manifest.temporalAttributes?.selected, scale: true, colorDc: true },
    },
    compressionV23: source.manifest.compressionV23 ? {
      ...source.manifest.compressionV23,
      bounds: {
        ...source.manifest.compressionV23.bounds,
        positionMeters: position.metrics.measuredMaximumEuclideanError,
        rotationDegrees: rotation.metrics.measuredMaximumAngleDegrees,
        scaleLog: scale.metrics.measuredMaximumError,
        scaleRelativeRadius: maximumScaleRelativeError,
        dcCoefficient: dc.metrics.measuredMaximumError,
        dcRgb: maximumDcRgbError,
        opacityAlpha: 0,
      },
    } : undefined,
    compressionV26: {
      version: '2.6',
      parentContainer: sourcePath,
      parentSha256: sha256(sourceBytes),
      targetBytes: TARGET_BYTES,
      pruning: false,
      changedStreams: [...replacements.keys()],
      generalizationPolicy: 'fixed attribute error bounds with exact overflow exceptions; no scene or motion-speed quality tuning',
      positionPolicy: {
        step: positionStep,
        maximumAllowedEuclideanErrorMeters: positionMaximumError,
        measuredRmseMeters: position.metrics.measuredRmse,
        measuredMaximumEuclideanErrorMeters: position.metrics.measuredMaximumEuclideanError,
      },
      rotationPolicy: {
        stepDegrees: rotationStepDegrees,
        maximumAllowedAngleDegrees: rotationMaximumAngleDegrees,
        measuredAngularRmseDegrees: rotation.metrics.measuredAngularRmseDegrees,
        measuredMaximumAngleDegrees: rotation.metrics.measuredMaximumAngleDegrees,
      },
      scalePolicy: {
        step: scaleStep,
        maximumLogError: scale.metrics.measuredMaximumError,
        maximumRelativeRadiusError: maximumScaleRelativeError,
      },
      dcPolicy: {
        step: dcStep,
        maximumCoefficientError: dc.metrics.measuredMaximumError,
        maximumRgbError: maximumDcRgbError,
      },
      opacityPolicy: 'inherit V2.5 four-bank bit-exact FP16 stream',
      qualityGate: {
        segments: 6, uniqueTimelineFrames: 180, camerasPerFrame: 3, samples: 540,
        aggregateMinimumPsnr: 40, perViewMinimumPsnr: 39, status: 'pending',
      },
    },
    streams: source.manifest.streams.map((entry) => {
      const replacement = replacements.get(entry.name);
      if (!replacement) return entry;
      return {
        ...entry,
        compression: 'raw',
        rawBytes: replacement.stored.length,
        rawSha256: sha256(replacement.stored),
        storedBytes: replacement.stored.length,
        storedSha256: sha256(replacement.stored),
        v21DecodedBytes: replacement.inner.length,
        v21DecodedSha256: sha256(replacement.inner),
        structuredDecodedBytes: replacement.inner.length,
        structuredDecodedSha256: sha256(replacement.inner),
      };
    }),
  };
  const container = packContainer(nextManifest, outputStreams);
  const reopened = readContainer(container);
  for (const [name, replacement] of replacements) {
    if (!reopened.streams.get(name).equals(replacement.stored)) throw new Error(`V2.6 reopen failed for ${name}.`);
  }
  if (container.length > TARGET_BYTES) throw new Error(`V2.6 candidate exceeds 70M: ${container.length}.`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, container);
  const report = {
    version: 'Compression V2.6 fixed high precision 70M candidate',
    sourcePath, sourceBytes: sourceBytes.length, sourceSha256: sha256(sourceBytes),
    outputPath, outputBytes: container.length, outputBytesM: container.length / 1_000_000,
    outputSha256: sha256(container), meets70M: true,
    headroomBytes: TARGET_BYTES - container.length,
    ratioToSixRaw4d: source.manifest.sourceBytes / container.length,
    changedStreams: [...replacements].map(([name, replacement]) => {
      const previous = source.manifest.streams.find((entry) => entry.name === name);
      return { name, sourceBytes: previous.storedBytes, outputBytes: replacement.stored.length, deltaBytes: replacement.stored.length - previous.storedBytes };
    }),
    bounds: nextManifest.compressionV23?.bounds,
    position: position.metrics,
    rotation: rotation.metrics,
    scale: scale.metrics,
    colorDc: dc.metrics,
    qualityGate: nextManifest.compressionV26.qualityGate,
    elapsedSeconds: (performance.now() - started) / 1000,
  };
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
