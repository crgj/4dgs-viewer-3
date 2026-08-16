import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function xzBytes(source, profile, deltaDistance = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'fourcgs-v22-xz-'));
  const input = join(directory, 'payload.bin');
  try {
    await writeFile(input, source);
    const argumentsList = ['-f', '-k'];
    if (deltaDistance) argumentsList.push(`--delta=dist=${deltaDistance}`);
    if (profile) argumentsList.push(`--lzma2=${profile}`);
    else argumentsList.push('-9e');
    argumentsList.push(input);
    await execFileAsync('xz', argumentsList, { maxBuffer: 1024 * 1024 });
    return (await stat(`${input}.xz`)).size;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function profilesFor(name) {
  const defaultLc = name === 'scale' ? 0 : 1;
  const dictionaries = ['4KiB', '8KiB', '16KiB', '32KiB', '64KiB', '128KiB', '256KiB', '512KiB', '1MiB', '4MiB', '16MiB', '64MiB'];
  const profiles = [{ label: 'preset-9e', profile: null, deltaDistance: 0 }];
  for (const dictionary of dictionaries) profiles.push({
    label: `dict-${dictionary}-lc${defaultLc}-lp0-pb0`,
    profile: `preset=9e,dict=${dictionary},lc=${defaultLc},lp=0,pb=0`,
    deltaDistance: 0,
  });
  for (const dictionary of ['4KiB', '16KiB', '64KiB', '256KiB', '1MiB']) {
    for (let lc = 0; lc <= 4; lc += 1) for (let pb = 0; pb <= 3; pb += 1) profiles.push({
      label: `dict-${dictionary}-lc${lc}-lp0-pb${pb}`,
      profile: `preset=9e,dict=${dictionary},lc=${lc},lp=0,pb=${pb}`,
      deltaDistance: 0,
    });
    for (let lc = 0; lc <= 3; lc += 1) for (let lp = 1; lp <= Math.min(2, 4 - lc); lp += 1) profiles.push({
      label: `dict-${dictionary}-lc${lc}-lp${lp}-pb0`,
      profile: `preset=9e,dict=${dictionary},lc=${lc},lp=${lp},pb=0`,
      deltaDistance: 0,
    });
  }
  for (const dictionary of ['4KiB', '64KiB']) for (const distance of [1, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32]) profiles.push({
    label: `delta${distance}-dict-${dictionary}-lc${defaultLc}-lp0-pb0`,
    profile: `preset=9e,dict=${dictionary},lc=${defaultLc},lp=0,pb=0`,
    deltaDistance: distance,
  });
  return [...new Map(profiles.map((profile) => [profile.label, profile])).values()];
}

// #WDD-gpt 2026-08-16 - 为 V2.2 三条候选流实测 LZMA2 字典、字节上下文和 Delta filter 网格，避免把默认 XZ 参数误当作码率下限。
async function main() {
  const inputDirectory = resolve(process.argv[2] ?? '/tmp/compression_v22_rds');
  const outputPath = resolve(process.argv[3] ?? 'artifacts/compression_v2_20260816/v22_xz_tuning.json');
  const files = {
    rotation: 'rotation_rice64.symbols',
    scale: 'scale_rice64.symbols',
    dc: 'dc_ycocg_r_rice32.symbols',
  };
  const report = {};
  for (const [name, filename] of Object.entries(files)) {
    const source = await readFile(resolve(inputDirectory, filename));
    const results = [];
    for (const profile of profilesFor(name)) {
      const storedBytes = await xzBytes(source, profile.profile, profile.deltaDistance);
      results.push({ ...profile, storedBytes });
    }
    results.sort((a, b) => a.storedBytes - b.storedBytes);
    report[name] = { sourceBytes: source.length, best: results[0], top: results.slice(0, 20), testedProfiles: results.length };
    process.stderr.write(`${name} best ${results[0].label}: ${results[0].storedBytes}\n`);
  }
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

await main();
