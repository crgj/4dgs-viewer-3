import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

type TooltipPlacement = 'above' | 'below' | 'right';

interface TooltipDescriptor {
  readonly placement: TooltipPlacement;
  readonly target: HTMLElement;
  readonly text: string;
}

interface TooltipPosition {
  readonly left: number;
  readonly top: number;
}

function placementFor(target: HTMLElement): TooltipPlacement {
  const explicit = target.dataset.tipPlacement;
  if (explicit === 'above' || explicit === 'below' || explicit === 'right') return explicit;
  // #WDD-gpt 2026-08-16 - 渲染模式整组提示固定向下，其余区域延续原有方向习惯。
  if (target.closest('.viewport-toolbar') || target.closest('.topbar') || target.closest('.selection-detail-panel')) return 'below';
  if (target.closest('.timeline-panel')) return 'above';
  return 'right';
}

function findTooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('.has-tip[data-tip]');
  return element?.dataset.tip?.trim() ? element : null;
}

function calculatePosition(
  target: DOMRect,
  tooltip: DOMRect,
  placement: TooltipPlacement,
): TooltipPosition {
  const gap = 8;
  const edge = 8;
  let left: number;
  let top: number;
  if (placement === 'below') {
    left = target.left + (target.width - tooltip.width) * 0.5;
    top = target.bottom + gap;
  } else if (placement === 'above') {
    left = target.left + (target.width - tooltip.width) * 0.5;
    top = target.top - tooltip.height - gap;
  } else {
    left = target.right + gap;
    top = target.top + (target.height - tooltip.height) * 0.5;
    if (left + tooltip.width > window.innerWidth - edge) left = target.left - tooltip.width - gap;
  }
  return {
    left: Math.max(edge, Math.min(left, window.innerWidth - tooltip.width - edge)),
    top: Math.max(edge, Math.min(top, window.innerHeight - tooltip.height - edge)),
  };
}

// #WDD-gpt 2026-08-16 - 所有 data-tip 统一通过 body Portal 绘制，彻底避开面板 overflow 与层叠上下文。
export function GlobalTooltipLayer() {
  const [descriptor, setDescriptor] = useState<TooltipDescriptor | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const show = (target: HTMLElement) => {
      const text = target.dataset.tip?.trim();
      if (!text) return;
      activeTargetRef.current = target;
      setPosition(null);
      setDescriptor({ placement: placementFor(target), target, text });
    };
    const hide = (target: HTMLElement | null) => {
      if (!target || activeTargetRef.current !== target) return;
      activeTargetRef.current = null;
      setDescriptor(null);
      setPosition(null);
    };
    const onPointerOver = (event: PointerEvent) => {
      const target = findTooltipTarget(event.target);
      if (target && !target.contains(event.relatedTarget as Node | null)) show(target);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = findTooltipTarget(event.target);
      if (target && !target.contains(document.activeElement) && !target.contains(event.relatedTarget as Node | null)) hide(target);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = findTooltipTarget(event.target);
      if (target) show(target);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = findTooltipTarget(event.target);
      if (target && !target.contains(event.relatedTarget as Node | null)) hide(target);
    };
    document.addEventListener('pointerover', onPointerOver);
    document.addEventListener('pointerout', onPointerOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerover', onPointerOver);
      document.removeEventListener('pointerout', onPointerOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  useEffect(() => {
    if (!descriptor) return undefined;
    const updateLayout = () => setLayoutRevision((revision) => revision + 1);
    window.addEventListener('resize', updateLayout);
    window.addEventListener('scroll', updateLayout, true);
    return () => {
      window.removeEventListener('resize', updateLayout);
      window.removeEventListener('scroll', updateLayout, true);
    };
  }, [descriptor]);

  useLayoutEffect(() => {
    if (!descriptor || !tooltipRef.current || !descriptor.target.isConnected) return;
    setPosition(calculatePosition(
      descriptor.target.getBoundingClientRect(),
      tooltipRef.current.getBoundingClientRect(),
      descriptor.placement,
    ));
  }, [descriptor, layoutRevision]);

  if (!descriptor || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={`global-tooltip ${position ? 'ready' : ''}`}
      ref={tooltipRef}
      role="tooltip"
      style={(position ?? { left: 0, top: 0 }) as CSSProperties}
    >{descriptor.text}</div>,
    document.body,
  );
}
