import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { sha256 } from './fourcgs-prs-codec.mjs';

const MAGIC = '4CGSPRS2';

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

// #WDD-gpt 2026-08-16 - 只有 6 段 180 帧 540 视角门禁全部通过后，才把候选固化为正式 V2.5 容器。
async function main() {
  const candidatePath = resolve(process.argv[2] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_5_p625.4cgs');
  const qualityPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/V25_QUALITY_ACCEPTANCE.json');
  const outputPath = resolve(process.argv[4] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_5.4cgs');
  const candidateBytes = await readFile(candidatePath);
  const source = readContainer(candidateBytes);
  const candidateRepackPath = `${candidatePath}.repack.json`;
  let candidateRepack = null;
  try {
    candidateRepack = JSON.parse(await readFile(candidateRepackPath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const qualityBytes = await readFile(qualityPath);
  const quality = JSON.parse(qualityBytes.toString('utf8'));
  if (quality.summary?.status !== 'passed' || quality.summary.samples !== 540 || quality.summary.segmentsPassing !== 6) {
    throw new Error('V2.5 quality report did not pass all 540 samples.');
  }
  if (quality.summary.aggregatePsnr < 40 || quality.summary.minimumPsnr < 37) throw new Error('V2.5 PSNR gate is below the required threshold.');
  const nextManifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-Accepted`,
    compressionV25: {
      ...source.manifest.compressionV25,
      qualityGate: {
        ...source.manifest.compressionV25.qualityGate,
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
      },
    },
  };
  const output = packContainer(nextManifest, source.streams);
  if (output.length > 60_000_000) throw new Error(`Accepted V2.5 container exceeds 60M: ${output.length}.`);
  const reopened = readContainer(output);
  if (reopened.manifest.compressionV25?.qualityGate?.status !== 'passed') throw new Error('V2.5 accepted manifest reopen failed.');
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  const sourceBytes = nextManifest.sourceBytes;
  const report = {
    version: 'Compression V2.5 accepted', candidatePath, candidateBytes: candidateBytes.length,
    candidateSha256: sha256(candidateBytes), qualityPath, qualitySha256: sha256(qualityBytes),
    outputPath, outputBytes: output.length, outputBytesM: output.length / 1_000_000,
    outputSha256: sha256(output), meets60M: true,
    sourceBytes, savedBytes: sourceBytes - output.length,
    ratioToSixRaw4d: sourceBytes / output.length,
    qualityGate: nextManifest.compressionV25.qualityGate,
    bounds: nextManifest.compressionV23?.bounds,
  };
  await writeFile(`${outputPath}.finalize.json`, `${JSON.stringify(report, null, 2)}\n`);
  if (candidateRepack) {
    // #WDD-gpt 2026-08-16 - 正式文件必须附带自身的最终参数与质量门，避免遗留同名探针报告误导后续复核。
    await writeFile(`${outputPath}.repack.json`, `${JSON.stringify({
      ...candidateRepack,
      version: report.version,
      outputPath,
      outputBytes: output.length,
      outputBytesM: output.length / 1_000_000,
      outputSha256: report.outputSha256,
      meets60M: true,
      ratioToSixRaw4d: report.ratioToSixRaw4d,
      qualityGate: report.qualityGate,
      acceptedFrom: {
        candidatePath,
        candidateSha256: report.candidateSha256,
        qualityPath,
        qualitySha256: report.qualitySha256,
      },
    }, null, 2)}\n`);
  }
  console.log(JSON.stringify(report));
}

await main();
