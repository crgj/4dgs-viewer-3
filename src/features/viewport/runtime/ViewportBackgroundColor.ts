export const DEFAULT_VIEWPORT_BACKGROUND_COLOR = '#000000';
export const VIEWPORT_BACKGROUND_COLOR_STORAGE_KEY = 'dong-editor-3-viewport-background-color';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// #WDD-gpt 2026-09-02 - 视口背景统一保存为六位十六进制颜色，拒绝损坏的工作区或浏览器偏好值。
export function isViewportBackgroundColor(value: string | null | undefined): value is string {
  return Boolean(value && HEX_COLOR_PATTERN.test(value));
}

export function normalizeViewportBackgroundColor(value: string | null | undefined): string {
  return isViewportBackgroundColor(value) ? value.toLowerCase() : DEFAULT_VIEWPORT_BACKGROUND_COLOR;
}

export function viewportBackgroundColorRgb(value: string | null | undefined): readonly [number, number, number] {
  const normalized = normalizeViewportBackgroundColor(value);
  return [
    Number.parseInt(normalized.slice(1, 3), 16) / 255,
    Number.parseInt(normalized.slice(3, 5), 16) / 255,
    Number.parseInt(normalized.slice(5, 7), 16) / 255,
  ];
}
