export interface EvaluationCameraIntrinsics {
  readonly fx: number;
  readonly fy?: number;
  readonly sourceWidth: number;
  readonly sourceHeight?: number;
}

// #WDD-gpt 2026-08-16 - 用手动宽高比把独立 fx/fy 转成 PlayCanvas 水平 FOV 投影，缺失竖直内参时保留自动宽高比。
export function evaluationCameraManualAspectRatio(
  intrinsics: EvaluationCameraIntrinsics,
): number | null {
  if (!Number.isFinite(intrinsics.fx)
    || !Number.isFinite(intrinsics.fy)
    || !Number.isFinite(intrinsics.sourceWidth)
    || !Number.isFinite(intrinsics.sourceHeight)
    || intrinsics.fx <= 0
    || intrinsics.fy! <= 0
    || intrinsics.sourceWidth <= 0
    || intrinsics.sourceHeight! <= 0) {
    return null;
  }
  return intrinsics.fy! * intrinsics.sourceWidth / (intrinsics.fx * intrinsics.sourceHeight!);
}
