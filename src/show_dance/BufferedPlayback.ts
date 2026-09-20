// #WDD-gpt 2026-09-20 - 未完成内存预读的区间不可跳转；下段未完成预读时回到常驻首段。
import { locateShowFrame, type ShowVideo } from './ShowGallery';
export function playableSeekTarget(video: ShowVideo, frame: number, prepared: readonly number[]) {
  const target = locateShowFrame(video, frame);
  return prepared.includes(target.index) ? target : null;
}
export function nextPreparedPart(current: number, prepared: readonly number[]) {
  return prepared.includes(current + 1) ? current + 1 : 0;
}

// #WDD-gpt 2026-09-20 - 下载与解码按连续片段接力：只允许首个未就绪片段进入磁盘队列，避免网络写盘和 GPU 缓冲争抢资源。
export function pacedCacheSegments(video: ShowVideo, prepared: readonly number[]) {
  let contiguous = 0;
  while (contiguous < video.segments.length && prepared.includes(contiguous)) contiguous += 1;
  return video.segments.slice(contiguous, contiguous + 1);
}
