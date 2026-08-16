import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function splitStreams(symbols, probe) {
  const result = [];
  let offset = 0;
  for (const stream of probe.streams) { result.push({ ...stream, bytes: symbols.subarray(offset, offset + stream.rawBytes) }); offset += stream.rawBytes; }
  return result;
}

function signedValues(bytes) {
  const values = [];
  let offset = 0;
  while (offset < bytes.length) {
    let code = 0;
    let multiplier = 1;
    for (;;) { const byte = bytes[offset++]; code += (byte & 0x7f) * multiplier; if ((byte & 0x80) === 0) break; multiplier *= 128; }
    values.push(code & 1 ? -(code + 1) / 2 : code / 2);
  }
  return values;
}

function entropy(values) {
  const counts = new Map();
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) { counts.set(value, (counts.get(value) ?? 0) + 1); minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
  let bits = 0;
  for (const count of counts.values()) bits -= count * Math.log2(count / values.length);
  return { values: values.length, symbols: counts.size, minimum, maximum, entropyBits: bits, entropyBitsPerValue: bits / values.length, entropyBytes: bits / 8 };
}

// #WDD-gpt 2026-08-16 - 统计 V2.2 三条流的整数符号熵下限，区分“编码器还有空间”和“数据本身接近不可压缩”。
async function main() {
  const report = JSON.parse(await readFile(resolve('artifacts/compression_v2_20260816/inner_entropy_probe.json'), 'utf8'));
  const output = {};
  for (const name of ['rotation', 'scale', 'dc']) {
    const probe = report.probes.find((entry) => entry.name === name);
    const streams = splitStreams(await readFile(resolve(`/tmp/compression_v2_inner_entropy/${name}.symbols`)), probe);
    output[name] = streams.filter((stream) => stream.name !== 'birth' && stream.name !== 'exceptions' && stream.bytes.length).map((stream) => ({
      name: stream.name,
      rawBytes: stream.bytes.length,
      ...entropy(signedValues(stream.bytes)),
    }));
    output[name].push({
      name: 'residual-total',
      entropyBytes: output[name].reduce((sum, stream) => sum + stream.entropyBytes, 0),
      values: output[name].reduce((sum, stream) => sum + stream.values, 0),
    });
  }
  await writeFile(resolve('artifacts/compression_v2_20260816/v22_symbol_entropy.json'), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

await main();
