import { buildRaw4DSequenceSegments, matchRaw4DSequenceBoundary } from './Raw4DSequence';
import { readRaw4DHeader } from './Raw4DParser';
import type { Raw4DHeader } from './Raw4DTypes';
import type {
  Raw4DSequenceBoundaryMatch,
  Raw4DSequenceDescriptor,
  Raw4DSequenceExtractedSegment,
  Raw4DSequenceSegment,
} from './Raw4DSequenceTypes';
import type { Raw4DSequenceWorkerRequest, Raw4DSequenceWorkerResponse } from './Raw4DSequenceWorkerProtocol';

interface Raw4DSequenceWorkerScope {
  onmessage: ((event: MessageEvent<Raw4DSequenceWorkerRequest>) => void) | null;
  postMessage(message: Raw4DSequenceWorkerResponse): void;
}

interface SegmentPropertyIndices {
  readonly firstPosition: readonly [number, number, number];
  readonly lastPosition: readonly [number, number, number];
  readonly firstColorDc: readonly [number, number, number];
  readonly lastColorDc: readonly [number, number, number];
  readonly sh: readonly number[];
}

const workerScope = globalThis as unknown as Raw4DSequenceWorkerScope;
const controllers = new Map<number, AbortController>();
const CHUNK_ROWS = 8_192;

function bankCount(propertyNames: readonly string[], prefix: string): number {
  const expression = new RegExp(`^${prefix}_(\\d+)(?:_|$)`);
  let maximum = -1;
  for (const name of propertyNames) {
    const match = expression.exec(name);
    if (match) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

function requireProperty(index: ReadonlyMap<string, number>, name: string, fileName: string): number {
  const value = index.get(name);
  if (value === undefined) throw new Error(`${fileName} 缺少 ${name}。`);
  return value;
}

function propertyIndices(header: Raw4DHeader, fileName: string): SegmentPropertyIndices {
  const index = new Map(header.propertyNames.map((name, property) => [name, property]));
  const lastPositionBank = bankCount(header.propertyNames, 'xyz_bank') - 1;
  const lastDcBank = bankCount(header.propertyNames, 'f_dc_bank') - 1;
  if (lastPositionBank < 0 || lastDcBank < 0) throw new Error(`${fileName} 缺少 Position 或 DC 关键帧。`);
  const position = (bank: number) => ['x', 'y', 'z'].map((component) => (
    requireProperty(index, `xyz_bank_${bank}_${component}`, fileName)
  )) as unknown as readonly [number, number, number];
  const colorDc = (bank: number) => ['0', '1', '2'].map((component) => (
    requireProperty(index, `f_dc_bank_${bank}_${component}`, fileName)
  )) as unknown as readonly [number, number, number];
  const sh = header.propertyNames
    .map((name, property) => ({ match: /^f_rest_(\d+)$/.exec(name), property }))
    .filter((entry): entry is { match: RegExpExecArray; property: number } => Boolean(entry.match))
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
    .map((entry, coefficient) => {
      if (Number(entry.match[1]) !== coefficient) throw new Error(`${fileName} 的 SH 属性不连续。`);
      return entry.property;
    });
  return {
    firstPosition: position(0),
    lastPosition: position(lastPositionBank),
    firstColorDc: colorDc(0),
    lastColorDc: colorDc(lastDcBank),
    sh,
  };
}

function copyComponents(
  source: Uint16Array | Uint32Array,
  rowOffset: number,
  sourceProperties: readonly number[],
  destination: Uint32Array,
  destinationOffset: number,
): void {
  for (let component = 0; component < sourceProperties.length; component += 1) {
    destination[destinationOffset + component] = source[rowOffset + sourceProperties[component]];
  }
}

async function extractSegment(
  file: File,
  header: Raw4DHeader,
  signal: AbortSignal,
  onRatio: (ratio: number) => void,
): Promise<Raw4DSequenceExtractedSegment> {
  const indices = propertyIndices(header, file.name);
  const count = header.vertexCount;
  const firstPositionBits = new Uint32Array(count * 3);
  const lastPositionBits = new Uint32Array(count * 3);
  const firstColorDcBits = new Uint32Array(count * 3);
  const lastColorDcBits = new Uint32Array(count * 3);
  const shBits = new Uint32Array(count * indices.sh.length);
  for (let firstRow = 0; firstRow < count; firstRow += CHUNK_ROWS) {
    if (signal.aborted) throw new DOMException('RAW4D 序列预处理已取消。', 'AbortError');
    const rowCount = Math.min(CHUNK_ROWS, count - firstRow);
    const byteStart = header.dataOffset + firstRow * header.recordBytes;
    const buffer = await file.slice(byteStart, byteStart + rowCount * header.recordBytes).arrayBuffer();
    // #WDD-gpt 2026-08-16 - FP32 用 Uint32 视图保留原位模式；边界对应和 SH 更新判断不经过浮点重建。
    const source = header.scalarEncoding === 'float16' ? new Uint16Array(buffer) : new Uint32Array(buffer);
    for (let row = 0; row < rowCount; row += 1) {
      const local = firstRow + row;
      const sourceOffset = row * header.propertyNames.length;
      copyComponents(source, sourceOffset, indices.firstPosition, firstPositionBits, local * 3);
      copyComponents(source, sourceOffset, indices.lastPosition, lastPositionBits, local * 3);
      copyComponents(source, sourceOffset, indices.firstColorDc, firstColorDcBits, local * 3);
      copyComponents(source, sourceOffset, indices.lastColorDc, lastColorDcBits, local * 3);
      copyComponents(source, sourceOffset, indices.sh, shBits, local * indices.sh.length);
    }
    onRatio((firstRow + rowCount) / count);
  }
  return {
    encoding: header.scalarEncoding,
    count,
    shCoefficientCount: indices.sh.length,
    firstPositionBits,
    lastPositionBits,
    firstColorDcBits,
    lastColorDcBits,
    shBits,
  };
}

async function openSequence(request: Extract<Raw4DSequenceWorkerRequest, { type: 'open' }>): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  const progress = (ratio: number, message: string) => workerScope.postMessage({
    type: 'progress', requestId: request.requestId, progress: { ratio, message },
  });
  try {
    if (request.files.length < 2 || request.files.some((file) => !file.name.toLowerCase().endsWith('.raw4d'))) {
      throw new Error('多文件拖入只支持两个或更多 RAW4D 文件。');
    }
    progress(0, `正在读取 ${request.files.length} 个 RAW4D 文件头`);
    const headers = await Promise.all(request.files.map((file) => readRaw4DHeader(file, controller.signal)));
    const segments = buildRaw4DSequenceSegments(request.files.map((file, fileIndex) => ({
      fileIndex, name: file.name, header: headers[fileIndex],
    })));
    const sourceBytes = request.files.reduce((sum, file) => sum + file.size, 0);
    let previousExtracted: Raw4DSequenceExtractedSegment | null = null;
    let previousTrackMap: Int32Array | null = null;
    let nextTrackId = 0;
    let shUpdateStateCount = 0;
    const matches: Raw4DSequenceBoundaryMatch[] = [];

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex];
      const file = request.files[segment.fileIndex];
      const header = headers[segment.fileIndex];
      const extracted = await extractSegment(file, header, controller.signal, (fileRatio) => {
        const ratio = 0.04 + (segmentIndex + fileRatio) / segments.length * 0.9;
        progress(ratio, `正在提取 SH 与边界 ${segmentIndex + 1}/${segments.length} · ${file.name}`);
      });
      if (!previousExtracted || !previousTrackMap) {
        previousTrackMap = Int32Array.from({ length: extracted.count }, (_, index) => index);
        nextTrackId = extracted.count;
      } else {
        const work = matchRaw4DSequenceBoundary(previousExtracted, previousTrackMap, extracted, nextTrackId);
        const previous = segments[segmentIndex - 1];
        matches.push({
          previous: previous.name,
          current: segment.name,
          matchedCount: work.matchedCount,
          matchedRatio: work.matchedCount / segment.splatCount,
          duplicateCandidateCount: work.duplicateCandidateCount,
          shUpdateCount: work.shUpdateCount,
          method: 'exact_scalar_bits_position_sh_dc_tie_break',
        });
        previousTrackMap = work.currentTrackMap;
        nextTrackId = work.nextTrackId;
        shUpdateStateCount += work.shUpdateCount;
      }
      previousExtracted = extracted;
    }

    const coefficientCount = segments[0].shCoefficientCount;
    const bytesPerScalar = headers[segments[0].fileIndex].scalarEncoding === 'float16' ? 2 : 4;
    const sourceStateCount = segments.reduce((sum, segment) => sum + segment.splatCount, 0);
    const extractedStateCount = nextTrackId + shUpdateStateCount;
    const sourceShBytes = sourceStateCount * coefficientCount * bytesPerScalar;
    const extractedShBytes = extractedStateCount * coefficientCount * bytesPerScalar;
    const descriptor: Raw4DSequenceDescriptor = {
      sourceName: `${segments[0].name.replace(/\.raw4d$/i, '')}…${segments.at(-1)!.name.replace(/\.raw4d$/i, '')}`,
      sourceBytes,
      firstFrame: segments[0].firstFrame,
      lastFrame: segments.at(-1)!.lastFrame,
      totalFrames: segments.at(-1)!.lastFrame - segments[0].firstFrame + 1,
      boundaryFramesRemoved: segments.length - 1,
      permanentTrackCount: nextTrackId,
      segments,
      matches,
      sharedSh: {
        encoding: headers[segments[0].fileIndex].scalarEncoding,
        coefficientCount,
        sourceStateCount,
        extractedStateCount,
        updateStateCount: shUpdateStateCount,
        sourceBytes: sourceShBytes,
        extractedBytes: extractedShBytes,
        savedBytes: sourceShBytes - extractedShBytes,
        exactBitComparison: true,
      },
    };
    progress(1, `预处理完成：合并 ${descriptor.boundaryFramesRemoved} 个边界帧，SH 已独立提取`);
    workerScope.postMessage({ type: 'opened', requestId: request.requestId, descriptor });
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    workerScope.postMessage({
      type: 'error', requestId: request.requestId, name: value.name, message: value.message,
    });
  } finally {
    controllers.delete(request.requestId);
  }
}

workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type === 'open') void openSequence(request);
  else controllers.get(request.requestId)?.abort();
};
