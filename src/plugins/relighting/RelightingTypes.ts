export type RelightingVector3 = readonly [number, number, number];

export interface RelightingLight {
  readonly id: string;
  readonly name: string;
  readonly position: RelightingVector3;
  readonly color: string;
  readonly intensity: number;
  readonly range: number;
  readonly castShadows: boolean;
}

export interface RelightingSettings {
  readonly blend: number;
  readonly brightness: number;
  readonly background: number;
  readonly textureScale: number;
}

export interface RelightingState extends RelightingSettings {
  readonly enabled: boolean;
  readonly selectedLightId: string | null;
  readonly lights: readonly RelightingLight[];
  readonly error?: string;
}

export type RelightingLightPatch = Partial<Omit<RelightingLight, 'id' | 'name'>>;

export const DEFAULT_RELIGHTING_SETTINGS: RelightingSettings = {
  blend: 0.72,
  brightness: 2,
  background: 1,
  textureScale: 0.75,
};

export const INITIAL_RELIGHTING_STATE: RelightingState = {
  ...DEFAULT_RELIGHTING_SETTINGS,
  enabled: false,
  selectedLightId: null,
  lights: [],
};

function clamp(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

// #WDD-gpt 2026-08-15 - 在 UI 和 PlayCanvas 之间建立统一参数边界，避免异常输入触发超大阴影或离屏纹理。
export function sanitizeRelightingSettings(settings: RelightingSettings): RelightingSettings {
  return {
    blend: clamp(settings.blend, 0, 1, DEFAULT_RELIGHTING_SETTINGS.blend),
    brightness: clamp(settings.brightness, 0, 5, DEFAULT_RELIGHTING_SETTINGS.brightness),
    background: clamp(settings.background, 0, 5, DEFAULT_RELIGHTING_SETTINGS.background),
    textureScale: clamp(settings.textureScale, 0.25, 1, DEFAULT_RELIGHTING_SETTINGS.textureScale),
  };
}

export function sanitizeRelightingLight(
  light: RelightingLight,
  fallbackRange: number,
): RelightingLight {
  const position = light.position.map((value) => clamp(value, -1_000_000, 1_000_000, 0)) as [number, number, number];
  return {
    ...light,
    position,
    color: /^#[0-9a-f]{6}$/i.test(light.color) ? light.color.toLowerCase() : '#ffd7aa',
    // #WDD-gpt 2026-08-16 - Preserve the existing wide light range; the Gaussian shader now compresses HDR peaks without rewriting saved intensity values.
    intensity: clamp(light.intensity, 0, 50, 1.5),
    range: clamp(light.range, 0.01, 1_000_000, Math.max(0.01, fallbackRange)),
  };
}
