import { describe, expect, it } from 'vitest';
import { UI_COPY, localizeRendererLabel, localizeRuntimeMessage } from './i18n';

describe('UI localization', () => {
  it('keeps the Chinese and English dictionaries structurally complete', () => {
    expect(Object.keys(UI_COPY.en).sort()).toEqual(Object.keys(UI_COPY.zh).sort());
  });

  it('localizes renderer and RAW4D progress labels', () => {
    expect(localizeRendererLabel('zh', 'WebGPU · GPU Sort')).toBe('WebGPU · GPU 排序');
    expect(localizeRuntimeMessage('en', '正在读取高斯数据 42%')).toBe('Reading Gaussian data 42%');
    expect(localizeRuntimeMessage('en', '11 个子 Worker · 3/7 项完成 · 正在处理 位置、旋转、缩放等 4 项 · 1.2 秒'))
      .toBe('11 subworkers · 3/7 attributes complete · Processing Position, Rotation, Scale and 1 more · 1.2s');
    expect(localizeRuntimeMessage('en', '正在并行提取 4CGS 片段 4/6'))
      .toBe('Extracting 4CGS segments 4/6');
    expect(localizeRuntimeMessage('en', '3 个 Loader Worker · 2/6 段完成 · segment.raw4d · 系统内存已驻留'))
      .toBe('3 Loader Workers · 2/6 segments complete · segment.raw4d · resident in system memory');
  });

  it('provides Chinese labels for render and guide switches', () => {
    expect(UI_COPY.zh.renderAll).toBe('全部');
    expect(UI_COPY.zh.grid).toBe('网格');
    expect(UI_COPY.zh.axes).toBe('坐标轴');
  });
});
