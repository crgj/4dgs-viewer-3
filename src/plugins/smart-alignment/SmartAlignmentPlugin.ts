import {
  estimateConsensusPeopleCount,
  solveSmartAlignmentCenter,
  solveSmartAlignmentUp,
} from './SmartAlignmentSolver';
import type {
  SmartAlignmentCapture,
  SmartAlignmentHost,
  SmartAlignmentState,
  SmartAlignmentViewAnalysis,
  SmartAlignmentViewId,
} from './SmartAlignmentTypes';
import { assessSmartAlignmentVerification } from './SmartAlignmentVerification';
import { SmartAlignmentWorkerClient } from './SmartAlignmentWorkerClient';

const ORIENTATION_VIEWS: readonly SmartAlignmentViewId[] = [
  'azimuth-0000', 'azimuth-0225', 'azimuth-0450', 'azimuth-0675',
  'azimuth-0900', 'azimuth-1125', 'azimuth-1350', 'azimuth-1575',
  'azimuth-1800', 'azimuth-2025', 'azimuth-2250', 'azimuth-2475',
  'azimuth-2700', 'azimuth-2925', 'azimuth-3150', 'azimuth-3375',
];

const MIN_REFINEMENT_TILT_DEGREES = 3;
const MAX_REFINEMENT_TILT_DEGREES = 60;

function tiltDegrees(worldUp: readonly [number, number, number]): number {
  const length = Math.hypot(...worldUp);
  if (length < 1e-6) return 180;
  const cosine = Math.max(-1, Math.min(1, worldUp[1] / length));
  return Math.acos(cosine) * (180 / Math.PI);
}

export class SmartAlignmentPlugin {
  private readonly worker = new SmartAlignmentWorkerClient();
  private running = false;

  async align(
    host: SmartAlignmentHost,
    onStateChange: (state: SmartAlignmentState) => void,
  ): Promise<void> {
    if (this.running) return;
    this.running = true;
    const original = host.getSmartAlignmentTransform();
    let diagnostics: Pick<SmartAlignmentState, 'peopleCount' | 'viewsUsed' | 'confidence'> = {};
    try {
      onStateChange({ stage: 'loading-model', progress: 0.05 });
      await this.worker.initialize();

      onStateChange({ stage: 'capturing-orientation', progress: 0.12 });
      // #WDD-gpt 2026-08-15 - 首轮以用户点击时的当前相机构图作为第一个识别视图，其余视图再围绕该方向展开。
      const orientationCaptures = await host.captureSmartAlignmentViews(ORIENTATION_VIEWS, {
        useCurrentCameraAsFirstView: true,
      });
      onStateChange({ stage: 'analyzing-orientation', progress: 0.18 });
      const orientationViews = await this.analyze(orientationCaptures, 0.18, 0.43, onStateChange, 'analyzing-orientation');
      const up = solveSmartAlignmentUp(orientationViews);
      diagnostics = up ? {
        peopleCount: up.peopleCount,
        viewsUsed: up.viewsUsed,
        confidence: up.confidence,
      } : {
        // #WDD-gpt 2026-08-15 - 失败诊断也沿用跨视角共识人数，避免 UI 在低置信度分支重新显示残影人数。
        peopleCount: estimateConsensusPeopleCount(orientationViews),
        viewsUsed: orientationViews.filter((view) => view.poses.length > 0).length,
        confidence: 0,
      };
      // #WDD-gpt 2026-08-15 - 十六视角除置信度外还要求主方向覆盖过半，正反票接近时不再强行写入场景。
      const orientationThreshold = up && up.viewsUsed >= 10 ? 0.32 : up && up.viewsUsed >= 8 ? 0.36 : 0.46;
      if (
        !up
        || up.confidence < orientationThreshold
        || up.viewsUsed < 6
        || up.directionalDominance < 0.56
        || up.semanticViewsUsed < 2
        || up.semanticDominance < 0.65
      ) {
        const semanticDetails = up
          ? `（人脸检测 ${up.facesDetected} 个，面部有效视角 ${up.semanticViewsUsed}/16，一致性 ${Math.round(up.semanticDominance * 100)}%）`
          : '';
        throw new Error(`未能从多视角稳定确认人物头端与脚端${semanticDetails}，请切换到面部轮廓清晰的帧后重试。`);
      }

      onStateChange({
        stage: 'analyzing-ground',
        progress: 0.47,
        peopleCount: up.peopleCount,
        viewsUsed: up.viewsUsed,
        confidence: up.confidence,
      });
      // #WDD-gpt 2026-08-15 - 首次朝向和脚点复用同一批十六向图像，避免首轮内部重复检测造成误差放大。
      const center = solveSmartAlignmentCenter(orientationViews);
      diagnostics = center ? {
        peopleCount: Math.max(up.peopleCount, center.peopleCount),
        viewsUsed: Math.max(up.viewsUsed, center.viewsUsed),
        confidence: Math.min(up.confidence, center.confidence),
      } : {
        peopleCount: up.peopleCount,
        viewsUsed: up.viewsUsed,
        confidence: 0,
      };
      const groundThreshold = center && center.viewsUsed >= 4 ? 0.28 : 0.42;
      if (!center || center.confidence < groundThreshold) {
        throw new Error('已识别人体方向，但脚部关键点不足，未写入不可靠的原点变换。');
      }

      onStateChange({
        stage: 'applying',
        progress: 0.53,
        peopleCount: Math.max(up.peopleCount, center.peopleCount),
        viewsUsed: Math.max(up.viewsUsed, center.viewsUsed),
        confidence: Math.min(up.confidence, center.confidence),
      });
      let alignedStandingCenter = host.applySmartAlignmentSolution(up.worldUp, center.standingCenter);
      let finalPeopleCount = Math.max(up.peopleCount, center.peopleCount);
      let finalViewsUsed = Math.max(up.viewsUsed, center.viewsUsed);
      let finalConfidence = Math.min(up.confidence, center.confidence);

      // #WDD-gpt 2026-08-15 - 首次写入后重新渲染十六个环绕视角；复检未通过会抛出并由外层恢复原变换，禁止带着倒立结果报告成功。
      onStateChange({
        stage: 'verifying',
        progress: 0.58,
        peopleCount: finalPeopleCount,
        viewsUsed: finalViewsUsed,
        confidence: finalConfidence,
      });
      const verificationCaptures = await host.captureSmartAlignmentViews(ORIENTATION_VIEWS);
      const verificationViews = await this.analyze(
        verificationCaptures,
        0.62,
        0.86,
        onStateChange,
        'verifying',
      );
      const residualUp = solveSmartAlignmentUp(verificationViews);
      const residualCenter = solveSmartAlignmentCenter(verificationViews);
      const residualTilt = residualUp ? tiltDegrees(residualUp.unsignedWorldUp) : 180;
      const verification = assessSmartAlignmentVerification(residualUp, residualCenter);
      const verifiedPeopleCount = estimateConsensusPeopleCount([
        ...orientationViews,
        ...verificationViews,
      ]);
      if (verifiedPeopleCount > 0) finalPeopleCount = verifiedPeopleCount;
      finalViewsUsed = Math.max(
        finalViewsUsed,
        residualUp?.viewsUsed ?? 0,
        residualCenter?.viewsUsed ?? 0,
      );

      if (!verification.orientationReliable || !residualUp) {
        const details = residualUp
          ? `（方向视角 ${residualUp.viewsUsed}/16，方向置信度 ${Math.round(residualUp.confidence * 100)}%）`
          : '（未解出稳定身体轴）';
        throw new Error(`对齐后复检的几何方向不稳定${details}，已恢复原变换。`);
      }
      if (verification.semanticStatus === 'inverted') {
        throw new Error(`对齐后有 ${residualUp.semanticViewsUsed} 个视角稳定证明头部在下，已恢复原变换以避免倒立。`);
      }
      if (residualTilt > MAX_REFINEMENT_TILT_DEGREES) {
        throw new Error('对齐后检测到方向可能翻转，已恢复原变换，请切换到人物轮廓更清晰的帧后重试。');
      }
      finalConfidence = Math.min(
        finalConfidence,
        residualUp.confidence,
        verification.centerReliable && residualCenter ? residualCenter.confidence : 1,
      );
      if (residualTilt >= MIN_REFINEMENT_TILT_DEGREES) {
        onStateChange({
          stage: 'refining',
          progress: 0.92,
          peopleCount: finalPeopleCount,
          viewsUsed: finalViewsUsed,
          confidence: Math.min(
            residualUp.confidence,
            verification.centerReliable && residualCenter ? residualCenter.confidence : 1,
          ),
        });
        // #WDD-gpt 2026-08-15 - 复检只用上半球无符号身体轴做小角度校正，从结构上禁止二次校正产生 180 度翻转。
        alignedStandingCenter = host.applySmartAlignmentSolution(
          residualUp.unsignedWorldUp,
          verification.centerReliable && residualCenter ? residualCenter.standingCenter : [0, 0, 0],
        );
      }

      // #WDD-gpt  2026-08-16 - 多轮对齐与复检确认成功后才提交一条撤销记录，失败恢复不留下中间姿态。
      host.commitSmartAlignmentTransform?.();
      onStateChange({
        stage: 'success',
        progress: 1,
        peopleCount: finalPeopleCount,
        viewsUsed: finalViewsUsed,
        confidence: finalConfidence,
        standingCenter: alignedStandingCenter,
      });
    } catch (error) {
      host.restoreSmartAlignmentTransform(original);
      onStateChange({
        stage: 'error',
        progress: 0,
        ...diagnostics,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.worker.dispose();
  }

  private async analyze(
    captures: readonly SmartAlignmentCapture[],
    startProgress: number,
    endProgress: number,
    onStateChange: (state: SmartAlignmentState) => void,
    stage: 'analyzing-orientation' | 'analyzing-ground' | 'verifying',
  ): Promise<SmartAlignmentViewAnalysis[]> {
    const remaining = new Set(captures.map(({ bitmap }) => bitmap));
    const results: SmartAlignmentViewAnalysis[] = [];
    try {
      for (let index = 0; index < captures.length; index += 1) {
        const { bitmap, ...metadata } = captures[index];
        remaining.delete(bitmap);
        const { poses, faces } = await this.worker.detect(bitmap);
        results.push({ ...metadata, poses, faces });
        onStateChange({
          stage,
          progress: startProgress + (endProgress - startProgress) * ((index + 1) / captures.length),
          peopleCount: estimateConsensusPeopleCount(results),
          viewsUsed: results.filter((result) => result.poses.length > 0).length,
        });
      }
      return results;
    } finally {
      remaining.forEach((bitmap) => bitmap.close());
    }
  }
}
