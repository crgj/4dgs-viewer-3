import { createRaw4DPlySequenceEncoder } from './Raw4DPlySequenceExporter';
import type {
  Raw4DPlySequenceExportWorkerRequest,
  Raw4DPlySequenceExportWorkerResponse,
} from './Raw4DPlySequenceWorkerProtocol';

interface Raw4DPlySequenceWorkerScope {
  onmessage: ((event: MessageEvent<Raw4DPlySequenceExportWorkerRequest>) => void) | null;
  postMessage(message: Raw4DPlySequenceExportWorkerResponse): void;
}

const workerScope = globalThis as unknown as Raw4DPlySequenceWorkerScope;

// #WDD-gpt 2026-08-17 - 每帧编码后立即通过 FileSystemDirectoryHandle 写入用户选择的目录；
// 不再打包 ZIP，输出字节直接流式落盘。
workerScope.onmessage = (event) => {
  const request = event.data;
  if (request.type !== 'export') return;
  void (async () => {
    try {
      const encoder = createRaw4DPlySequenceEncoder(request.sources);
      workerScope.postMessage({
        type: 'progress',
        progress: {
          ratio: 0,
          frameIndex: 0,
          frameCount: encoder.frameCount,
          message: `已规划 ${encoder.plans.length} 段共 ${encoder.frameCount} 帧，正在写入所选目录…`,
        },
      });
      let outputBytes = 0;
      for (let timelineFrame = 0; timelineFrame < encoder.frameCount; timelineFrame += 1) {
        const frame = encoder.encodeFrame(timelineFrame);
        const fileHandle = await request.directory.getFileHandle(frame.filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(frame.header);
        await writable.write(frame.rows);
        await writable.close();
        outputBytes += frame.header.length + frame.rows.length;
        workerScope.postMessage({
          type: 'progress',
          progress: {
            ratio: (timelineFrame + 1) / encoder.frameCount,
            frameIndex: timelineFrame + 1,
            frameCount: encoder.frameCount,
            message: `正在写入 ${frame.filename} · ${timelineFrame + 1}/${encoder.frameCount}`,
          },
        });
      }
      workerScope.postMessage({
        type: 'result',
        requestId: request.requestId,
        result: {
          directoryName: request.directory.name,
          stats: {
            segmentCount: encoder.plans.length,
            frameCount: encoder.frameCount,
            deletedPointCount: encoder.deletedPointCount,
            outputBytes,
          },
        },
      });
    } catch (error) {
      workerScope.postMessage({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
