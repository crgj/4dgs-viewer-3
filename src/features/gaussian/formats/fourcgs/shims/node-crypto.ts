import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// #WDD-gpt 2026-08-16 - V2.4 结构流目录需要同步 SHA-256；noble 在 Worker 内保持 Node createHash 链式语义且不开放系统能力。
export function createHash(algorithm: string) {
  if (algorithm.toLowerCase() !== 'sha256') throw new Error(`4CGS browser runtime only supports SHA-256, received ${algorithm}.`);
  const hash = sha256.create();
  const chain = {
    update(input: Uint8Array) {
      hash.update(input);
      return chain;
    },
    digest(encoding?: string) {
      const bytes = hash.digest();
      if (encoding === undefined) return bytes;
      if (encoding !== 'hex') throw new Error(`4CGS browser runtime cannot encode SHA-256 as ${encoding}.`);
      return bytesToHex(bytes);
    },
  };
  return chain;
}
