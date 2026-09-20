// #WDD-gpt 2026-09-20 - 当前场景持续显示，当前视频全部场景常驻以随时循环；后台预读仅在首帧绘制完成后参与切换。
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { PlaybackClock } from './PlaybackClock';
import type { ViewportPerformanceSnapshot } from '../features/viewport/runtime/ViewportPerformanceMonitor';
import { nextPreparedPart } from './BufferedPlayback';
import { GaussianViewport } from '../features/viewport/components/GaussianViewport';
import { createGaussian4DMemoryPolicy } from '../features/gaussian/memory/Gaussian4DMemoryPolicy';
import type { ViewportRuntime, ViewportStatus, ViewportTransform } from '../features/viewport/runtime/ViewportRuntime';
import type { AlbumDiskCache, CacheSnapshot } from './AlbumDiskCache';
import { segmentPlaybackEnd, type ShowVideo } from './ShowGallery';
const noop = () => {};
const transform: ViewportTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const cylinder = { centerX: 0, centerZ: 0, radius: 1, height: 2, groundPadding: 0.08 };
export interface BufferedPlayerHandle { seek(index: number, frame?: number): void; retry(): void; }
export interface PlayerReport { index: number; frame: number; displayed: number; status: ViewportStatus; runtime: ViewportRuntime | null; }
interface Slot { index: number; file: File; frame: number; report?: PlayerReport; prepared: boolean; resident: boolean; }
interface Props { video: ShowVideo; cache: Pick<AlbumDiskCache, 'get'>; cacheState: CacheSnapshot; playing: boolean; speed: number; onReport(report: PlayerReport): void; onWork(message: string): void; onFirstReady(): void; onPlayable(indices: number[]): void; onBuffering(index: number | null): void; }
// 稳定回调避免每次日志或缓存进度变化都重建 WebGL/WebGPU 场景。
const ViewportSlot = memo(function ViewportSlot({ slot, active, report }: { slot: Slot; active: boolean; report(index: number, value: PlayerReport): void }) {
  const [policy] = useState(() => createGaussian4DMemoryPolicy('auto'));
  const [files] = useState(() => [slot.file]);
  const [runtime, setRuntime] = useState<ViewportRuntime | null>(null);
  const [status, setStatus] = useState<ViewportStatus>({ phase: 'initializing', renderer: '', splatCount: 0 });
  const [displayed, setDisplayed] = useState(-1);
  const callback = useRef(report); callback.current = report;
  const fitted = useRef(false);
  const [performance, setPerformance] = useState<ViewportPerformanceSnapshot | null>(null);
  useEffect(() => {
    if (runtime && status.phase === 'ready' && !fitted.current) {
      runtime.setCameraView('front');
      fitted.current = runtime.frameSceneToViewport();
    }
    callback.current(slot.index, { index: slot.index, frame: slot.frame, displayed, status, runtime });
  }, [slot.index, slot.frame, displayed, status, runtime]);
  // #WDD-gpt 2026-09-20 - 隐藏且已绘制完成的驻留场景不再持续消耗 GPU 绘制带宽。
  useEffect(() => { runtime?.setContinuousRendering(active || !slot.prepared); }, [runtime, active, slot.prepared]);
  return <div className={`dance-buffer-slot${active ? ' is-current' : ''}`} aria-hidden={!active} inert={!active}>
    {/* #WDD-gpt 2026-09-20 - 展示播放器默认启用强制排序，确保显示帧等待对应深度顺序提交。 */}
    <GaussianViewport activeTool="select" backgroundColor="#000000" transparentBackground preloadAllSegments backgroundPreparation preserveDrawingBuffer retainFrameDuringTransitions brushRadius={20} currentFrame={slot.frame} forceSortSync frameReadyRequestId={0}
      memoryPolicy={policy} onMemoryChange={noop} onPerformanceChange={setPerformance} onHistoryChange={noop} onFrameRenderReady={noop} onFrameDisplayed={setDisplayed}
      onCameraBookmarksChange={noop} onRelightingChange={noop} onRuntimeChange={setRuntime} onSelectionChange={noop} onStatusChange={setStatus} onTransformChange={noop}
      renderMode="gaussian" shLevel={3} showAxes={false} showHeightRuler={false} showGaussianEnvelope={false} showGrid={false} showGuides={false}
      sourceFiles={files} selectionCylinder={cylinder} selectionScope="global" transform={transform} uniformScale viewportLabel={active ? '三维模型：拖动旋转，滚轮缩放' : '后台预读片段'}/>
    {active && performance && <output className="dance-render-stats" aria-label="渲染性能" title="渲染循环帧率，非视频内容帧率">渲染 {performance.fps.toFixed(0)} FPS · {performance.frameTimeMs.toFixed(1)} ms</output>}
  </div>;
});
export const BufferedShowPlayer = forwardRef<BufferedPlayerHandle, Props>(function BufferedShowPlayer({ video, cache, cacheState, playing, speed, onReport, onWork, onFirstReady, onPlayable, onBuffering }, ref) {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<{ index: number; frame: number } | null>(null);
  const handoff = useRef<typeof pending>(null);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [reading, setReading] = useState<number | null>(null);
  const alive = useRef(true);
  const first = useRef(false);
  const readStartedAt = useRef(new Map<number, number>());
  const loading = useRef<number | null>(null);
  const failed = useRef(new Set<number>());
  const latest = useRef({ slots, active, cacheState }); latest.current = { slots, active, cacheState };
  const callbacks = useRef({ onReport, onWork, onFirstReady, onPlayable, onBuffering }); callbacks.current = { onReport, onWork, onFirstReady, onPlayable, onBuffering };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const prepare = useCallback(async (index: number, frame = 0) => {
    if (loading.current !== null || latest.current.slots.some((slot) => slot.index === index)) return;
    loading.current = index; setReading(index);
    readStartedAt.current.set(index, performance.now());
    callbacks.current.onWork(`后台读取第 ${index + 1}/${video.segments.length} 段`);
    try {
      const file = await cache.get(video.segments[index]);
      if (!alive.current) return;
      // #WDD-gpt 2026-09-20 - 当前视频全部片段驻留，只在切换视频或清理时释放；逐个解码控制瞬时峰值。
      setSlots((old) => [...old, { index, file, frame, prepared: false, resident: false }]);
    } catch (error) {
      if (!alive.current) return;
      failed.current.add(index); loading.current = null; setReading(null);
      callbacks.current.onWork(`第 ${index + 1} 段读取失败：${String(error)}；继续播放已就绪部分`);
    }
  }, [cache, video]);
  const reportSlot = useCallback((index: number, report: PlayerReport) => {
    if (!alive.current) return;
    const prepared = report.status.phase === 'ready' && report.displayed === report.frame;
    setSlots((old) => old.map((slot) => slot.index === index ? { ...slot, report, prepared, resident: report.status.phase === 'error' ? false : slot.resident || prepared } : slot));
    if (loading.current === index) {
      if (prepared || report.status.phase === 'error') {
        // #WDD-gpt 2026-09-20 - 真实读文件到首帧绘制计时，不用属性解码或 CPU/GPU 准备代替可播放门槛。
        const started = readStartedAt.current.get(index);
        if (prepared && started !== undefined) {
          const elapsedMs = performance.now() - started;
          const segment = video.segments[index];
          const durationMs = (segment.lastFrame - segment.firstFrame) / video.fps * 1000;
          console.info(`Show segment ready ${JSON.stringify({ index, elapsedMs, durationMs, targetMs: durationMs * .9, ratio: elapsedMs / durationMs, meetsTarget: elapsedMs <= durationMs * .9 })}`);
        }
        readStartedAt.current.delete(index);
        loading.current = null; setReading(null);
        if (report.status.phase === 'error') failed.current.add(index);
        callbacks.current.onWork(prepared ? `第 ${index + 1} 段已读取，可播放` : `第 ${index + 1} 段读取失败：${report.status.message}`);
      } else callbacks.current.onWork(`后台读取第 ${index + 1} 段 · ${report.status.message || '准备画面'}`);
    }
  }, [video]);
  // #WDD-gpt 2026-09-20 - 进度条只标记仍驻留且曾完成绘制的片段；逐帧排序不闪烁，释放场景即撤销绿色。
  const playableKey = slots.filter((slot) => slot.resident).map((slot) => slot.index).sort((a, b) => a - b).join(',');
  useEffect(() => { callbacks.current.onPlayable(playableKey ? playableKey.split(',').map(Number) : []); }, [playableKey]);
  // #WDD-gpt 2026-09-20 - 显式报告读取到首帧绘制期间的片段，供进度条局部闪烁。
  useEffect(() => { callbacks.current.onBuffering(reading); }, [reading]);
  const current = slots.find((slot) => slot.index === active);
  useEffect(() => {
    if (!current?.report) return;
    callbacks.current.onReport(current.report);
    if (current.prepared && !first.current) { first.current = true; callbacks.current.onFirstReady(); }
  }, [current]);
  // 切换前将隐藏场景定位到目标帧，收到真实绘制回调后才揭示；旧场景在这段时间继续播放。
  useEffect(() => {
    if (!pending) {
      if (handoff.current) { handoff.current = null; current?.report?.runtime?.setContinuousRendering(true); }
      return;
    }
    const target = slots.find((slot) => slot.index === pending.index);
    if (target?.prepared && target.frame === pending.frame && target.report?.runtime && handoff.current !== pending) {
      handoff.current = pending;
      const nextRuntime = target.report.runtime;
      const previousRuntime = current?.report?.runtime;
      const camera = previousRuntime?.getCameraState();
      previousRuntime?.setContinuousRendering(false);
      if (camera) nextRuntime.setCameraState(camera);
      nextRuntime.redrawCurrentFrame(() => {
        if (!alive.current || pendingRef.current !== pending) return;
        setActive(pending.index); setPending(null);
      });
    }
    else if (target && target.frame !== pending.frame) setSlots((old) => old.map((slot) => slot.index === pending.index ? { ...slot, frame: pending.frame, prepared: false } : slot));
    else if (!target && reading === null) void prepare(pending.index, pending.frame);
  }, [pending, slots, reading, prepare, current]);
  useEffect(() => {
    if (pending || reading !== null || slots.some((slot) => slot.report?.status.phase === 'error')) return;
    if (!slots.length) {
      if (cacheState.entries[video.segments[0].id]?.phase === 'cached') failed.current.delete(0);
      if (!failed.current.has(0)) void prepare(0); return;
    }
    const next = video.segments.findIndex((_part, index) => !slots.some((slot) => slot.index === index));
    if (next >= 0 && cacheState.entries[video.segments[next].id]?.phase === 'cached' && !failed.current.has(next)) void prepare(next);
  }, [active, cacheState, slots, pending, reading, current?.prepared, prepare, video]);
  useImperativeHandle(ref, () => ({ retry() {
    failed.current.clear(); setSlots((old) => old.filter((slot) => slot.report?.status.phase !== 'error'));
  }, seek(index, frame = 0) {
    if (!latest.current.slots.some((slot) => slot.index === index && slot.resident)) return;
    failed.current.delete(index);
    const target = latest.current.slots.find((slot) => slot.index === index);
    if (target?.report?.status.phase === 'error') setSlots((old) => old.filter((slot) => slot.index !== index));
    if (index === latest.current.active) setSlots((old) => old.map((slot) => slot.index === index ? { ...slot, frame, prepared: false } : slot));
    else setPending({ index, frame });
  } }), [cache, video]);
  // #WDD-gpt 2026-09-20 - 播放时钟只随播放/速度改变；下载与后台状态更新不能重置下一帧截止时间。
  const playback = useRef({ current, pending, video, active }); playback.current = { current, pending, video, active };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const clock = new PlaybackClock(1000 / (video.fps * speed));
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const { current, pending, video, active } = playback.current;
      if (!current || !clock.take(now, current.prepared && pending === null)) return;
      // 同一绘制确认仅推进一次，避免 React 提交前重复排入帧请求。
      playback.current = { ...playback.current, current: { ...current, prepared: false } };
      if (current.frame < segmentPlaybackEnd(video, active)) setSlots((old) => old.map((slot) => slot.index === active ? { ...slot, frame: slot.frame + 1, prepared: false } : slot));
      else if (pending) setSlots((old) => old.map((slot) => slot.index === active ? { ...slot, frame: 0, prepared: false } : slot));
      else {
        const next = nextPreparedPart(active, latest.current.slots.filter((slot) => slot.resident).map((slot) => slot.index));
        if (next > 0) setPending({ index: next, frame: 0 });
        else if (active === 0) setSlots((old) => old.map((slot) => slot.index === 0 ? { ...slot, frame: 0, prepared: false } : slot));
        else setPending({ index: 0, frame: 0 });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, video.fps]);
  return <>{slots.map((slot) => <ViewportSlot key={slot.index} slot={slot} active={slot.index === active} report={reportSlot}/>)}</>;
});
