import { describe, expect, it } from 'vitest';
import { UI_COPY, localizeRendererLabel, localizeRuntimeMessage } from './i18n';

describe('UI localization', () => {
  it('keeps the Chinese and English dictionaries structurally complete', () => {
    expect(Object.keys(UI_COPY.en).sort()).toEqual(Object.keys(UI_COPY.zh).sort());
  });

  it('localizes renderer and RAW4D progress labels', () => {
    expect(localizeRendererLabel('zh', 'WebGPU · GPU Sort')).toBe('WebGPU · GPU 排序');
    expect(localizeRuntimeMessage('en', '正在读取高斯数据 42%')).toBe('Reading Gaussian data 42%');
  });
});
