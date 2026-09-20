/// <reference lib="webworker" />

import brotliPromise from 'brotli-wasm';
import { unzlibSync } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { FourCgsStreamEntry } from './FourCgsTypes';
import { unshuffle16 } from './FourCgsRaw4DBundle';

interface StreamRequest {
  readonly requestId: number;
  readonly file: File;
  readonly offset: number;
  readonly entry: FourCgsStreamEntry;
}

// #WDD-gpt 2026-09-20 - 优先原生 SHA-256，保留同等完整校验；不支持 WebCrypto 时使用原 JS 路径。
async function digest(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle && bytes.buffer instanceof ArrayBuffer) {
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)));
  }
  return bytesToHex(sha256(bytes));
}

async function decodeStream(request: StreamRequest): Promise<ArrayBuffer> {
  const { entry } = request;
  const stored = new Uint8Array(await request.file.slice(
    request.offset,
    request.offset + entry.storedBytes,
  ).arrayBuffer());
  if (stored.byteLength !== entry.storedBytes || await digest(stored) !== entry.storedSha256) {
    throw new Error(`4CGS 存储流校验失败：${entry.name}。`);
  }
  let raw: Uint8Array;
  if (entry.compression === 'brotli' || entry.compression === 'brotli-shuffle16') {
    const brotli = await brotliPromise;
    const decoded = brotli.decompress(stored);
    raw = entry.compression === 'brotli-shuffle16' ? unshuffle16(decoded) : decoded;
  } else if (entry.compression === 'deflate-shuffle16') {
    raw = unshuffle16(unzlibSync(stored));
  } else if (entry.compression === 'deflate') {
    raw = unzlibSync(stored);
  } else {
    raw = stored;
  }
  const rawDigestMatches = raw === stored
    ? entry.rawSha256 === entry.storedSha256
    : await digest(raw) === entry.rawSha256;
  if (raw.byteLength !== entry.rawBytes || !rawDigestMatches) {
    throw new Error(`4CGS 原始流校验失败：${entry.name}。`);
  }
  // #WDD-gpt 2026-09-20 - File 切片独占的未压缩流直接转移所有权；WASM 解压视图仍复制以保护运行时内存。
  if (raw === stored) return stored.buffer;
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return copy.buffer;
}

self.addEventListener('message', (event: MessageEvent<StreamRequest>) => {
  const startedAt = performance.now();
  void decodeStream(event.data).then(
    (bytes) => self.postMessage({
      type: 'result', requestId: event.data.requestId, name: event.data.entry.name,
      bytes, elapsedMs: performance.now() - startedAt,
    }, [bytes]),
    (error: unknown) => self.postMessage({
      type: 'error', requestId: event.data.requestId,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
});

export {};
