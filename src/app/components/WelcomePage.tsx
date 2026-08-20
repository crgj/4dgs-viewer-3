import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  fourCgsGalleryManifestUrl,
  loadFourCgsGalleryManifest,
  type FourCgsGalleryItem,
} from '../fourCgsGallery';
import type { UiLanguage } from '../i18n';
import { WelcomeParticleField } from './WelcomeParticleField';

interface WelcomePageProps {
  readonly language: UiLanguage;
  readonly onBrowse: () => void;
  readonly onOpenGallery: () => void;
  readonly recoverySources: readonly string[];
}

interface BrowserHardwareReport {
  readonly cpuThreads: number;
  readonly deviceMemoryGiB: number | null;
  readonly maxTextureSize: number | null;
  readonly sharedMemory: boolean;
  readonly webgl2: boolean;
  readonly webgpu: boolean;
}

async function detectBrowserHardware(): Promise<BrowserHardwareReport> {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  const maxTextureSize = gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : null;
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  let webgpu = false;
  try {
    webgpu = Boolean(await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }));
  } catch {
    webgpu = false;
  }
  const deviceMemory = (navigator as Navigator & { readonly deviceMemory?: number }).deviceMemory;
  return {
    cpuThreads: navigator.hardwareConcurrency || 1,
    deviceMemoryGiB: Number.isFinite(deviceMemory) ? deviceMemory ?? null : null,
    maxTextureSize,
    sharedMemory: crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined',
    webgl2: Boolean(gl),
    webgpu,
  };
}

export function wrapGalleryIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

interface WelcomeGalleryDeckProps {
  readonly items: readonly FourCgsGalleryItem[];
  readonly language: UiLanguage;
  readonly onOpen: () => void;
}

interface GalleryDeckMotion {
  readonly dragX: number;
  readonly tiltX: number;
  readonly tiltY: number;
}

const idleDeckMotion: GalleryDeckMotion = { dragX: 0, tiltX: 0, tiltY: 0 };

// #WDD-gpt 2026-08-19 - 欢迎页相册使用浏览器原生 Pointer Events 实现 3D 视差和横向甩卡，不依赖额外交互库。
function WelcomeGalleryDeck({ items, language, onOpen }: WelcomeGalleryDeckProps) {
  const zh = language === 'zh';
  const [index, setIndex] = useState(0);
  const [interacting, setInteracting] = useState(false);
  const [motion, setMotion] = useState<GalleryDeckMotion>(idleDeckMotion);
  const [turnDirection, setTurnDirection] = useState<-1 | 0 | 1>(0);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const turnTimerRef = useRef<number | null>(null);
  const turnDirectionRef = useRef<-1 | 0 | 1>(0);
  const turnRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  const activeIndex = wrapGalleryIndex(index, items.length);
  const featured = items[activeIndex];
  const orbitItem = items[wrapGalleryIndex(activeIndex + (turnDirection === -1 ? -1 : 1), items.length)];

  useEffect(() => {
    return () => { if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current); };
  }, []);

  const turn = (direction: -1 | 1) => {
    if (items.length < 2 || turnDirectionRef.current !== 0) return;
    turnDirectionRef.current = direction;
    setTurnDirection(direction);
    if (turnTimerRef.current !== null) window.clearTimeout(turnTimerRef.current);
    turnTimerRef.current = window.setTimeout(() => {
      setIndex((value) => wrapGalleryIndex(value + direction, items.length));
      turnDirectionRef.current = 0;
      setTurnDirection(0);
      setMotion(idleDeckMotion);
      turnTimerRef.current = null;
    }, 540);
  };
  turnRef.current = turn;
  useEffect(() => {
    if (interacting || items.length < 2) return undefined;
    const timer = window.setTimeout(() => turnRef.current(1), 6_400);
    return () => window.clearTimeout(timer);
  }, [activeIndex, interacting, items.length]);
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || turnDirection !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) drag.moved = true;
      setMotion({
        dragX: Math.max(-120, Math.min(120, deltaX)),
        tiltX: Math.max(-4, Math.min(4, -deltaY / 20)),
        tiltY: Math.max(-9, Math.min(9, deltaX / 14)),
      });
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5;
    const normalizedY = (event.clientY - bounds.top) / Math.max(1, bounds.height) - 0.5;
    setMotion({ dragX: 0, tiltX: normalizedY * -4, tiltY: normalizedX * 6 });
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (Math.abs(deltaX) >= 44) turn(deltaX < 0 ? 1 : -1);
    else setMotion(idleDeckMotion);
  };
  const deckStyle = {
    '--deck-drag-x': `${motion.dragX}px`,
    '--deck-tilt-x': `${motion.tiltX}deg`,
    '--deck-tilt-y': `${motion.tiltY}deg`,
  } as CSSProperties;

  return (
    <div
      className={`welcome-gallery-preview${dragRef.current ? ' dragging' : ''}`}
      onPointerEnter={() => setInteracting(true)}
      onPointerLeave={() => setInteracting(false)}
      style={deckStyle}
    >
      <div className="welcome-gallery-stage-light" />
      {items.length > 1 && orbitItem && (
        <button
          aria-label={`${zh ? '切换到' : 'Switch to'} ${orbitItem.name}`}
          className={`welcome-gallery-orbit-card${turnDirection === 1 ? ' incoming-next' : turnDirection === -1 ? ' incoming-previous' : ''}`}
          onClick={() => turn(turnDirection === -1 ? -1 : 1)}
          type="button"
        >
          <img alt="" draggable={false} src={orbitItem.snapshotUrl} />
          <span>{zh ? '下一场景' : 'NEXT SCENE'}</span>
        </button>
      )}
      <div className="welcome-gallery-active-shell">
        <button
          aria-label={featured ? `${zh ? '相册预览' : 'Gallery preview'}：${featured.name}` : (zh ? '浏览测试相册' : 'Browse test gallery')}
          className={`welcome-gallery-feature${turnDirection === 1 ? ' turn-next' : turnDirection === -1 ? ' turn-previous' : ''}`}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            onOpen();
          }}
          onPointerCancel={finishDrag}
          onPointerDown={onPointerDown}
          onPointerLeave={() => { if (!dragRef.current) setMotion(idleDeckMotion); }}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          type="button"
        >
          {featured ? <img alt={`${featured.name} snapshot`} draggable={false} src={featured.snapshotUrl} /> : <span className="welcome-gallery-placeholder" />}
          <span key={featured?.id ?? 'gallery-placeholder'}>
            <small>{zh ? '测试相册' : 'TEST GALLERY'} {items.length > 0 ? `${activeIndex + 1}/${items.length}` : ''}</small>
            <strong>{featured?.name ?? (zh ? '浏览测试相册' : 'Browse test gallery')}</strong>
            <b><i>↔</i>{zh ? '拖动翻页' : 'Drag to browse'}</b>
          </span>
          <em>{zh ? '点击打开' : 'Click to open'} ↗</em>
        </button>
      </div>
      {featured && <div className="welcome-gallery-reflection" style={{ backgroundImage: `url(${JSON.stringify(featured.snapshotUrl)})` }} />}
      {items.length > 1 && (
        <div className="welcome-gallery-pager" aria-label={zh ? '相册翻页' : 'Gallery pagination'}>
          <button aria-label={zh ? '上一张缩略图' : 'Previous thumbnail'} onClick={() => turn(-1)} type="button">‹</button>
          <span>{items.map((item, itemIndex) => <i className={itemIndex === activeIndex ? 'active' : ''} key={item.id} />)}</span>
          <button aria-label={zh ? '下一张缩略图' : 'Next thumbnail'} onClick={() => turn(1)} type="button">›</button>
        </div>
      )}
    </div>
  );
}

// #WDD-gpt 2026-08-19 - 欢迎页收敛成单一导入动作、相册文字入口和一行设备状态，减少空场景的信息负担。
export function WelcomePage({ language, onBrowse, onOpenGallery, recoverySources }: WelcomePageProps) {
  const zh = language === 'zh';
  const [hardware, setHardware] = useState<BrowserHardwareReport | null>(null);
  const [galleryItems, setGalleryItems] = useState<readonly FourCgsGalleryItem[]>([]);
  useEffect(() => {
    let active = true;
    void detectBrowserHardware().then((report) => { if (active) setHardware(report); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    void loadFourCgsGalleryManifest(fourCgsGalleryManifestUrl())
      .then((manifest) => { if (active) setGalleryItems(manifest.items); })
      .catch(() => { /* 完整相册对话框负责呈现网络错误；欢迎页保持安静。 */ });
    return () => { active = false; };
  }, []);
  const capability = hardware
    ? hardware.webgpu && hardware.sharedMemory
      ? (zh ? '高性能模式可用' : 'High-performance mode ready')
      : hardware.webgl2
        ? (zh ? '兼容模式可用' : 'Compatibility mode ready')
        : (zh ? '当前浏览器不兼容' : 'Browser is not compatible')
    : (zh ? '正在检测设备' : 'Detecting device');

  return (
    <section aria-label={zh ? '欢迎使用 Dong Editor 3' : 'Welcome to Dong Editor 3'} className="welcome-page" data-camera-input-block>
      <div aria-hidden="true" className="welcome-cosmic-light" />
      <WelcomeParticleField />
      <div className="welcome-content">
        <header>
          <span>DONG EDITOR 3</span>
          <h1>{zh ? '打开 Gaussian 场景' : 'Open a Gaussian scene'}</h1>
          <p>{zh ? '本地编辑，不上传文件。' : 'Edited locally. Your files are not uploaded.'}</p>
        </header>
        <button className="welcome-drop-card" onClick={onBrowse} type="button">
          <i aria-hidden="true">＋</i>
          <strong>{recoverySources.length > 0 ? (zh ? '重新选择文件并恢复' : 'Reopen files to recover') : (zh ? '拖入文件，或点击选择' : 'Drop a file, or click to browse')}</strong>
          <small>.4cgs · .4gs · .raw4d · .ply4 · .sog · .ply</small>
        </button>
        <WelcomeGalleryDeck items={galleryItems} language={language} onOpen={onOpenGallery} />
        {recoverySources.length > 0 && (
          <div className="welcome-recovery" title={recoverySources.join(' · ')}>
            <strong>{zh ? '发现可恢复工作区' : 'Recoverable workspace found'}</strong> · {recoverySources.join(' · ')}
          </div>
        )}
        <div className={`welcome-hardware${hardware?.webgl2 ? ' ready' : ''}`} title={zh ? '内存数值是设备提示，不代表网页实际可分配量；请在性能面板运行压力测试。' : 'Memory is a device hint, not an allocation limit. Use the Performance panel pressure test.'}>
          <i />
          <strong>{capability}</strong>
          {hardware && <span>{[
            hardware.webgpu ? 'WebGPU' : 'WebGL2',
            hardware.sharedMemory ? (zh ? '共享内存' : 'Shared memory') : null,
            `${hardware.cpuThreads} ${zh ? '线程' : 'threads'}`,
            hardware.deviceMemoryGiB ? `${hardware.deviceMemoryGiB} GiB` : null,
          ].filter(Boolean).join(' · ')}</span>}
          <small>{zh ? '内存为设备提示，实测请使用压力测试' : 'Memory is a device hint; use the pressure test for a measured limit'}</small>
        </div>
      </div>
    </section>
  );
}

export { detectBrowserHardware };
