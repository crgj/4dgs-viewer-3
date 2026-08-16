import { unzlibSync, zlibSync } from 'fflate';

// #WDD-gpt 2026-08-16 - 4CGS 内层使用 Node zlib 包装的 DEFLATE，浏览器用 fflate 保持字节兼容。
export function inflateSync(input: Uint8Array): Uint8Array {
  return unzlibSync(input);
}

export function deflateSync(input: Uint8Array): Uint8Array {
  return zlibSync(input);
}
