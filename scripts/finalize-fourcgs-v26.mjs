import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { sha256 } from './fourcgs-prs-codec.mjs';

const MAGIC = '4CGSPRS2';
const TARGET_BYTES = 70_000_000;

function readContainer(bytes) {
  if (bytes.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported 4CGS source.');
  const manifestBytes = bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.subarray(12, 12 + manifestBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + manifestBytes;
  for (const entry of manifest.streams) {
    const stored = bytes.subarray(offset, offset + entry.storedBytes);
    if (stored.length !== entry.storedBytes || sha256(stored) !== entry.storedSha256) throw new Error(`Stored stream validation failed: ${entry.name}.`);
    streams.set(entry.name, stored);
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

// #WDD-gpt 2026-08-16 - 仅当六段 540 样本全部达到 39 dB 且整包低于 70M 时，才签发正式 V2.6。
async function main() {
  const candidatePath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_6_candidate2.4cgs');
  const qualityPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/V26_QUALITY_ACCEPTANCE.json');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_6.4cgs');
  const candidateBytes = await readFile(candidatePath);
  const source = readContainer(candidateBytes);
  const candidateRepack = JSON.parse(await readFile(`${candidatePath}.repack.json`, 'utf8'));
  const qualityBytes = await readFile(qualityPath);
  const quality = JSON.parse(qualityBytes.toString('utf8'));
  if (quality.summary?.status !== 'passed' || quality.summary.samples !== 540 || quality.summary.segmentsPassing !== 6) {
    throw new Error('V2.6 quality report did not pass all 540 samples.');
  }
  if (quality.summary.aggregatePsnr < 40 || quality.summary.minimumPsnr < 39 || quality.summary.samplesBelowPerViewThreshold !== 0) {
    throw new Error('V2.6 PSNR gate is below aggregate 40 dB or per-sample 39 dB.');
  }
  const qualityGate = {
    ...source.manifest.compressionV26.qualityGate,
    status: 'passed',
    samples: quality.summary.samples,
    aggregatePsnr: quality.summary.aggregatePsnr,
    minimumPsnr: quality.summary.minimumPsnr,
    segmentsPassing: quality.summary.segmentsPassing,
    samplesBelowPerViewThreshold: quality.summary.samplesBelowPerViewThreshold,
    renderer: quality.renderer,
    captureStability: quality.policy.captureStability,
    reportName: basename(qualityPath),
    reportSha256: sha256(qualityBytes),
  };
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-Accepted`,
    compressionV26: { ...source.manifest.compressionV26, qualityGate },
  };
  const output = packContainer(nextManifest, source.streams);
  if (output.length > TARGET_BYTES) throw new Error(`Accepted V2.6 container exceeds 70M: ${output.length}.`);
  const reopened = readContainer(output);
  if (reopened.manifest.compressionV26?.qualityGate?.status !== 'passed') throw new Error('V2.6 accepted manifest reopen failed.');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  const sourceBytes = nextManifest.sourceBytes;
  const report = {
    version: 'Compression V2.6 accepted',
    candidatePath, candidateBytes: candidateBytes.length, candidateSha256: sha256(candidateBytes),
    qualityPath, qualitySha256: sha256(qualityBytes),
    outputPath, outputBytes: output.length, outputBytesM: output.length / 1_000_000,
    outputSha256: sha256(output), meets70M: true, headroomBytes: TARGET_BYTES - output.length,
    sourceBytes, savedBytes: sourceBytes - output.length, ratioToSixRaw4d: sourceBytes / output.length,
    qualityGate, bounds: nextManifest.compressionV23?.bounds,
  };
  await writeFile(`${outputPath}.finalize.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify({
    ...candidateRepack,
    version: report.version,
    outputPath,
    outputBytes: report.outputBytes,
    outputBytesM: report.outputBytesM,
    outputSha256: report.outputSha256,
    meets70M: true,
    headroomBytes: report.headroomBytes,
    ratioToSixRaw4d: report.ratioToSixRaw4d,
    qualityGate,
    acceptedFrom: {
      candidatePath, candidateSha256: report.candidateSha256,
      qualityPath, qualitySha256: report.qualitySha256,
    },
  }, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
