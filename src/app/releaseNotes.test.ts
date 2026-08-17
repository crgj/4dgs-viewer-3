import { describe, expect, it } from 'vitest';
import { parseReleaseNotes } from './releaseNotes';

describe('release notes parser', () => {
  it('extracts versions, dates, and bullet items in file order', () => {
    expect(parseReleaseNotes(`# 更新日志

## 3.0.16 - 2026-08-16

- 新增更新信息面板。
- 自动读取更新日志。

## 3.0.15 - 2026-08-15

- 上一个版本。
`)).toEqual([
      {
        version: '3.0.16',
        date: '2026-08-16',
        changes: ['新增更新信息面板。', '自动读取更新日志。'],
      },
      {
        version: '3.0.15',
        date: '2026-08-15',
        changes: ['上一个版本。'],
      },
    ]);
  });

  it('ignores unrelated headings and text', () => {
    expect(parseReleaseNotes('# 文档\n\n## 计划\n\n普通文字')).toEqual([]);
  });
});
