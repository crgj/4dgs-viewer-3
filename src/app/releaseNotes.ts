export interface ReleaseNote {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
}

// #WDD-gpt 2026-08-16 - 更新面板直接解析仓库 CHANGELOG，确保页面内容与版本提交说明始终只有一个数据源。
export function parseReleaseNotes(markdown: string): readonly ReleaseNote[] {
  const headings = [...markdown.matchAll(/^##\s+(\d+\.\d+\.\d+)\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/gm)];
  return headings.map((heading, index) => {
    const sectionStart = (heading.index ?? 0) + heading[0].length;
    const sectionEnd = headings[index + 1]?.index ?? markdown.length;
    const changes = markdown
      .slice(sectionStart, sectionEnd)
      .split(/\r?\n/)
      .map((line) => /^\s*-\s+(.+?)\s*$/.exec(line)?.[1])
      .filter((change): change is string => Boolean(change));
    return {
      version: heading[1],
      date: heading[2],
      changes,
    };
  });
}
