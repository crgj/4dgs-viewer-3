// #WDD-gpt 2026-09-19 - 以本地 SVG 和 CSS 构成动态水墨背景，无网络素材依赖且不拦截模型交互。
import { useEffect, useRef, useState, type CSSProperties } from 'react';

export function InkLandscape() {
  const root = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState('mist');
  const [moving, setMoving] = useState(true);
  // #WDD-gpt 2026-09-19 - 被动监听舞台：轻移带来视差，边缘轻点产生涟漪，拖动及控制面板不触发。
  useEffect(() => {
    const layer = root.current, stage = layer?.parentElement;
    if (!layer || !stage) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, x = 0, y = 0, lastTrail = 0;
    // #WDD-gpt 2026-09-20 - 有界 DOM 粒子仅响应真实指针事件，不开启额外持续渲染循环。
    const spawn = (className: string, left: number, top: number, life: number) => {
      const container = layer.querySelector('.dance-touch-ripples');
      if (!container || container.childElementCount >= 32) return;
      const particle = document.createElement('i');
      particle.className = className;
      particle.style.left = `${left}px`; particle.style.top = `${top}px`;
      container.append(particle);
      const timer = setTimeout(() => { particle.remove(); timers.delete(timer); }, life);
      timers.add(timer);
    };
    let down: { x: number; y: number; id: number } | null = null;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const isStage = (event: PointerEvent) => event.target instanceof Element && !event.target.closest('[data-camera-input-block],button,input,select');
    const move = (event: PointerEvent) => {
      if (!moving || reduced.matches || !isStage(event) || event.pointerType === 'touch') return;
      const bounds = stage.getBoundingClientRect();
      x = (event.clientX - bounds.left) / bounds.width - .5;
      y = (event.clientY - bounds.top) / bounds.height - .5;
      if (performance.now() - lastTrail > 65) {
        spawn('dance-wind-trace', event.clientX - bounds.left, event.clientY - bounds.top, 1400);
        lastTrail = performance.now();
      }
      if (!raf) raf = requestAnimationFrame(() => {
        layer.style.setProperty('--ink-x', `${x * 64}px`);
        layer.style.setProperty('--ink-y', `${y * 36}px`);
        layer.style.setProperty('--light-x', `${50 + x * 100}%`);
        layer.style.setProperty('--light-y', `${50 + y * 100}%`);
        raf = 0;
      });
    };
    const reset = () => { down = null; cancelAnimationFrame(raf); raf = 0; layer.style.setProperty('--ink-x', '0px'); layer.style.setProperty('--ink-y', '0px'); layer.style.setProperty('--light-x', '50%'); layer.style.setProperty('--light-y', '36%'); };
    const press = (event: PointerEvent) => { down = event.isPrimary && event.button === 0 && isStage(event) ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null; };
    const release = (event: PointerEvent) => {
      const start = down; down = null;
      if (!start || start.id !== event.pointerId || !moving || reduced.matches || !isStage(event) || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const bounds = stage.getBoundingClientRect();
      const left = event.clientX - bounds.left, top = event.clientY - bounds.top;
      spawn('dance-click-ring', left, top, 2600);
      spawn('dance-click-bloom', left, top, 1800);
    };
    stage.addEventListener('pointermove', move, { passive: true, capture: true });
    stage.addEventListener('pointerdown', press, { passive: true, capture: true });
    stage.addEventListener('pointerup', release, { passive: true, capture: true });
    stage.addEventListener('pointerleave', reset); stage.addEventListener('pointercancel', reset);
    reduced.addEventListener('change', reset);
    return () => {
      reset(); timers.forEach(clearTimeout); layer.querySelector('.dance-touch-ripples')?.replaceChildren();
      stage.removeEventListener('pointermove', move, true); stage.removeEventListener('pointerdown', press, true); stage.removeEventListener('pointerup', release, true);
      stage.removeEventListener('pointerleave', reset); stage.removeEventListener('pointercancel', reset); reduced.removeEventListener('change', reset);
    };
  }, [moving]);
  return <><div ref={root} className={`dance-landscape ink-${theme}${moving ? '' : ' ink-still'}`} aria-hidden="true">
    <div className="dance-ink-light"/>
    {/* #WDD-gpt 2026-09-20 - 三种意境各有光束、飞絮/金叶/流萤和水面反光，素材全部内置。 */}
    <div className="dance-sun-rays"><i/><i/><i/></div>
    <div className="dance-sky-stars">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ left: `${(i * 47 + 7) % 100}%`, top: `${(i * 17 + 5) % 46}%`, animationDelay: `${-i * .7}s` }}/>)}</div>
    <svg className="dance-ink-mountains" viewBox="0 0 1600 800" preserveAspectRatio="none">
      <defs>
        <linearGradient id="dance-ink-far" x2="0" y2="1"><stop stopColor="var(--ink-tone)" stopOpacity=".22"/><stop offset="1" stopColor="#a3b1a1" stopOpacity="0"/></linearGradient>
        <linearGradient id="dance-ink-near" x2="0" y2="1"><stop stopColor="var(--ink-tone)" stopOpacity=".30"/><stop offset="1" stopColor="#9ca994" stopOpacity=".03"/></linearGradient>
        <linearGradient id="dance-water" x2="0" y2="1"><stop stopColor="#dce3d6" stopOpacity="0"/><stop offset="1" stopColor="#c3d4c6" stopOpacity=".52"/></linearGradient>
        <radialGradient id="dance-moon"><stop stopColor="#fff8d8" stopOpacity=".9"/><stop offset=".75" stopColor="#f6e2b0" stopOpacity=".55"/><stop offset="1" stopColor="#f6e2b0" stopOpacity="0"/></radialGradient>
      </defs>
      <circle className="dance-ink-moon" cx="1285" cy="270" r="44" fill="url(#dance-moon)"/>
      <g fill="none" stroke="var(--ink-tone)" strokeWidth=".7" opacity=".12"><path d="M0 734 Q220 721 440 741 M40 751 Q205 739 390 751 M1160 731 Q1400 712 1600 734 M1250 756 Q1450 742 1600 753"/></g>
      <g className="dance-far-ridge" fill="url(#dance-ink-far)">
        <path d="M-80 605 L20 523 62 537 111 455 148 473 185 378 208 404 231 466 253 451 291 510 336 539 361 578 Q445 633 620 711 L760 820 H-80Z"/>
        <path d="M970 737 Q1080 670 1137 602 L1181 532 1200 545 1229 481 1252 495 1295 391 1320 421 1359 505 1385 481 1412 507 1454 453 1470 473 1518 410 1555 458 1620 436 1680 526 V820 H970Z"/>
      </g>
      <g className="dance-near-ridge" fill="url(#dance-ink-near)">
        <path d="M-60 670 L18 605 44 617 78 569 101 589 126 574 164 628 199 617 242 657 Q301 703 490 770 V840 H-60Z"/>
        <path d="M1190 784 Q1280 743 1320 704 L1364 654 1391 666 1424 603 1457 625 1487 572 1521 591 1563 557 1602 604 1670 579 V820Z"/>
      </g>
      <path d="M0 690 Q370 664 800 720 Q1220 680 1600 670 V800 H0Z" fill="url(#dance-water)"/>
      <g className="dance-distant-birds" fill="none" stroke="#5c7265" strokeWidth="2" strokeLinecap="round" opacity=".35"><path d="M1100 287q9-8 18 0q8-10 17-4"/><path d="M1143 271q7-5 13 1q7-7 14-3"/><path d="M1080 308q6-5 12 0q6-6 12-2"/></g>
    </svg>
    <div className="dance-mist dance-mist-back"/><div className="dance-mist dance-mist-front"/>
    <div className="dance-water-glints">{Array.from({ length: 9 }, (_, i) => <i key={i} style={{ left: `${(i * 31 + 4) % 95}%`, bottom: `${4 + (i * 7) % 23}%`, animationDelay: `${-i * 1.3}s` }}/>)}</div>
    <div className="dance-atmosphere">{Array.from({ length: 22 }, (_, i) => <span key={i} style={{ '--seed-x': `${(i * 37 + 3) % 100}%`, '--seed-y': `${(i * 23 + 12) % 90}%`, '--seed-time': `${14 + i % 7 * 2}s`, '--seed-delay': `${-i * 2.7}s`, '--seed-size': `${3 + i % 4}px` } as CSSProperties}><i/></span>)}</div>
    <svg className="dance-reeds" viewBox="0 0 1600 800" preserveAspectRatio="none"><g fill="none" stroke="var(--ink-tone)" strokeWidth="1.3">{[0, 1, 2, 3, 4, 5].map((i) => <g key={i} className="dance-reed" style={{ animationDelay: `${-i * .6}s` }}><path d={`M${18 + i * 16} 810 Q${50 + i * 14} 730 ${24 + i * 19} ${644 + i % 3 * 25}`} /><path d={`M${32 + i * 16} 769 q-29 -25 -27 -48 M${36 + i * 16} 743 q28 -25 34 -50`} /></g>)}</g></svg>
    <div className="dance-touch-ripples"/>
    <div className="dance-ink-caption"><span>{theme === 'gold' ? '落 日 · 流 金' : theme === 'moon' ? '月 白 · 萤 飞' : '山 静 · 云 生'}</span><i>逸</i></div>
  </div>
  <div className="dance-ambience" data-camera-input-block>
    <span className="dance-ambience-label">意境</span>
    {([['mist', '清岚'], ['gold', '暮金'], ['moon', '月白']] as const).map(([id, label]) => <button key={id} aria-pressed={theme === id} onClick={() => setTheme(id)}>{label}</button>)}
    <button className="dance-motion-toggle" aria-pressed={moving} aria-label={moving ? '暂停背景动态' : '开启背景动态'} onClick={() => setMoving((value) => !value)}>{moving ? 'Ⅱ' : '▷'}</button>
    <span className="dance-ambience-tip">移鼠生风 · 轻点漾波</span>
  </div></>;
}
