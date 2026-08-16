export function promisify(fn: (...arguments_: unknown[]) => unknown) {
  return (...arguments_: unknown[]): Promise<unknown> => Promise.resolve(fn(...arguments_));
}
