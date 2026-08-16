function createFloat16DecodeTable(): Float32Array {
  const table = new Float32Array(65_536);
  const floatBits = new Uint32Array(1);
  const floatValue = new Float32Array(floatBits.buffer);

  for (let encoded = 0; encoded < table.length; encoded += 1) {
    const sign = (encoded & 0x8000) << 16;
    let exponent = (encoded >>> 10) & 0x1f;
    let fraction = encoded & 0x03ff;

    if (exponent === 0) {
      if (fraction === 0) {
        floatBits[0] = sign;
      } else {
        while ((fraction & 0x0400) === 0) {
          fraction <<= 1;
          exponent -= 1;
        }
        exponent += 1;
        fraction &= 0x03ff;
        floatBits[0] = sign | ((exponent + 112) << 23) | (fraction << 13);
      }
    } else if (exponent === 0x1f) {
      floatBits[0] = sign | 0x7f800000 | (fraction << 13);
    } else {
      floatBits[0] = sign | ((exponent + 112) << 23) | (fraction << 13);
    }
    table[encoded] = floatValue[0];
  }

  return table;
}

// #WDD-gpt  2026-08-15 - 用 64K 查表在 Loader Worker 中批量展开 fp16，兼容无 Float16Array 的浏览器。
export const RAW4D_FLOAT16_DECODE_TABLE = createFloat16DecodeTable();
