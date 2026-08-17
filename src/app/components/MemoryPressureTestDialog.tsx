import { useEffect, useMemo, useRef, useState } from 'react';
import { formatBytes } from '../../core/format/formatBytes';
import {
  BrowserMemoryPressureTestClient,
  MEMORY_PRESSURE_TARGET_GIB,
  type BrowserMemoryPressureProgress,
  type BrowserMemoryPressureResult,
} from '../../features/gaussian/memory/BrowserMemoryPressureTest';
import type { UiCopy } from '../i18n';

const GIB = 1024 ** 3;

interface MemoryPressureTestDialogProps {
  readonly availableBudgetBytes: number;
  readonly browserDeviceMemoryBytes: number | null;
  readonly copy: UiCopy;
  readonly currentResidentBytes: number;
  readonly onClose: () => void;
  readonly onComplete: (result: BrowserMemoryPressureResult) => void;
}

// #WDD-gpt 2026-08-16 - 高风险压力测试必须由用户在顶层对话框中明确选择上限并启动，绝不随页面加载自动执行。
export function MemoryPressureTestDialog({
  availableBudgetBytes,
  browserDeviceMemoryBytes,
  copy,
  currentResidentBytes,
  onClose,
  onComplete,
}: MemoryPressureTestDialogProps) {
  const clientRef = useRef<BrowserMemoryPressureTestClient | null>(null);
  const mountedRef = useRef(true);
  const options = useMemo(() => {
    const budgetGiB = availableBudgetBytes / GIB;
    const bounded = MEMORY_PRESSURE_TARGET_GIB.filter((value) => value <= budgetGiB + 1e-6);
    return bounded.length > 0 ? bounded : [Math.max(0.0625, budgetGiB)];
  }, [availableBudgetBytes]);
  const [targetGiB, setTargetGiB] = useState(() => options.includes(0.5) ? 0.5 : options[options.length - 1]);
  const targetBytes = Math.min(availableBudgetBytes, targetGiB * GIB);
  const [phase, setPhase] = useState<'confirm' | 'running' | 'complete'>('confirm');
  const [progress, setProgress] = useState<BrowserMemoryPressureProgress>({
    confirmedBytes: 0,
    targetBytes,
    elapsedMs: 0,
  });
  const [result, setResult] = useState<BrowserMemoryPressureResult | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!options.includes(targetGiB)) setTargetGiB(options[options.length - 1]);
  }, [options, targetGiB]);

  useEffect(() => {
    // #WDD-gpt 2026-08-16 - React StrictMode 会模拟一次卸载再挂载，第二次 setup 必须恢复存活标记才能接收 Worker 结果。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clientRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (phase === 'running') {
        setCancelling(true);
        clientRef.current?.cancel();
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose, phase]);

  const start = async () => {
    if (targetBytes < 64 * 1024 ** 2) return;
    const client = new BrowserMemoryPressureTestClient();
    clientRef.current = client;
    setCancelling(false);
    setResult(null);
    setProgress({ confirmedBytes: 0, targetBytes, elapsedMs: 0 });
    setPhase('running');
    let completed: BrowserMemoryPressureResult;
    try {
      completed = await client.start(targetBytes, (next) => {
        if (mountedRef.current) setProgress(next);
      });
    } catch (error) {
      completed = {
        status: 'worker-error', confirmedBytes: 0, targetBytes, elapsedMs: 0, completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!mountedRef.current) return;
    clientRef.current = null;
    setProgress(completed);
    setResult(completed);
    setPhase('complete');
    setCancelling(false);
    onComplete(completed);
  };

  const ratio = progress.targetBytes > 0 ? Math.min(1, progress.confirmedBytes / progress.targetBytes) : 0;
  const resultTitle = result?.status === 'success'
    ? copy.memoryPressureSuccess
    : result?.status === 'cancelled'
      ? copy.memoryPressureCancelled
      : copy.memoryPressureStopped;

  return (
    <div
      className="memory-pressure-backdrop"
      data-camera-input-block
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && phase !== 'running') onClose();
      }}
    >
      <section aria-label={copy.memoryPressureTitle} aria-modal="true" className="memory-pressure-dialog" role="dialog">
        <header>
          <div><span>MEMORY PRESSURE</span><strong>{copy.memoryPressureTitle}</strong></div>
          {phase !== 'running' && <button aria-label={copy.close} onClick={onClose} type="button">×</button>}
        </header>

        {phase === 'confirm' && (
          <>
            <p className="memory-pressure-intro">{copy.memoryPressureDescription}</p>
            <dl className="memory-pressure-context">
              <div><dt>{copy.current4DResident}</dt><dd>{formatBytes(currentResidentBytes)}</dd></div>
              <div><dt>{copy.currentBudgetRemaining}</dt><dd>{formatBytes(availableBudgetBytes)}</dd></div>
              <div><dt>{copy.deviceMemoryReported}</dt><dd>{formatBytes(browserDeviceMemoryBytes)}</dd></div>
            </dl>
            <label className="memory-pressure-target">
              <span>{copy.memoryPressureTarget}</span>
              <select className="ui-select" onChange={(event) => setTargetGiB(Number(event.target.value))} value={targetGiB}>
                {options.map((value) => <option key={value} value={value}>{formatBytes(value * GIB)}</option>)}
              </select>
            </label>
            <div className="memory-pressure-warning">
              <strong>{copy.memoryPressureRiskTitle}</strong>
              <p>{copy.memoryPressureRisk}</p>
            </div>
          </>
        )}

        {phase === 'running' && (
          <section className="memory-pressure-running">
            <div className="memory-pressure-gauge"><i style={{ width: `${ratio * 100}%` }} /></div>
            <strong>{Math.round(ratio * 100)}%</strong>
            <p>{copy.memoryPressureConfirmed} {formatBytes(progress.confirmedBytes)} / {formatBytes(progress.targetBytes)}</p>
            <small>{copy.memoryPressureTouchingPages} · {(progress.elapsedMs / 1000).toFixed(1)} s</small>
          </section>
        )}

        {phase === 'complete' && result && (
          <section className={`memory-pressure-result ${result.status}`}>
            <span>{resultTitle}</span>
            <strong>{copy.memoryPressureAtLeast} {formatBytes(result.confirmedBytes)}</strong>
            <p>{result.status === 'success' ? copy.memoryPressureReachedLimit : copy.memoryPressurePartialResult}</p>
            <small>{copy.memoryPressureReleased} · {(result.elapsedMs / 1000).toFixed(1)} s</small>
          </section>
        )}

        <footer>
          <small>{copy.memoryPressureLowerBound}</small>
          {phase === 'confirm' && <button className="memory-pressure-start" onClick={() => void start()} type="button">{copy.memoryPressureStart}</button>}
          {phase === 'running' && <button className="quiet-button" disabled={cancelling} onClick={() => { setCancelling(true); clientRef.current?.cancel(); }} type="button">{cancelling ? copy.memoryPressureCancelling : copy.memoryPressureCancel}</button>}
          {phase === 'complete' && <button className="primary-button" onClick={onClose} type="button">{copy.close}</button>}
        </footer>
      </section>
    </div>
  );
}
