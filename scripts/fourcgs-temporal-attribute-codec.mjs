import { decodeRans, encodeRans, floatToHalf, halfToFloat } from './fourcgs-prs-codec.mjs';

const MAGIC = 'TATTR001';

class ByteWriter {
  constructor() { this.bytes = []; }
  byte(value) { this.bytes.push(value & 0xff); }
  uint(value) {
    let remaining = Math.trunc(value);
    while (remaining >= 128) { this.byte((remaining % 128) | 0x80); remaining = Math.floor(remaining / 128); }
    this.byte(remaining);
  }
  sint(value) { this.uint(value >= 0 ? value * 2 : -value * 2 - 1); }
  ushort(value) { this.byte(value); this.byte(value >>> 8); }
  finish() { return Buffer.from(this.bytes); }
}

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.offset = 0; }
  byte() {
    if (this.offset >= this.bytes.length) throw new Error('Unexpected end of temporal attribute stream.');
    return this.bytes[this.offset++];
  }
  uint() {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      const byte = this.byte();
      value += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Oversized temporal attribute varint.');
  }
  sint() { const value = this.uint(); return value & 1 ? -(value + 1) / 2 : value / 2; }
  ushort() { return this.byte() | (this.byte() << 8); }
  done() {
    if (this.offset !== this.bytes.length) throw new Error(`Unused temporal attribute bytes: ${this.bytes.length - this.offset}`);
  }
}

function orderedHalf(bits) {
  return bits & 0x8000 ? (~bits & 0xffff) : (bits ^ 0x8000);
}

function unorderedHalf(code) {
  return code & 0x8000 ? (code ^ 0x8000) : (~code & 0xffff);
}

function propertyName(prefix, bank, component) {
  return component === '' ? `${prefix}_${bank}` : `${prefix}_${bank}_${component}`;
}

function packStreams(metadata, streams) {
  const directory = Buffer.from(JSON.stringify({
    ...metadata,
    streams: streams.map((stream) => ({ name: stream.name, bytes: stream.bytes.length })),
  }), 'utf8');
  const prefix = Buffer.alloc(12);
  prefix.write(MAGIC, 0, 'ascii');
  prefix.writeUInt32LE(directory.length, 8);
  return Buffer.concat([prefix, directory, ...streams.map((stream) => stream.bytes)]);
}

function unpackStreams(encoded) {
  if (encoded.subarray(0, 8).toString('ascii') !== MAGIC) throw new Error('Unsupported temporal attribute stream.');
  const directoryBytes = encoded.readUInt32LE(8);
  const metadata = JSON.parse(encoded.subarray(12, 12 + directoryBytes).toString('utf8'));
  const streams = new Map();
  let offset = 12 + directoryBytes;
  for (const stream of metadata.streams) {
    streams.set(stream.name, decodeRans(encoded.subarray(offset, offset + stream.bytes)));
    offset += stream.bytes;
  }
  if (offset !== encoded.length) throw new Error(`Unexpected temporal attribute trailing bytes: ${encoded.length - offset}`);
  return { metadata, streams };
}

function quantizedBanks(segment, layout, segmentIndex, options) {
  const active = layout.activeSlots[segmentIndex];
  const inverse = layout.slotToLocal[segmentIndex];
  const bankCount = options.bankCounts[segmentIndex];
  const dimensions = options.components.length;
  return Array.from({ length: bankCount }, (_, bank) => {
    const properties = options.components.map((component) => segment.propertyIndex.get(propertyName(options.prefix, bank, component)));
    const values = new Int32Array(active.length * dimensions);
    for (let row = 0; row < active.length; row += 1) {
      const source = inverse[active[row]] * segment.propertyNames.length;
      for (let component = 0; component < dimensions; component += 1) {
        const bits = segment.rows[source + properties[component]];
        values[row * dimensions + component] = options.exactHalf ? orderedHalf(bits) : Math.round(halfToFloat(bits) / options.step);
      }
    }
    return values;
  });
}

// #WDD-gpt 2026-08-15 - 不同属性独立选择码型；这里只编码永久 Track 出生值、共享边界修复、端点和内部线性预测残差。
export function encodeTemporalAttribute(segments, layout, options) {
  const dimensions = options.components.length;
  const contexts = Object.fromEntries(['boundary', 'endpoint', 'internal'].map((name) => [
    name,
    Array.from({ length: dimensions }, () => new ByteWriter()),
  ]));
  const birth = new Int32Array(layout.slotCount * dimensions);
  const endState = new Int32Array(layout.slotCount * dimensions);
  const initialized = new Uint8Array(layout.slotCount);
  let maximumError = 0;
  let squaredError = 0;
  let valueCount = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const active = layout.activeSlots[segmentIndex];
    const banks = quantizedBanks(segments[segmentIndex], layout, segmentIndex, options);
    const endpoint = banks.length - 1;
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      for (let component = 0; component < dimensions; component += 1) {
        const offset = row * dimensions + component;
        const stateOffset = slot * dimensions + component;
        const start = banks[0][offset];
        if (!initialized[slot]) birth[stateOffset] = start;
        else contexts.boundary[component].sint(start - endState[stateOffset]);
        contexts.endpoint[component].sint(banks[endpoint][offset] - start);
        for (let bank = 1; bank < endpoint; bank += 1) {
          const predicted = Math.round(((endpoint - bank) * start + bank * banks[endpoint][offset]) / endpoint);
          contexts.internal[component].sint(banks[bank][offset] - predicted);
        }
        endState[stateOffset] = banks[endpoint][offset];
      }
      initialized[slot] = 1;
    }
    if (!options.exactHalf) {
      const segment = segments[segmentIndex];
      const inverse = layout.slotToLocal[segmentIndex];
      for (let bank = 0; bank < banks.length; bank += 1) {
        for (let row = 0; row < active.length; row += 1) {
          const source = inverse[active[row]] * segment.propertyNames.length;
          for (let component = 0; component < dimensions; component += 1) {
            const property = segment.propertyIndex.get(propertyName(options.prefix, bank, options.components[component]));
            const original = halfToFloat(segment.rows[source + property]);
            const reconstructed = halfToFloat(floatToHalf(banks[bank][row * dimensions + component] * options.step));
            const error = Math.abs(original - reconstructed);
            maximumError = Math.max(maximumError, error);
            squaredError += error * error;
            valueCount += 1;
          }
        }
      }
    }
  }
  const birthWriter = new ByteWriter();
  for (const value of birth) options.exactHalf ? birthWriter.ushort(value) : birthWriter.sint(value);
  const rawStreams = [{ name: 'birth', raw: birthWriter.finish() }];
  for (const context of ['boundary', 'endpoint', 'internal']) {
    for (let component = 0; component < dimensions; component += 1) {
      rawStreams.push({ name: `${context}:${component}`, raw: contexts[context][component].finish() });
    }
  }
  const streams = rawStreams.map((stream) => ({ name: stream.name, bytes: encodeRans(stream.raw), rawBytes: stream.raw.length }));
  const encoded = packStreams({
    prefix: options.prefix,
    components: options.components,
    bankCounts: options.bankCounts,
    exactHalf: Boolean(options.exactHalf),
    step: options.step ?? 0,
    slotCount: layout.slotCount,
  }, streams);
  return {
    encoded,
    metrics: {
      encodedBytes: encoded.length,
      exactHalf: Boolean(options.exactHalf),
      step: options.step ?? 0,
      measuredRmse: valueCount ? Math.sqrt(squaredError / valueCount) : 0,
      measuredMaximumError: maximumError,
      streams: streams.map((stream) => ({ name: stream.name, rawBytes: stream.rawBytes, encodedBytes: stream.bytes.length })),
      temporalTransform: 'permanent Track birth plus shared-boundary, endpoint and internal linear residuals',
      entropyCodec: 'component-separated signed-varint static byte rANS-12',
    },
  };
}

export function decodeTemporalAttribute(encoded, manifest, activeSlots, rows, indices) {
  const { metadata, streams } = unpackStreams(encoded);
  return decodeTemporalAttributeStreams(metadata, streams, manifest, activeSlots, rows, indices);
}

// #WDD-gpt 2026-08-16 - V2.4 允许 Scale/DC 从结构化外层的原始上下文流直接写入行缓冲，消除重复熵编解码。
export function decodeTemporalAttributeStreams(metadata, streams, manifest, activeSlots, rows, indices) {
  if (metadata.slotCount !== manifest.slotCount || metadata.bankCounts.length !== manifest.segments.length) {
    throw new Error('Temporal attribute layout mismatch.');
  }
  const dimensions = metadata.components.length;
  const birthReader = new ByteReader(streams.get('birth'));
  const birth = new Int32Array(manifest.slotCount * dimensions);
  for (let index = 0; index < birth.length; index += 1) birth[index] = metadata.exactHalf ? birthReader.ushort() : birthReader.sint();
  birthReader.done();
  const contextReaders = Object.fromEntries(['boundary', 'endpoint', 'internal'].map((context) => [
    context,
    Array.from({ length: dimensions }, (_, component) => new ByteReader(streams.get(`${context}:${component}`))),
  ]));
  const endState = new Int32Array(manifest.slotCount * dimensions);
  const initialized = new Uint8Array(manifest.slotCount);
  let decodedValues = 0;
  for (let segmentIndex = 0; segmentIndex < manifest.segments.length; segmentIndex += 1) {
    const active = activeSlots[segmentIndex];
    const endpoint = metadata.bankCounts[segmentIndex] - 1;
    const banks = Array.from({ length: endpoint + 1 }, () => new Int32Array(active.length * dimensions));
    for (let row = 0; row < active.length; row += 1) {
      const slot = active[row];
      for (let component = 0; component < dimensions; component += 1) {
        const offset = row * dimensions + component;
        const stateOffset = slot * dimensions + component;
        const start = initialized[slot] ? endState[stateOffset] + contextReaders.boundary[component].sint() : birth[stateOffset];
        banks[0][offset] = start;
        banks[endpoint][offset] = start + contextReaders.endpoint[component].sint();
        for (let bank = 1; bank < endpoint; bank += 1) {
          const predicted = Math.round(((endpoint - bank) * start + bank * banks[endpoint][offset]) / endpoint);
          banks[bank][offset] = predicted + contextReaders.internal[component].sint();
        }
        endState[stateOffset] = banks[endpoint][offset];
      }
      initialized[slot] = 1;
    }
    const rowValues = rows[segmentIndex];
    const stride = indices[segmentIndex].size;
    for (let bank = 0; bank <= endpoint; bank += 1) {
      for (let row = 0; row < active.length; row += 1) {
        for (let component = 0; component < dimensions; component += 1) {
          const code = banks[bank][row * dimensions + component];
          rowValues[row * stride + indices[segmentIndex].get(propertyName(metadata.prefix, bank, metadata.components[component]))]
            = metadata.exactHalf ? unorderedHalf(code) : floatToHalf(code * metadata.step);
          decodedValues += 1;
        }
      }
    }
  }
  for (const readers of Object.values(contextReaders)) for (const reader of readers) reader.done();
  return { mode: metadata.exactHalf ? 'exact-fp16-temporal-residual-rans' : 'controlled-temporal-residual-rans', decodedValues, step: metadata.step };
}
