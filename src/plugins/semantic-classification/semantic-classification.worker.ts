/// <reference lib="webworker" />

import {
  AutoProcessor,
  AutoTokenizer,
  CLIPSegForImageSegmentation,
  RawImage,
  env,
} from '@huggingface/transformers';
import type {
  SemanticWorkerRequest,
  SemanticWorkerResponse,
} from './SemanticClassificationWorkerProtocol';
import {
  selectSemanticModelProfile,
  type SemanticModelProfile,
} from './SemanticClassificationBackend';

const scope = self as unknown as DedicatedWorkerGlobalScope;
export const CLIPSEG_MODEL_ID = 'Xenova/clipseg-rd64-refined';
export const CLIPSEG_MODEL_REVISION = '924dc94f85f58739f353f94258b33bc47eae4862';

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
type Model = Awaited<ReturnType<typeof CLIPSegForImageSegmentation.from_pretrained>>;

let tokenizer: Tokenizer | null = null;
let processor: Processor | null = null;
let model: Model | null = null;
let activeProfile: SemanticModelProfile | null = null;
let initializePromise: Promise<SemanticModelProfile> | null = null;

function respond(message: SemanticWorkerResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detectModelProfile(): Promise<SemanticModelProfile> {
  if (!('gpu' in navigator)) return selectSemanticModelProfile(false, false);
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return selectSemanticModelProfile(Boolean(adapter), Boolean(adapter?.features.has('shader-f16')));
  } catch {
    return selectSemanticModelProfile(false, false);
  }
}

async function initialize(requestId: number): Promise<SemanticModelProfile> {
  if (tokenizer && processor && model && activeProfile) return activeProfile;
  if (!initializePromise) {
    env.useBrowserCache = true;
    initializePromise = (async () => {
      const profile = await detectModelProfile();
      // #WDD-gpt 2026-08-26 - 保留 WebGPU q4f16 主路径；无 Adapter 或无 shader-f16 时使用官方 q8/WASM 图，而不是让 q4f16 在不兼容图融合阶段崩溃。
      const progressCallback = (progress: {
        status?: string;
        file?: string;
        loaded?: number;
        total?: number;
        progress?: number;
      }) => respond({
        type: 'progress',
        requestId,
        status: progress.status ?? 'loading',
        file: progress.file,
        loaded: progress.loaded,
        total: progress.total,
        progress: progress.progress,
      });
      const [loadedTokenizer, loadedProcessor, loadedModel] = await Promise.all([
        AutoTokenizer.from_pretrained(CLIPSEG_MODEL_ID, {
          revision: CLIPSEG_MODEL_REVISION,
          progress_callback: progressCallback,
        }),
        AutoProcessor.from_pretrained(CLIPSEG_MODEL_ID, {
          revision: CLIPSEG_MODEL_REVISION,
          progress_callback: progressCallback,
        }),
        CLIPSegForImageSegmentation.from_pretrained(CLIPSEG_MODEL_ID, {
          revision: CLIPSEG_MODEL_REVISION,
          dtype: profile.dtype,
          device: profile.device,
          progress_callback: progressCallback,
        }),
      ]);
      tokenizer = loadedTokenizer;
      processor = loadedProcessor;
      model = loadedModel;
      activeProfile = profile;
      return profile;
    })().catch((error) => {
      tokenizer = null;
      processor = null;
      model = null;
      activeProfile = null;
      initializePromise = null;
      throw error;
    });
  }
  return initializePromise;
}

async function classify(requestId: number, bitmap: ImageBitmap, prompts: readonly string[]): Promise<void> {
  try {
    await initialize(requestId);
    if (!tokenizer || !processor || !model) throw new Error('CLIPSeg 模型没有完成初始化。');
    if (prompts.length === 0 || prompts.length > 16) throw new Error('每次分类需要 1 到 16 个 Tag。');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('CLIPSeg Worker 无法创建图像画布。');
    context.drawImage(bitmap, 0, 0);
    const image = RawImage.fromCanvas(canvas);
    const textInputs = tokenizer([...prompts], { padding: true, truncation: true });
    const imageInputs = await processor(image);
    const output = await model({ ...textInputs, ...imageInputs });
    const logits = output.logits;
    const height = logits.dims[logits.dims.length - 2];
    const width = logits.dims[logits.dims.length - 1];
    // #WDD-gpt 2026-08-26 - WebGPU 驱动可把 q4f16 输出暴露为 Uint16Array/Float16Array，统一提升到 f32 后再做 sigmoid，避免把 half bits 当普通整数概率。
    const floatLogits = logits.type === 'float32' ? logits : logits.to('float32');
    const source = floatLogits.data as Float32Array;
    const probabilities = new Float32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      const value = source[index];
      probabilities[index] = value >= 0
        ? 1 / (1 + Math.exp(-value))
        : Math.exp(value) / (1 + Math.exp(value));
    }
    if (floatLogits !== logits) floatLogits.dispose();
    logits.dispose();
    respond({ type: 'result', requestId, width, height, probabilities }, [probabilities.buffer]);
  } finally {
    bitmap.close();
  }
}

scope.onmessage = (event: MessageEvent<SemanticWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'dispose') {
    void model?.dispose();
    tokenizer = null;
    processor = null;
    model = null;
    activeProfile = null;
    initializePromise = null;
    scope.close();
    return;
  }
  void (async () => {
    try {
      if (request.type === 'initialize') {
        const profile = await initialize(request.requestId);
        respond({ type: 'ready', requestId: request.requestId, backend: profile.backend });
      } else {
        await classify(request.requestId, request.bitmap, request.prompts);
      }
    } catch (error) {
      // #WDD-gpt 2026-08-26 - classify 自己在 finally 中释放已转移的位图，避免异常路径重复 close。
      respond({ type: 'error', requestId: request.requestId, message: errorMessage(error) });
    }
  })();
};
