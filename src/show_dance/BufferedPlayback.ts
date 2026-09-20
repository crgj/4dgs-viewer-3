// #WDD-gpt 2026-09-20 - 未完成内存预读的区间不可跳转；下段未完成预读时回到常驻首段。
import { locateShowFrame, type ShowVideo } from './ShowGallery';
export function playableSeekTarget(video: ShowVideo, frame: number, prepared: readonly number[]) {
  const target = locateShowFrame(video, frame);
  return prepared.includes(target.index) ? target : null;
}
export function nextPreparedPart(current: number, prepared: readonly number[]) {
  return prepared.includes(current + 1) ? current + 1 : 0;
}
