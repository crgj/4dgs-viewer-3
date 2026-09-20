// #WDD-gpt 2026-09-19 - 复用真实高斯渲染与相册数据，提供无编辑功能的独立空间影像播放器。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CacheSnapshot } from './AlbumDiskCache';
import { AlbumCacheWorkerClient } from './AlbumCacheWorkerClient';
import { loadCacheDirectory, saveCacheDirectory, cacheDirectoryPermission } from './CacheDirectoryPreference';
import { InkLandscape } from './InkLandscape';
import { pacedCacheSegments, playableSeekTarget } from './BufferedPlayback';
import { BufferedShowPlayer, type BufferedPlayerHandle, type PlayerReport } from './BufferedShowPlayer';
import type { ViewportRuntime, ViewportStatus, ViewportCameraView } from '../features/viewport/runtime/ViewportRuntime';
import { loadShowGallery, type ShowVideo } from './ShowGallery';

const FullscreenIcon = () => <svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>;
const views: readonly [ViewportCameraView, string][] = [['front', '正面'], ['left', '左侧'], ['right', '右侧'], ['back', '背面']];
const time = (frame: number, fps: number) => `${Math.floor(frame / fps / 60).toString().padStart(2, '0')}:${Math.floor(frame / fps % 60).toString().padStart(2, '0')}`;

export function ShowDance() {
  const [items, setItems] = useState<readonly ShowVideo[]>([]);
  const [selected, setSelected] = useState<ShowVideo | null>(null);
  const [playerVideo, setPlayerVideo] = useState<ShowVideo | null>(null);
  const player = useRef<BufferedPlayerHandle>(null);
  const [workLog, setWorkLog] = useState('正在准备播放器');
  const [bufferingPart, setBufferingPart] = useState<number | null>(null);
  const [playableParts, setPlayableParts] = useState<number[]>([]);
  const [status, setStatus] = useState<ViewportStatus>({ phase: 'initializing', renderer: '', splatCount: 0 });
  const [runtime, setRuntime] = useState<ViewportRuntime | null>(null);
  const [frame, setFrame] = useState(0);
  const [displayed, setDisplayed] = useState(-1);
  const [partIndex, setPartIndex] = useState(0);
  const [loadedGeneration, setLoadedGeneration] = useState(0);
  // #WDD-gpt 2026-09-20 - 首段加载动画以真实首帧绘制为结束信号，后台缓冲不重复遮挡画面。
  const [firstFrameShown, setFirstFrameShown] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [orbit, setOrbit] = useState(false);
  const [view, setView] = useState<string>('free');
  const [expanded, setExpanded] = useState(false);
  // #WDD-gpt 2026-09-19 - 相册可收起，保留独立入口以随时恢复模型切换。
  // #WDD-gpt 2026-09-20 - 右侧相册默认收起，边缘悬停与键盘按钮均可展开。
  const [albumVisible, setAlbumVisible] = useState(false);
  const [error, setError] = useState('');
  const [galleryLoading, setGalleryLoading] = useState(true);
  // #WDD-gpt 2026-09-20 - 缓存管理与播放器共用同一下载队列，避免自动预取和点击播放重复请求。
  const cache = useRef(new AlbumCacheWorkerClient());
  const detachCache = useRef<(() => void) | null>(null);
  const revision = useRef('');
  const [cacheState, setCacheState] = useState<CacheSnapshot>(cache.current.state);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [firstCacheSetup, setFirstCacheSetup] = useState(false);
  const [pendingDirectory, setPendingDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [cacheNotice, setCacheNotice] = useState('');
  const generation = useRef(0);
  const stage = useRef<HTMLElement>(null);
  const framed = useRef<ViewportRuntime | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const fps = selected?.fps || 30;
  const activePart = selected?.segments[partIndex];
    const timelineEnd = selected ? selected.lastFrame - selected.firstFrame : 0;
  const globalFrame = selected && activePart ? activePart.firstFrame - selected.firstFrame + frame : 0;
  const globalDisplayed = selected && activePart ? activePart.firstFrame - selected.firstFrame + Math.max(0, displayed) : 0;
  const allParts = items.flatMap((video) => video.segments);
  const ready = playerVideo !== null && status.phase === 'ready';

  const handlePlayer = useCallback((value: PlayerReport) => {
    setPartIndex(value.index); setFrame(value.frame); setDisplayed(value.displayed); setStatus(value.status); setRuntime(value.runtime);
  }, []);
  const startPlaying = useCallback(() => { setFirstFrameShown(true); setPlaying(true); }, []);
  const select = useCallback(async (video: ShowVideo) => {
    const token = ++generation.current;
    framed.current = null;
    setFirstFrameShown(false); setWorkLog('正在读取第一段');
    setPlaying(false); setOrbit(false); setPartIndex(0); setFrame(0); setDisplayed(-1); setSelected(video); setPlayerVideo(null); setPlayableParts([]); setBufferingPart(null); setError(''); setView('free');
    setStatus({ phase: 'initializing', renderer: '', splatCount: 0 });
    await cache.current.stop();
    if (token !== generation.current) return;
    // #WDD-gpt 2026-09-20 - 首次只下载首段；后续段等待前一段完成解码和首帧绘制后再进入队列。
    cache.current.resume(pacedCacheSegments(video, []));
    setLoadedGeneration(token); setPlayerVideo(video);
  }, []);

  // #WDD-gpt 2026-09-20 - 播放就绪进度驱动下一个磁盘任务，禁止下载跑到解码缓冲前方并争用资源。
  useEffect(() => {
    if (!selected || cacheState.paused) return;
    cache.current.start(pacedCacheSegments(selected, playableParts));
  }, [selected, playableParts, cacheState.paused]);

  useEffect(() => {
    let active = true;
    const initialCache = new AlbumCacheWorkerClient();
    cache.current = initialCache;
    detachCache.current = initialCache.subscribe(setCacheState);
    loadShowGallery().then(async (manifest) => {
      if (!active) return;
      setItems(manifest.items); setGalleryLoading(false);
      revision.current = manifest.updatedAt;
      // #WDD-gpt 2026-09-20 - 优先恢复普通硬盘目录，权限失效时等待点击授权，避免误向 OPFS 重复下载。
      const preference = await loadCacheDirectory();
      if (!active || cache.current !== initialCache) return;
      // #WDD-gpt 2026-09-20 - 首次访问先完成缓存位置设置，用户选择前不预取大模型。
      if (!preference) {
        await initialCache.stop();
        if (!active || cache.current !== initialCache) return;
        setFirstCacheSetup(true); setExpanded(true);
        return;
      }
      const parent = preference === 'opfs' ? undefined : preference;
      if (parent && await cacheDirectoryPermission(parent) !== 'granted') {
        if (!active || cache.current !== initialCache) return;
        setPendingDirectory(parent);
        setCacheNotice(`默认硬盘目录“${parent.name}”需要重新授权，点击“授权并使用默认硬盘目录”继续。`);
        await initialCache.stop();
        setExpanded(true);
        return;
      }
      await initialCache.initialize(manifest.items.flatMap((video) => video.segments), manifest.updatedAt, parent);
      if (!active || cache.current !== initialCache) return;
      if (manifest.items[0]) void select(manifest.items[0]);
    }).catch((cause) => { if (active) { setError(String(cause)); setGalleryLoading(false); } });
    return () => { active = false; generation.current++; detachCache.current?.(); const closing = cache.current; void closing.stop().catch(() => {}).finally(() => closing.dispose()); };
  }, [select]);

  const clearCache = async () => {
    setCacheBusy(true); setCacheNotice('正在停止下载并清理当前存储位置…');
    generation.current++; setPlaying(false); setOrbit(false); setPlayerVideo(null); setPlayableParts([]); setBufferingPart(null); setSelected(null);  setError('');
    try { await cache.current.clear(); setCacheNotice('已强制清理当前缓存并暂停自动下载。点击“恢复缓存”后重新下载。'); }
    catch (cause) { setCacheNotice(String(cause)); }
    finally { setCacheBusy(false); }
  };
  // #WDD-gpt 2026-09-20 - 目录设置跨刷新保存，切换不删除原缓存；显式选择 OPFS 才取消硬盘目录偏好。
  const activateDirectory = async (parent?: FileSystemDirectoryHandle) => {
    generation.current++; 
    await cache.current.stop(); cache.current.dispose(); detachCache.current?.();
    cache.current = new AlbumCacheWorkerClient(); detachCache.current = cache.current.subscribe(setCacheState);
    await cache.current.initialize(allParts, revision.current, parent);
    setPendingDirectory(null); setFirstCacheSetup(false);
    let notice = parent ? `已将“${parent.name}”设为默认硬盘缓存目录，刷新后优先复用。` : '已设为使用浏览器磁盘缓存（受网站配额限制）。';
    try { await saveCacheDirectory(parent || null); }
    catch (cause) { notice += ` 设置保存失败，本次会话仍可使用；刷新后需重新选择：${String(cause)}`; }
    setError(''); setCacheNotice(notice);
    if (firstCacheSetup) setExpanded(false);
    if (items[0]) void select(selected || items[0]);
  };
  const chooseDirectory = async () => {
    if (typeof window.showDirectoryPicker !== 'function') { setCacheNotice('此浏览器不支持选择硬盘目录，请使用支持文件系统访问的 Chrome / Edge。'); return; }
    setCacheBusy(true);
    try {
      const parent = await window.showDirectoryPicker({ id: 'show-dance-cache', mode: 'readwrite' });
      await activateDirectory(parent);
    } catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setCacheNotice(String(cause)); }
    finally { setCacheBusy(false); }
  };
  const authorizeDirectory = async () => {
    if (!pendingDirectory) return;
    setCacheBusy(true);
    try {
      if (await cacheDirectoryPermission(pendingDirectory, true) !== 'granted') {
        setCacheNotice('未获目录读写授权。请重新授权、选择其他硬盘目录，或切换到浏览器磁盘缓存。');
        return;
      }
      await activateDirectory(pendingDirectory);
    } catch (cause) { setCacheNotice(String(cause)); }
    finally { setCacheBusy(false); }
  };
  const useOpfs = async () => {
    setCacheBusy(true);
    try { await activateDirectory(); }
    catch (cause) { setCacheNotice(String(cause)); }
    finally { setCacheBusy(false); }
  };
  const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
  const videoProgress = (video: ShowVideo) => {
    const parts = video.segments.map((part) => cacheState.entries[part.id]);
    return { count: parts.filter((part) => part?.phase === 'cached').length,
      received: parts.reduce((sum, part) => sum + (part?.received || 0), 0),
      error: parts.find((part) => part?.error)?.error };
  };
  const cachedCount = selected ? videoProgress(selected).count : 0;
  const totalBytes = selected?.fileBytes || 0;
  const loadedBytes = selected ? videoProgress(selected).received : 0;
  const phaseLabel = (video: ShowVideo) => {
    const progress = videoProgress(video);
    if (progress.count === video.segments.length) return '✓ 全部已下载';
    if (progress.error) return '片段缓存失败';
    if (selected?.id !== video.id) return progress.count ? `已下载 ${progress.count}/${video.segments.length} 段` : '选择后缓存';
    return `${cacheState.paused ? '已暂停' : '顺序缓存'} ${progress.count}/${video.segments.length} 段`;
  };
  const progressStops = selected?.segments.flatMap((part, index) => {
    // #WDD-gpt 2026-09-20 - 仅下载/校验/读入中的区间闪烁，已可播放和等待区间保持稳定。
    const phase = cacheState.entries[part.id]?.phase;
    const buffering = index === bufferingPart || phase === 'downloading' || phase === 'checking';
    const color = playableParts.includes(index) ? '#4d9471' : buffering ? 'var(--dance-buffer-color)' : '#e7c35b';
    const start = (part.firstFrame - selected.firstFrame) / (timelineEnd + 1) * 100;
    const stop = ((selected.segments[index + 1]?.firstFrame ?? selected.lastFrame + 1) - selected.firstFrame) / (timelineEnd + 1) * 100;
    return [`${color} ${start}%`, `${color} ${stop}%`];
  }).join(', ') || '#e7c35b 0%, #e7c35b 100%';
  const downloading = selected?.segments.findIndex((part) => cacheState.entries[part.id]?.phase === 'downloading' || cacheState.entries[part.id]?.phase === 'checking');
  const downloadLog = selected && downloading !== undefined && downloading >= 0 ? `下载第 ${downloading + 1}/${selected.segments.length} 段 ${Math.floor((cacheState.entries[selected.segments[downloading].id]?.received || 0) / selected.segments[downloading].fileBytes * 100)}%` : '';
  const cachePanel = <div className="dance-cache-panel">
    <div><strong>当前视频缓存 {cachedCount}/{selected?.segments.length || 0} 段</strong><span>{bytes(loadedBytes)} / {bytes(totalBytes)} · 逐段顺序写盘</span></div>
    <progress aria-label="相册总缓存进度" value={loadedBytes} max={Math.max(1, totalBytes)}/>
    <p>{pendingDirectory ? `默认硬盘目录：${pendingDirectory.name}（等待授权）` : cacheState.location} · {cacheState.persistent ? '持久保存' : '未获持久保存，空间不足时可能被浏览器回收'}</p>
    {cacheState.quota !== undefined && <p>本站已用 {bytes(cacheState.usage || 0)} / 配额 {bytes(cacheState.quota)}（包含本站其他数据）</p>}
    <div className="dance-cache-actions">
      {pendingDirectory && <button disabled={cacheBusy} onClick={() => void authorizeDirectory()}>授权并使用默认硬盘目录</button>}
      <button disabled={cacheBusy || firstCacheSetup || Boolean(pendingDirectory)} onClick={() => { if (selected) cache.current.resume(pacedCacheSegments(selected, playableParts)); else if (items[0]) void select(items[0]); setCacheNotice('已恢复下载与播放缓冲的逐段接力，失败片段将重新尝试。'); }}>恢复缓存 / 重试</button>
      <button disabled={cacheBusy} onClick={() => { setCacheBusy(true); void cache.current.stop().finally(() => setCacheBusy(false)); }}>暂停缓存</button>
      <button disabled={cacheBusy} onClick={() => void chooseDirectory()}>选择硬盘目录并设为默认</button>
      <button disabled={cacheBusy} onClick={() => void useOpfs()}>使用浏览器磁盘缓存</button>
      {!cacheState.persistent && <button disabled={cacheBusy} onClick={() => void cache.current.persist().catch((cause) => setCacheNotice(String(cause)))}>申请持久保存</button>}
      <button className="dance-cache-clear" disabled={cacheBusy} onClick={() => void clearCache()}>强制清理当前缓存</button>
    </div>
    {(cacheNotice || cacheState.error) && <p role="status">{cacheState.error || cacheNotice}</p>}
    <small>首次选择硬盘目录需要授权，之后自动记住；浏览器撤销权限时需再次点击授权。只清理当前存储位置的 show_dance 缓存文件。清理会停止播放和下载；其他位置需切换后分别清理。</small>
  </div>;

  useEffect(() => {
    if (!orbit || !ready || !runtime) return;
    let id = 0; let previous = performance.now();
    const tick = (now: number) => { runtime.orbitCameraBy(Math.min(50, now - previous) * 0.012, 0); previous = now; id = requestAnimationFrame(tick); };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [orbit, ready, runtime]);
  useEffect(() => {
    if (expanded) dialog.current?.showModal();
    else dialog.current?.close();
  }, [expanded]);

  // #WDD-gpt 2026-09-19 - 人物默认占满可用视窗，中央人形按钮恢复相同构图。
  const fitScene = useCallback(() => runtime?.frameSceneToViewport() ?? false, [runtime]);
  useEffect(() => {
    if (ready && runtime && status.sourceName && framed.current !== runtime) {
      // #WDD-gpt 2026-09-20 - 同一视频跨段继承当前相机，只有首次进入视频才自动取景。
      if (!framed.current) { runtime.setCameraView('front'); fitScene(); setView('front'); }
      framed.current = runtime;
    }
  }, [ready, runtime, fitScene, status.sourceName]);
  // #WDD-gpt 2026-09-19 - 全屏和窗口尺寸改变后重新适配构图，普通拖动与缩放不受影响。
  useEffect(() => {
    if (!runtime || !stage.current) return;
    let width = stage.current.clientWidth, height = stage.current.clientHeight;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect;
      if (Math.abs(width - next.width) > 2 || Math.abs(height - next.height) > 2) {
        width = next.width; height = next.height;
        if (framed.current === runtime) fitScene();
      }
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [runtime, fitScene]);
  const changeView = (next: ViewportCameraView) => { setOrbit(false); setView(next); runtime?.setCameraView(next); fitScene(); };
  const fullscreen = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { setError('当前浏览器暂不支持全屏，请使用浏览器全屏功能。'); }
  };
  const cards = (all: boolean) => items.map((item, index) => (
    <button className={`dance-card ${selected?.id === item.id ? 'is-active' : ''}`} key={item.id} aria-pressed={selected?.id === item.id} disabled={cacheBusy || firstCacheSetup || Boolean(pendingDirectory)}
      onClick={() => { if (all) setExpanded(false); void select(item); }}>
      <img src={item.snapshotUrl} alt={item.name} loading="lazy"/><span className="dance-card-number">{String(index + 1).padStart(2, '0')}</span>
      <span className="dance-card-name">{item.name}</span>
      <span className="dance-cache-badge" title={videoProgress(item).error}>{phaseLabel(item)}</span>
      <progress className="dance-cache-progress" aria-label={`${item.name} 缓存进度`} value={videoProgress(item).received} max={Math.max(1, item.fileBytes)}/>
      {all && videoProgress(item).error && <span className="dance-cache-item-error">{videoProgress(item).error}</span>}
    </button>
  ));
  return <main className={`dance-page${albumVisible ? '' : ' dance-album-hidden'}`} onKeyDown={(event) => { if (event.key === 'Escape') setAlbumVisible(false); }}>
    <header className="dance-header"><div className="dance-brand"><span aria-hidden="true">◎</span> 空间影像 <small>4DGS</small>{/* #WDD-gpt 2026-09-20 - 在独立观赏页直接显示根 VERSION 注入的构建版本，便于识别旧页面。 */}<span className="dance-version" title={`当前构建版本 ${__APP_VERSION__}`}>v{__APP_VERSION__}</span></div><div className="dance-header-actions"><button className="dance-album-toggle" aria-expanded={albumVisible} aria-controls="dance-album" onClick={() => setAlbumVisible((visible) => !visible)}>{albumVisible ? '收起相册' : '展开相册'} <span aria-hidden="true">{albumVisible ? '›' : '‹'}</span></button><button className="dance-icon" aria-label="全屏" onClick={() => void fullscreen()}><FullscreenIcon/></button></div></header>
    <section ref={stage} className="dance-stage" aria-label="空间视频播放器">
      <InkLandscape/>
      {playerVideo && <BufferedShowPlayer key={loadedGeneration} ref={player} video={playerVideo} cache={cache.current} cacheState={cacheState} playing={playing} speed={speed} onReport={handlePlayer} onFirstReady={startPlaying} onWork={setWorkLog} onPlayable={setPlayableParts} onBuffering={setBufferingPart}/>}
      <div className="dance-title"><span>THE SPATIAL COLLECTION</span><h1>{selected?.name.split(' · ').at(-1) || '空间里的每一刻'}</h1><p>{selected ? `${selected.tags.filter((tag) => tag !== '空间视频').slice(0, 2).join(' · ') || '分段播放'} · 空间视频` : '自由探索 · 沉浸欣赏'}</p>{selected?.description && <div className="dance-history"><i aria-hidden="true">乐舞</i><p>{selected.description}</p></div>}</div>
      {/* #WDD-gpt 2026-09-20 - 移除重复的自由视角标题，将预设视角与重置按钮合并为单行控件。 */}
      <div className="dance-camera" data-camera-input-block><nav aria-label="预设视角">{views.map(([id, name]) => <button disabled={!ready} aria-pressed={view === id} key={id} onClick={() => changeView(id)}>{name}</button>)}<button className="dance-camera-reset" aria-label="重置视角" title="重置视角" disabled={!ready} onClick={() => { changeView('front'); fitScene(); }}>↻</button></nav></div>
      <div className="dance-work-log" role="status" title={error || workLog}>
        {error || (galleryLoading ? '正在读取相册' : [downloadLog, workLog].filter(Boolean).join(' · '))}
        {selected && (workLog.includes('失败') || Object.values(cacheState.entries).some((entry) => entry.phase === 'error')) && <button onClick={() => { cache.current.resume(pacedCacheSegments(selected, playableParts)); player.current?.retry(); }}>重试</button>}
      </div>
      {selected && !firstFrameShown && !error && status.phase !== 'error' && !workLog.includes('失败') && cacheState.entries[selected.segments[0].id]?.phase !== 'error' && <div className="dance-first-loading" role="status" aria-label="正在读取第一段">
        <span className="dance-loading-ring" aria-hidden="true"/>
        <strong>正在读取第一段</strong><span>空间影像即将呈现</span>
      </div>}
      {!galleryLoading && !items.length && !error && <div className="dance-loading">相册暂无模型</div>}
      <div className="dance-hint">◉ <span>拖动旋转 · 滚轮缩放</span></div>
      <div className="dance-orbit" data-camera-input-block><button role="switch" aria-checked={orbit} disabled={!ready} onClick={() => { setOrbit(!orbit); setView('free'); }}><i/>自动环绕</button><div className="dance-compass" aria-label="环绕视角控制">
        <button className="dance-focus" aria-label="人物充满视窗" title="人物充满视窗" disabled={!ready} onClick={() => { setOrbit(false); fitScene(); }}><svg aria-hidden="true" width="26" height="32" viewBox="0 0 26 32" fill="currentColor"><circle cx="13" cy="5" r="4"/><path d="M9 11h8l5 12-3 1-4-8v7l3 9h-4l-1-7-1 7H8l3-9v-7l-4 8-3-1z"/></svg></button>
        {views.map(([id, name]) => <button key={id} className={`dance-direction dance-direction-${id}`} aria-label={`环绕到${name}`} title={name} aria-pressed={view === id} disabled={!ready} onClick={() => changeView(id)}><i/></button>)}
      </div></div>
    </section>
    <section className="dance-playback" aria-label="播放控制" data-camera-input-block>
      <button className="dance-play" aria-label={playing ? '暂停' : '播放'} disabled={!selected || (!ready && !playing) || timelineEnd === 0} onClick={() => setPlaying(!playing)}>{playing ? 'Ⅱ' : '▶'}</button>
      <input aria-label="播放进度" title="绿色可播放，橙色闪烁正在缓冲，黄色等待或未就绪不可选择" style={{ background: `linear-gradient(to right, ${progressStops})` }} type="range" min={0} max={timelineEnd} value={globalFrame} disabled={!selected || (!ready && !playing) || timelineEnd === 0} onChange={(event) => {
        if (!selected) return;
        const target = playableSeekTarget(selected, Number(event.target.value), playableParts);
        if (!target) { event.currentTarget.value = String(globalFrame); return; }
        player.current?.seek(target.index, target.localFrame);
      }}/>
      <span className="dance-time">{time(globalDisplayed, fps)} <em>/ {time(timelineEnd, fps)}</em></span>
      <select aria-label="播放速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>{[0.5, 1, 1.5, 2].map((value) => <option key={value} value={value}>{value.toFixed(1)}×</option>)}</select>
      <button className="dance-icon" aria-label="全屏播放" onClick={() => void fullscreen()}><FullscreenIcon/></button>
    </section>
    <button className="dance-album-edge" aria-label="从右侧展开相册" aria-controls="dance-album" aria-expanded={albumVisible} onPointerEnter={(event) => { if (event.pointerType === 'mouse') setAlbumVisible(true); }} onClick={() => setAlbumVisible(true)}><span>相册</span></button>
    <aside id="dance-album" className={`dance-album${albumVisible ? ' is-open' : ''}`} aria-label="模型相册" inert={!albumVisible} onPointerLeave={(event) => { if (event.pointerType === 'mouse' && !event.currentTarget.contains(document.activeElement)) setAlbumVisible(false); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setAlbumVisible(false); }}><button className="dance-drawer-close" aria-label="收起右侧相册" onClick={() => setAlbumVisible(false)}>›</button><h2>相册<small>{String(items.length).padStart(2, '0')} 个作品</small></h2><div className="dance-filmstrip">{cards(false)}</div><button className="dance-all" onClick={() => { setPlaying(false); setExpanded(true); }}>查看全部 <span>›</span></button><div className="dance-cache-strip"><span>播放第 {selected ? partIndex + 1 : 0}/{selected?.segments.length || 0} 段 · 播放就绪 {playableParts.length} 段 · 磁盘缓存 {cachedCount} 段 · {bytes(loadedBytes)} / {bytes(totalBytes)}{cacheState.paused ? ' · 已暂停' : ''}</span><progress aria-label="相册缓存进度" value={loadedBytes} max={Math.max(1, totalBytes)}/><button onClick={() => { setPlaying(false); setExpanded(true); }}>缓存管理</button></div></aside>
    <dialog className="dance-dialog" ref={dialog} onCancel={(event) => { if (firstCacheSetup) event.preventDefault(); else setExpanded(false); }} onClose={() => setExpanded(false)}><header><div><small>SPATIAL COLLECTION</small><h2>{firstCacheSetup ? '设置磁盘缓存' : '空间影像相册'}</h2></div>{!firstCacheSetup && <button autoFocus aria-label="关闭相册" onClick={() => setExpanded(false)}>×</button>}</header>{firstCacheSetup ? <div className="dance-cache-panel">
      <strong>首次使用，请选择缓存位置</strong>
      <p>授权一个硬盘文件夹，当前播放视频的片段将依次缓存到该目录。之后进入页面会自动复用，无需重复选择。</p>
      <p>普通硬盘目录不受网站缓存配额限制，请选择剩余空间充足的磁盘。</p>
      <div className="dance-cache-actions">
        <button autoFocus disabled={cacheBusy || typeof window.showDirectoryPicker !== 'function'} onClick={() => void chooseDirectory()}>选择硬盘目录并开始</button>
        <button disabled={cacheBusy} onClick={() => void useOpfs()}>使用浏览器磁盘缓存继续</button>
      </div>
      {typeof window.showDirectoryPicker !== 'function' && <p>当前浏览器不支持选择普通目录，可使用浏览器磁盘缓存，或使用 Chrome / Edge 打开。</p>}
      <small>浏览器磁盘缓存受网站配额限制。可稍后在缓存管理中更换；若目录权限被撤销，需要再次授权。</small>
      {(cacheState.error || cacheNotice) && <p role="status">{cacheState.error || cacheNotice}</p>}
    </div> : <>{cachePanel}<div className="dance-gallery">{cards(true)}</div><p>选择一个作品，开始探索它的空间。</p></>}</dialog>
  </main>;
}
