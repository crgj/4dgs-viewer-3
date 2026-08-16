import {
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

export interface NumberInputConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly precision?: number;
  readonly integer?: boolean;
}

export interface NumberInputResult {
  readonly value: number;
  readonly status: 'valid' | 'corrected' | 'invalid';
}

const decimalPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

// #WDD-gpt 2026-08-16 - 数字编辑先保留完整文本，提交时才统一解析、限值和精度修正。
export function validateNumberDraft(
  draft: string,
  fallback: number,
  constraints: NumberInputConstraints,
): NumberInputResult {
  const trimmed = draft.trim();
  if (!decimalPattern.test(trimmed)) return { value: fallback, status: 'invalid' };

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return { value: fallback, status: 'invalid' };

  let value = parsed;
  if (constraints.integer) value = Math.round(value);
  if (constraints.min !== undefined) value = Math.max(constraints.min, value);
  if (constraints.max !== undefined) value = Math.min(constraints.max, value);
  if (constraints.precision !== undefined) {
    const scale = 10 ** constraints.precision;
    value = Math.round(value * scale) / scale;
  }

  return { value, status: Object.is(value, parsed) ? 'valid' : 'corrected' };
}

export function formatNumberValue(value: number, precision = 6): string {
  const scale = 10 ** precision;
  return String(Math.round(value * scale) / scale);
}

interface ValidatedNumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'max' | 'min' | 'onChange' | 'step' | 'type' | 'value'>, NumberInputConstraints {
  readonly value: number;
  readonly onCommit: (value: number) => void;
  readonly step: number;
  readonly scrub?: boolean;
  readonly scrubStep?: number;
}

interface ScrubState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startValue: number;
  moved: boolean;
}

// #WDD-gpt 2026-08-16 - 只有明确的横向手势才进入 Scrub，轻微抖动和纵向选字不再误触数值拖拽。
export function shouldStartNumberScrub(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) >= 6 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5;
}

export function ValidatedNumberInput({
  className,
  integer = false,
  max,
  min,
  onBlur,
  onCommit,
  onFocus,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  precision = 6,
  scrub = false,
  scrubStep,
  step,
  value,
  ...inputProps
}: ValidatedNumberInputProps) {
  const constraints = { integer, max, min, precision } satisfies NumberInputConstraints;
  const [draft, setDraft] = useState(() => formatNumberValue(value, precision));
  const [validationStatus, setValidationStatus] = useState<NumberInputResult['status']>('valid');
  const editing = useRef(false);
  const cancelBlurCommit = useRef(false);
  const scrubState = useRef<ScrubState | null>(null);

  useEffect(() => {
    if (!editing.current && !scrubState.current) setDraft(formatNumberValue(value, precision));
  }, [precision, value]);

  const commitDraft = () => {
    const result = validateNumberDraft(draft, value, constraints);
    setValidationStatus(result.status);
    setDraft(formatNumberValue(result.value, precision));
    if (result.status !== 'invalid' && !Object.is(result.value, value)) onCommit(result.value);
    return result.value;
  };

  const commitStep = (direction: number, event: KeyboardEvent<HTMLInputElement>) => {
    const base = validateNumberDraft(draft, value, constraints).value;
    const multiplier = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
    const next = validateNumberDraft(String(base + direction * step * multiplier), value, constraints);
    setValidationStatus(next.status);
    setDraft(formatNumberValue(next.value, precision));
    if (!Object.is(next.value, value)) onCommit(next.value);
  };

  const finishScrub = (event: PointerEvent<HTMLInputElement>) => {
    const active = scrubState.current;
    if (!active || active.pointerId !== event.pointerId) return;
    scrubState.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <input
      {...inputProps}
      aria-invalid={validationStatus === 'invalid'}
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      className={`validated-number-input${scrub ? ' scrubbable' : ''}${className ? ` ${className}` : ''}`}
      data-validation={validationStatus}
      draggable={false}
      inputMode={integer ? 'numeric' : 'decimal'}
      onBlur={(event) => {
        editing.current = false;
        if (cancelBlurCommit.current) {
          cancelBlurCommit.current = false;
          setDraft(formatNumberValue(value, precision));
          setValidationStatus('valid');
        } else {
          commitDraft();
        }
        onBlur?.(event);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        setValidationStatus('valid');
      }}
      onFocus={(event) => {
        editing.current = true;
        event.currentTarget.select();
        onFocus?.(event);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelBlurCommit.current = true;
          event.currentTarget.blur();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          commitStep(event.key === 'ArrowUp' ? 1 : -1, event);
        }
      }}
      onPointerCancel={(event) => {
        finishScrub(event);
        onPointerCancel?.(event);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!scrub || event.defaultPrevented || event.button !== 0) return;
        // 已经聚焦时优先保证插入光标和文本选择；失焦后仍可直接横向拖动微调。
        if (editing.current || document.activeElement === event.currentTarget) return;
        const startValue = validateNumberDraft(draft, value, constraints).value;
        scrubState.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startValue,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        const active = scrubState.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if ((event.buttons & 1) === 0) {
          scrubState.current = null;
          return;
        }
        const deltaX = event.clientX - active.startX;
        const deltaY = event.clientY - active.startY;
        if (!active.moved && !shouldStartNumberScrub(deltaX, deltaY)) return;
        if (!active.moved) {
          active.moved = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        const multiplier = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
        const next = validateNumberDraft(
          String(active.startValue + deltaX * (scrubStep ?? step) * multiplier),
          value,
          constraints,
        );
        setValidationStatus(next.status);
        setDraft(formatNumberValue(next.value, precision));
        if (!Object.is(next.value, value)) onCommit(next.value);
      }}
      onPointerUp={(event) => {
        finishScrub(event);
        onPointerUp?.(event);
      }}
      onWheel={(event) => {
        event.currentTarget.blur();
        onWheel?.(event);
      }}
      role="spinbutton"
      type="text"
      value={draft}
    />
  );
}
