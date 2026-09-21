export type GaussianSourceSelectionKind = 'single' | 'raw4d-sequence' | 'fourcgs-sequence' | 'invalid';

export function gaussianSourceSelectionKind(files: readonly File[]): GaussianSourceSelectionKind {
  if (files.length === 0 || files.some((file) => !/\.(?:4cgs|4gs|raw4d|ply4|sog|ply)$/i.test(file.name))) {
    return 'invalid';
  }
  if (files.length === 1) return 'single';
  if (files.every((file) => /\.(?:raw4d|ply4)$/i.test(file.name))) return 'raw4d-sequence';
  // #WDD-gpt 2026-09-20 - 多个 4CGS 作为连续容器序列导入，禁止与 RAW4D 或静态格式混拖后隐式猜测。
  if (files.every((file) => /\.4cgs$/i.test(file.name))) return 'fourcgs-sequence';
  return 'invalid';
}
