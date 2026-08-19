import { Entity, Vec3 } from 'playcanvas';

const CAMERA_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

function blocksCameraInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-camera-input-block]') !== null;
}

interface OrbitCameraOptions {
  distance: number;
  pitch: number;
  target: { x: number; y: number; z: number };
  yaw: number;
}

export interface OrbitCameraState {
  readonly distance: number;
  readonly pitch: number;
  readonly target: readonly [number, number, number];
  readonly yaw: number;
}

interface OrbitCameraTransition {
  readonly durationMs: number;
  readonly from: OrbitCameraState;
  readonly startTime: number;
  readonly to: OrbitCameraState;
  readonly yawDelta: number;
}

export type OrbitCameraPreset = 'back' | 'bottom' | 'front' | 'left' | 'right' | 'top';

export function orbitCameraPresetAngles(preset: OrbitCameraPreset): { pitch: number; yaw: number } {
  switch (preset) {
    case 'back': return { pitch: 0, yaw: 180 };
    case 'bottom': return { pitch: -90, yaw: 0 };
    case 'left': return { pitch: 0, yaw: -90 };
    case 'right': return { pitch: 0, yaw: 90 };
    case 'top': return { pitch: 90, yaw: 0 };
    default: return { pitch: 0, yaw: 0 };
  }
}

export function shortestOrbitYawDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

export function easeOrbitCameraTransition(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped < 0.5
    ? 4 * clamped * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

interface PointerPoint {
  x: number;
  y: number;
}

export class OrbitCameraController {
  private readonly target: Vec3;
  private readonly pointers = new Map<number, PointerPoint>();
  private readonly pressedKeys = new Set<string>();
  private distance: number;
  private pitch: number;
  private yaw: number;
  private lastPinchDistance = 0;
  private activeButton = 0;
  private inputEnabled = true;
  private animationFrame = 0;
  private lastFrameTime = performance.now();
  private transition: OrbitCameraTransition | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Entity,
    options: OrbitCameraOptions,
  ) {
    this.distance = options.distance;
    this.pitch = options.pitch;
    this.yaw = options.yaw;
    this.target = new Vec3(options.target.x, options.target.y, options.target.z);

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.preventContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearInput);
    window.addEventListener('focusin', this.onFocusIn);
    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    this.updateCamera();
    // #WDD-gpt 2026-08-15 - 使用逐帧位移实现 WASD+QE 自由漫游，并让速度与当前观察距离协调。
    this.animationFrame = window.requestAnimationFrame(this.updateKeyboardMovement);
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.preventContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.clearInput);
    window.removeEventListener('focusin', this.onFocusIn);
    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    window.cancelAnimationFrame(this.animationFrame);
    this.pointers.clear();
    this.pressedKeys.clear();
  }

  // #WDD-gpt 2026-08-15 - Gizmo 拖拽期间暂停相机输入，避免一次鼠标操作同时改变对象和镜头。
  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.cancelTransition();
      this.clearInput();
    }
  }

  // #WDD-gpt 2026-08-15 - 智能对齐在点击瞬间读取只读轨道状态，以用户当前构图作为多视角分析起点。
  getState(): OrbitCameraState {
    return {
      distance: this.distance,
      pitch: this.pitch,
      target: [this.target.x, this.target.y, this.target.z],
      yaw: this.yaw,
    };
  }

  // #WDD-gpt 2026-08-18 - 工作区恢复和视角书签通过同一受控入口写回轨道相机，避免直接操作 PlayCanvas 实体造成状态分裂。
  setState(state: OrbitCameraState): void {
    const normalized = this.normalizeState(state);
    this.cancelTransition();
    this.clearInput();
    this.applyState(normalized);
    this.canvas.dataset.cameraView = 'custom';
    this.updateCamera();
  }

  // #WDD-gpt 2026-08-19 - 视角书签使用可打断的缓入缓出轨道插值，并沿 ±180° 最短偏航路径过渡。
  transitionToState(state: OrbitCameraState, durationMs = 600): void {
    const to = this.normalizeState(state);
    const from = this.getState();
    const duration = Math.max(0, Math.min(4_000, durationMs));
    this.cancelTransition();
    this.clearInput();
    if (duration === 0) {
      this.setState(to);
      return;
    }
    this.transition = {
      durationMs: duration,
      from,
      startTime: performance.now(),
      to,
      yawDelta: shortestOrbitYawDelta(from.yaw, to.yaw),
    };
    this.canvas.dataset.cameraTransition = 'running';
    this.canvas.dataset.cameraView = 'custom';
  }

  frameBounds(min: readonly [number, number, number], max: readonly [number, number, number]): void {
    const center = new Vec3(
      (min[0] + max[0]) * 0.5,
      (min[1] + max[1]) * 0.5,
      (min[2] + max[2]) * 0.5,
    );
    const diagonal = new Vec3(max[0] - min[0], max[1] - min[1], max[2] - min[2]).length();
    this.setState({
      distance: this.clampDistance(Math.max(1, diagonal * 1.15)),
      pitch: this.pitch,
      target: [center.x, center.y, center.z],
      yaw: this.yaw,
    });
  }

  // #WDD-gpt 2026-08-16 - ViewCube 只吸附观察方向，保留当前轨道中心和距离，便于在编辑构图间快速往返。
  setPreset(preset: OrbitCameraPreset): void {
    const angles = orbitCameraPresetAngles(preset);
    this.cancelTransition();
    this.clearInput();
    this.pitch = angles.pitch;
    this.yaw = angles.yaw;
    this.updateCamera();
    this.canvas.dataset.cameraView = preset;
  }

  // #WDD-gpt 2026-08-16 - 导航立方体拖拽直接复用轨道相机角度，形成与 Blender 导航 Gizmo 一致的环绕反馈。
  orbitBy(deltaYaw: number, deltaPitch: number): void {
    this.cancelTransition();
    this.clearInput();
    this.yaw += deltaYaw;
    this.pitch = Math.max(-89.8, Math.min(89.8, this.pitch + deltaPitch));
    this.canvas.dataset.cameraView = 'custom';
    this.updateCamera();
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    if (!this.inputEnabled || blocksCameraInput(event.target)) return;
    this.cancelTransition();
    this.canvas.setPointerCapture(event.pointerId);
    this.activeButton = event.button;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 2) {
      this.lastPinchDistance = this.getPinchDistance();
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (!this.inputEnabled) return;
    const previous = this.pointers.get(event.pointerId);
    if (!previous) {
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2) {
      const nextDistance = this.getPinchDistance();
      if (this.lastPinchDistance > 0) {
        this.distance = this.clampDistance(this.distance * (this.lastPinchDistance / Math.max(nextDistance, 1)));
      }
      this.lastPinchDistance = nextDistance;
    } else if (this.activeButton === 2 || this.activeButton === 1) {
      this.pan(dx, dy);
    } else {
      this.yaw -= dx * 0.22;
      this.pitch = Math.max(-82, Math.min(82, this.pitch + dy * 0.18));
      this.canvas.dataset.cameraView = 'custom';
    }

    this.updateCamera();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    this.lastPinchDistance = this.pointers.size === 2 ? this.getPinchDistance() : 0;
  };

  private readonly onWheel = (event: WheelEvent) => {
    if (!this.inputEnabled || blocksCameraInput(event.target)) return;
    event.preventDefault();
    this.cancelTransition();
    this.distance = this.clampDistance(this.distance * Math.exp(event.deltaY * 0.0012));
    this.updateCamera();
  };

  private readonly preventContextMenu = (event: MouseEvent) => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.inputEnabled || blocksCameraInput(event.target)) {
      this.clearInput();
      return;
    }
    if (!CAMERA_KEYS.has(event.code)) return;
    event.preventDefault();
    this.cancelTransition();
    if (!this.pressedKeys.has(event.code)) {
      this.pressedKeys.add(event.code);
      // #WDD-gpt 2026-08-15 - 首次 keydown 立即移动一小步，保证快速点按不会落在两帧之间而被漏掉。
      this.applyKeyboardMovement(1 / 60);
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.pressedKeys.delete(event.code);
  };

  private readonly onFocusIn = (event: FocusEvent) => {
    if (blocksCameraInput(event.target)) this.clearInput();
  };

  private readonly onWindowPointerDown = (event: PointerEvent) => {
    if (blocksCameraInput(event.target)) this.clearInput();
  };

  private readonly clearInput = () => {
    this.pressedKeys.clear();
    this.pointers.clear();
    this.lastPinchDistance = 0;
  };

  private readonly updateKeyboardMovement = (now: number) => {
    const deltaSeconds = Math.min((now - this.lastFrameTime) / 1000, 0.05);
    this.lastFrameTime = now;
    this.updateTransition(now);
    if (this.inputEnabled && this.pressedKeys.size > 0) this.applyKeyboardMovement(deltaSeconds);
    this.animationFrame = window.requestAnimationFrame(this.updateKeyboardMovement);
  };

  private updateTransition(now: number): void {
    const transition = this.transition;
    if (!transition) return;
    const progress = Math.max(0, Math.min(1, (now - transition.startTime) / transition.durationMs));
    const amount = easeOrbitCameraTransition(progress);
    const mix = (from: number, to: number) => from + (to - from) * amount;
    this.distance = mix(transition.from.distance, transition.to.distance);
    this.pitch = mix(transition.from.pitch, transition.to.pitch);
    this.yaw = transition.from.yaw + transition.yawDelta * amount;
    this.target.set(
      mix(transition.from.target[0], transition.to.target[0]),
      mix(transition.from.target[1], transition.to.target[1]),
      mix(transition.from.target[2], transition.to.target[2]),
    );
    if (progress >= 1) {
      this.applyState(transition.to);
      this.transition = null;
      this.canvas.dataset.cameraTransition = 'idle';
    }
    this.updateCamera();
  }

  private applyKeyboardMovement(deltaSeconds: number): void {
    const movement = new Vec3();
    if (this.pressedKeys.has('KeyW')) movement.add(this.camera.forward);
    if (this.pressedKeys.has('KeyS')) movement.sub(this.camera.forward);
    if (this.pressedKeys.has('KeyD')) movement.add(this.camera.right);
    if (this.pressedKeys.has('KeyA')) movement.sub(this.camera.right);
    if (this.pressedKeys.has('KeyE')) movement.y += 1;
    if (this.pressedKeys.has('KeyQ')) movement.y -= 1;
    if (movement.lengthSq() === 0) return;
    const speed = Math.max(0.45, this.distance * 0.55);
    movement.normalize().mulScalar(speed * deltaSeconds);
    this.target.add(movement);
    this.updateCamera();
  }

  private pan(dx: number, dy: number): void {
    const scale = this.distance * 0.0016;
    const world = this.camera.getWorldTransform();
    const right = world.getX(new Vec3()).mulScalar(-dx * scale);
    const up = world.getY(new Vec3()).mulScalar(dy * scale);
    this.target.add(right).add(up);
  }

  private updateCamera(): void {
    const yaw = this.yaw * Math.PI / 180;
    const pitch = this.pitch * Math.PI / 180;
    const horizontal = Math.cos(pitch) * this.distance;
    this.camera.setPosition(
      this.target.x + Math.sin(yaw) * horizontal,
      this.target.y + Math.sin(pitch) * this.distance,
      this.target.z + Math.cos(yaw) * horizontal,
    );
    // #WDD-gpt 2026-08-16 - 正上方视角改用 -Z 作为屏幕上方，避免默认 Y-up 与视线平行时退化翻转。
    const up = Math.abs(Math.cos(pitch)) < 1e-5 ? new Vec3(0, 0, -1) : Vec3.UP;
    this.camera.lookAt(this.target, up);
    // #WDD-gpt 2026-08-15 - 将只读相机位置写入 canvas dataset，便于无侵入浏览器回归验证输入隔离。
    const position = this.camera.getPosition();
    this.canvas.dataset.cameraPosition = [position.x, position.y, position.z]
      .map((value) => value.toFixed(5))
      .join(',');
    // #WDD-gpt 2026-08-17 - 同步记录真实 Orbit target，便于确认智能对齐球面机位围绕用户当前旋转中心而不是模型包围盒中心。
    this.canvas.dataset.cameraTarget = [this.target.x, this.target.y, this.target.z]
      .map((value) => value.toFixed(5))
      .join(',');
  }

  private getPinchDistance(): number {
    const [first, second] = [...this.pointers.values()];
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0;
  }

  private clampDistance(value: number): number {
    return Math.max(0.5, Math.min(80, value));
  }

  private normalizeState(state: OrbitCameraState): OrbitCameraState {
    if (!Number.isFinite(state.distance) || !Number.isFinite(state.pitch) || !Number.isFinite(state.yaw)
      || state.target.some((value) => !Number.isFinite(value))) {
      throw new Error('相机状态包含无效数值。');
    }
    return {
      distance: this.clampDistance(state.distance),
      pitch: Math.max(-89.8, Math.min(89.8, state.pitch)),
      target: [...state.target],
      yaw: state.yaw,
    };
  }

  private applyState(state: OrbitCameraState): void {
    this.distance = state.distance;
    this.pitch = state.pitch;
    this.yaw = state.yaw;
    this.target.set(...state.target);
  }

  private cancelTransition(): void {
    if (!this.transition) return;
    this.transition = null;
    this.canvas.dataset.cameraTransition = 'idle';
  }
}
