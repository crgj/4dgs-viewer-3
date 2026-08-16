import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...manifest.streams.map((entry) => streams.get(entry.name))]);
}

// #WDD-gpt 2026-08-16 - V2.4 保持 V2.3 全部属性字节不变，只冻结自包含直解和四 Worker 共享行缓冲协议。
async function main() {
  const sourcePath = resolve(process.argv[2] ?? '/home/crgj/wdd/data/Row4D/collected_master_ply4_cleaned_fp16_v2_3.4cgs');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/collected_master_ply4_cleaned_fp16_v2_4.4cgs');
  const sourceBytes = await readFile(sourcePath);
  const source = readContainer(sourceBytes);
  const manifest = {
    ...source.manifest,
    codecName: `${source.manifest.codecName}-V24SelfContainedParallelDirectDecode`,
    compressionV24: {
      version: '2.4',
      parentContainer: sourcePath,
      parentSha256: sha256(sourceBytes),
      storedStreamsByteIdenticalToV23: true,
      qualityImpactRelativeToV23: 'none',
      sourceRaw4dRequiredAtRuntime: false,
      validationSeparatedFromRuntimeDecode: true,
      workerCount: 4,
      rowBuffer: 'SharedArrayBuffer',
      directContexts: {
        position: ['metadata', 'dictionary_codes', 'escape_0', 'escape_1', 'escape_2', 'exceptions'],
        rotation: 'V22 SO3 structured parts without intermediate rANS repack',
        scale: 'predictive Rice values consumed directly',
        colorDc: 'V22 YCoCg-R structured parts without intermediate rANS repack',
      },
      mainThreadAttributes: ['opacity', 'lifetime_mu', 'lifetime_w', 'coresh5r_shared'],
      target: 'complete six-file RAW4D decode in single-digit seconds on the acceptance workstation',
    },
  };
  const output = packContainer(manifest, source.streams);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output);
  const report = {
    version: 'Compression V2.4',
    sourcePath,
    sourceBytes: sourceBytes.length,
    sourceSha256: sha256(sourceBytes),
    outputPath,
    outputBytes: output.length,
    outputBytesM: output.length / 1_000_000,
    outputSha256: sha256(output),
    targetBytes: 60_000_000,
    headroomBytes: 60_000_000 - output.length,
    streamBytes: source.manifest.streams.reduce((sum, entry) => sum + entry.storedBytes, 0),
    storedStreamsByteIdenticalToV23: source.manifest.streams.every((entry) => sha256(source.streams.get(entry.name)) === entry.storedSha256),
    qualityImpactRelativeToV23: 'none',
  };
  await writeFile(`${outputPath}.repack.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

await main();
