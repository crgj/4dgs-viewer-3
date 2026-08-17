import type {
  SmartAlignmentCenterSolution,
  SmartAlignmentUpSolution,
} from './SmartAlignmentSolver';

export interface SmartAlignmentVerificationAssessment {
  readonly centerReliable: boolean;
  readonly orientationReliable: boolean;
  readonly semanticStatus: 'upright' | 'inverted' | 'unknown';
}

export type SmartAlignmentVerificationRollbackReason = 'inverted' | 'excessive-tilt' | null;

// #WDD-gpt 2026-08-15 - 复检将几何方向、头脚语义和脚点分开判定；暂时看不到脸或脚时不再撤销首轮可靠对齐。
export function assessSmartAlignmentVerification(
  up: SmartAlignmentUpSolution | null,
  center: SmartAlignmentCenterSolution | null,
): SmartAlignmentVerificationAssessment {
  const orientationReliable = Boolean(
    up
    && up.viewsUsed >= 6
    && up.directionalDominance >= 0.56
    && up.confidence >= 0.34,
  );
  const centerReliable = Boolean(
    center
    && center.viewsUsed >= 4
    && center.confidence >= 0.28,
  );
  const semanticReliable = Boolean(
    up
    && up.semanticViewsUsed >= 2
    && up.semanticDominance >= 0.65,
  );
  const semanticStatus = !semanticReliable || !up
    ? 'unknown'
    : up.worldUp[1] < 0
      ? 'inverted'
      : 'upright';
  return { centerReliable, orientationReliable, semanticStatus };
}

// #WDD-gpt 2026-08-17 - 复检证据不足只跳过二次校正；仅明确倒立或可靠的大残余倾角才能推翻首轮严格对齐。
export function getSmartAlignmentVerificationRollbackReason(
  assessment: SmartAlignmentVerificationAssessment,
  residualTiltDegrees: number | null,
  maximumReliableTiltDegrees: number,
): SmartAlignmentVerificationRollbackReason {
  if (assessment.semanticStatus === 'inverted') return 'inverted';
  if (
    assessment.orientationReliable
    && residualTiltDegrees !== null
    && residualTiltDegrees > maximumReliableTiltDegrees
  ) {
    return 'excessive-tilt';
  }
  return null;
}
