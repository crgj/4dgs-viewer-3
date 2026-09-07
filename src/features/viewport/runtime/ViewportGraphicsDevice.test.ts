import { describe, expect, it, vi } from 'vitest';
import { DEVICETYPE_WEBGL2, DEVICETYPE_WEBGPU } from 'playcanvas';
import { createViewportGraphicsDevice } from './ViewportGraphicsDevice';

const canvas = {} as HTMLCanvasElement;
const device = { isWebGPU: false } as Awaited<ReturnType<typeof import('playcanvas')['createGraphicsDevice']>>;

describe('createViewportGraphicsDevice', () => {
  it('uses WebGL2 directly when the browser exposes WebGPU but has no adapter', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    const createDevice = vi.fn().mockResolvedValue(device);
    await expect(createViewportGraphicsDevice(canvas, { antialias: false }, false, {
      gpu: { requestAdapter }, createDevice,
    })).resolves.toBe(device);
    expect(requestAdapter).toHaveBeenCalledTimes(2);
    expect(createDevice).toHaveBeenCalledOnce();
    expect(createDevice.mock.calls[0][1].deviceTypes).toEqual([DEVICETYPE_WEBGL2]);
  });

  it('uses an automatic adapter when the high-performance preference is unavailable', async () => {
    const requestAdapter = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ features: new Set() });
    const createDevice = vi.fn().mockResolvedValue(device);
    await createViewportGraphicsDevice(canvas, { antialias: false }, false, {
      gpu: { requestAdapter } as unknown as GPU, createDevice,
    });
    expect(createDevice.mock.calls[0][1].deviceTypes).toEqual([DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2]);
  });

  it('retries WebGL2 if the adapter disappears during WebGPU device creation', async () => {
    const webGpuError = new TypeError("Cannot read properties of null (reading 'features')");
    const createDevice = vi.fn()
      .mockRejectedValueOnce(webGpuError)
      .mockResolvedValueOnce(device);
    const onWebGpuFallback = vi.fn();
    const result = await createViewportGraphicsDevice(canvas, { antialias: false }, false, {
      gpu: { requestAdapter: vi.fn().mockResolvedValue({ features: new Set() }) } as unknown as GPU,
      createDevice,
      onWebGpuFallback,
    });
    expect(result).toBe(device);
    expect(onWebGpuFallback).toHaveBeenCalledWith(webGpuError);
    expect(createDevice.mock.calls[1][1].deviceTypes).toEqual([DEVICETYPE_WEBGL2]);
  });

  it('does not probe WebGPU in forced compatibility mode', async () => {
    const requestAdapter = vi.fn();
    const createDevice = vi.fn().mockResolvedValue(device);
    await createViewportGraphicsDevice(canvas, { antialias: false }, true, {
      gpu: { requestAdapter }, createDevice,
    });
    expect(requestAdapter).not.toHaveBeenCalled();
    expect(createDevice.mock.calls[0][1].deviceTypes).toEqual([DEVICETYPE_WEBGL2]);
  });
});
