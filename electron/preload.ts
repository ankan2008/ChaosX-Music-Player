import { contextBridge, ipcRenderer } from 'electron';
import type { WallpaperInfo } from '../src/vite-env';

/**
 * The mpv command bridge.
 *
 * Main answers every call with `{ok, result, error}` because an Electron
 * `invoke` rejection loses the reason. Unwrapping here means the renderer writes
 * ordinary `await api.mpv.play()` and gets a real error message when a deck is
 * wedged, rather than `[Error invoking remote method ...]`.
 */
const call = (channel: string) => async (...args: unknown[]) => {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as {
    ok: boolean;
    result?: unknown;
    error?: string;
  };
  if (!reply?.ok) throw new Error(reply?.error || `mpv call failed: ${channel}`);
  return reply.result;
};

/** The newest handoff this page load has seen; replayed to a late subscriber. */
let lastHandoff: unknown;

/*
 * Registered at module load, not at subscribe time: the main process sends the
 * handoff on `did-finish-load`, which is before React exists, and an ipcRenderer
 * message with no listener is simply dropped. Without this the buffer below can
 * never see the one payload a cold overlay needs.
 */
ipcRenderer.on('pill:handoff', (_event, state) => {
  lastHandoff = state;
});

// Expose a safe, minimal API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  /** Kill the process and come back clean. See the handler for why not `quit`. */
  restartApp: () => ipcRenderer.invoke('app:restart'),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  /** One-way: this page has composed, so the window may now be put on screen. */
  notifyReady: () => ipcRenderer.send('window:ready'),
  /** Whether the window is really zoomed, pushed whenever the answer changes. */
  onZoomed: (callback: (zoomed: boolean) => void) => {
    const listener = (_event: unknown, zoomed: boolean) => callback(zoomed === true);
    ipcRenderer.on('window:zoomed', listener);
    return () => ipcRenderer.removeListener('window:zoomed', listener);
  },
  setWindowMaterial: (material: string) => ipcRenderer.invoke('window:set-material', material),
  /** Take the whole monitor including the taskbar, or hand it back. */
  setImmersive: (on: boolean) => ipcRenderer.invoke('window:set-immersive', on),
  setViewMode: (mode: 'normal' | 'full' | 'mini' | 'pill', state?: unknown) =>
    ipcRenderer.invoke('window:set-view-mode', mode, state),
  /** Pill mode lives in its own frameless window: open it, and hand back. */
  openPill: (state: unknown) => ipcRenderer.invoke('pill:open', state),
  closePill: (state: unknown) => ipcRenderer.invoke('pill:close', state),
  /** Lets the main process recover playback if the overlay is closed hard. */
  reportPillState: (state: unknown) => ipcRenderer.send('pill:state', state),
  onPillHandoff: (callback: (state: unknown) => void) => {
    /*
     * The cold-start buffer and the live channel can both hand over the same
     * payload — one send arriving before React mounts is replayed at subscribe,
     * and the warm push for an already-loaded renderer arrives again a beat
     * later. Applying it twice means loading the film twice, and the second
     * load's play races the first element's teardown into a paused widget.
     * Same track, same playhead, same flag is the same hand-off: deliver once.
     */
    let lastKey: string | null = null;
    const deliver = (state: unknown) => {
      const s = state as { trackId?: string; position?: number; playing?: boolean; mode?: string } | null;
      const key = `${s?.trackId}|${s?.position}|${s?.playing}|${s?.mode}`;
      if (key === lastKey) return;
      lastKey = key;
      callback(state);
    };
    const listener = (_event: unknown, state: unknown) => {
      lastHandoff = state;
      deliver(state);
    };
    ipcRenderer.on('pill:handoff', listener);
    /*
     * A cold overlay's `did-finish-load` fires before React has subscribed, so the
     * one payload that carries "which track, where in it, and is it a film this
     * window has to take over" was dropped on every first open — the widget then
     * fell back to the session broadcast and showed whatever the deck's index
     * pointed at. Buffering the last payload here and replaying it at subscribe
     * time closes the gap; within one page load the newest handoff is the last
     * one received, so nothing stale can be replayed.
     */
    if (lastHandoff !== undefined) queueMicrotask(() => deliver(lastHandoff));
    return () => ipcRenderer.removeListener('pill:handoff', listener);
  },
  onMainHandoff: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('main:handoff', listener);
    return () => ipcRenderer.removeListener('main:handoff', listener);
  },
  /*
   * The mpv playback engine, owned by the main process and shared by every
   * window. Commands are discrete transport and mixing actions only: anything
   * the UI needs every frame arrives on onMpvState and is interpolated in the
   * renderer, because an IPC message is not a vsync.
   */
  mpv: {
    load: call('mpv:load'),
    preload: call('mpv:preload'),
    play: call('mpv:play'),
    pause: call('mpv:pause'),
    stop: call('mpv:stop'),
    halt: call('mpv:halt'),
    seek: call('mpv:seek'),
    beginScrub: call('mpv:begin-scrub'),
    endScrub: call('mpv:end-scrub'),
    volume: call('mpv:volume'),
    speed: call('mpv:speed'),
    pitch: call('mpv:pitch'),
    eq: call('mpv:eq'),
    trim: call('mpv:trim'),
    guard: call('mpv:guard'),
    snapshot: call('mpv:snapshot'),
    forceAf: call('mpv:force-af'),
    rawProps: call('mpv:raw-props'),
    // The play session is published one-way and mirrored both ways, so it does
    // not go through the invoke/unwrap helper the deck commands use.
    setSession: (session: unknown) => ipcRenderer.send('mpv:set-session', session),
    getSession: () => ipcRenderer.invoke('mpv:get-session'),
    onSession: (callback: (session: any) => void) => {
      const listener = (_e: unknown, session: any) => callback(session);
      ipcRenderer.on('mpv:session', listener);
      return () => ipcRenderer.removeListener('mpv:session', listener);
    },
    onMix: (callback: (mix: any) => void) => {
      const listener = (_e: unknown, mix: any) => callback(mix);
      ipcRenderer.on('mpv:mix', listener);
      return () => ipcRenderer.removeListener('mpv:mix', listener);
    },
  },
  onMpvState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on('mpv:state', listener);
    return () => ipcRenderer.removeListener('mpv:state', listener);
  },
  onMpvEnded: (callback: (info: unknown) => void) => {
    const listener = (_event: unknown, info: unknown) => callback(info);
    ipcRenderer.on('mpv:ended', listener);
    return () => ipcRenderer.removeListener('mpv:ended', listener);
  },

  /*
   * The hole mpv's video shows through. Sent rather than invoked: a layout
   * observer fires this continuously while a panel animates, and an ack per
   * frame would be a second round trip for information nobody waits on.
   */
  video: {
    setSlot: (slot: { x: number; y: number; w: number; h: number; under?: boolean } | null) => ipcRenderer.send('video:slot', slot),
    debug: () => ipcRenderer.invoke('video:debug'),
  },

  /*
   * The film one window is decoding, shared with the others.
   *
   * The library owns the only `<video>` in the app, so a widget asks it to move
   * and mirrors what comes back — the same relation the widgets already have to
   * the mpv deck for music. Sent rather than invoked: the state is a broadcast on
   * a timer and nobody waits on an ack.
   */
  film: {
    command: (cmd: unknown) => ipcRenderer.send('film:command', cmd),
    /**
     * Whether the page's own element is currently making noise.
     *
     * The main process holds the media keys for exactly as long as the app is
     * audible, and a film decoded here is audible while the deck is halted — so
     * without this push the transport keys are handed back the moment a video
     * starts and never come back.
     */
    reportPlaying: (on: boolean) => ipcRenderer.send('app:film-playing', on === true),
    onCommand: (callback: (cmd: unknown) => void) => {
      const listener = (_event: unknown, cmd: unknown) => callback(cmd);
      ipcRenderer.on('film:command', listener);
      return () => ipcRenderer.removeListener('film:command', listener);
    },
    report: (state: unknown) => ipcRenderer.send('film:state', state),
    onState: (callback: (state: unknown) => void) => {
      const listener = (_event: unknown, state: unknown) => callback(state);
      ipcRenderer.on('film:state', listener);
      return () => ipcRenderer.removeListener('film:state', listener);
    },
  },

  /**
   * A press on one of the taskbar thumbnail's transport buttons. The queue lives
   * in the renderer, so the main process only says which button was pressed.
   */
  thumbbar: {
    onCommand: (callback: (action: 'prev' | 'next' | 'toggle' | 'back' | 'forward') => void) => {
      const listener = (_event: unknown, action: 'prev' | 'next' | 'toggle' | 'back' | 'forward') => callback(action);
      ipcRenderer.on('thumb:command', listener);
      return () => ipcRenderer.removeListener('thumb:command', listener);
    },
    /** PNG bytes (base64) for the thumbnail's glyphs, rasterised by the page. */
    setIcons: (icons: Record<string, string>) => ipcRenderer.send('thumbbar:icons', icons),
  },

  /**
   * The floating widget's own channel. Most of it is the pill's: its window is
   * wider than the strip so that tooltips and the equalizer can open sideways away
   * from the docked edge, and the empty gutter beside the strip has to stop
   * swallowing desktop clicks. `setSize` and `onPicture` belong to the mini card —
   * the first is a film's rectangle asking for a frame to match, the second is
   * mpv's native picture arriving in this window.
   */
  overlay: {
    setInteractive: (on: boolean) => ipcRenderer.send('overlay:interactive', on),
    /** Put the widget away without converting the library window. */
    collapse: () => ipcRenderer.invoke('overlay:collapse'),
    /** Dock the strip to the other edge of the screen. */
    setPillSide: (side: 'left' | 'right') =>
      ipcRenderer.invoke('pill:set-side', side) as Promise<{ ok: boolean; side: 'left' | 'right' }>,
    getPillSide: () => ipcRenderer.invoke('pill:get-side') as Promise<{ side: 'left' | 'right' }>,
    /**
     * The window's content size, for the mini player while a film is on: the
     * rectangle takes the picture's ratio, so the frame has to follow it. Null
     * hands the size back to the mode's default.
     */
    setSize: (size: { width: number; height: number } | null) =>
      ipcRenderer.send('overlay:set-size', size),
    /** Where the strip and any open panel are, so the main process can
     *  decide who receives the click. */
    reportHit: (payload: { rects: Array<{ x: number; y: number; w: number; h: number }>; open: boolean }) =>
      ipcRenderer.send('overlay:hit-rects', payload),
    /** Which widget the main process currently has on screen, or null. */
    onRole: (callback: (role: 'mini' | 'pill' | null) => void) => {
      const listener = (_event: unknown, role: 'mini' | 'pill' | null) => callback(role);
      ipcRenderer.on('main:overlay-role', listener);
      return () => ipcRenderer.removeListener('main:overlay-role', listener);
    },
    /**
     * mpv's native film picture has been moved into *this* window.
     *
     * Pushed by main because it is the only party that knows: the card cannot infer
     * it from the film relay, which goes quiet for exactly the films this says
     * something about — the library stops decoding them in a page element, so there
     * is nobody left reporting. Two things hang off the answer, and neither is
     * guessable: the card must stop mirroring a picture that is now drawn behind its
     * own glass, and it must take the film's dimensions from the deck rather than
     * from readings that will never arrive.
     */
    onPicture: (callback: (native: boolean) => void) => {
      const listener = (_event: unknown, native: boolean) => callback(native);
      ipcRenderer.on('overlay:picture', listener);
      return () => ipcRenderer.removeListener('overlay:picture', listener);
    },
    /** A press landed outside this window, so an open flyout should stand down. */
    onDismiss: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('overlay:dismiss', listener);
      return () => ipcRenderer.removeListener('overlay:dismiss', listener);
    },
    /** The pointer is over the widget's own box. Pushed by the click-routing poll. */
    onHover: (callback: (over: boolean) => void) => {
      const listener = (_event: unknown, over: boolean) => callback(over);
      ipcRenderer.on('overlay:hover', listener);
      return () => ipcRenderer.removeListener('overlay:hover', listener);
    },
    /**
     * Where this window sits on the display, so a whole-screen capture laid out
     * inside it lines up with the desktop it is standing on.
     */
    captureGeometry: () => ipcRenderer.invoke('overlay:capture-geometry'),
    onGeometry: (callback: (geometry: unknown) => void) => {
      const listener = (_event: unknown, geometry: unknown) => callback(geometry);
      ipcRenderer.on('overlay:geometry', listener);
      return () => ipcRenderer.removeListener('overlay:geometry', listener);
    },
  },

  // File dialogs
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  createFolder: (parent: string, name: string) =>
    ipcRenderer.invoke('fs:create-folder', parent, name) as Promise<{ ok: boolean; path?: string; error?: string }>,
  openFile: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('dialog:open-file', options),
  /** Several files at once — the playlist and library "Add songs" pickers. */
  openFiles: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('dialog:open-files', options) as Promise<string[]>,
  saveFile: (options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) =>
    ipcRenderer.invoke('dialog:save-file', options),

  // File system
  readFile: (filePath: string) => ipcRenderer.invoke('fs:read-file', filePath),
  /** Write/remove the `.lrc` beside a song. Main derives the path from the audio file. */
  saveLyrics: (audioPath: string, content: string) =>
    ipcRenderer.invoke('lyrics:save', audioPath, content) as Promise<{ ok: boolean; path?: string; error?: string }>,
  deleteLyrics: (audioPath: string) =>
    ipcRenderer.invoke('lyrics:delete', audioPath) as Promise<{ ok: boolean; path?: string; error?: string }>,
  pathExists: (filePath: string) => ipcRenderer.invoke('fs:path-exists', filePath),
  listDir: (dirPath: string) => ipcRenderer.invoke('fs:list-dir', dirPath),
  loadLibraryCache: () => ipcRenderer.invoke('library:load-cache'),
  saveLibraryCache: (data: unknown) => ipcRenderer.invoke('library:save-cache', data),
  /** The `.m3u8` lists in the app's own folder. A playlist is named, never pathed. */
  createPlaylist: (name: string, entries: string[]) =>
    ipcRenderer.invoke('playlist:create', name, entries) as Promise<{ ok: boolean; path?: string; error?: string }>,
  writePlaylist: (name: string, entries: string[]) =>
    ipcRenderer.invoke('playlist:write', name, entries) as Promise<{ ok: boolean; path?: string; error?: string }>,
  renamePlaylist: (from: string, to: string) =>
    ipcRenderer.invoke('playlist:rename', from, to) as Promise<{ ok: boolean; path?: string; error?: string }>,
  removePlaylist: (name: string) =>
    ipcRenderer.invoke('playlist:remove', name) as Promise<{ ok: boolean; error?: string }>,
  fileToDataUrl: (filePath: string) => ipcRenderer.invoke('fs:file-to-data-url', filePath),
  /** Tags and the embedded cover's bytes, streamed by the shell rather than read whole. */
  readTags: (filePath: string) => ipcRenderer.invoke('media:read-tags', filePath),

  // ffmpeg-backed media analysis
  analyzeMedia: (filePath: string, durationSec: number) =>
    ipcRenderer.invoke('media:analyze', filePath, durationSec),
  extractPeaks: (filePath: string, count: number) => ipcRenderer.invoke('media:peaks', filePath, count),
  extractPoster: (filePath: string, atSec?: number) => ipcRenderer.invoke('media:poster', filePath, atSec),
  writeTags: (filePath: string, tags: unknown) => ipcRenderer.invoke('media:write-tags', filePath, tags) as Promise<{ ok: boolean; error?: string }>,
  ffmpegAvailable: () => ipcRenderer.invoke('media:ffmpeg-available') as Promise<boolean>,

  /**
   * The desktop's own background, for the pill's glass. Read from the registry
   * rather than captured, because a capture of the monitor contains this window.
   */
  desktop: {
    wallpaper: () => ipcRenderer.invoke('desktop:wallpaper') as Promise<WallpaperInfo>,
  },

  // App info
  getUser: () => ipcRenderer.invoke('app:get-user'),  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getPlatform: () => ipcRenderer.invoke('app:get-platform'),
  /** Register or unregister ChaosX in the per-user login items. */
  setAutoLaunch: (on: boolean) =>
    ipcRenderer.invoke('app:set-auto-launch', on) as Promise<{ ok: boolean }>,
  getAutoLaunch: () => ipcRenderer.invoke('app:get-auto-launch') as Promise<boolean>,
  /** Park in the notification area on close instead of quitting. */
  setCloseToTray: (on: boolean) =>
    ipcRenderer.invoke('app:set-close-to-tray', on) as Promise<{ ok: boolean }>,
  openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url),
  openPath: (filePath: string) => ipcRenderer.invoke('app:open-path', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('app:show-in-folder', filePath),

  /**
   * Machine telemetry for the Statistics page. `get` answers the first frame;
   * `onSysInfo` is the one-second pump that keeps it alive.
   */
  getSysInfo: () => ipcRenderer.invoke('sysinfo:get'),
  onSysInfo: (callback: (info: unknown) => void) => {
    const listener = (_event: unknown, info: unknown) => callback(info);
    ipcRenderer.on('sysinfo:update', listener);
    return () => ipcRenderer.removeListener('sysinfo:update', listener);
  },

  // Event listeners
  onMediaKey: (callback: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => callback(action);
    ipcRenderer.on('media-key', listener);
    return () => ipcRenderer.removeListener('media-key', listener);
  },
});

export type ElectronAPI = typeof window.electronAPI;
