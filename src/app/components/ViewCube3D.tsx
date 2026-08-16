import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  ViewportCameraView,
  ViewportRuntime,
} from '../../features/viewport/runtime/ViewportRuntime';
import {
  activeViewCubeFace,
  pickViewCubeFace,
  projectViewCubeFaces,
  type ProjectedViewCubeFace,
} from './ViewCubeGeometry';

interface ViewCubeLabel {
  readonly long: string;
  readonly short: string;
}

interface ViewCube3DProps {
  readonly inspectorOpen: boolean;
  readonly labels: Readonly<Record<ViewportCameraView, ViewCubeLabel>>;
  readonly runtime: ViewportRuntime | null;
  readonly title: string;
}

interface DragState {
  moved: boolean;
  pointerId: number;
  x: number;
  y: number;
}

const FACE_COLORS: Readonly<Record<ViewportCameraView, readonly [number, number, number]>> = {
  back: [45, 62, 72],
  bottom: [43, 66, 58],
  front: [47, 68, 80],
  left: [67, 49, 54],
  right: [76, 52, 57],
  top: [50, 76, 64],
};

function traceFace(context: CanvasRenderingContext2D, face: ProjectedViewCubeFace): void {
  context.beginPath();
  context.moveTo(face.points[0].x, face.points[0].y);
  for (let index = 1; index < face.points.length; index += 1) {
    context.lineTo(face.points[index].x, face.points[index].y);
  }
  context.closePath();
}

function drawViewCube(
  canvas: HTMLCanvasElement,
  faces: readonly ProjectedViewCubeFace[],
  labels: Readonly<Record<ViewportCameraView, ViewCubeLabel>>,
  hoveredFace: ViewportCameraView | null,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(width * ratio));
  const pixelHeight = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.lineJoin = 'round';
  const activeFace = activeViewCubeFace(faces);

  for (const face of faces) {
    const base = FACE_COLORS[face.id];
    const light = 0.72 + face.facing * 0.34;
    const hovered = face.id === hoveredFace;
    const active = face.id === activeFace;
    traceFace(context, face);
    context.save();
    context.shadowColor = hovered ? 'rgba(55, 233, 180, 0.36)' : 'rgba(0, 0, 0, 0.48)';
    context.shadowBlur = hovered ? 11 : 7;
    context.shadowOffsetY = 3;
    context.fillStyle = hovered
      ? 'rgba(34, 139, 108, 0.98)'
      : `rgb(${Math.round(base[0] * light)}, ${Math.round(base[1] * light)}, ${Math.round(base[2] * light)})`;
    context.fill();
    context.restore();
    traceFace(context, face);
    context.lineWidth = active ? 1.65 : hovered ? 1.35 : 0.85;
    context.strokeStyle = active
      ? 'rgba(77, 239, 187, 0.96)'
      : hovered ? 'rgba(151, 255, 220, 0.84)' : 'rgba(155, 177, 184, 0.54)';
    context.stroke();

    const center = face.points.reduce(
      (value, point) => ({ x: value.x + point.x / 4, y: value.y + point.y / 4 }),
      { x: 0, y: 0 },
    );
    if (face.facing > 0.15) {
      context.font = `${active ? 720 : 650} 9px Inter, "PingFang SC", system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = hovered || active ? '#eafff8' : 'rgba(221, 231, 233, 0.82)';
      context.fillText(labels[face.id].short, center.x, center.y + 0.4);
    }
  }
}

// #WDD-gpt 2026-08-16 - 小型导航立方体采用逐帧姿态同步、面拾取和指针拖拽，复现 Blender Gizmo 的核心交互。
export function ViewCube3D({ inspectorOpen, labels, runtime, title }: ViewCube3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const facesRef = useRef<readonly ProjectedViewCubeFace[]>([]);
  const hoveredFaceRef = useRef<ViewportCameraView | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let animationFrame = 0;
    const render = () => {
      const canvas = canvasRef.current;
      if (canvas) {
        const state = runtime?.getCameraState();
        const yaw = state?.yaw ?? 28;
        const pitch = state?.pitch ?? -18;
        const faces = projectViewCubeFaces(canvas.clientWidth, canvas.clientHeight, yaw, pitch);
        facesRef.current = faces;
        drawViewCube(canvas, faces, labels, hoveredFaceRef.current);
      }
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [labels, runtime]);

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { moved: false, pointerId: event.pointerId, ...point };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const deltaX = point.x - drag.x;
      const deltaY = point.y - drag.y;
      if (drag.moved || Math.hypot(deltaX, deltaY) > 2) {
        event.preventDefault();
        drag.moved = true;
        drag.x = point.x;
        drag.y = point.y;
        hoveredFaceRef.current = null;
        setDragging(true);
        runtime?.orbitCameraBy(-deltaX * 0.42, deltaY * 0.36);
      }
      return;
    }
    hoveredFaceRef.current = pickViewCubeFace(facesRef.current, point.x, point.y);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = localPoint(event);
    if (!drag.moved) {
      const face = pickViewCubeFace(facesRef.current, point.x, point.y);
      if (face) runtime?.setCameraView(face);
    }
    dragRef.current = null;
    setDragging(false);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    hoveredFaceRef.current = null;
    setDragging(false);
  };

  return (
    <div
      aria-label={title}
      className={`viewcube-toolbar${inspectorOpen ? ' inspector-open' : ''}`}
      data-camera-input-block
      role="toolbar"
    >
      <canvas
        aria-label={title}
        className={`viewcube-canvas has-tip${dragging ? ' dragging' : ''}`}
        data-tip={title}
        draggable={false}
        onPointerCancel={onPointerCancel}
        onPointerDown={onPointerDown}
        onPointerLeave={() => { if (!dragRef.current) hoveredFaceRef.current = null; }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        ref={canvasRef}
        role="application"
        tabIndex={0}
      />
      <div className="viewcube-accessible-actions">
        {(Object.keys(labels) as ViewportCameraView[]).map((view) => (
          <button
            aria-label={labels[view].long}
            key={view}
            onClick={() => runtime?.setCameraView(view)}
            tabIndex={-1}
            type="button"
          />
        ))}
      </div>
    </div>
  );
}
