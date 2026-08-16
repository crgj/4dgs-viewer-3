import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

export interface UiSelectOption<T extends string | number> {
  readonly label: string;
  readonly value: T;
}

interface UiSelectProps<T extends string | number> {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: T) => void;
  readonly options: readonly UiSelectOption<T>[];
  readonly placement?: 'above' | 'below';
  readonly value: T;
}

interface UiSelectPopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

interface UiSelectAnchorRect {
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

// #WDD-gpt 2026-08-16 - 弹层使用视口坐标并限制在页面内，脱离时间轴和面板各自的层叠上下文。
export function calculateUiSelectPopoverPosition(
  anchor: UiSelectAnchorRect,
  optionCount: number,
  placement: 'above' | 'below',
  viewportWidth: number,
  viewportHeight: number,
): UiSelectPopoverPosition {
  const gap = 6;
  const edge = 8;
  const width = Math.max(86, anchor.width);
  const height = Math.max(35, optionCount * 25 + 10);
  const preferredTop = placement === 'above' ? anchor.top - height - gap : anchor.bottom + gap;
  return {
    left: Math.max(edge, Math.min(anchor.right - width, viewportWidth - width - edge)),
    top: Math.max(edge, Math.min(preferredTop, viewportHeight - height - edge)),
    width,
  };
}

// #WDD-gpt 2026-08-16 - 自绘统一下拉，避免原生 select 的 FPS 弹层脱离编辑器 CSS。
export function UiSelect<T extends string | number>({
  ariaLabel,
  className,
  disabled = false,
  onChange,
  options,
  placement = 'below',
  value,
}: UiSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<UiSelectPopoverPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopoverPosition(calculateUiSelectPopoverPosition(
        rect,
        options.length,
        placement,
        window.innerWidth,
        window.innerHeight,
      ));
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length, placement]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const selectIndex = (index: number) => {
    const option = options[(index + options.length) % options.length];
    if (!option) return;
    onChange(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectIndex(selectedIndex + (event.key === 'ArrowDown' ? 1 : -1));
      setOpen(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((current) => !current);
    }
  };

  return (
    <div className={`ui-select${className ? ` ${className}` : ''}`} data-camera-input-block ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="ui-select-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleKeyDown}
        type="button"
      >
        <span>{options[selectedIndex]?.label ?? String(value)}</span>
        <i aria-hidden="true" />
      </button>
      {open && popoverPosition && typeof document !== 'undefined' && createPortal(
        <div
          aria-label={ariaLabel}
          className={`ui-select-popover ${placement}`}
          data-camera-input-block
          ref={popoverRef}
          role="listbox"
          style={popoverPosition as CSSProperties}
        >
          {options.map((option) => (
            <button
              aria-selected={option.value === value}
              className="ui-select-option"
              key={String(option.value)}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              role="option"
              type="button"
            >{option.label}</button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
