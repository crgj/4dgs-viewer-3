// #WDD-gpt 2026-09-20 - CPU 纹理打包专用线程，不占用播放主线程或额外提交 GPU 计算。
import { prepareRaw4D, type PreparationRequest } from './Raw4DPreparation';
const scope = self as unknown as { onmessage: ((event: MessageEvent<{ id: number; request: PreparationRequest }>) => void) | null; postMessage(value: unknown, transfer?: Transferable[]): void };
scope.onmessage = ({ data: { id, request } }) => {
  try {
    const result = prepareRaw4D(request);
    scope.postMessage({ id, result }, Object.values(result).map((array) => array.buffer as ArrayBuffer));
  } catch (error) { scope.postMessage({ id, error: String(error) }); }
};
