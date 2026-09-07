import {
  DEVICETYPE_WEBGL2,
  DEVICETYPE_WEBGPU,
  createGraphicsDevice,
} from 'playcanvas';

type GraphicsDeviceOptions = NonNullable<Parameters<typeof createGraphicsDevice>[1]>;
type GraphicsDeviceFactory = typeof createGraphicsDevice;

interface WebGpuAdapterProbe {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
}

export interface ViewportGraphicsDeviceDependencies {
  readonly createDevice?: GraphicsDeviceFactory;
  readonly gpu?: WebGpuAdapterProbe | null;
  readonly onWebGpuFallback?: (error: unknown) => void;
}

async function requestAvailableAdapter(gpu: WebGpuAdapterProbe | null | undefined): Promise<boolean> {
  if (!gpu) return false;
  try {
    if (await gpu.requestAdapter({ powerPreference: 'high-performance' })) return true;
  } catch {
    // 某些浏览器会拒绝 powerPreference，但默认适配器仍然可用。
  }
  try {
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

// #WDD-gpt 2026-09-06 - PlayCanvas 在 navigator.gpu 存在但 requestAdapter 返回 null 时会读取 null.features；先探测真实适配器，并在设备创建竞态失败时显式重试 WebGL2。
export async function createViewportGraphicsDevice(
  canvas: HTMLCanvasElement,
  options: Omit<GraphicsDeviceOptions, 'deviceTypes'>,
  forceWebGL2: boolean,
  dependencies: ViewportGraphicsDeviceDependencies = {},
): ReturnType<GraphicsDeviceFactory> {
  const createDevice = dependencies.createDevice ?? createGraphicsDevice;
  const gpu = dependencies.gpu !== undefined
    ? dependencies.gpu
    : typeof navigator === 'undefined' ? null : navigator.gpu;
  const webGpuAvailable = !forceWebGL2 && await requestAvailableAdapter(gpu);
  if (!webGpuAvailable) {
    return createDevice(canvas, { ...options, deviceTypes: [DEVICETYPE_WEBGL2] });
  }
  try {
    return await createDevice(canvas, {
      ...options,
      deviceTypes: [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
    });
  } catch (error) {
    dependencies.onWebGpuFallback?.(error);
    return createDevice(canvas, { ...options, deviceTypes: [DEVICETYPE_WEBGL2] });
  }
}
