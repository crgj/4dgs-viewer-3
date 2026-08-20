import { describe, expect, it } from 'vitest';
import { resolveGaussianRuntimeProfile } from './GaussianRuntimeProfile';

describe('Gaussian runtime profile', () => {
  it('uses the mobile fallback for Android even when memory reporting is unavailable', () => {
    const profile = resolveGaussianRuntimeProfile({
      userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile',
      maxTouchPoints: 5,
      viewportWidth: 412,
      viewportHeight: 915,
    });
    expect(profile.name).toBe('mobile-compatible');
    expect(profile.defaultMemoryMode).toBe('mobile');
    expect(profile.forceWebGL2).toBe(true);
    expect(profile.streamTextureKeyframes).toBe(true);
    expect(profile.maxPixelRatio).toBe(1);
  });

  it('recognizes iPadOS desktop user agents', () => {
    expect(resolveGaussianRuntimeProfile({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
      platform: 'MacIntel',
      maxTouchPoints: 5,
      viewportWidth: 1024,
      viewportHeight: 768,
    }).name).toBe('mobile-compatible');
  });

  it('keeps the workstation profile on desktop', () => {
    const profile = resolveGaussianRuntimeProfile({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      viewportWidth: 1920,
      viewportHeight: 1080,
      deviceMemoryGiB: 32,
    });
    expect(profile.name).toBe('desktop');
    expect(profile.defaultMemoryMode).toBe('local-maximum');
  });
});
