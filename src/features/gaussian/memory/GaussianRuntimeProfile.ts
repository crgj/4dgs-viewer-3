import type { Gaussian4DMemoryMode } from './Gaussian4DMemoryPolicy';

export type GaussianRuntimeProfileName = 'desktop' | 'mobile-compatible';

export interface GaussianRuntimeSignals {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly mobileHint?: boolean;
  readonly maxTouchPoints?: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly deviceMemoryGiB?: number;
}

export interface GaussianRuntimeProfile {
  readonly name: GaussianRuntimeProfileName;
  readonly defaultMemoryMode: Gaussian4DMemoryMode;
  readonly forceWebGL2: boolean;
  readonly maxPixelRatio: number;
  readonly streamTextureKeyframes: boolean;
  readonly loaderWorkerCount: number | undefined;
}

const MOBILE_USER_AGENT = /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i;

export function resolveGaussianRuntimeProfile(signals: GaussianRuntimeSignals): GaussianRuntimeProfile {
  const compactViewport = Math.min(
    signals.viewportWidth ?? Number.POSITIVE_INFINITY,
    signals.viewportHeight ?? Number.POSITIVE_INFINITY,
  ) <= 900;
  const touchDevice = (signals.maxTouchPoints ?? 0) > 1;
  const ipadDesktopAgent = signals.platform === 'MacIntel' && touchDevice;
  const constrainedMemory = Number.isFinite(signals.deviceMemoryGiB)
    && (signals.deviceMemoryGiB ?? Number.POSITIVE_INFINITY) <= 4;
  const mobile = signals.mobileHint === true
    || MOBILE_USER_AGENT.test(signals.userAgent ?? '')
    || ipadDesktopAgent
    || (compactViewport && touchDevice && constrainedMemory);

  if (mobile) {
    return {
      name: 'mobile-compatible',
      defaultMemoryMode: 'mobile',
      forceWebGL2: true,
      maxPixelRatio: 1,
      streamTextureKeyframes: true,
      loaderWorkerCount: 1,
    };
  }
  return {
    name: 'desktop',
    defaultMemoryMode: 'local-maximum',
    forceWebGL2: false,
    maxPixelRatio: 2,
    streamTextureKeyframes: false,
    loaderWorkerCount: undefined,
  };
}

interface NavigatorWithRuntimeHints extends Navigator {
  readonly deviceMemory?: number;
  readonly userAgentData?: { readonly mobile?: boolean };
}

// #WDD-gpt 2026-08-19 - 移动端不能沿用工作站显存假设；集中检测一次并让内存、设备和关键帧上传共享同一档案。
export function detectGaussianRuntimeProfile(): GaussianRuntimeProfile {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return resolveGaussianRuntimeProfile({});
  }
  const runtimeNavigator = navigator as NavigatorWithRuntimeHints;
  return resolveGaussianRuntimeProfile({
    userAgent: runtimeNavigator.userAgent,
    platform: runtimeNavigator.platform,
    mobileHint: runtimeNavigator.userAgentData?.mobile,
    maxTouchPoints: runtimeNavigator.maxTouchPoints,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    deviceMemoryGiB: runtimeNavigator.deviceMemory,
  });
}
