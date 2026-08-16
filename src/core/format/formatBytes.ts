export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '--';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}
