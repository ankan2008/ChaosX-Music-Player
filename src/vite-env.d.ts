/// <reference types="vite/client" />

import type { FilmCommand, FilmState, MpvApi, MpvSnapshot, MpvState } from '../shared/audio';

export type { FilmCommand, FilmState, MpvApi, MpvSnapshot, MpvState };

export interface UserInfo {
  username: string;
  displayName: string;
  avatar: string | null;
  /** The machine's network name, for the Statistics page's device card. */
  device: string;
}

export interface GainAnalysis {
  /** Highest sample peak seen, in dBFS (can exceed 0 on hot masters) */
  truePeakDb: number;
  /** Mean RMS of the sampled windows, dBFS */
  rmsDb: number;
  /** Linear gain to apply so the peak lands at the target ceiling */
  gainDb: number;
}

/** What crosses between the library window and the pill overlay on a hand-off. */
export interface HandoffState {
  trackId?: string;
  position: number;
  playing: boolean;
  mode?: 'normal' | 'full' | 'mini' | 'pill';
}

/** Where a window sits on the display it is drawn on, in CSS pixels. */
export interface CaptureGeometry {
  displayWidth: number;
  displayHeight: number;
  offsetX: number;
  offsetY: number;
  scaleFactor: number;
}

/**
 * What Windows is showing as the desktop background, and where it puts it.
 *
 * `style` and `tile` are the raw `Control Panel\Desktop` strings, `solid` is the
 * `Control Panel\Colors` background as "r g b", and the two geometry fields are DIP
 * bounds — the virtual desktop being the union of every monitor, which is the
 * surface Center, Tile and Span are measured against.
 */
export interface WallpaperInfo {
  /** False when the registry read itself failed, as opposed to no wallpaper set. */
  ok: boolean;
  path: string | null;
  style: string;
  tile: string;
  solid: string;
  displays: Array<{ x: number; y: number; width: number; height: number; scaleFactor: number }>;
  virtual: { x: number; y: number; width: number; height: number } | null;
}

export interface ElectronAPI {
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  /** Hard-kill and relaunch the app with Chromium's cache cleared. Never resolves. */
  restartApp: () => Promise<void>;
  getWindowState: () => Promise<{ isMaximized: boolean }>;
  /** Sent once by the library window, after its first composed frame. */
  notifyReady?: () => void;
  /** The real `WS_MAXIMIZE` of the library window, pushed as it changes. */
  onZoomed?: (callback: (zoomed: boolean) => void) => () => void;
  setWindowMaterial: (material: string) => Promise<void>;
  /** Cover the whole monitor, taskbar included, and hand it back again. */
  setImmersive: (on: boolean) => Promise<{ ok: boolean }>;
  setViewMode: (mode: 'normal' | 'full' | 'mini' | 'pill', state?: HandoffState) => Promise<{ mode: string }>;
  openPill?: (state: HandoffState) => Promise<{ ok: boolean }>;
  closePill?: (state: HandoffState) => Promise<{ ok: boolean }>;
  reportPillState?: (state: HandoffState) => void;
  onPillHandoff?: (callback: (state: HandoffState) => void) => () => void;
  onMainHandoff?: (callback: (state: HandoffState) => void) => () => void;
  /** The main-process mpv deck. Commands are discrete; state arrives by event. */
  mpv?: MpvApi;
  /** The transparent hole mpv's embedded video shows through. */
  video?: {
    setSlot: (slot: { x: number; y: number; w: number; h: number; under?: boolean } | null) => void;
    debug: () => Promise<Record<string, unknown>>;
  };
  /**
   * The film one window is decoding, shared with the others. The library owns it:
   * it answers commands and announces readings. A widget sends commands and
   * consumes readings, and never has a media element for the file at all.
   */
  film?: {
    command: (cmd: FilmCommand) => void;
    onCommand: (callback: (cmd: FilmCommand) => void) => () => void;
    report: (state: FilmState) => void;
    /** Whether the page's own element is making noise, for the media-key hold. */
    reportPlaying: (on: boolean) => void;
    onState: (callback: (state: FilmState) => void) => () => void;
  };
  /** Presses on the taskbar thumbnail's transport buttons. */
  thumbbar?: {
    onCommand: (callback: (action: 'prev' | 'next' | 'toggle' | 'back' | 'forward') => void) => () => void;
    setIcons: (icons: Record<string, string>) => void;
  };
  /** Click-through control for the pill's transparent flyout gutter. */
  overlay?: {
    setInteractive: (on: boolean) => void;
    collapse: () => Promise<{ ok: boolean }>;
    setPillSide?: (side: 'left' | 'right') => Promise<{ ok: boolean; side: 'left' | 'right' }>;
    getPillSide?: () => Promise<{ side: 'left' | 'right' }>;
    setSize: (size: { width: number; height: number } | null) => void;
    reportHit?: (payload: { rects: Array<{ x: number; y: number; w: number; h: number }>; open: boolean }) => void;
    onRole: (callback: (role: 'mini' | 'pill' | null) => void) => () => void;
    /**
     * mpv's native film picture now lives in this window. The card has to stop
     * mirroring a film nobody is decoding in a page element any more, and start
     * reading its size off the deck instead.
     */
    onPicture?: (callback: (native: boolean) => void) => () => void;
    onDismiss?: (callback: () => void) => () => void;
    onHover?: (callback: (over: boolean) => void) => () => void;
    captureGeometry?: () => Promise<CaptureGeometry | null>;
    onGeometry?: (callback: (geometry: CaptureGeometry | null) => void) => () => void;
  };
  /** The desktop's own background, which is what sits behind the pill's capsule. */
  desktop?: {
    wallpaper?: () => Promise<WallpaperInfo>;
  };
  onMpvState?: (callback: (state: MpvState) => void) => () => void;
  onMpvEnded?: (callback: (info: { path: string | null }) => void) => () => void;
  openFolder: () => Promise<string | null>;
  createFolder: (parent: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  openFile: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
  openFiles: (options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string[]>;
  saveFile: (options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>;
  readFile: (filePath: string) => Promise<string>;
  saveLyrics: (audioPath: string, content: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  deleteLyrics: (audioPath: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  pathExists: (filePath: string) => Promise<boolean>;
  listDir: (dirPath: string) => Promise<
    Array<{ name: string; isDirectory: boolean; isFile: boolean; size?: number; mtimeMs?: number }>
  >;
  loadLibraryCache: () => Promise<unknown>;
  saveLibraryCache: (data: unknown) => Promise<boolean>;
  /**
   * The playlists this app owns, at `<userData>/playlists/<name>.m3u8`.
   *
   * Named rather than pathed, in both directions: main assembles the file from the
   * name, so the renderer cannot aim a write at anything outside that one folder.
   * `entries` are absolute audio paths, one per line.
   */
  createPlaylist: (
    name: string,
    entries: string[],
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  writePlaylist: (
    name: string,
    entries: string[],
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  /** Moves the file, which is what keeps its entries through a rename. */
  renamePlaylist: (from: string, to: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  removePlaylist: (name: string) => Promise<{ ok: boolean; error?: string }>;
  fileToDataUrl: (filePath: string) => Promise<string | null>;
  /**
   * Tags read by the shell's streaming parser, which touches only the ranges a
   * tag needs instead of the whole file. `bitrate` is in bits per second, as the
   * container reports it. Null when the file is unreadable or the container needs
   * a full scan to price, in which case the caller has the old path to fall back on.
   */
  readTags: (filePath: string) => Promise<{
    format: string;
    duration: number;
    sampleRate: number;
    bitrate: number;
    bitDepth: number;
    channels: number;
    title: string;
    artist: string;
    album: string;
    year: number | null;
    genre: string;
    track: number | null;
    lyrics: string[];
    picture: { data: Uint8Array; mime: string } | null;
  } | null>;
  analyzeMedia: (filePath: string, durationSec: number) => Promise<GainAnalysis | null>;
  extractPeaks: (filePath: string, count: number) => Promise<number[] | null>;
  extractPoster: (filePath: string, atSec?: number) => Promise<string | null>;
  writeTags: (filePath: string, tags: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
  ffmpegAvailable: () => Promise<boolean>;
  getUser: () => Promise<UserInfo>;
  getAppVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  /** Register ChaosX as a per-user login item. */
  setAutoLaunch?: (on: boolean) => Promise<{ ok: boolean }>;
  getAutoLaunch?: () => Promise<boolean>;
  /** Hide to the notification area on close instead of quitting. */
  setCloseToTray?: (on: boolean) => Promise<{ ok: boolean }>;
  openExternal: (url: string) => Promise<void>;
  openPath: (filePath: string) => Promise<string | null>;
  showInFolder: (filePath: string) => Promise<void>;
  onMediaKey: (callback: (action: string) => void) => () => void;
  /** Machine telemetry for the Statistics page. */
  getSysInfo?: () => Promise<SysInfo>;
  onSysInfo?: (callback: (info: SysInfo) => void) => () => void;
}

/** Mirrors `SysInfo` in `electron/sysinfo.ts`. */
export interface SysInfo {
  ramTotal: number;
  ramUsed: number;
  threads: number;
  cores: number;
  busyThreads: number;
  /** 0..1 across all threads. */
  load: number;
  /** Bytes, summed over every process ChaosX owns. */
  appRam: number;
  /** 0..1 of the whole machine, so it reads against `load`. */
  appLoad: number;
  battery: {
    present: boolean;
    /** 0..1, or null when Windows reports "unknown". */
    level: number | null;
    charging: boolean;
    lifeSeconds: number | null;
  };
}

declare global {
  interface Window {
    /**
     * The host, as `electron/preload.ts` exposes it. Optional because a browser tab
     * opened at the dev server has neither the preload nor anything like it, and half
     * the glass work got looked at that way.
     */
    electronAPI?: ElectronAPI;
  }
}

export {};
