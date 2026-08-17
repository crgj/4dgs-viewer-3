import type { SmartAlignmentPose } from './SmartAlignmentTypes';

export type SmartAlignmentImageRotation = 0 | 90 | -90 | 180;

// #WDD-gpt 2026-08-17 - 姿态模型需要先看到屏幕朝上的人体；旋转推理后必须把关键点严格还原到原抓帧坐标，才能继续做多视角三维求解。
export function restoreSmartAlignmentPoseRotation(
  poses: readonly SmartAlignmentPose[],
  rotation: SmartAlignmentImageRotation,
): SmartAlignmentPose[] {
  if (rotation === 0) return poses.map(({ landmarks }) => ({ landmarks: [...landmarks] }));
  return poses.map(({ landmarks }) => ({
    landmarks: landmarks.map((landmark) => {
      if (rotation === 90) {
        return { ...landmark, x: landmark.y, y: 1 - landmark.x };
      }
      if (rotation === -90) {
        return { ...landmark, x: 1 - landmark.y, y: landmark.x };
      }
      return { ...landmark, x: 1 - landmark.x, y: 1 - landmark.y };
    }),
  }));
}
