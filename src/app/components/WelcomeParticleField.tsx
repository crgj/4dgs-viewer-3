import { useEffect, useRef } from 'react';

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Particle {
  depth: number;
  driftVx: number;
  driftVy: number;
  phase: number;
  radius: number;
  scatterX: number;
  scatterY: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

interface PointerField {
  active: boolean;
  strength: number;
  x: number;
  y: number;
}

interface TextCycleState {
  readonly cycleIndex: number;
  readonly dissolve: number;
  readonly form: number;
  readonly textIndex: number;
}

const TAU = Math.PI * 2;
const SCATTER_SECONDS = 10;
const GATHER_SECONDS = 2.4;
const HOLD_SECONDS = 2.4;
const DISSOLVE_SECONDS = 2.4;
const TEXT_CYCLE_SECONDS = SCATTER_SECONDS + GATHER_SECONDS + HOLD_SECONDS + DISSOLVE_SECONDS;
const TEXT_PATTERNS = ['4D', 'GS', 'WDD', 'SS', 'MoMo', '4CGS', 'RAW4D', 'PLY4', 'WEBGPU', 'DONG'] as const;
const TEXT_PALETTES = [
  [[108, 239, 204], [67, 174, 193]],
  [[100, 218, 235], [128, 152, 235]],
  [[129, 239, 206], [183, 155, 234]],
  [[100, 224, 191], [79, 163, 222]],
  [[151, 220, 235], [111, 234, 193]],
  [[174, 174, 241], [91, 226, 202]],
] as const;

function smoothStep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function getTextCycleState(elapsedSeconds: number): TextCycleState {
  const cycleIndex = Math.floor(elapsedSeconds / TEXT_CYCLE_SECONDS);
  const localTime = elapsedSeconds - cycleIndex * TEXT_CYCLE_SECONDS;
  const gatherStart = SCATTER_SECONDS;
  const holdStart = gatherStart + GATHER_SECONDS;
  const dissolveStart = holdStart + HOLD_SECONDS;
  let form = 0;
  let dissolve = 0;
  if (localTime >= gatherStart && localTime < holdStart) {
    form = smoothStep((localTime - gatherStart) / GATHER_SECONDS);
  } else if (localTime >= holdStart && localTime < dissolveStart) {
    form = 1;
  } else if (localTime >= dissolveStart) {
    dissolve = smoothStep((localTime - dissolveStart) / DISSOLVE_SECONDS);
    form = 1 - dissolve;
  }
  return { cycleIndex, dissolve, form, textIndex: cycleIndex % TEXT_PATTERNS.length };
}

function createParticle(width: number, height: number): Particle {
  const depth = 0.2 + Math.random() * 0.8;
  const driftVx = (Math.random() - 0.5) * (0.055 + depth * 0.05);
  const driftVy = (Math.random() - 0.5) * (0.04 + depth * 0.04);
  const sizeRoll = Math.random();
  const radius = sizeRoll < 0.07
    ? 2.25 + Math.random() * 1.5
    : sizeRoll < 0.3
      ? 1.15 + Math.random() * 1.05
      : 0.34 + Math.random() * 0.78;
  return {
    depth,
    driftVx,
    driftVy,
    phase: Math.random() * TAU,
    radius,
    scatterX: Math.random() * width,
    scatterY: Math.random() * height,
    vx: driftVx,
    vy: driftVy,
    x: Math.random() * width,
    y: Math.random() * height,
  };
}

export function scatterSpeedLimit(depth: number, radius: number): number {
  return 0.075 + Math.max(0.2, Math.min(1, depth)) * 0.12 + Math.min(3.75, Math.max(0.34, radius)) * 0.02;
}

export function limitScatterVelocity(vx: number, vy: number, depth: number, radius: number): readonly [number, number] {
  const speed = Math.hypot(vx, vy);
  const maximum = scatterSpeedLimit(depth, radius);
  if (speed <= maximum || speed <= 1e-9) return [vx, vy];
  const scale = maximum / speed;
  return [vx * scale, vy * scale];
}

function createTextTargets(count: number, width: number, height: number, label: string, textIndex: number): Point[] {
  const mask = document.createElement('canvas');
  mask.width = 960;
  mask.height = 320;
  const context = mask.getContext('2d');
  if (!context) return Array.from({ length: count }, () => ({ x: width / 2, y: height / 2 }));

  let fontSize = 224;
  context.font = `850 ${fontSize}px Inter, "Arial Black", sans-serif`;
  const measuredWidth = context.measureText(label).width;
  if (measuredWidth > 850) fontSize *= 850 / measuredWidth;
  context.font = `850 ${fontSize}px Inter, "Arial Black", sans-serif`;
  context.strokeStyle = '#fff';
  context.lineJoin = 'round';
  context.lineWidth = 9;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.strokeText(label, mask.width / 2, mask.height / 2 + 8);

  const pixels = context.getImageData(0, 0, mask.width, mask.height).data;
  const candidates: Point[] = [];
  let minX = mask.width;
  let maxX = 0;
  let minY = mask.height;
  let maxY = 0;
  for (let y = 2; y < mask.height; y += 3) {
    for (let x = 2; x < mask.width; x += 3) {
      if (pixels[(y * mask.width + x) * 4 + 3] <= 40) continue;
      candidates.push({ x, y });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  candidates.sort((first, second) => {
    const firstBand = Math.floor(first.y / 10);
    const secondBand = Math.floor(second.y / 10);
    if (firstBand !== secondBand) return firstBand - secondBand;
    return firstBand % 2 === 0 ? first.x - second.x : second.x - first.x;
  });

  const compact = width < 700;
  const glyphWidth = Math.max(1, maxX - minX);
  const glyphHeight = Math.max(1, maxY - minY);
  const requestedWidth = compact ? width * 0.92 : width * 0.78;
  const requestedHeight = height * (compact ? 0.24 : 0.48);
  const scale = Math.min(requestedWidth / glyphWidth, requestedHeight / glyphHeight);
  const desktopX = [0.22, 0.78, 0.28, 0.72, 0.24, 0.76, 0.3, 0.7, 0.5, 0.5];
  const desktopY = [0.28, 0.72, 0.7, 0.3, 0.5, 0.48, 0.3, 0.7, 0.24, 0.76];
  const compactY = [0.18, 0.82, 0.5, 0.2, 0.8];
  const centerX = width * (compact ? 0.5 : (desktopX[textIndex] ?? 0.5));
  const centerY = height * (compact ? (compactY[textIndex % compactY.length] ?? 0.5) : (desktopY[textIndex] ?? 0.5));
  const glyphCenterX = (minX + maxX) / 2;
  const glyphCenterY = (minY + maxY) / 2;
  return Array.from({ length: count }, (_, index) => {
    const candidate = candidates[Math.floor((index / Math.max(1, count - 1)) * Math.max(0, candidates.length - 1))]
      ?? { x: glyphCenterX, y: glyphCenterY };
    const jitter = index % 3 === 0 ? 1.25 : 0.5;
    return {
      x: centerX + (candidate.x - glyphCenterX) * scale + Math.sin(index * 2.31) * jitter,
      y: centerY + (candidate.y - glyphCenterY) * scale + Math.cos(index * 1.77) * jitter,
    };
  });
}

function mixColor(first: readonly number[], second: readonly number[], amount: number): string {
  return `${Math.round(first[0] + (second[0] - first[0]) * amount)}, ${Math.round(first[1] + (second[1] - first[1]) * amount)}, ${Math.round(first[2] + (second[2] - first[2]) * amount)}`;
}

// #WDD-gpt 2026-08-20 - 文字解体阶段完全退出字形吸附并先向全屏目标充分散射，结束后才限制随机态速度；鼠标排斥与连线始终保留。
export function WelcomeParticleField() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { alpha: true });
    if (!canvas || !context) return undefined;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
    const pointer: PointerField = { active: false, strength: 0, x: 0, y: 0 };
    let particles: Particle[] = [];
    let textTargets: Point[][] = [];
    let width = 1;
    let height = 1;
    let animationFrame = 0;
    let previousTime = performance.now();
    let elapsedSeconds = 0;
    let lastCycleIndex = -1;
    let pageVisible = !document.hidden;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const coarsePointer = coarsePointerQuery.matches;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, coarsePointer ? 1.2 : 1.5);
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const targetCount = coarsePointer
        ? Math.max(315, Math.min(420, Math.round((width * height) / 867)))
        : Math.max(450, Math.min(780, Math.round((width * height) / 1_200)));
      particles = Array.from({ length: targetCount }, () => createParticle(width, height));
      textTargets = TEXT_PATTERNS.map((label, textIndex) => createTextTargets(targetCount, width, height, label, textIndex));
    };

    const updatePointer = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      pointer.active = x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height;
      if (!pointer.active) return;
      pointer.x = x;
      pointer.y = y;
      pointer.strength = event.pointerType === 'touch' ? 1.15 : 1;
    };
    const clearPointer = () => { pointer.active = false; };

    const draw = (time: number) => {
      const deltaSeconds = Math.min(0.04, Math.max(0.004, (time - previousTime) / 1_000));
      const delta = deltaSeconds * 60;
      previousTime = time;
      if (!reducedMotionQuery.matches) elapsedSeconds += deltaSeconds;
      context.clearRect(0, 0, width, height);

      const cycle = reducedMotionQuery.matches
        ? { cycleIndex: 0, dissolve: 0, form: 1, textIndex: 0 }
        : getTextCycleState(elapsedSeconds);
      if (cycle.cycleIndex !== lastCycleIndex) {
        lastCycleIndex = cycle.cycleIndex;
        for (const particle of particles) {
          particle.scatterX = Math.random() * width;
          particle.scatterY = Math.random() * height;
        }
      }
      const targets = textTargets[cycle.textIndex] ?? [];
      const palette = TEXT_PALETTES[cycle.textIndex % TEXT_PALETTES.length] ?? TEXT_PALETTES[0];
      const slowRandomState = cycle.dissolve === 0 && cycle.form < 0.08;
      const targetCenter = targets.reduce(
        (sum, target) => ({ x: sum.x + target.x / Math.max(1, targets.length), y: sum.y + target.y / Math.max(1, targets.length) }),
        { x: 0, y: 0 },
      );
      if (!pointer.active) pointer.strength *= 0.955;

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const target = targets[index] ?? targetCenter;
        const waveX = Math.sin(elapsedSeconds * 1.15 + particle.phase) * (0.8 + particle.depth * 1.45);
        const waveY = Math.cos(elapsedSeconds * 0.92 + particle.phase) * (0.7 + particle.depth * 1.2);

        if (reducedMotionQuery.matches) {
          particle.x = target.x;
          particle.y = target.y;
          particle.vx = 0;
          particle.vy = 0;
        } else if (cycle.dissolve > 0) {
          const scatterPull = 0.005 + cycle.dissolve * 0.004;
          particle.vx += (particle.scatterX - particle.x) * scatterPull * delta;
          particle.vy += (particle.scatterY - particle.y) * scatterPull * delta;
          const damping = Math.pow(0.89, delta);
          particle.vx *= damping;
          particle.vy *= damping;
        } else if (cycle.form > 0.015) {
          const attraction = 0.0012 + cycle.form * cycle.form * 0.006;
          particle.vx += (target.x + waveX - particle.x) * attraction * delta;
          particle.vy += (target.y + waveY - particle.y) * attraction * delta;
          const damping = Math.pow(0.88, delta);
          particle.vx *= damping;
          particle.vy *= damping;
        } else {
          particle.vx += (particle.scatterX - particle.x) * 0.00045 * delta;
          particle.vy += (particle.scatterY - particle.y) * 0.00045 * delta;
          particle.vx += (particle.driftVx - particle.vx) * 0.025 * delta;
          particle.vy += (particle.driftVy - particle.vy) * 0.025 * delta;
          particle.vx += Math.sin(elapsedSeconds * 0.8 + particle.phase) * 0.004 * delta;
          particle.vy += Math.cos(elapsedSeconds * 0.65 + particle.phase) * 0.003 * delta;
        }

        if (cycle.dissolve > 0) {
          const dx = particle.x - targetCenter.x;
          const dy = particle.y - targetCenter.y;
          const distance = Math.max(1, Math.hypot(dx, dy));
          const burst = Math.sin(cycle.dissolve * Math.PI) * (0.045 + particle.depth * 0.045) * delta;
          particle.vx += ((dx / distance) - (dy / distance) * 0.5) * burst;
          particle.vy += ((dy / distance) + (dx / distance) * 0.5) * burst;
        }

        if (pointer.strength > 0.02) {
          const dx = particle.x - pointer.x;
          const dy = particle.y - pointer.y;
          const distance = Math.hypot(dx, dy);
          const influenceRadius = coarsePointerQuery.matches ? 125 : 170;
          if (distance > 0 && distance < influenceRadius) {
            const force = (1 - distance / influenceRadius) * pointer.strength;
            particle.vx += (dx / distance) * force * 0.11 * delta;
            particle.vy += (dy / distance) * force * 0.11 * delta;
          }
        }

        if (slowRandomState) {
          [particle.vx, particle.vy] = limitScatterVelocity(
            particle.vx, particle.vy, particle.depth, particle.radius,
          );
        }

        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        if (cycle.form < 0.08) {
          const margin = 16;
          if (particle.x < -margin) particle.x = width + margin;
          else if (particle.x > width + margin) particle.x = -margin;
          if (particle.y < -margin) particle.y = height + margin;
          else if (particle.y > height + margin) particle.y = -margin;
        }
      }

      context.lineWidth = 0.65;
      const linkDistance = 29 + (1 - cycle.form) * 47;
      const linkStep = cycle.form > 0.18 ? 1 : 9;
      for (let index = linkStep; index < particles.length; index += linkStep) {
        const first = particles[index];
        const second = particles[index - linkStep];
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (distance >= linkDistance) continue;
        const alpha = (1 - distance / linkDistance) * (0.04 + cycle.form * 0.1) * Math.min(first.depth, second.depth);
        context.strokeStyle = `rgba(${mixColor(palette[0], palette[1], first.depth)}, ${alpha})`;
        context.beginPath();
        context.moveTo(first.x, first.y);
        context.lineTo(second.x, second.y);
        context.stroke();
      }

      if (pointer.strength > 0.02) {
        const influenceRadius = coarsePointerQuery.matches ? 125 : 170;
        for (let index = 0; index < particles.length; index += 5) {
          const particle = particles[index];
          const distance = Math.hypot(particle.x - pointer.x, particle.y - pointer.y);
          if (distance >= influenceRadius) continue;
          const alpha = (1 - distance / influenceRadius) * 0.2 * pointer.strength * particle.depth;
          context.strokeStyle = `rgba(112, 238, 210, ${alpha})`;
          context.beginPath();
          context.moveTo(pointer.x, pointer.y);
          context.lineTo(particle.x, particle.y);
          context.stroke();
        }
        const pulse = 24 + Math.sin(elapsedSeconds * 3.2) * 3;
        context.strokeStyle = `rgba(117, 239, 211, ${0.18 * pointer.strength})`;
        context.setLineDash([2, 6]);
        context.beginPath();
        context.arc(pointer.x, pointer.y, pulse, 0, TAU);
        context.stroke();
        context.setLineDash([]);
      }

      for (let index = 0; index < particles.length; index += 1) {
        const particle = particles[index];
        const shimmer = 0.78 + Math.sin(elapsedSeconds * 2.15 + particle.phase) * 0.22;
        const radius = particle.radius * (0.8 + cycle.form * 0.48) * shimmer;
        const color = mixColor(palette[0], palette[1], (particle.depth + (index % 5) * 0.08) % 1);
        context.fillStyle = `rgba(${color}, ${(0.3 + particle.depth * 0.46) * shimmer})`;
        context.beginPath();
        context.arc(particle.x, particle.y, radius, 0, TAU);
        context.fill();
        if (particle.radius >= 1.8 || index % 17 === 0) {
          context.fillStyle = `rgba(${color}, ${0.05 * shimmer})`;
          context.beginPath();
          context.arc(particle.x, particle.y, radius * 4.8, 0, TAU);
          context.fill();
        }
      }

      if (pageVisible && !reducedMotionQuery.matches) animationFrame = window.requestAnimationFrame(draw);
    };

    const restartAnimation = () => {
      window.cancelAnimationFrame(animationFrame);
      previousTime = performance.now();
      animationFrame = window.requestAnimationFrame(draw);
    };
    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      if (pageVisible) restartAnimation();
      else window.cancelAnimationFrame(animationFrame);
    };
    const onMotionPreferenceChange = () => restartAnimation();

    const observer = new ResizeObserver(() => {
      resize();
      if (reducedMotionQuery.matches) restartAnimation();
    });
    observer.observe(canvas);
    resize();
    window.addEventListener('pointerdown', updatePointer, { passive: true });
    window.addEventListener('pointermove', updatePointer, { passive: true });
    window.addEventListener('blur', clearPointer);
    document.addEventListener('visibilitychange', onVisibilityChange);
    reducedMotionQuery.addEventListener('change', onMotionPreferenceChange);
    animationFrame = window.requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener('pointerdown', updatePointer);
      window.removeEventListener('pointermove', updatePointer);
      window.removeEventListener('blur', clearPointer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      reducedMotionQuery.removeEventListener('change', onMotionPreferenceChange);
    };
  }, []);

  return <canvas aria-hidden="true" className="welcome-particle-canvas" ref={canvasRef} />;
}
