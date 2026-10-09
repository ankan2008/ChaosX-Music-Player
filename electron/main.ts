import { app, BrowserWindow, ipcMain, dialog, shell, protocol, globalShortcut, nativeTheme, desktopCapturer, session, screen, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { analyzeLoudness, extractPeaks, extractPoster, ffmpegAvailable, writeTags, type TagWrite } from './ffmpeg';
import { registerMpvIpc, mpvEngine } from './mpv-engine';
import { mpvWindow, type VideoSlot } from './mpv-window';
import { initThumbButtons, applyThumbIcons } from './taskbar-buttons';
import { appBar, type BarEdge } from './appbar';
import { armTaskbarHover, disarmTaskbarHover, taskbar } from './taskbar';
import { registerSysInfo } from './sysinfo';

/**
 * The name the app answers to on screen.
 *
 * Releases are named `ChaosX Mark x<Major>.<Minor>`, and the user wants that on
 * the window and in the shell — Task Manager, the tray — not only in the Settings
 * credits. Keep it in step with `version` in package.json and the credits card.
 */
const APP_MARK = 'ChaosX Mark x1.0';

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4a: 'audio/mp4',
  aac: 'audio/aac',
  alac: 'audio/mp4',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  ape: 'audio/x-ape',
  wv: 'audio/x-wavpack',
  mpc: 'audio/x-musepack',
};

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  divx: 'video/x-msvideo',
  mov: 'video/quicktime',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  vob: 'video/mpeg',
};

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_MIME[ext] ?? AUDIO_MIME[ext] ?? 'application/octet-stream';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

// Custom streaming protocol for local media files.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      stream: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

function toMediaUrl(filePath: string): string {
  return `media://track/${encodeURIComponent(filePath)}`;
}

function fromMediaUrl(url: string): string {
  const parsed = new URL(url);
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

function getMainWindow(): BrowserWindow {
  if (!mainWindow) {
    throw new Error('Main window not initialized');
  }
  return mainWindow;
}

// ─────────────────────────────────────────────────────────────
// Windows account picture + username
// ─────────────────────────────────────────────────────────────

interface UserInfo {
  username: string;
  displayName: string;
  avatar: string | null;
  /** `os.hostname()` — what the Statistics page's device card prints. */
  device: string;
}

let cachedUserInfo: UserInfo | null = null;

/**
 * `C:\Windows\System32`, so the two probes below can name their binaries.
 *
 * Bare `whoami` is not safe to ask for. In development the main process inherits
 * the shell's PATH, and a Git Bash on the machine puts the GNU coreutils
 * `whoami` — which rejects `/user` outright with "extra operand" — ahead of
 * Windows' own. The lookup then returned null in dev, fell through to the generic
 * silhouette, and looked like a registry problem rather than a PATH one. Naming
 * the binary removes the ambiguity in both dev and the installed app.
 */
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * The signed-in user's SID, e.g. `S-1-5-21-…-1001`.
 *
 * The account picture is stored per-SID, and nothing else here hands one over:
 * `os.userInfo()` gives a name, and the name is not a key.
 */
function currentUserSid(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      path.join(SYSTEM32, 'whoami.exe'),
      ['/user', '/fo', 'csv', '/nh'],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        // `hp\ankan","S-1-5-21-…-1001"` — the SID is the only token of that shape.
        const m = stdout.match(/S-\d-\d+-(?:\d+-){3,}\d+/);
        resolve(m ? m[0] : null);
      },
    );
  });
}

/**
 * Ask the registry where Windows put this account's picture.
 *
 * **HKLM, keyed by SID, is the one that matters.** The original code read
 * `HKCU\…\AccountPicture\Users` — the hive Windows 8 wrote, which on this machine
 * (11, build 26300, local account) does not exist at all. The real entry sits at
 * `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AccountPicture\Users\<SID>` and
 * points into `C:\Users\Public\AccountPictures\<SID>\{GUID}-Image1080.jpg`. Both
 * hives are tried, because which one a machine uses depends on how the account was
 * made, and reading only one is how this stayed broken twice.
 */
function readRegistryAccountPicture(sid: string | null): Promise<string | null> {
  const hives = ['HKLM', 'HKCU'];
  const base = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AccountPicture\\Users';
  const tries = [
    ...(sid ? hives.map((h) => `${h}\\${base}\\${sid}`) : []),
    ...hives.map((h) => `${h}\\${base}`),
  ];

  return new Promise((resolve) => {
    const attempt = (i: number) => {
      if (i >= tries.length) {
        resolve(null);
        return;
      }
      execFile(
        path.join(SYSTEM32, 'reg.exe'),
        ['query', tries[i], '/v', 'Image1080'],
        { windowsHide: true },
        (err, stdout) => {
          /*
           * One value is queried rather than the whole tree: `/s` on the parent
           * walks every SID on the machine, which on a shared box returns other
           * people's pictures.
           *
           * The output is split into lines before it is matched, not matched in
           * place. `reg.exe` ends its lines with CRLF, and in a multiline regex `.`
           * will not cross `\r` while `$` only sits before `\n` — so a single
           * `/(.+)$/m` over the raw stdout never matches, the lookup silently
           * returns null, and the interface falls back to the generic silhouette
           * while claiming to have found the real one.
           */
          let p: string | null = null;
          if (!err && stdout) {
            for (const line of stdout.split(/\r?\n/)) {
              const m = line.match(/^\s*Image1080\s+REG_SZ\s+(.+)$/);
              if (m) {
                p = m[1].trim();
                break;
              }
            }
          }
          if (p && fs.existsSync(p)) {
            resolve(p);
            return;
          }
          attempt(i + 1);
        },
      );
    };
    attempt(0);
  });
}

/**
 * The filesystem fallbacks, once the registry has been asked.
 *
 * Reached only when no SID entry exists — a brand-new local account that has
 * never been given a picture. Each candidate is checked for bytes rather than
 * assumed, because `ProgramData\…\user.png` is the generic silhouette and a
 * zero-byte `.dat` marker sits beside it, and either handed to an `<img>` is
 * worse than the initial the interface can draw itself.
 */
async function findAccountPicture(username: string): Promise<string | null> {
  const dirs = [
    path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'AccountPictures'),
    path.join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Microsoft', 'User Account Pictures'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'AccountPicture'),
  ];
  // `<username>.png` and `<sid>_192.png` are both forms Windows has shipped.
  const safe = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wanted = new RegExp(`^(${safe})(_.+)?\\.(png|jpe?g|bmp)$`, 'i');

  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    const pick =
      names.find((n) => wanted.test(n)) ??
      names.find((n) => /^user\.(png|jpe?g)$/i.test(n));
    if (!pick) continue;
    const full = path.join(dir, pick);
    try {
      if ((await fs.promises.stat(full)).size > 0) return full;
    } catch {
      /* unreadable — fall through to the next candidate */
    }
  }
  return null;
}

async function getUserInfo(): Promise<UserInfo> {
  if (cachedUserInfo) return cachedUserInfo;
  const username = os.userInfo().username;
  let avatar: string | null = null;
  try {
    const sid = process.platform === 'win32' ? await currentUserSid() : null;
    const picPath =
      (await readRegistryAccountPicture(sid)) ?? (await findAccountPicture(username));
    if (picPath) {
      const buf = await fs.promises.readFile(picPath);
      const ext = path.extname(picPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
      avatar = `data:${mime};base64,${buf.toString('base64')}`;
    }
  } catch {
    avatar = null;
  }
  cachedUserInfo = { username, displayName: username, avatar, device: os.hostname() };
  return cachedUserInfo;
}

/**
 * Global media-key fallback.
 *
 * `navigator.mediaSession` is what makes this app a real SMTC participant, and
 * Windows routes a headset or touchpad gesture to whichever session owns the
 * key. Holding `globalShortcut` unconditionally on top of that made every
 * press land here even when YouTube or Spotify was the thing playing, so
 * play/pause and stop are only held while our window is focused — the same rule
 * the OS already applies to keyboard input. When we blur, ownership is handed
 * back.
 *
 * Next and previous are the exception, and they answer to a different clock.
 * The SMTC session does carry handlers for both, but a backgrounded press still
 * never reached them while play/pause did, so the transport keys are held for as
 * long as *this deck is the thing making noise* rather than for as long as the
 * window has focus. That is the condition that actually matters: while we are
 * playing, next/previous belong to us wherever the focus is, and the moment we
 * are silent they are handed straight back, so a paused app never eats the key
 * from a video that is.
 */
/*
 * One set, one rule: the media keys are ChaosX's for as long as ChaosX is open.
 *
 * They used to be held only while this deck was actually making noise, on the
 * argument that a paused player has no business eating the button from the video
 * or the stream that is. That argument was right about courtesy and wrong about
 * what the user asked for: the report was that the hardware keys do nothing
 * until something is already playing, which is precisely the case a listener
 * reaches for the key first. Play/pause from a stopped app is the whole point of
 * the key.
 *
 * So the hold is now for the life of the window. The cost is that a running but
 * silent ChaosX wins the key from another player, and that is the priority the
 * request asked for by name.
 *
 * Fn-combinations need nothing extra here. On the machines that have no dedicated
 * media key the firmware synthesises the same `VK_MEDIA_*` scancode the
 * combination is short for, and this registers at that level, so `Fn+D` and a
 * printed play key are the same event to us. What we cannot reach is an OEM
 * utility that swallows the combination before it becomes a scancode at all —
 * that mapping has to be turned off in the vendor's own app.
 *
 * Because these also arrive through `navigator.mediaSession`, one press can
 * reach the renderer down both paths; `claimMediaKey` in the guard is what stops
 * the second one from un-doing the first.
 */
const MEDIA_KEYS: Record<string, string> = {
  MediaPlayPause: 'playpause',
  MediaStop: 'stop',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'previous',
};

function registerKeys(map: Record<string, string>): string[] {
  const landed: string[] = [];
  for (const [accelerator, action] of Object.entries(map)) {
    try {
      // `register` reports failure by returning false rather than throwing,
      // so record which keys we actually got instead of assuming all did.
      if (globalShortcut.register(accelerator, () => sendToRenderer('media-key', action))) {
        landed.push(accelerator);
      }
    } catch {
      // Another app already holds it
    }
  }
  return landed;
}

function unregisterKeys(map: Record<string, string>): void {
  for (const accelerator of Object.keys(map)) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // Already gone
    }
  }
}

let mediaKeysHeld = false;
/** Keys a previous pass could not take, because something else had them. */
let mediaKeysMissing: string[] = [];
let mediaKeyRetry: NodeJS.Timeout | null = null;

/**
 * Hold or hand back the media keys.
 *
 * A key another app already owns is not lost: the shell releases it when that app
 * quits or loses its own claim, so the missing ones are retried on a slow timer
 * for as long as ours are wanted. Registering a key that is already ours returns
 * false, which is why the retry only ever attempts the gaps.
 */
function setMediaKeysHeld(held: boolean): void {
  if (held === mediaKeysHeld) return;
  mediaKeysHeld = held;
  if (mediaKeyRetry) {
    clearInterval(mediaKeyRetry);
    mediaKeyRetry = null;
  }
  if (held) {
    const landed = registerKeys(MEDIA_KEYS);
    mediaKeysMissing = Object.keys(MEDIA_KEYS).filter((k) => !landed.includes(k));
    console.log(`[media-keys] held: ${landed.join(', ') || 'none'}`);
    if (mediaKeysMissing.length) {
      mediaKeyRetry = setInterval(() => {
        if (!mediaKeysHeld) return;
        const want = Object.fromEntries(
          mediaKeysMissing.map((k) => [k, MEDIA_KEYS[k]]),
        );
        const got = registerKeys(want);
        mediaKeysMissing = mediaKeysMissing.filter((k) => !got.includes(k));
        if (!mediaKeysMissing.length && mediaKeyRetry) {
          clearInterval(mediaKeyRetry);
          mediaKeyRetry = null;
        }
      }, 4000);
    }
  } else {
    unregisterKeys(MEDIA_KEYS);
    mediaKeysMissing = [];
    console.log('[media-keys] handed back');
  }
}

/*
 * The hold no longer keys off what is playing, so the deck's and the film's play
 * states are not this file's business any more — but the two events below still
 * fire, and re-asserting the hold on them is what picks up a key another app has
 * just let go of without waiting for the retry timer.
 */
function refreshMediaKeys(): void {
  setMediaKeysHeld(true);
}

/** True while the transport shortcuts are ours. Owned by the deck's play state. */

function createWindow(): void {
  nativeTheme.themeSource = 'dark';

  // Packaged builds inherit the icon embedded from build/icon.ico; this only
  // matters in dev, where the exe has no icon of its own.
  const devIcon = path.join(app.getAppPath(), 'build', 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    /*
     * Narrow enough for Windows' snap presets to actually take. A 960 floor is a
     * third of a 1920 display, which is the smallest pane the maximize button's
     * flyout offers on a quarter layout, so the window refused the preset and the
     * preset's own animation left it sitting back at the floor. The layout answers
     * the small sizes rather than the frame refusing them — see the snap-width
     * blocks in `globals.css`.
     */
    /*
     * 330 DIP, which is Microsoft's own floor for the snap-layout presets: a
     * desktop app must support a minimum width of at most 500 effective pixels to
     * show them at all, and 330 or less "so that it's compatible with a larger set
     * of devices and snap layouts". The previous 560 sat above that, so on this
     * 1536-DIP display a quarter pane (384) was refused and the preset's own
     * animation left the window back at the floor — which read as the snap
     * flyout doing nothing. The layout answers the small sizes; see the
     * snap-width blocks in `globals.css`.
     */
    minWidth: 330,
    minHeight: 560,
    /*
     * No native titlebar, and the standard Windows controls painted by the Window
     * Controls Overlay instead.
     *
     * The caption band this replaces was drawn by DWM, and on a `transparent: true`
     * window it could not be kept painted: any frame recompute — the snap-layout
     * preset, the maximise button, `setAlwaysOnTop`, the takeover's `setBounds` —
     * collapsed the frame extension and the strip stopped being drawn altogether, so
     * the backdrop showed through where the titlebar should have been. Nothing in the
     * DWM attribute set could bring it back, and the one call that does
     * (`DwmExtendFrameIntoClientArea`) segfaults this process when made from inside it.
     *
     * With the overlay there is no non-client strip to lose: the whole rectangle is
     * web content, the page paints the bar, and the operating system draws only the
     * three buttons over the top-right corner.
     */
    /*
     * `titleBarStyle: 'hidden'` with the frame left on, rather than `frame: false`, and
     * no `titleBarOverlay`.
     *
     * With `frame: false` the overlay's minimise and close work and its maximise does
     * not: `SC_MAXIMIZE` reaches the window and is dropped, because views answers it
     * through `Widget::CanUserMaximize()`, which needs a non-client view to exist at
     * all — and a frameless window has none. Saying `maximizable: true` and
     * `resizable: true` out loud does not help; both already report true and the
     * message is still swallowed. Measured by posting the very command the button
     * posts: `IsZoomed` never moved.
     *
     * Keeping the frame keeps that non-client view, so the button has something to
     * talk to, while `hidden` takes the visible titlebar away. Measured anyway: the
     * command is dropped here too, because the check that fails is "is the titlebar
     * hidden", not "is there a frame view". `SC_RESTORE` on the same window works, and
     * so does `ShowWindow(SW_MAXIMIZE)` — it is specifically the maximise *command*
     * that views filters, which is why the shell's snap preset can still maximise the
     * window while its own button cannot.
     *
     * So the operating system is not asked to draw any of the three controls. The
     * overlay is left off entirely and the renderer paints its own, wired to the same
     * `window:*` handlers the overlay's live neighbours use — and it can be wired
     * there because a renderer button calls straight into this process instead of
     * posting a system command into views. Electron 30.5.1's `TitleBarOverlay` is only
     * `{color, symbolColor, height}`: there is no `showMaximize`, so the dead button
     * could not have been hidden while the other two stayed.
     */
    frame: true,
    titleBarStyle: 'hidden',
    /*
     * Required by the embedded mpv video, not by the look of the app. mpv draws
     * into a native child window that sits *behind* Chromium's surface, so the
     * surface has to have a hole in it for the video to show through — and a
     * non-transparent window has no holes, only a background of its own. Measured
     * both ways: with this off the video slot is a black rectangle.
     * See electron/mpv-window.ts for the rest of the arrangement.
     */
    transparent: true,
    backgroundColor: '#00000000',
    title: APP_MARK,
    icon: fs.existsSync(devIcon) ? devIcon : undefined,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      /*
       * This is now the whole of the promise, and it is made per window rather than
       * for every process Chromium can start. `backgroundThrottling: false` is
       * `RenderWidgetHostImpl::DisableBackgrounding()` for this one host: the host
       * refuses to be marked hidden or occluded, so its page visibility never drops
       * and its timers are never clamped. The library window is the renderer that
       * must keep its clocks — a film's `AudioContext` lives here even when the
       * picture is on the widget, and a clamped host is the crackle and the drop-outs
       * — and it is the one whose frames matter while it is on screen.
       */
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    try {
      mainWindow?.setBackgroundMaterial('acrylic');
    } catch {
      // Older Windows builds without DWM materials
    }
    /*
     * Always start maximised, whatever the last session looked like — a player that
     * opens at a random remembered size reads as broken on every launch. "Maximised"
     * here means the work area, taskbar still visible; true fullscreen is reserved for
     * fullscreen music mode.
     *
     * `show()` comes first because `SW_MAXIMIZE` on a window that has never been
     * displayed is overridden by Electron's own show path, which places the window at
     * its created rectangle. Measured: the library came up at `48,0 1440x816`.
     *
     * And through `mpvWindow.zoom`, so the launch, the overlay's button and the exit
     * from fullscreen all move the window the same way and read the same answer. See
     * `window:maximize` for why Electron's own pair is one-directional here. It is also
     * why the frame bits must be stable when it runs: Windows derives the maximised
     * rectangle from them, and with `WS_CAPTION` and `WS_THICKFRAME` stripped — which
     * is the takeover's whole trick — the same call answers with the monitor and
     * swallows the taskbar.
     */
    /*
     * The reveal is gated on the renderer, not on this event.
     *
     * `ready-to-show` is the first frame, not the first frame of anything worth
     * looking at: the window used to appear as a dark rectangle that filled in a beat
     * later, which is the black window reported at boot and after a restart. So the
     * page says when it has composed, and the window goes up with something already in
     * it. A timer sits behind that — a window that waits forever on a wedged renderer
     * is worse than one that shows a frame early.
     */
    let revealed = false;
    const reveal = () => {
      if (revealed) return;
      revealed = true;
      const win = mainWindow;
      if (!win || win.isDestroyed()) return;
      win.show();
      mpvWindow.zoom(win, true);
      /*
       * Forced, because this is the one transition the page cannot learn about by
       * watching for changes. It asked for its own state on mount and got "not
       * maximised" — which was true then, and is not now — and the change-gated push
       * that follows has nothing left to report, so the window came up maximised with
       * the page still drawing it as a floating one: rounded corners cut into the
       * work area, showing desktop at all four.
       */
      pushZoom(true);
      /*
       * The thumbnail buttons are added once the window exists and has a taskbar
       * button to hang them on. Everything in that path is guarded and reports
       * itself unavailable rather than throwing, so a shell that refuses the call
       * costs the buttons and nothing else.
       */
      initThumbButtons(win);
    };
    ipcMain.once('window:ready', reveal);
    setTimeout(() => {
      ipcMain.removeListener('window:ready', reveal);
      reveal();
    }, 3000);
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  /*
   * Coming back is also the moment to ask the deck what it is actually doing.
   * A touchpad media gesture reached the deck through SMTC while this window
   * was in the background; the deck obeyed, and the renderer's `isPlaying` only
   * ever moves on a report. The broadcast is change-gated, so a state that
   * changed while nobody was listening never looks like a change again — which
   * is the song that stops, the pause button that stays a pause button, and the
   * waveform that keeps sweeping over silence.
   */
  mainWindow.on('focus', () => mpvEngine.resync());

  /*
   * mpv needs this window's HWND on its command line, which means it has to be
   * attached before the decks start. The child-window set is snapshotted here
   * too, so mpv's window can be recognised later by elimination rather than by
   * its class name.
   */
  mpvWindow.attach(mainWindow);
  /*
   * `transparent: true` costs the window its sizing border and maximize button —
   * measured, Electron clears WS_THICKFRAME and WS_MAXIMIZEBOX for a framed
   * transparent window and says nothing about it. Both have to be handed back or
   * the caption's middle button is dead. See `restoreFrame()`.
   */
  const frame = mpvWindow.restoreFrame(mainWindow);
  if (!frame.ok) console.warn('[window] could not restore the sizing frame:', frame.error);
  /*
   * No `hookWindowMessage(0x00a3)` here, though one was tried.
   *
   * Double-clicking the strip is answered further down than a window procedure hook can
   * reach: the first click hands the pointer to `DefWindowProc`'s caption move loop, and
   * that loop turns the second click into a `WM_SYSCOMMAND` itself, so
   * `WM_NCLBUTTONDBLCLK` is never dispatched to the window and a hook on it sits there
   * collecting nothing. Measured with a probe on the hook and several real double-clicks
   * landed on the strip: not one line.
   *
   * It is also the last piece of the asymmetry the user kept hitting. From maximised the
   * loop posts `SC_RESTORE`, which views allows, so double-click *did* something; from a
   * custom size it posts `SC_MAXIMIZE`, which views refuses for a hidden titlebar, so the
   * same gesture looked dead. The page owns the double-click now, on the title itself —
   * see `.win-title` in `src/App.tsx`.
   */
  /*
   * Claimed at launch rather than at first play, which is the whole of the
   * change: a listener pressing play on a player that has not started yet
   * expects it to start.
   */
  setMediaKeysHeld(true);
  screen.on('display-metrics-changed', () => {
    mpvWindow.sync();
    syncFilmPictureTarget();
  });
  /*
   * The renderer re-sends the picture's rectangle from a rAF poll, and that
   * clock is not running while the window is being moved between display modes
   * — a fullscreen transition, a maximize, a snap. Without a push from this
   * side, mpv's child keeps the geometry it was given for the previous state
   * until the poll happens to notice, which is the film sitting half out of its
   * card for a beat after coming back from fullscreen.
   */
  const resyncPicture = () => mpvWindow.sync();
  /*
   * Which way the middle window control should point, pushed to the page.
   *
   * The renderer cannot work it out for itself: it never sees the maximise that comes
   * from the shell (the snap preset, a jump list, `Win+Up`), and it must not guess from
   * the window's rectangle, because the takeover covers the same ground by setting
   * bounds rather than by maximising. `IsZoomed` is the only answer that is about the
   * window Windows actually has.
   *
   * Change-gated, because these events arrive in bunches — a maximise fires `maximize`
   * and `resize`, and a bounds change fires `resize` many times a second.
   */
  let zoomPushed: boolean | null = null;
  const pushZoom = (force = false) => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    const zoomed = (mpvWindow.isZoomed(win) ?? win.isMaximized()) === true;
    if (zoomed === zoomPushed && !force) return;
    zoomPushed = zoomed;
    if (!win.webContents.isDestroyed()) win.webContents.send('window:zoomed', zoomed);
  };
  /*
   * Show-state changes re-sync mpv and nothing else — they no longer re-assert the
   * frame, and that is deliberate.
   *
   * `restoreFrame` writes `GWL_STYLE` and sends `SWP_FRAMECHANGED`. Doing that in the
   * middle of a show-state change desynchronises Electron's own maximise bookkeeping:
   * measured, after one maximise cycle the window came to rest with `WS_MAXIMIZE` set
   * and `unmaximize()` answering with nothing at all, so the gesture worked in one
   * direction only and the shell's snap preset was the sole way back.
   *
   * The frame bits are asserted once, at creation, which is all the takeover needs —
   * `stripFrame` has something to take away, and the exit path puts them back inside a
   * pair of explicit bounds changes. What must not happen is the style word moving
   * underneath a maximise the shell is still animating.
   *
   * mpv still needs its push: its child window keeps the geometry it was given for the
   * previous state until the renderer's poll happens to notice, which is the film
   * sitting half out of its card for a beat after coming back from fullscreen.
   */
  mainWindow.on('resize', resyncPicture);
  mainWindow.on('maximize', resyncPicture);
  mainWindow.on('unmaximize', resyncPicture);
  mainWindow.on('restore', resyncPicture);
  mainWindow.on('enter-full-screen', resyncPicture);
  mainWindow.on('leave-full-screen', resyncPicture);
  /*
   * `resize` is on this list as well as the show-state events, because Electron fires
   * `maximize`/`restore` from its own bookkeeping and those can disagree with the real
   * `WS_MAXIMIZE` this window is moved by. A resize is not a zoom, so the read is the
   * one that decides, and the gate above keeps the bunches from reaching the page.
   */
  mainWindow.on('resize', pushZoom);
  mainWindow.on('maximize', pushZoom);
  mainWindow.on('unmaximize', pushZoom);
  mainWindow.on('restore', pushZoom);
  mainWindow.webContents.once('did-finish-load', pushZoom);

  mainWindow.on('closed', () => {
    mpvWindow.detach();
    mainWindow = null;
  });

  /*
   * Close-to-tray.
   *
   * Intercepted on `close` rather than on the quit path, because that is the
   * difference between "I pressed the X" and "I asked the app to end" — a
   * `Shift+F4`, a session logoff or `app.quit()` still comes through here and has
   * to be allowed to actually quit, which is what `isQuitting` records.
   */
  mainWindow.on('close', (event) => {
    if (!closeToTrayEnabled || isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
    showTray();
  });
}

let closeToTrayEnabled = false;
let isQuitting = false;
let tray: Tray | null = null;

/**
 * Park the app in the notification area.
 *
 * The tray is created on the first hide rather than at startup: an icon that sits
 * in the overflow doing nothing for a session that never minimised is clutter the
 * user did not ask for, and on Windows a `Tray` also costs a message-loop entry.
 */
function showTray(): void {
  if (tray) return;
  /*
   * An empty `nativeImage` still gives a working tray — a click lands, the menu
   * opens, close-to-tray behaves — but the slot in the overflow is blank, which is
   * exactly what the packaged build did: `build/` is a build-resources folder, not
   * part of the archive, so the dev path existed only on the dev machine and the
   * fallback was `createEmpty()`. Try the bundled brand art as well, and resize to
   * the glyph the shell actually wants rather than letting it scale 512px down.
   */
  const sources = [
    path.join(__dirname, '../build/icon-24.png'),
    path.join(__dirname, '../dist/brand/icon.png'),
    path.join(__dirname, '../public/brand/icon.png'),
  ];
  let icon: ReturnType<typeof nativeImage.createFromPath> | null = null;
  for (const file of sources) {
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) continue;
    icon = image.getSize().width > 32 ? image.resize({ width: 16, height: 16, quality: 'best' }) : image;
    break;
  }
  tray = new Tray(icon ?? nativeImage.createEmpty());
  tray.setToolTip(`${APP_MARK} — running in the background`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open ChaosX',
        click: () => {
          const win = getMainWindow();
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => {
    const win = getMainWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

ipcMain.handle('app:set-close-to-tray', (_event, on: boolean) => {
  closeToTrayEnabled = !!on;
  // Turning the option off while parked would otherwise strand the app with no
  // window and no way back but the tray icon.
  if (!closeToTrayEnabled && tray) {
    tray.destroy();
    tray = null;
    const win = getMainWindow();
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }
  return { ok: true };
});

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

/*
 * The film relay: intents in, readings out.
 *
 * Exactly one window decodes a video — the library, which is the only one with a
 * media element and the only one mpv's native picture can be parented to. A widget
 * asks and the library answers with the next reading, so the two can disagree for
 * one frame and never for one song. The design before this handed ownership of the
 * film from window to window instead, and every failure of that hand-off was
 * audible: two decoders running, or one's sound under the other's picture.
 */
ipcMain.on('film:command', (event, cmd: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender === mainWindow.webContents) return;
  mainWindow.webContents.send('film:command', cmd);
});

ipcMain.on('film:state', (event, state: unknown) => {
  for (const win of [getMainWindow(), overlayWindow]) {
    if (win && !win.isDestroyed() && win.webContents !== event.sender) {
      win.webContents.send('film:state', state);
    }
  }
});

// The rectangle the page has reserved for mpv's video, in CSS pixels relative
// to this window's client area. `null` means "no video here", which hides the
// embedded window rather than leaving it parked at the last size.
ipcMain.on('video:slot', (event, slot: unknown) => {
  /*
   * mpv's picture is a child window of the *library* HWND — the only handle it
   * was ever given, at deck start — so a rectangle from the floating widget is
   * not a placement at all: it puts the native window inside the library at the
   * widget's own coordinates. That is the black slab over the sidebar, and it is
   * why the widget can only ever show a film this renderer decodes itself.
   *
   * That reasoning still holds, and it is now the reason this handler has to keep
   * quiet rather than the reason the widget cannot have a picture: once a card is
   * holding the native window (`mpvWindow.retarget`), a rectangle in library
   * coordinates is exactly the wrong measurement for the window it would be
   * applied to. The card's rectangle is computed here, from its own bounds.
   */
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (mpvWindow.pictureInWidget) return;
  if (slot === null) {
    mpvEngine.setVideoSlot(null);
    return;
  }
  if (typeof slot !== 'object' || slot === null) return;
  const s = slot as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const rect: VideoSlot = {
    x: n(s.x),
    y: n(s.y),
    w: n(s.w),
    h: n(s.h),
    under: s.under === true,
  };
  if (rect.w < 2 || rect.h < 2) {
    mpvEngine.setVideoSlot(null);
    return;
  }
  mpvEngine.setVideoSlot(rect);
});

// The page rasterises the app's own icons and posts them here as PNG bytes; the
// shell needs icon handles, which only this process can make for this window.
ipcMain.on('thumbbar:icons', (_event, icons: unknown) => {
  if (typeof icons !== 'object' || icons === null) return;
  applyThumbIcons(icons as Record<string, string>);
});

ipcMain.handle('video:debug', () => mpvWindow.debug());

// Window controls (used by mini player / settings shortcuts)
ipcMain.handle('window:minimize', () => {
  getMainWindow().minimize();
});

ipcMain.handle('window:maximize', () => {
  const win = getMainWindow();
  /*
   * Both directions through the native state machine, and the decision read from
   * `IsZoomed` rather than `isMaximized()`.
   *
   * The two disagree on this window and the disagreement is one-directional:
   * `maximize()` places it on the work area and sets Electron's flag, but never
   * `WS_MAXIMIZE`, so `IsZoomed` stays false — and `unmaximize()`, which asks Windows,
   * finds nothing to undo and does nothing at all. Measured over three cycles, the
   * restore landed once out of three and left the window at `-122,28`. A button wired
   * to that pair can only ever work in one direction.
   *
   * `zoom` is `ShowWindow(SW_MAXIMIZE|SW_RESTORE)`, which is what the shell's own
   * controls send, so the app and the snap preset now move the window the same way and
   * read the same answer. The maximised rect is derived from the frame bits, which is why
   * this stays inside the work area — and why the style word must not be mutated
   * underneath it.
   */
  const zoomed = mpvWindow.isZoomed(win) ?? win.isMaximized();
  mpvWindow.zoom(win, !zoomed);
  /*
   * The answer is read back rather than assumed: `zoom` is a `ShowWindow`, and the
   * renderer's middle glyph has to match whatever the window actually ended up as.
   * `pushZoom` sends the same value a moment later; the page tolerates the duplicate.
   */
  return (mpvWindow.isZoomed(win) ?? !zoomed) === true;
});

ipcMain.handle('window:close', () => {
  getMainWindow().close();
});

ipcMain.handle('window:get-state', () => {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return { isMaximized: false, isMinimized: false, isVisible: false };
  /*
   * `isMinimized` has to come from here because the renderer cannot infer it.
   * This app passes --disable-backgrounding-occluded-windows and
   * --disable-renderer-backgrounding so audio survives being covered, and the side
   * effect is that document.visibilityState stays "visible" even when minimized —
   * so it is worthless as a "did the window actually go away" signal.
   */
  return {
    /*
     * `IsZoomed`, not `isMaximized()`: the latter is Electron's own bookkeeping and it
     * says true for a window Windows has never maximised, which draws the strip's
     * middle button as a restore control on a window that will not restore.
     */
    isMaximized: mpvWindow.isZoomed(win) ?? win.isMaximized(),
    isMinimized: win.isMinimized(),
    isVisible: win.isVisible(),
  };
});

// Windows 11 backdrop material: 'acrylic' | 'mica' | 'tabbed' | 'none' | 'auto'
ipcMain.handle('window:set-material', (_event, material: string) => {
  const win = getMainWindow();
  const valid: Array<'acrylic' | 'mica' | 'tabbed' | 'none' | 'auto'> = [
    'acrylic', 'mica', 'tabbed', 'none', 'auto',
  ];
  if (valid.includes(material as 'acrylic')) {
    try {
      win.setBackgroundMaterial(material as 'acrylic' | 'mica' | 'tabbed' | 'none' | 'auto');
    } catch {
      // Not supported on this Windows build
    }
  }
});

/**
 * What the window looked like before it took the monitor, so it can be handed
 * back. `null` means the library window is not immersive.
 */
let immersiveRestore: { maximized: boolean; bounds: Electron.Rectangle } | null = null;

/**
 * Take the whole monitor, taskbar and caption included, or give it back.
 *
 * Both takeover views ask for this. The reason it has to be done with Win32 style
 * bits rather than Electron's `setFullScreen` or `setKiosk` is that the library
 * window is `transparent: true`, and the shell only moves its bar out of the way
 * for a window it recognises as a fullscreen top-level — no caption, no sizing
 * border, a rectangle over the whole monitor. A layered transparent window never
 * presents as one, so both of Electron's fullscreen paths grew the page to the
 * monitor and left the taskbar painted across the bottom of it. That is the
 * "fullscreen sits underneath the taskbar" report, and it is also why the quote
 * card used to be cut off.
 *
 * Clearing the bits by hand gets the shell's attention, and the reward is the
 * behaviour Windows itself implements for an auto-hidden bar: the taskbar goes, and
 * putting the pointer on the bottom edge brings it back. Nothing here touches the
 * user's taskbar settings — the bar reappears the moment the caption comes back.
 *
 * The strip keeps its always-on-top level while this is up, so a docked pill is
 * still reachable; the library window is what goes immersive.
 */
ipcMain.handle('window:set-immersive', (_event, on: boolean) => {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false };
  const display = screen.getDisplayMatching(win.getBounds());

  if (on) {
    /* The snapshot of what to hand back is taken below, after the zoom comes off. */
    /*
     * Give up the zoom before anything else, and give it up through Windows rather
     * than by clearing a bit.
     *
     * A window the shell has maximised ignores a bounds change: measured on a
     * snapped window, `setBounds` leaves it sitting on the maximised rectangle, so
     * the takeover came up with the taskbar still painted across the bottom of it —
     * the "fullscreen stopped taking the full screen" report, and it only ever
     * arrived after the snap flyout had been used.
     *
     * `stripFrame` does not help here, because `WS_MAXIMIZE` is a different bit from
     * the five it clears: the window comes out with no caption and still flagged as
     * maximised. That combination is the one the exit path below crashes on, so it
     * is ended before the takeover starts rather than cleaned up afterwards.
     *
     * The snapshot of the window's own rectangle is taken *after* this, because with
     * the zoom up `getBounds` answers with the maximised box rather than with the size
     * the user left — and the takeover is about to overwrite that rectangle with the
     * monitor anyway, so whatever is saved here is the only copy that survives.
     */
    const wasZoomed = (mpvWindow.isZoomed(win) ?? win.isMaximized()) === true;
    if (wasZoomed) mpvWindow.zoom(win, false);
    if (!immersiveRestore) immersiveRestore = { maximized: wasZoomed, bounds: win.getBounds() };
    /*
     * Order matters. Sizing first and stripping after leaves a window whose frame
     * changed underneath its own bounds, and the caption's old height shows up as a
     * band of unpainted window at the bottom — the same black strip the page has
     * been complaining about, arrived at from the other direction.
     */
    win.setBounds({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height });
    const s = mpvWindow.stripFrame(win);
    if (!s.ok) console.warn('[window] could not strip the caption:', s.error);
    armTaskbarHover(win);
    return { ok: s.ok, style: s };
  }

  const saved = immersiveRestore;
  immersiveRestore = null;
  disarmTaskbarHover();
  /*
   * The zoom comes off before the caption goes back on, and that order is the
   * crash.
   *
   * `restoreFrame` has to send `SWP_FRAMECHANGED` or the window keeps the client
   * rectangle it computed with no caption. On a window still flagged as maximised
   * that makes the shell re-derive the maximised rectangle and repaint a non-client
   * area which does not exist yet, and the repaint takes the main process down with
   * it — measured, a segmentation fault that left both renderer processes alive with
   * nothing to talk to. Restoring first leaves a plain rectangle for the frame
   * change to work on, which is the case it was written for.
   */
  if (mpvWindow.isZoomed(win)) mpvWindow.zoom(win, false);
  const f = mpvWindow.restoreFrame(win);
  if (!f.ok) console.warn('[window] could not re-assert the sizing frame:', f.error);
  /*
   * Back to the rectangle the user was actually working in, and then to maximised only
   * if that is how the window was left.
   *
   * The takeover wrote the monitor over the window's normal position, and the normal
   * position is what `SW_RESTORE` answers with — so after one fullscreen round trip the
   * middle button's restore began filling the screen and hiding the taskbar instead of
   * giving back the custom size. Nothing else remembers that size: the maximised
   * rectangle is derived from the frame bits, not stored, so the copy taken on the way
   * in has to be written back on the way out.
   *
   * Landing on the work area rather than on the remembered smaller window is deliberate
   * when the window was maximised going in: the button that leaves this view is drawn as
   * a maximise control, and it used to answer it with something smaller than what you
   * left. Both entry and exit go through the same native call so the two never disagree
   * about which one it is.
   */
  if (saved) win.setBounds(saved.bounds);
  if (!saved || saved.maximized) mpvWindow.zoom(win, true);
  return { ok: f.ok, style: f };
});


/**
 * The visible part of the pill: a scrub lane plus a two-column button grid.
 *
 * It was 146 wide for as long as the housekeeping icons stood in a column
 * *beside* the grid. They are above it now, so that column — 28px of button and
 * 6px of gap — is the strip's own dead weight, and the strip kept its old width
 * with nothing in it. This is the number the desk bar reserves, so shrinking it
 * gives 34px of screen back to every maximised window as well.
 */
const PILL_STRIP_WIDTH = 112;

/** Declared before `MODE_SIZES` because the table reads it. */
const PILL_GUTTER = 400;

/**
 * Mini's own transparent margin.
 *
 * The card used to be exactly the window — 250x250 in a 250x250 frame — so
 * nothing could leave it. A `[data-tip]::after` label on a corner button was cut
 * by the OS, and the queue panel, which is declared far larger than the card,
 * simply did not exist past its edge. The gutter is transparent and click-through
 * until the pointer is over the card or a panel is open, which is the same
 * arrangement the pill already uses; the cursor poll had to stop bailing out on
 * `role !== 'pill'` for it to work here at all.
 */
const MINI_GUTTER = 64;

/** The mini card itself; the window is this plus a gutter on all four sides. */
const MINI_CARD = 250;

/*
 * There used to be a `MINI_PANEL_ROOM` of 340px added to the window's *height*
 * alone, so the card sat at the bottom of a tall transparent frame and a flyout
 * had somewhere to go above it. That one constant was the reason the widget could
 * not be dragged into the top or bottom band of the screen: Windows keeps a
 * dragged window inside the work area, so the card's own top edge was pinned 340px
 * below wherever the user thought they were putting it.
 *
 * The flyouts live inside the card now, so the room is gone and the gutter is
 * symmetric — which also means `overlay:set-size` centring the window is centring
 * the card, and a track crossing into a film stops nudging the widget.
 */

/** Web-area size for each floating mode. Mini is square; the pill is a strip. */
const MODE_SIZES: Record<'mini' | 'pill', { width: number; height: number }> = {
  mini: {
    width: MINI_CARD + MINI_GUTTER * 2,
    height: MINI_CARD + MINI_GUTTER * 2,
  },
  /*
   * The window is wider than the strip on purpose: a tooltip or the equalizer has
   * to open *sideways*, away from the docked edge, and there is nowhere sideways
   * to go inside 96 pixels. The gutter sits to the LEFT of the strip, is
   * transparent, and passes clicks through to whatever is behind it until the
   * pointer enters the window — see `overlay:interactive`.
   */
  pill: { width: PILL_STRIP_WIDTH + PILL_GUTTER, height: 470 },
};

/** Large enough to never clamp; used to undo a floating mode's constraints. */
const UNBOUNDED = 100000;

/**
 * Mini's size when a film is on: the renderer measures the picture's ratio and
 * asks for a window to match (see `overlay:set-size`). Null is the square card.
 */
let miniSizeOverride: { width: number; height: number } | null = null;

ipcMain.handle(
  'window:set-view-mode',
  (_event, mode: ViewMode, state?: Handoff) => {
    const win = getMainWindow();

    if (mode === 'mini' || mode === 'pill') {
      /*
       * Both widgets are separate overlay windows, not resized library windows.
       * They used to be the latter, and it could never work: `frame` cannot be
       * changed on a live Electron window, so shrinking the library window left a
       * Windows title bar — minimize, restore, close — sitting on top of the
       * artwork. Mini is an overlay for exactly that reason, and pill always was
       * one; the two now arrive through here so they behave identically.
       */
      openOverlay(mode, { position: 0, playing: false, mode, ...state });
      return { mode };
    }

    /*
     * Changing between these says nothing about the widget: a pill or a mini card
     * stays exactly where it is, and the only things that put one away are its own
     * collapse button and converting it into the other widget. This used to call
     * `closeOverlay` first, which meant leaving the takeover silently deleted the
     * strip the user had just docked.
     *
     * They are two states of the same window rather than two geometries, and now
     * neither of them changes it. Normal is maximised inside the work area — full
     * width, taskbar still there, which is what the caption's middle button does.
     * The takeover used to ask Windows for real fullscreen on top of that, which
     * stretched the page to the whole monitor and put its bottom edge *behind* the
     * taskbar: the fullscreen music view's quote card was being cut off by a strip
     * of desktop the user can still see and click. A takeover is a change of what
     * is drawn, not of where the window is, so both modes now land on the same
     * maximised box and nothing about the frame moves.
     *
     * The one thing that still resizes this window is the pill strip arriving, and
     * that is its own overlay window rather than anything decided here.
     *
     * This used to tween the window back to 1440x920. That was the last remnant
     * of the design where a floating widget resized the library window, and it
     * quietly undid any maximize the user had just done.
     */
    win.setResizable(true);
    win.setMaximizable(true);
    win.setMaximumSize(UNBOUNDED, UNBOUNDED);
    win.setAlwaysOnTop(false);
    win.setMinimumSize(330, 560);
    if (win.isFullScreen()) win.setFullScreen(false);
    /*
     * Not `if (!win.isMaximized()) win.maximize()`. That line read as "the
     * library is always maximised" and was: it fired every time a widget arrived
     * or left, so a window the user had just restored from the caption button
     * snapped straight back to full screen. The window starts maximised and the
     * caption button is the only thing that decides its size after that.
     *
     * `restoreFrame` is re-asserted here because this is the one path that calls
     * Electron's own style setters, and Electron recomputes the whole style word
     * when it applies them — the WS_THICKFRAME and WS_MAXIMIZEBOX it had cleared
     * for a transparent window come back cleared. Losing those two is exactly a
     * dead maximize button and no snap-layout flyout on hover.
     */
    const f = mpvWindow.restoreFrame(win);
    if (!f.ok) console.warn('[window] could not re-assert the sizing frame:', f.error);
    return { mode };
  },
);

/**
 * The pill overlay: a second, frameless, always-on-top window that carries
 * playback while the library window is put away.
 *
 * It exists because Electron cannot change `frame` on a live window. Mini and
 * pill used to shrink the library window itself, which left a Windows title bar
 * welded on top of a floating card — the one piece of chrome the whole design
 * argues against. A separate window gets a real edge-to-edge capsule, and the
 * library window keeps its native title bar for the modes that want it.
 *
 * Both windows run the same bundle, so they share the store, the library cache
 * and the glass engine by construction. What they cannot share is the *audio*:
 * each renderer has its own `AudioContext` and its own media element, so
 * playback is handed over explicitly — the sender fades itself to silence, the
 * receiver loads the same track at the same offset. Two copies of one song is
 * the only failure mode worth designing around, and it is the reason the
 * handoff is a request the renderer makes rather than something the window
 * lifecycle decides on its own.
 */
interface Handoff {
  trackId?: string;
  position: number;
  playing: boolean;
  mode?: 'normal' | 'full' | 'mini' | 'pill';
}

/** The layouts the renderer can ask the window system for. */
type ViewMode = 'normal' | 'full' | 'mini' | 'pill';

/** The floating widget roles, in the order they claim the single overlay window. */
type OverlayRole = 'pill' | 'mini';

let overlayWindow: BrowserWindow | null = null;
/** Which role the one overlay window is currently serving. */
let overlayRole: OverlayRole | null = null;
/** Waits for the overlay's renderer to finish booting, then is delivered. */
let pendingHandoff: Handoff | null = null;
/** The overlay reports along every second so a hard close can be recovered. */
let lastPillState: Handoff = { position: 0, playing: false };
/** Whether the overlay window currently accepts clicks, or passes them through. */
let overlayInteractive = false;

function overlayUrl(role: OverlayRole): { url: string; filePath?: string; query?: Record<string, string> } {
  const query: Record<string, string> = { view: role };
  /*
   * The side travels in the URL so the strip knows which way it is facing before
   * it paints. Reading it from an IPC instead would mean one frame of the
   * right-hand layout on a left-hand strip — a visible flip, on a control whose
   * entire job is to not move.
   */
  if (role === 'pill') query.side = pillSide;
  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return { url: url.toString() };
  }
  return {
    url: '',
    filePath: path.join(__dirname, '../dist/index.html'),
    query,
  };
}

/** Which edge of the screen the strip is docked to. Mirrored by `appBar`. */
let pillSide: BarEdge = 'right';

/**
 * Where an overlay window should land.
 *
 * The pill is a strip down the right-hand edge of the work area, as tall as that
 * work area — the notification side, which is where a thing you glance at lives.
 * It stops 8px short of the edge and of the taskbar on all four sides, because a
 * rounded rectangle that is flush with the screen edge reads as a clipped
 * rectangle: the radius is only visible if there is something beside it.
 *
 * Mini has no such convention, so it opens centred on the display it belongs to
 * and lets the user drag it wherever they want.
 */
function overlayBounds(role: OverlayRole): Electron.Rectangle {
  const display = screen.getPrimaryDisplay();
  const { workArea, bounds } = display;
  const size = role === 'mini' && miniSizeOverride ? miniSizeOverride : MODE_SIZES[role];
  if (role === 'pill') {
    /*
     * Flush to the docked edge and exactly the work area tall, so the strip's
     * bottom sits on the taskbar's top boundary rather than floating above it and
     * its edge leaves no gap for the desktop to show through beside the widget.
     * The window is wider than the strip; on the right the strip is the rightmost
     * `PILL_STRIP_WIDTH` of it, and on the left the leftmost, which is what the
     * `pill-left` rule in the renderer arranges.
     *
     * The horizontal anchor is the *monitor*, not the work area. The pill
     * registers as an application desk bar and takes its own width out of the
     * work area, so measuring against the work area would move the strip one
     * width further away from the edge every time it was re-docked.
     */
    return {
      x: Math.round(pillSide === 'left' ? bounds.x : bounds.x + bounds.width - size.width),
      y: Math.round(workArea.y),
      width: size.width,
      height: Math.max(320, workArea.height),
    };
  }
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };
}

/**
 * Where mpv's picture sits inside the mini card, in CSS pixels relative to that
 * window's client area — the same unit and the same origin the library's page
 * reports for its own docked slot.
 *
 * Measured from the window rather than reported by the widget's renderer, because
 * the card *is* the picture: its rectangle is the window minus the transparent
 * gutter on all four sides, which is an agreement between `MINI_GUTTER` here and
 * the shell's own padding, and main already knows both halves of it. Sending it
 * over an IPC instead would buy a per-frame round trip for a number that is a
 * subtraction, and would need the `video:slot` sender guard punched open for a
 * second window — the one guard in this file that exists because a rectangle from
 * the wrong window is worse than no rectangle at all.
 *
 * `under: true`, and it has to be. The card's transport row, its scrub bar and its
 * head all live *inside* the picture's box, and a native window raised above the
 * page would cover them along with every click aimed at them. The widget renders no
 * tint layer and no backdrop canvas — `App.tsx` refuses both to an overlay window —
 * so dropping the picture below the page leaves only the surfaces that are meant to
 * float over the film.
 */
function miniPictureRect(): VideoSlot | null {
  const win = overlayWindow;
  if (!win || win.isDestroyed() || overlayRole !== 'mini' || !win.isVisible()) return null;
  const c = win.getContentBounds();
  const w = c.width - MINI_GUTTER * 2;
  const h = c.height - MINI_GUTTER * 2;
  if (w < 2 || h < 2) return null;
  return { x: MINI_GUTTER, y: MINI_GUTTER, w, h, under: true };
}

/**
 * Put the film's native picture in whichever window the user is looking at.
 *
 * Called from both sides of the only two facts it joins up: a card came on screen
 * or went away, and mpv started or stopped drawing a frame. Neither order works
 * without the other — open a card over a film the page is decoding and the deck has
 * nothing to hand over yet, so this returns having done nothing and the deck's own
 * `file-loaded` calls it again; load a film into mpv while a card is already up and
 * the same hook catches it going the other way.
 *
 * The one thing it must never do is leave the picture inside a window that is about
 * to be destroyed: Windows takes a window's children down with it, and mpv's video
 * output cannot recover from losing the HWND it was told to draw into. Every teardown
 * path calls `reclaimPictureFromOverlay()` *before* the frame goes, which is why
 * nothing here waits for a `closed` event.
 */
function syncFilmPictureTarget(): void {
  if (!mpvWindow.available) return;
  const win = overlayWindow;
  const want =
    !!win && !win.isDestroyed() && overlayRole === 'mini' && mpvEngine.hasFilmPicture();
  const before = mpvWindow.pictureInWidget;
  if (want && win) {
    if (!before) mpvWindow.retarget(win);
    /*
     * Pushed on every call, not only on the transition: a card being dragged or
     * resized by a film's own aspect ratio changes the rectangle without changing
     * which window owns the picture.
     */
    mpvEngine.setVideoSlot(miniPictureRect());
  } else if (before) {
    /*
     * Same order as `reclaimPictureFromOverlay()` and for the same reason: hide it
     * while it is still where the user can see it behaving, then hand the window
     * back. A film that ended while the card was open takes this branch.
     */
    mpvEngine.setVideoSlot(null);
    mpvWindow.retarget(null);
  }
  if (before === want) return;
  if (win && !win.isDestroyed()) win.webContents.send('overlay:picture', want);
}

/**
 * Take the picture out of the widget before the widget stops existing.
 *
 * The order is the whole of this function. `destroyOverlay()` clears `overlayWindow`
 * first — deliberately, so everything else in this file sees "no widget" from that
 * instant — and by then there is nothing left to move the window *from*.
 */
function reclaimPictureFromOverlay(): void {
  if (!mpvWindow.pictureInWidget) return;
  const win = overlayWindow;
  /*
   * Hidden first, then moved, and the order is the whole function. Reparenting a
   * *visible* window shows it, at its old coordinates, inside the library — a
   * freeze-frame of the film over whatever the user is now looking at, for as long
   * as it takes the next placement to notice. Hidden, the trip is invisible, and
   * `movePicture` carries the hidden state across with it.
   */
  mpvEngine.setVideoSlot(null);
  mpvWindow.retarget(null);
  if (win && !win.isDestroyed()) win.webContents.send('overlay:picture', false);
}

/**
 * The one frameless overlay window, retargeted to whichever role is active.
 *
 * Mini and pill share a single window rather than each having their own because
 * only one of them can be on screen at a time — the library window hides for
 * both — and two always-on-top frames competing for the same corner is a bug
 * waiting to be reported. Reusing the window also keeps the renderer warm, so
 * switching modes a second time does not pay for a fresh bundle.
 *
 * That warmth is now only for *while a widget is on screen*. Converting strip to
 * card and back keeps this window and reloads it in place; putting the widget away
 * destroys it (`destroyOverlay`), because a parked-but-hidden frame cost a full
 * Chromium renderer — measured at 88 MB — for the rest of the session, and in
 * Small Potato Mode, where the switcher that would reopen a widget is not even
 * drawn, there was no path left that could ever have reused it. So every call here
 * has to cope with `overlayWindow` being null and build a fresh one, which the tail
 * of this function already did before the reuse branch existed.
 */
function getOverlayWindow(role: OverlayRole): BrowserWindow {
  const wanted = overlayBounds(role);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    if (overlayRole !== role) {
      // Same window, different widget: resize it and point the renderer at the
      // other layer. A reload is cheaper and far less error-prone than trying to
      // make `?view=` reactive.
      overlayWindow.setBounds(wanted);
      overlayWindow.webContents.send('overlay:role', role);
      const target = overlayUrl(role);
      if (target.filePath) overlayWindow.loadFile(target.filePath, { query: target.query });
      else overlayWindow.loadURL(target.url);
      overlayRole = role;
    }
    return overlayWindow;
  }

  overlayWindow = new BrowserWindow({
    ...wanted,
    /*
     * Frameless, and that is the entire point of this window existing. Electron
     * cannot change `frame` on a live window, so the library window — which wants
     * a title bar in normal view — can never become a chrome-less card by being
     * shrunk. Mini mode used to do exactly that and shipped with a Windows title
     * bar across the top of the artwork.
     */
    frame: false,
    /* Transparent, so the margin around the widget really is see-through and it
       has its own silhouette rather than a rectangular one. The cost is that
       `backdrop-filter` has nothing to sample — a renderer cannot refract the
       desktop — so the widget paints its own artwork wash through `AmbientFlow`.
       No shadow either: Windows draws one around the rectangle, not the shape. */
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    /*
     * The pill does not move. Not "has no drag handle" — cannot.
     *
     * It has no `-webkit-app-region: drag` anywhere in its window, and it is still
     * being reported as sliding across the screen when a dropdown is grabbed, which
     * means something other than the page is taking the window by the title bar.
     * The strip's whole contract with the desktop is that it reserves one band at
     * one edge and stays there; the only thing allowed to change its position is the
     * side button, and that goes through `setBounds`, which does not need this.
     *
     * The mini card keeps it, because that widget is meant to be put where the user
     * wants it.
     */
    movable: role !== 'pill',
    /*
     * Both widgets stay above the desktop. The pill has to, because it reserves
     * its own band through the app bar and nothing else may sit in it.
     *
     * The card used to be an ordinary window on the theory that a floating film
     * with no taskbar entry is impossible to send behind the thing you are
     * actually clicking on. That is the lesser evil: as a normal window it went
     * *under* them instead, so the first click anywhere else put the player out
     * of sight with no way to bring it back. It is a control surface, so it stays
     * where it was put until the user collapses it.
     */
    alwaysOnTop: true,
    /* These are desktop widgets, not applications. A taskbar entry for a pill
       that only exists while the real window is hidden is noise. */
    skipTaskbar: true,
    show: false,
    title: APP_MARK,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  overlayRole = role;
  /*
   * The frame this call made, for every handler below to compare itself against.
   * They cannot read `overlayWindow`: collapsing a widget destroys this instance and
   * reopening it assigns a new one, and these events land afterwards — a handler that
   * followed the module variable would be acting on a window it does not own.
   */
  const created = overlayWindow;
  created.setAlwaysOnTop(true, 'floating');
  /*
   * The widget refracts a live capture of the screen it sits on (see
   * `overlay:capture-geometry`), and this window is on top of that screen. Without
   * exclusion it would be captured into its own backdrop and refract itself —
   * an infinite regression of the same pill, which blooms into a mirror tunnel the
   * moment anything moves behind it. `WDA_EXCLUDEFROMCAPTURE` removes it from the
   * capture only.
   *
   * It also removes it from *every* capture, including the user's own screenshot
   * tool, and that is not a price worth paying on a surface the app draws itself:
   * with the default backdrop nothing is grabbing the screen at all, so the
   * exclusion has no purpose there and the mini card simply cannot be screenshotted.
   * It is therefore switched on by the renderer for exactly as long as the live
   * desktop scene is feeding the glass, and off the rest of the time.
   */
  created.setContentProtection(false);

  created.webContents.on('did-finish-load', () => {
    if (created.isDestroyed() || overlayWindow !== created) return;
    if (pendingHandoff) {
      created.webContents.send('pill:handoff', pendingHandoff);
      pendingHandoff = null;
    }
  });


  /*
   * Re-docking (an app-bar resize, a monitor change, a role swap) moves the
   * window, and the live backdrop is aligned to the window. Push the new offset
   * so the capture slides back into register instead of leaving the glass
   * refracting a strip of desktop the pill no longer covers.
   */
  const pushGeometry = () => {
    if (created.isDestroyed() || overlayWindow !== created) return;
    created.webContents.send('overlay:geometry', captureGeometry(created));
    /*
     * The card's own rectangle *is* the picture's rectangle, so a drag, a snap or
     * the resize that follows a film's aspect ratio arriving all have to be pushed
     * at the native window. A child keeps its position in its parent's client area
     * when the parent moves, so the drag alone is harmless — but re-applying it is
     * cheaper than working out which of the three cases this was, and one Win32
     * call on a window move is nothing beside the frame the card is already paying
     * for its own glass.
     */
    syncFilmPictureTarget();
  };
  created.on('moved', pushGeometry);
  created.on('resized', pushGeometry);

  /*
   * The overlay can leave the session without ever handing back: Alt-F4, a task
   * bar close, or a crash. It used to be the only way the library window came
   * back, because opening the widget had hidden it. Now the widget is an
   * addition rather than a replacement, so all this has to do is put the media
   * keys somewhere sensible and clear the role — forcing the library window into
   * normal view from here would be the bug the user just asked to remove.
   *
   * `destroy()` does not come through here — it skips `close` — which is why
   * putting a widget away shows and focuses the library window itself rather than
   * leaving it to this handler.
   */
  created.on('close', () => {
    /*
     * The hard way the widget can leave: Alt-F4, a shell close, a crash about to
     * happen. None of them come through `destroyOverlay()`, and a frame destroyed
     * with the film's native window still inside it takes the picture — and mpv's
     * only drawing surface — down with it.
     */
    if (overlayWindow === created) reclaimPictureFromOverlay();
    const win = getMainWindow();
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      win.focus();
    }
    if (overlayWindow === created) {
      overlayWindow = null;
      overlayRole = null;
    }
  });

  created.on('closed', () => {
    if (overlayWindow !== created) return;
    overlayWindow = null;
    overlayRole = null;
  });

  const target = overlayUrl(role);
  if (target.filePath) created.loadFile(target.filePath, { query: target.query });
  else created.loadURL(target.url);

  return created;
}

/**
 * Put the widget away for real, so its renderer process goes with it.
 *
 * `hide()` was the whole of this for a long time, on the theory that a window it
 * already paid for is worth keeping against the next press of the same button. What
 * that bought in practice was a full Chromium renderer parked off-screen for the rest
 * of the session — 88 MB measured, on a machine with four logical cores and this app
 * at 918 MB — for a surface the user had explicitly dismissed. And in Small Potato
 * Mode the switcher that reopens a widget is not rendered at all, so nothing could
 * ever have reused it.
 *
 * The module variables are cleared *before* the frame is destroyed, not from the
 * `closed` handler afterwards: everything that reads `overlayWindow` — the poll, the
 * `film:state` relay, `bridgeWindow()`, the `library:load-cache` handler deciding
 * which reader it is talking to — has to see "no widget" from this instant, and a
 * `getOverlayWindow()` call made while the teardown is in flight has to take the
 * create-fresh branch rather than retarget a dying window.
 */
function destroyOverlay(): void {
  /*
   * Before anything else, and before the module variables are cleared: the frame
   * is about to stop existing, and Windows destroys a window's children with it.
   * mpv's picture is one of those children, and its video output has no way back
   * from having the HWND it was given deleted underneath it — the film would keep
   * playing, silently, for the rest of the session with nothing left to draw it.
   */
  reclaimPictureFromOverlay();
  const win = overlayWindow;
  overlayWindow = null;
  overlayRole = null;
  pendingHandoff = null;
  if (!win || win.isDestroyed()) return;
  try {
    win.destroy();
  } catch {
    // A frame mid-teardown refuses this; it is already going and the state is clear.
  }
}

/**
 * Show a floating widget *alongside* the library window.
 *
 * It used to put the library window away first, on the theory that a widget is a
 * substitute for the app. That is not what the user wants: the normal or
 * fullscreen window stays exactly as it is and the widget appears in addition to
 * it. Nothing here hides the main window any more.
 *
 * The hand-off payload is mostly historical: with mpv in the main process every
 * window already shares one deck, so the overlay does not need to take audio over.
 * It still needs to know which *layout* to open in and where the playhead is, so
 * the payload is kept for that.
 */
function openOverlay(role: OverlayRole, state: Handoff): { ok: boolean } {
  const win = getMainWindow();
  pendingHandoff = state;
  lastPillState = state;
  const overlay = getOverlayWindow(role);
  /*
   * Deliberately nothing about the media keys here. This used to call
   * `setMediaKeysHeld(false)` on the theory that a widget taking the foreground
   * should hand the transport over — but the hold stopped depending on focus the
   * day background gestures started working, and collapsing a card over a playing
   * song then left the keys unregistered with nothing left to re-assert them: the
   * deck was still playing, so `held === mediaKeysHeld` short-circuited every later
   * attempt. Audibility is the only input, and a window opening changes none.
   */
  /*
   * Both widgets have a transparent gutter, so both have to hand the clicks in it
   * back to whatever is underneath. This used to force the mini interactive across
   * its whole frame on the theory that it is exactly its card, edge to edge — but
   * the card is 250px inside a 378px window, so every pixel of that margin was
   * swallowing mouse moves and clicks that belonged to the application behind it.
   * The user could not click a control that sat under the card's own bottom edge,
   * and the film's controls lit up from a pointer nowhere near the widget.
   */
  overlayInteractive = true;
  overlay.setIgnoreMouseEvents(false);
  overlayHit = { rects: [], open: false };
  overlayHover = false;
  /*
   * Mini and pill share one window, so the topmost claim is a per-open decision
   * rather than a per-creation one: converting strip → card never rebuilds the
   * frame. Both claim it, because both are meant to stay in front of whatever the
   * user is working in.
   */
  overlay.setAlwaysOnTop(true, 'floating');
  /*
   * Mini and pill share one window, and capture exclusion is a property of the
   * window, not of the role currently drawn in it. Converting pill → mini never
   * recreates the frame, so a pill that had protected itself left the mini card
   * invisible to the user's screenshot tool for the rest of the session. The
   * pill's own renderer re-asserts this as soon as its backdrop comes up.
   */
  overlay.setContentProtection(false);
  startOverlayPoll();
  if (role !== 'pill') {
    /*
     * Mini and pill share one window, so converting between them never hides it.
     * The desk bar's re-assert loop keys off that window staying visible, which
     * means it happily keeps running after the card takes the window over — and
     * every second it re-applies the pill's geometry, turning the 250x250 card
     * into a 250x816 slab. Anything the pill owns has to be put down here.
     */
    appBar.release();
  }
  overlay.show();
  overlay.focus();

  /*
   * Dock the strip into the work area rather than over it. A pill that only
   * floats on top buries a maximized window's caption buttons under an opaque
   * bar, so the window controls are visible and unreachable; reserving the
   * strip's width makes the two surfaces sit side by side.
   */
  if (role === 'pill') {
    // The bar has to be told which edge before it is asked to hold one.
    appBar.setEdge(pillSide);
    appBar.reserve(overlay, PILL_STRIP_WIDTH);
    /*
     * Re-dock after the reservation, not before it. Windows pulls a window whose
     * right edge sits on the monitor edge back inside the work area the moment
     * that work area shrinks, which left the strip sitting one width in from the
     * edge with a clear channel of desktop beside it — the exact gap this pass
     * was meant to close. Setting the bounds again afterwards sticks, because
     * the work area has now stopped changing.
     */
    overlay.setBounds(overlayBounds(role));
  }
  /*
   * Now the frame is on screen at its final size, hand it the film if it is owed
   * one. Deliberately after the pill's re-dock above rather than before it: the
   * rectangle this computes is the window's *current* bounds, and a card measured
   * before its own geometry has settled is a picture placed against a box it is
   * about to leave.
   */
  syncFilmPictureTarget();
  /*
   * Tell the library window which widget is now on screen. Its own store field is
   * the only thing that lights the right switcher button, and it cannot know on
   * its own once the widget is a separate window — worse, switching mini to pill
   * happens entirely inside the overlay, so the library would keep believing the
   * old one is open.
   */
  if (!win.isDestroyed()) win.webContents.send('main:overlay-role', role);
  if (!pendingHandoff) return { ok: true };
  // Already-loaded renderers never fire did-finish-load again, so the payload
  // is also pushed straight away for the common case of a warm overlay.
  overlay.webContents.executeJavaScript('document.readyState', true)
    .then((ready) => {
      if (ready !== 'complete' || !pendingHandoff) return;
      overlay.webContents.send('pill:handoff', pendingHandoff);
      pendingHandoff = null;
    })
    .catch(() => undefined);
  return { ok: true };
}

function closeOverlay(state: Handoff): { ok: boolean } {
  const win = getMainWindow();
  lastPillState = state;
  const wasShowing = !!overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible();
  /*
   * The role has to be released here, and the frame with it. `hide()` used to leave
   * the window parked with `overlayRole === 'mini'` still set — which made every
   * later `window:set-view-mode` re-enter this function, re-send `main:handoff`, make
   * the library window call `setView` again, and call `set-view-mode` again. That loop
   * was visible as fullscreen mode snapping back to normal, and as the window fighting
   * the taskbar for the foreground after a minimize, because each pass calls `win.show()`
   * and `win.focus()`.
   *
   * Destroying the frame is what releases its renderer. `destroyOverlay()` clears
   * the role itself, immediately, so a `wasShowing` read has to happen above it and
   * the next `openOverlay()` takes its create-fresh branch instead of retargeting a
   * window that is on its way out. Reopening a widget now pays for a renderer boot it
   * used to avoid — that is the price of the ~88 MB back, and only someone who asked
   * for the widget again after putting it away ever pays it.
   */
  stopOverlayPoll();
  appBar.release();
  destroyOverlay();
  // Only hand back if the overlay was actually on screen. A redundant call must
  // not push another `main:handoff` at the library window.
  if (!wasShowing || win.isDestroyed()) return { ok: true };
  win.webContents.send('main:overlay-role', null);
  /*
   * Bring the window that is already there to the front. `restore()` first,
   * because a minimized window ignores `focus()` and `show()` alone leaves it
   * sitting in the taskbar; and never construct a second library window to work
   * around that.
   */
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('main:handoff', state);
  return { ok: true };
}

ipcMain.handle('pill:open', (_event, state: Handoff) => openOverlay('pill', state));

ipcMain.handle('pill:close', (_event, state: Handoff) => closeOverlay(state));

/*
 * Collapsing a widget is not the same as leaving it. Normal and Fullscreen from
 * the switcher convert the library window as well as closing the overlay; this
 * puts the widget away and leaves the library exactly where it already was —
 * which is the point of the two windows coexisting. Deliberately no
 * `main:handoff` and no show/focus: sending one is what re-entered setView and
 * produced the fullscreen-vs-taskbar loop described in closeOverlay().
 */
ipcMain.handle('overlay:collapse', () => {
  collapseOverlay();
  return { ok: true };
});

/**
 * Put the widget away and leave the library exactly where it already was.
 *
 * Collapsing is not the same as leaving: Normal and Fullscreen from the switcher
 * convert the library window as well as closing the overlay. Deliberately no
 * `main:handoff` and no show/focus — sending one is what re-entered `setView` and
 * produced the fullscreen-vs-taskbar loop described in `closeOverlay()`.
 *
 * Exported to the deck's own hook below, which is the one caller that is not the
 * user pressing a button.
 */
function collapseOverlay(): void {
  stopOverlayPoll();
  appBar.release();
  destroyOverlay();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('main:overlay-role', null);
  /*
   * Nothing to hand back. The widget never owned the deck and never decoded the
   * film, so putting it away leaves both exactly where they were — which is the whole
   * point of a widget being a hand on the player rather than a second one. The frame
   * goes with the widget rather than being hidden, because a card the user has just
   * dismissed has no more use for 88 MB of renderer than it has for the screen space.
   */
}

ipcMain.on('pill:state', (_event, state: Handoff) => {
  lastPillState = state;
});

/*
 * Move the strip to the other edge of the screen.
 *
 * Three things have to agree or the widget tears itself apart: the desk bar's
 * `uEdge` and rectangle, this window's bounds, and the renderer's mirrored
 * layout. The renderer owns its half and applies it optimistically on click, so
 * this only has to move the OS surfaces — and it must not reload the window to
 * do it, because a reload would drop the strip through a blank frame on every
 * press of a button whose whole job is to be in a different place.
 */
ipcMain.handle('pill:set-side', async (_event, side: BarEdge) => {
  const next: BarEdge = side === 'left' ? 'left' : 'right';
  if (next === pillSide) return { ok: true, side: next };
  pillSide = next;
  appBar.setEdge(next);
  const win = overlayWindow;
  if (win && !win.isDestroyed() && overlayRole === 'pill') {
    /*
     * Two attempts to fix the stall have now been made by guessing at the order of
     * events, and both changed the symptom rather than the bug: waiting on `moved`
     * moved the freeze from the centre of the screen to somewhere arbitrary, which
     * is what a listener that fires for *some* move rather than *the* move produces.
     *
     * So this no longer infers. `setBounds` on Windows is a synchronous
     * `MoveWindow`, so the bounds are re-read straight after it and compared with
     * what was asked for, and every step is logged. If the number that comes back
     * says the window is where it was told to be, the stall is in the renderer's
     * mirror and not in the OS; if it says the window has already been shoved
     * somewhere else, then something is moving it after the fact — the desk-bar
     * reservation changing the work area under a window that is docked to it is the
     * obvious candidate — and this has to be fixed against that, not against a
     * guess about event timing.
     */
    const wanted = overlayBounds('pill');
    const before = win.getBounds();
    win.setBounds(wanted);
    const after = win.getBounds();
    console.log(
      `[pill-side] -> ${next} wanted x=${wanted.x} before x=${before.x} after x=${after.x}` +
        `${after.x === wanted.x ? ' [landed]' : ' [MOVED BY SOMETHING ELSE]'}`,
    );
    win.once('moved', () => {
      const late = win.getBounds();
      console.log(`[pill-side] 'moved' later reported x=${late.x} y=${late.y} w=${late.width}`);
    });
  }
  return { ok: true, side: next };
});

ipcMain.handle('pill:get-side', () => ({ side: pillSide }));

/*
 * The pill window is wider than the strip it draws, so the empty gutter beside
 * it must not eat clicks meant for whatever is on the desktop underneath.
 *
 * This is decided from the main process, by watching the *global* cursor, rather
 * than by listening for pointer events in the pill's own renderer. That sounds
 * backwards and it is necessary: once a window is ignoring mouse events it is
 * not told where the mouse is. Electron's `forward: true` was supposed to patch
 * that hole, and measured against a real cursor it delivered nothing at all — so
 * a renderer-driven latch goes click-through once and can never come back, which
 * leaves a strip that is invisible and unclickable. Worse than the bug it fixes.
 *
 * So the renderer only reports geometry — the strip's box, and the box of any
 * panel currently open — and the poll below decides who gets the click.
 */
let overlayHit: {
  rects: Array<{ x: number; y: number; w: number; h: number; panel?: boolean }>;
  open: boolean;
} = {
  rects: [],
  open: false,
};

/** The last pointer state pushed to the widget, so `overlay:hover` is an edge. */
let overlayHover = false;

ipcMain.on('overlay:hit-rects', (event, payload: typeof overlayHit) => {
  if (!payload || !Array.isArray(payload.rects)) return;
  overlayHit = { rects: payload.rects, open: !!payload.open };
});

/*
 * Where a window sits inside the screen it is drawn on, in CSS pixels.
 *
 * The widget's glass refracts a live capture of the whole display, and a capture
 * is aligned to the display, not to the window. So the renderer has to slide the
 * frame by the window's own offset before the pixels behind a given corner of
 * the pill really are the pixels behind that corner of the desktop — otherwise
 * the glass shows the wallpaper two inches to the left of the wallpaper, and
 * every edge in the refraction is wrong.
 */
function captureGeometry(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  const d = screen.getDisplayMatching(b);
  return {
    // Size of the captured display in CSS pixels; the stream itself is this
    // multiplied by `scaleFactor` in device pixels.
    displayWidth: d.bounds.width,
    displayHeight: d.bounds.height,
    // Top-left of the window relative to top-left of that display.
    offsetX: b.x - d.bounds.x,
    offsetY: b.y - d.bounds.y,
    scaleFactor: d.scaleFactor,
  };
}

ipcMain.handle('overlay:capture-geometry', (event) =>
  captureGeometry(BrowserWindow.fromWebContents(event.sender)),
);

/**
 * Everything needed to reproduce Windows' own wallpaper geometry.
 *
 * The pill's capsule refracts the desktop wallpaper rather than a screen grab — a
 * grab of the monitor contains the strip, which is how every "live desktop" glass
 * on this window has ended up either a mirror tunnel or, after the first fix for
 * that, a copy of whatever application happened to sit beside it. Reading the file
 * is the only source that cannot contain the widget at all.
 *
 * But a file is not a placement. Windows does not stretch the wallpaper to the
 * monitor: it positions it according to `WallpaperStyle` and `TileWallpaper`, and
 * for Center, Tile, Mirror and Span it does so against the *virtual desktop* — the
 * union of every monitor — while Fit, Fill and Stretch are per monitor. Ignoring
 * that gives a strip that is blurring the right picture at the wrong coordinates,
 * which reads as a reflection even though nothing was ever captured.
 *
 * So main reports the settings and the topology, and `glass/capture` runs the same
 * arithmetic the shell does.
 */
ipcMain.handle('desktop:wallpaper', async () => {
  /*
   * One `reg query` per key, not one per value, and the two keys read in sequence.
   * Asking for four values meant four `reg.exe` processes, and four spawned
   * processes at cold start is exactly the moment this runs — enough of them lose
   * their window station or hit a sharing conflict, `execFile` reports an error,
   * and the handler answers "no wallpaper". The strip then renders with nothing in
   * it, which looks identical to the glass not working. One process per key halves
   * the exposure and every value in the key arrives together.
   */
  const readKey = (key: string): Promise<Record<string, string> | null> =>
    new Promise((resolve) => {
      execFile('reg', ['query', key], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const out: Record<string, string> = {};
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.trim().match(/^(.+?)\s+REG_[A-Z]+\s+([\s\S]*)$/);
          if (m) out[m[1]] = m[2].trim();
        }
        resolve(out);
      });
    });

  try {
    const desktop = await readKey('HKCU\\Control Panel\\Desktop');
    // `null` means the read failed, which is not the same answer as "no wallpaper
    // is set" — the renderer retries the first and stops politely on the second.
    if (!desktop) return { ok: false, path: null, style: '', tile: '', solid: '', displays: [], virtual: null };
    const colors = (await readKey('HKCU\\Control Panel\\Colors')) ?? {};

    let file = desktop['WallPaper'] ?? '';
    if (!file || !fs.existsSync(file)) {
      // A slideshow leaves `WallPaper` empty and the shell writes the current
      // frame here; it has no extension, which is why the renderer takes the
      // decode on faith rather than on a suffix.
      const local = process.env.LOCALAPPDATA || app.getPath('appData');
      const fallback = path.join(local, 'Microsoft', 'Windows', 'Shell', 'TranscodedWallpaper');
      file = fs.existsSync(fallback) ? fallback : '';
    }
    const box = (b: Electron.Rectangle) => ({ x: b.x, y: b.y, width: b.width, height: b.height });
    const displays = screen.getAllDisplays().map((d) => ({ ...box(d.bounds), scaleFactor: d.scaleFactor }));
    const bounds = screen.getAllDisplays().map((d) => d.bounds);
    const left = Math.min(...bounds.map((b) => b.x));
    const top = Math.min(...bounds.map((b) => b.y));
    const right = Math.max(...bounds.map((b) => b.x + b.width));
    const bottom = Math.max(...bounds.map((b) => b.y + b.height));
    return {
      ok: true,
      path: file || null,
      style: desktop['WallpaperStyle'] ?? '',
      tile: desktop['TileWallpaper'] ?? '',
      // The colour behind the letterbox bars of a Fit wallpaper, as "r g b".
      solid: colors['Background'] ?? '',
      displays,
      virtual: { x: left, y: top, width: right - left, height: bottom - top },
    };
  } catch {
    return { ok: false, path: null, style: '', tile: '', solid: '', displays: [], virtual: null };
  }
});

function setOverlayInteractive(win: BrowserWindow, on: boolean): void {
  if (on === overlayInteractive) return;
  overlayInteractive = on;
  try {
    win.setIgnoreMouseEvents(!on, { forward: !on });
  } catch {
    // A window mid-teardown can refuse this; the next tick re-applies it.
  }
}

let overlayPoll: NodeJS.Timeout | null = null;

function startOverlayPoll(): void {
  if (overlayPoll) return;
  let wasDown = false;
  overlayPoll = setInterval(() => {
    const win = overlayWindow;
    /*
     * Both widgets now have a transparent gutter, so both need this. It used to
     * bail out unless the role was pill, which was correct only while the mini
     * card filled its window exactly — a click anywhere in it was a click on the
     * card. With the margin, the alternative is a 128px band of dead desktop that
     * swallows every click landing on it.
     */
    if (!win || win.isDestroyed() || !win.isVisible() || !overlayRole) return;
    // No native bindings means no way to know where the cursor is, and the
    // safe failure is an ordinary window that takes its clicks.
    const point = mpvWindow.cursor();
    if (!point) {
      setOverlayInteractive(win, true);
      return;
    }
    const cursor = screen.screenToDipPoint(point);
    const box = win.getBounds();
    const lx = cursor.x - box.x;
    const ly = cursor.y - box.y;
    const inside =
      overlayHit.open ||
      overlayHit.rects.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h);
    setOverlayInteractive(win, inside);
    /*
     * A press that is not inside the open panel has to dismiss it from here.
     *
     * Two cases, and only one of them used to be handled. Outside the widget's own
     * window, the click belongs to whatever is underneath and never reaches this
     * renderer at all. Inside it is the newer half: both widgets are
     * `-webkit-app-region: drag` across their whole surface, so a press on the card
     * body is consumed by the window manager as the start of a drag and the page
     * sees no mousedown, no pointerdown and no mouseup for it — which means the
     * panel's own outside-click listener can never fire, and the dropdown just sat
     * there while the user clicked plainly on the card.
     *
     * A press *inside* a panel is excluded, because panels are `no-drag` and their
     * clicks do arrive normally; dismissing those would yank the surface away a
     * frame before the user's click on its slider landed.
     */
    const down = mpvWindow.leftDown();
    /*
     * Any reported box, not only the panel's.
     *
     * The panel is excluded from the dismiss because a press on its slider must
     * reach the slider, and the strip used to be *included* in the dismiss on the
     * reasoning that the window manager eats presses on the card body so the page
     * never sees them. In the pill nothing eats them: the strip has no drag region,
     * so a press there is a real press on a real control, and dismissing on it was
     * killing the volume and speed sliders the moment a dropdown was open.
     */
    const inPanel = overlayHit.rects.some(
      (r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h,
    );
    /*
     * Tell the widget where the pointer is, as an edge.
     *
     * The mini card cannot work this out for itself. Most of its surface is
     * `-webkit-app-region: drag` and the window goes click-through the moment the
     * cursor leaves the reported boxes, so `mousemove` in the renderer is
     * intermittent and `mouseleave` fires for a pointer that never left the card.
     * This poll already knows the true answer from the desktop's own cursor
     * position, so it is the one place the reveal can be driven from.
     */
    if (inside !== overlayHover) {
      overlayHover = inside;
      win.webContents.send('overlay:hover', inside);
    }
    /*
     * Read as an edge, because `GetAsyncKeyState`'s low bit reports "pressed
     * since anyone last asked" and this poll runs whether or not anything is open.
     */
    if (down && !wasDown && overlayHit.open && !inPanel) win.webContents.send('overlay:dismiss');
    wasDown = down;
  }, 60);
}

function stopOverlayPoll(): void {
  if (!overlayPoll) return;
  clearInterval(overlayPoll);
  overlayPoll = null;
}

ipcMain.on('overlay:interactive', (event, on: boolean) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  setOverlayInteractive(win, !!on);
});

/*
 * The mini player is the one widget whose size is the content's: a film gets a
 * rectangle of its own ratio rather than the square music card, so the window
 * has to follow. The renderer says how big, because only it knows the film's
 * dimensions; main keeps the centre put, because only it knows where the user
 * dragged the card to.
 */
ipcMain.on('overlay:set-size', (event, size: { width: number; height: number } | null) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win !== overlayWindow) return;
  if (size && Number.isFinite(size.width) && Number.isFinite(size.height)) {
    miniSizeOverride = {
      width: Math.min(1200, Math.max(200, Math.round(size.width))),
      height: Math.min(1200, Math.max(200, Math.round(size.height))),
    };
  } else {
    miniSizeOverride = null;
  }
  if (overlayRole !== 'mini') return;
  const now = win.getBounds();
  const wanted = overlayBounds('mini');
  win.setBounds({
    x: Math.round(now.x + now.width / 2 - wanted.width / 2),
    y: Math.round(now.y + now.height / 2 - wanted.height / 2),
    width: wanted.width,
    height: wanted.height,
  });
  /*
   * The card was asked to become a film's rectangle, so the picture inside it has a
   * new one too. `resized` fires for this as well and re-asserts the same numbers;
   * doing it here too is what keeps the two halves honest when a platform decides to
   * coalesce the event, which it does when the move and the resize land in one call.
   */
  syncFilmPictureTarget();
});

/**
 * Create a playlist folder.
 *
 * A playlist in this app is a directory that has been pinned, so "new playlist"
 * has to be able to make one. Refuses to overwrite: an existing folder of the same
 * name is still offered as a pin, because the user may well have put music in it
 * already, but silently merging a new playlist into it would be worse than saying no.
 */
ipcMain.handle('fs:create-folder', async (_event, parent: string, name: string) => {
  const clean = (name || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '');
  if (!clean) return { ok: false as const, error: 'That name cannot be used for a folder.' };
  if (!parent || !fs.existsSync(parent)) return { ok: false as const, error: 'Choose a folder for it to live in.' };
  const target = path.join(parent, clean);
  try {
    if (fs.existsSync(target)) {
      return { ok: false as const, error: `"${clean}" already exists. Pin it instead of creating it.` };
    }
    await fs.promises.mkdir(target);
    return { ok: true as const, path: target };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
});

// File system access
ipcMain.handle('dialog:open-folder', async (_event) => {  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: 'Select Music Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

ipcMain.handle('dialog:open-file', async (_event, options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: options?.title ?? 'Open File',
    properties: ['openFile'],
    filters: options?.filters,
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

/*
 * The many-file variant, for filling a playlist from the folder tree.
 *
 * A separate channel rather than an `allowMultiple` flag on the one above,
 * because that handler's contract is "a path or null" and eleven call sites
 * destructure it as a string. Returning an array here keeps both honest.
 */
ipcMain.handle('dialog:open-files', async (_event, options?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
  const result = await dialog.showOpenDialog(getMainWindow(), {
    title: options?.title ?? 'Open Files',
    properties: ['openFile', 'multiSelections'],
    filters: options?.filters,
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle('dialog:save-file', async (_event, options?: { title?: string; defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
  const result = await dialog.showSaveDialog(getMainWindow(), {
    title: options?.title ?? 'Save File',
    defaultPath: options?.defaultPath,
    filters: options?.filters,
  });
  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
});

ipcMain.handle('fs:read-file', async (_event, filePath: string) => {
  return fs.promises.readFile(filePath, 'utf8');
});

/*
 * Save, or remove, the `.lrc` that belongs to a song.
 *
 * Deliberately not a general "write this file" endpoint. The renderer passes the
 * *audio* path and main derives the sidecar from it, so the only location this
 * can ever touch is `<that file's directory>/<that file's basename>.lrc`. A
 * renderer that could name an output path could overwrite anything the user can
 * read, and the only thing this feature has ever needed is the file beside the
 * song — which is also exactly what the library scanner looks for on a rescan.
 */
function sidecarFor(audioPath: unknown): string | null {
  if (typeof audioPath !== 'string' || !audioPath) return null;
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const target = path.join(dir, `${stem}.lrc`);
  // Refuse a path that escaped its own directory through `..` or a stray separator.
  if (path.dirname(target) !== path.resolve(dir)) return null;
  return target;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('lyrics:save', async (_event, audioPath: string, content: string) => {
  const target = sidecarFor(audioPath);
  if (!target) return { ok: false, error: 'not a song path' };
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'nothing to save' };
  try {
    await fs.promises.writeFile(target, content, 'utf8');
    return { ok: true, path: target };
  } catch (e) {
    // Read-only media, a file open elsewhere, or a folder the user cannot write.
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('lyrics:delete', async (_event, audioPath: string) => {
  const target = sidecarFor(audioPath);
  if (!target) return { ok: false, error: 'not a song path' };
  /*
   * Retried, and then verified rather than trusted.
   *
   * Windows answers `unlink` with EPERM while anything at all still holds the
   * file — Defender, the search indexer, an editor — and a lyrics file written a
   * second ago by the Save button is exactly the case. Reporting success on a
   * resolved promise was enough to make the card go blank while the `.lrc` sat
   * there on disk, which is the failure the user would notice: "I deleted it and
   * it came back". So ask the filesystem afterwards, and say what it says.
   */
  let lastError = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.promises.unlink(target);
      if (!fs.existsSync(target)) return { ok: true, path: target };
      return { ok: false, error: 'the file is still there' };
    } catch (e) {
      lastError = String(e);
      if (!fs.existsSync(target)) return { ok: true, path: target };
      await sleep(120 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError || 'could not remove the file' };
});

ipcMain.handle('fs:path-exists', async (_event, filePath: string) => {
  return fs.existsSync(filePath);
});

ipcMain.handle('fs:list-dir', async (_event, dirPath: string) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return await Promise.all(
      entries.map(async (entry) => {
        const base = {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
        };
        if (!entry.isFile()) return base;
        // Size + mtime let the renderer tell an untouched file from an
        // edited one without re-reading any audio metadata.
        try {
          const st = await fs.promises.stat(path.join(dirPath, entry.name));
          return { ...base, size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return base;
        }
      }),
    );
  } catch {
    return [];
  }
});

// Scanning 300+ files means parsing every tag and cover image, which took
// long enough to dominate both startup and every dev reload. The scan's result is
// kept on disk here and revalidated by size/mtime in the renderer, so a launch
// reads a file instead of decoding the library again — the parse of that file is
// deliberately not also kept in memory (see `readLibraryIndex`).
const libraryCacheFile = () => path.join(app.getPath('userData'), 'library-cache.json');

/** One row of `<userData>/library-cache.json`, as the renderer writes it. */
type LibraryCacheEntry = { stamp: string; track: Record<string, unknown> };

/**
 * The library index, parsed per request and never kept.
 *
 * Two windows ask for this file and neither of them can use a second copy of its
 * 23 MB of base64 covers: the parsed blob is what dominated both startup and
 * every dev reload, and the pill used to pay it again in its own process.
 *
 * The widget gets the same rows with every `albumArt` replaced by null. A cover is
 * 56 KB per track, and a floating card paints at most eight of them at once, so the
 * ones it needs come from `media:read-tags` on demand instead of being carried
 * around for the whole library.
 *
 * This used to memoise the parse *and* a second copy of it with the covers nulled,
 * on the reasoning that parsing is not free and every dev reload asks again. What it
 * actually cost was both objects pinned for the life of the app — 437 tracks of
 * ASCII base64 is ~22.5 MB of strings, and the stripped copy adds its own 437
 * object shells — in a browser process measured at 104 MB. Neither memo had a
 * second reader to justify it: each window reads the cache exactly once per process
 * (`loadLibraryCache` memoises it in the renderer) and keeps its own copy from then
 * on, so main was holding a reference to data only it could still see.
 *
 * Parsing per request keeps nothing. The one thing worth still folding is the read
 * itself: the library window and a widget boot at the same moment, and on two
 * logical cores two concurrent 22 MB parses is worse than one shared, so
 * `pendingIndex` lets requests that overlap in time share one parse and is cleared
 * as soon as it has settled.
 */
let pendingIndex: Promise<Record<string, LibraryCacheEntry> | null> | null = null;

/**
 * The stripped copy the widget is served, built as its own object rather than by
 * nulling the parse in place: the shared parse may still be on its way to the
 * library window, which needs the covers. It is garbage the moment the reply is
 * written, which is the whole point.
 */
function withoutArt(index: Record<string, LibraryCacheEntry>): Record<string, LibraryCacheEntry> {
  const stripped: Record<string, LibraryCacheEntry> = {};
  for (const [file, entry] of Object.entries(index)) {
    stripped[file] = { ...entry, track: { ...entry.track, albumArt: null } };
  }
  return stripped;
}

async function readLibraryIndex(): Promise<Record<string, LibraryCacheEntry> | null> {
  if (pendingIndex) return pendingIndex;
  const parse = (async (): Promise<Record<string, LibraryCacheEntry> | null> => {
    try {
      const raw = await fs.promises.readFile(libraryCacheFile(), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, LibraryCacheEntry>;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      // No cache yet — the first scan writes one.
      return null;
    }
  })();
  pendingIndex = parse;
  // Released on settling, not on the reply: an awaiting handler holds its own
  // reference, and anything arriving after this lands pays for its own read rather
  // than being served a blob that has outlived its readers.
  void parse.finally(() => {
    if (pendingIndex === parse) pendingIndex = null;
  });
  return parse;
}

ipcMain.handle('library:load-cache', async () => {
  const index = await readLibraryIndex();
  if (!index) return null;
  /*
   * Neither reader is served the covers, which is a change from the library window
   * being handed the file exactly as written on the argument that it owns the artwork.
   * It does not: 22 MB of base64 in the process that also runs the glass, for a list
   * that shows ten rows at a time, was the single largest thing in its heap. It now
   * asks for the cover of whichever row is on screen, per row, through
   * `media:read-tags`, and the playing row's art arrives by push — see
   * `fillCurrentCover` in src/audio/engine.ts.
   *
   * Deciding which window asked used to be necessary, and had to happen before the
   * await because the parse is slow enough for a widget to collapse during it. With one
   * reply for both, there is nothing left to decide early.
   */
  return withoutArt(index);
});

/**
 * The covers the writer no longer has, put back from the copy on disk.
 *
 * The renderer's library rows carry `albumArt: null` by design now, so any cache
 * written from them would blank every cover in the file — and unlike the rest of a
 * track, a cover cannot be re-derived without opening the media again. Entries whose
 * `stamp` matches are the same bytes on disk the stored row was read from, so a null
 * there means "this window never held the art" and the stored copy wins. A different
 * stamp means the file changed underneath us, and whatever the scan just read is the
 * truth, including a cover the user genuinely removed.
 */
function keepStoredArt(
  stored: Record<string, LibraryCacheEntry>,
  incoming: Record<string, LibraryCacheEntry>,
): Record<string, LibraryCacheEntry> {
  const merged: Record<string, LibraryCacheEntry> = {};
  for (const [file, entry] of Object.entries(incoming)) {
    const previous = stored[file];
    const art = entry?.track?.albumArt;
    const bare = art === null || art === undefined;
    if (previous && bare && previous.stamp === entry.stamp && previous.track?.albumArt) {
      merged[file] = { ...entry, track: { ...entry.track, albumArt: previous.track.albumArt } };
    } else {
      merged[file] = entry;
    }
  }
  return merged;
}

ipcMain.handle('library:save-cache', async (_event, data: unknown) => {
  try {
    const file = libraryCacheFile();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const incoming = (
      data && typeof data === 'object' ? data : {}
    ) as Record<string, LibraryCacheEntry>;
    // Read from disk before overwriting it, so the merge has something to keep.
    const stored = await readLibraryIndex();
    const next = stored ? keepStoredArt(stored, incoming) : incoming;
    // Written beside the target and renamed over it, so an interrupted
    // write can never leave a half-written cache behind.
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(next), 'utf8');
    await fs.promises.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
});

/*
 * The playlists this app owns: `<userData>/playlists/<name>.m3u8`, one absolute audio
 * path per line. Deliberately not a general "write this file" endpoint — the renderer
 * names a *playlist* and main derives the file inside one folder it created itself, so
 * a name that would escape that folder, or land on a playlist the user did not mean to
 * touch, is refused rather than honoured. A rename moves the file and rewrites nothing,
 * which is what keeps the entries the user made through the rename.
 */
const playlistDir = () => path.join(app.getPath('userData'), 'playlists');

/** The file a playlist name means, or null when the name cannot be one. */
function playlistFile(name: unknown): string | null {
  const clean = typeof name === 'string' ? name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '') : '';
  if (!clean) return null;
  const target = path.join(playlistDir(), `${clean}.m3u8`);
  if (path.dirname(target) !== path.resolve(playlistDir())) return null;
  return target;
}

/** Written as CRLF, which is what a `.m3u8` opens as in Notepad on this platform. */
const writePlaylist = async (target: string, entries: unknown) => {
  const lines = Array.isArray(entries)
    ? entries.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : null;
  if (!lines) throw new Error('not a list of paths');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, lines.length ? `${lines.join('\r\n')}\r\n` : '', 'utf8');
};

ipcMain.handle('playlist:create', async (_event, name: unknown, entries: unknown) => {
  const target = playlistFile(name);
  if (!target) return { ok: false as const, error: 'That name cannot be used for a playlist.' };
  try {
    if (fs.existsSync(target)) {
      return { ok: false as const, error: 'A playlist with that name already exists.' };
    }
    await writePlaylist(target, entries);
    return { ok: true as const, path: target };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
});

ipcMain.handle('playlist:write', async (_event, name: unknown, entries: unknown) => {
  const target = playlistFile(name);
  if (!target) return { ok: false as const, error: 'That name cannot be used for a playlist.' };
  try {
    await writePlaylist(target, entries);
    return { ok: true as const, path: target };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
});

ipcMain.handle('playlist:rename', async (_event, from: unknown, to: unknown) => {
  const source = playlistFile(from);
  const target = playlistFile(to);
  if (!source || !target) return { ok: false as const, error: 'That name cannot be used for a playlist.' };
  try {
    if (!fs.existsSync(source)) return { ok: false as const, error: 'That playlist is not on disk.' };
    if (source === target) return { ok: true as const, path: target };
    if (fs.existsSync(target)) {
      return { ok: false as const, error: 'A playlist with that name already exists.' };
    }
    await fs.promises.rename(source, target);
    return { ok: true as const, path: target };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
});

ipcMain.handle('playlist:remove', async (_event, name: unknown) => {
  const target = playlistFile(name);
  if (!target) return { ok: false as const, error: 'That name cannot be used for a playlist.' };
  try {
    // `force` so removing a playlist whose file the user already deleted is still a
    // success — the tab in the store is the thing that has to go either way.
    await fs.promises.rm(target, { force: true });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
});

// Convert an arbitrary local file to a data URL (used for wallpaper thumbnails)
ipcMain.handle('fs:file-to-data-url', async (_event, filePath: string) => {
  try {
    const buf = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : ext === 'avif' ? 'image/avif'
      : ext === 'bmp' ? 'image/bmp'
      : 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
});

// ─────────────────────────────────────────────────────────────
// ffmpeg-backed media analysis (loudness, waveform peaks, posters)
// ─────────────────────────────────────────────────────────────

ipcMain.handle('media:analyze', async (_event, filePath: string, durationSec: number) => {
  return analyzeLoudness(filePath, durationSec);
});

ipcMain.handle('media:peaks', async (_event, filePath: string, count: number) => {
  return extractPeaks(filePath, Math.max(16, Math.min(4000, Math.round(count))));
});

ipcMain.handle('media:poster', async (_event, filePath: string, atSec?: number) => {
  return extractPoster(filePath, atSec ?? 1);
});

ipcMain.handle('media:write-tags', async (_event, filePath: string, tags: TagWrite) => {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'That file is not there any more.' };
  return writeTags(filePath, tags);
});

/*
 * Tags without the whole file.
 *
 * The scan used to fetch every track through `media://` and hand the resulting
 * Blob to the tag parser, which for a 437-file, 34-hour library means reading the
 * entire collection off disk — measured at twenty-five minutes and roughly half a
 * 2-core CPU, with the renderer heap climbing past 380 MB while it ran. Tag
 * parsers only read the header and, for a few containers, the tail, so this lets
 * music-metadata's Node reader do that over `fs` and returns only what the library
 * keeps.
 *
 * The cover comes back as raw bytes rather than a finished data URL because the
 * shrink to `ART_MAX_PX` belongs with the encoder, which needs a canvas and so
 * lives in the renderer. Duration is asked for cheaply — `duration: false` — and
 * the caller falls back to the old path for the few containers that only answer
 * it after a full scan, so a headerless MP3 still gets a length.
 */
ipcMain.handle('media:read-tags', async (_event, filePath: string) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    /*
     * The bundler resolves `music-metadata` to its browser entry, whose types stop
     * at `parseBlob`, but this runs in the main process where the Node entry is
     * what actually loads — and that one exports `parseFile`. The cast is the seam
     * between the two, and it claims only the fields read below rather than
     * pretending to know the whole result.
     */
    const mm = (await import('music-metadata')) as unknown as {
      parseFile: (
        file: string,
        opts?: { duration?: boolean; skipCovers?: boolean },
      ) => Promise<{
        format: Record<string, unknown>;
        common: {
          title?: string;
          artist?: string;
          albumartist?: string;
          album?: string;
          year?: number;
          genre?: string | string[];
          track?: { no?: number };
          lyrics?: Array<string | { text?: string }>;
          picture?: Array<{ data?: Uint8Array; format?: string }>;
        };
      }>;
    };
    const { format: fmt, common } = await mm.parseFile(filePath, {
      duration: false,
      skipCovers: false,
    });
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const picture = common.picture?.[0];
    const lyrics = Array.isArray(common.lyrics) ? common.lyrics : [];
    return {
      format: String(fmt.container || fmt.codec || ''),
      duration: num(fmt.duration),
      sampleRate: num(fmt.sampleRate),
      bitrate: num(fmt.bitrate),
      bitDepth: num(fmt.bitsPerSample),
      channels: num(fmt.numberOfChannels),
      title: common.title ?? '',
      artist: common.artist ?? common.albumartist ?? '',
      album: common.album ?? '',
      year: typeof common.year === 'number' ? common.year : null,
      genre: Array.isArray(common.genre) ? common.genre.join(', ') : common.genre ?? '',
      track: common.track?.no ?? null,
      lyrics: lyrics
        .map((entry) => (typeof entry === 'string' ? entry : entry?.text ?? ''))
        .filter((text) => text.trim()),
      picture: picture?.data?.length
        ? { data: new Uint8Array(picture.data), mime: picture.format || 'image/jpeg' }
        : null,
    };
  } catch {
    // Not a container the Node reader understands; the caller has another way.
    return null;
  }
});

ipcMain.handle('media:ffmpeg-available', () => ffmpegAvailable());

ipcMain.handle('app:get-user', () => getUserInfo());

ipcMain.handle('app:get-version', () => app.getVersion());

ipcMain.handle('app:get-platform', () => process.platform);

/*
 * Launch with Windows.
 *
 * `open-at-login` is the only honest way to do this on Windows 11: it writes the
 * per-user login item the shell itself manages, so the entry appears in Task
 * Manager's Startup tab where the user can see and kill it. Writing the `Run`
 * key by hand would work too and is what older apps do, but it is invisible
 * there, which reads as something having installed itself.
 */
ipcMain.handle('app:set-auto-launch', (_event, on: boolean) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('app:get-auto-launch', () => {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
});

ipcMain.handle('app:open-external', (_event, url: string) => {
  shell.openExternal(url);
});

// Hand a file to the OS default application (fallback for codecs Chromium lacks)
ipcMain.handle('app:open-path', async (_event, filePath: string) => {
  const error = await shell.openPath(filePath);
  return error || null;
});

ipcMain.handle('app:show-in-folder', (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

// ─────────────────────────────────────────────────────────────
// Dev-only debug bridge: lets the agent screenshot / evaluate /
// click inside the running app on http://127.0.0.1:4711
// ─────────────────────────────────────────────────────────────

function startDebugBridge(): void {
  // Screenshots must land outside the project tree: a write anywhere under
  // the Vite root triggers a full page reload, which wiped the running
  // session's state every time a capture was taken.
  const shotsDir = path.join(app.getPath('temp'), 'silent-chaos-shots');
  let counter = 0;

  // Renderer console + load failures, so /console can explain a dead UI
  const logs: string[] = [];
  const record = (tag: string, text: string) => {
    const line = `[${tag}] ${text}`;
    logs.push(line);
    if (logs.length > 500) logs.shift();
    console.log(line);
  };
  const attachDiagnostics = (contents: Electron.WebContents) => {
    contents.on('console-message', (_e, level, message, line, source) => {
      record(['verbose', 'info', 'warning', 'error'][level] ?? 'log', `${message} (${source}:${line})`);
    });
    contents.on('did-fail-load', (_e, code, desc, url) => record('did-fail-load', `${code} ${desc} ${url}`));
    contents.on('render-process-gone', (_e, details) => {
      record('render-process-gone', JSON.stringify(details));
      // A dead renderer leaves a white window and a hung debug bridge;
      // reloading brings the session back without a full app restart.
      const win = BrowserWindow.fromWebContents(contents);
      if (win && !win.isDestroyed()) win.reload();
    });
    contents.on('preload-error', (_e, preloadPath, error) => record('preload-error', `${preloadPath} ${error.message}`));
  };
  if (mainWindow) attachDiagnostics(mainWindow.webContents);
  app.on('browser-window-created', (_e, win) => attachDiagnostics(win.webContents));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, body: string, type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    const win = url.searchParams.get('win') === 'main'
      ? getMainWindow()
      : bridgeWindow();
    if (!win) {
      send(503, 'no window');
      return;
    }
    try {
      if (url.pathname === '/shot' || url.pathname === '/osshot') {
        fs.mkdirSync(shotsDir, { recursive: true });
        const file = path.join(shotsDir, `${url.pathname.slice(1)}-${++counter}.png`);
        if (url.pathname === '/shot') {
          win.webContents.capturePage().then((img) => {
            fs.promises.writeFile(file, img.toPNG()).then(() => send(200, file)).catch((e) => send(500, String(e)));
          }).catch((e) => send(500, String(e)));
          return;
        }
        desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2560, height: 1600 } }).then((sources) => {
          const own = sources.find((s) => s.name.includes('ChaosX'));
          if (!own) {
            send(404, 'window source not found: ' + sources.map((s) => s.name).join(' | '));
            return;
          }
          fs.promises.writeFile(file, own.thumbnail.toPNG()).then(() => send(200, file)).catch((e) => send(500, String(e)));
        }).catch((e) => send(500, String(e)));
        return;
      }
      /*
       * A whole-monitor grab through the same path the widget's live backdrop
       * uses. This is the only way to answer "is the widget excluded from its own
       * capture" — which is a question about the compositor, and every renderer
       * side probe can only report what the pixels look like, not who drew them.
       */
      if (url.pathname === '/screengrab') {
        fs.mkdirSync(shotsDir, { recursive: true });
        const file = path.join(shotsDir, `screen-${++counter}.png`);
        desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }).then((sources) => {
          if (!sources.length) {
            send(404, 'no screen source');
            return;
          }
          fs.promises.writeFile(file, sources[0].thumbnail.toPNG()).then(() => send(200, file)).catch((e) => send(500, String(e)));
        }).catch((e) => send(500, String(e)));
        return;
      }
      if (url.pathname === '/console') {
        send(200, logs.join('\n') || '(no renderer output)');
        return;
      }
      if (url.pathname === '/overlay') {
        const win = overlayWindow;
        const point = mpvWindow.cursor();
        send(
          200,
          JSON.stringify({
            role: overlayRole,
            interactive: overlayInteractive,
            hasWindow: !!win && !win.isDestroyed() && win.isVisible(),
            box: win && !win.isDestroyed() ? win.getBounds() : null,
            cursor: point,
            dip: point ? screen.screenToDipPoint(point) : null,
            hit: overlayHit,
            appBar: { available: appBar.available, error: appBar.error, holding: appBar.isHolding },
            workArea: screen.getPrimaryDisplay().workArea,
            displayBounds: screen.getPrimaryDisplay().bounds,
          }),
        );
        return;
      }
      if (url.pathname === '/raise') {
        /*
         * Bring the window under the cursor's attention, from the app's own
         * process. Nothing else in the harness can do it: `SetForegroundWindow`
         * from another process is refused by the Windows foreground lock, and
         * every capture taken while the app sits behind someone else's window
         * shows that other window and not the app.
         */
        const target = url.searchParams.get('win') === 'overlay' ? overlayWindow : getMainWindow();
        if (!target || target.isDestroyed()) {
          send(503, 'no window');
          return;
        }
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
        send(200, `raised ${target.getTitle()}`);
        return;
      }
      if (url.pathname === '/af') {
        /*
         * Put a filter chain on the live deck that the builder cannot produce, and
         * report what the filter says it is running. A/B-ing `window=short` against
         * `window=long` otherwise costs a rebuild per attempt, and a rebuild per
         * attempt is how a parameter gets blamed for the wrong reason.
         */
        const chain = url.searchParams.get('chain');
        if (chain === null) {
          send(200, JSON.stringify({ current: mpvEngine.currentAf() }));
          return;
        }
        mpvEngine
          .setRawAf(chain)
          .then((r) => send(200, JSON.stringify(r)))
          .catch((e) => send(500, String(e)));
        return;
      }
      if (url.pathname === '/sweep') {
        // What the pill's overlap guard saw last time it ran. The sweep moves
        // windows owned by other processes, so "the window is out of the band"
        // is not evidence that the guard put it there.
        send(200, JSON.stringify(appBar.lastSweep));
        return;
      }
      if (url.pathname === '/taskbar') {
        const how = url.searchParams.get('do');
        if (!how) {
          send(200, JSON.stringify(taskbar.probe()));
          return;
        }
        send(
          200,
          JSON.stringify(
            taskbar.act(how, url.searchParams.get('on') !== '0', url.searchParams.get('v') ?? ''),
          ),
        );
        return;
      }
      if (url.pathname === '/window') {
        /*
         * The library window's own account of itself, and a lever on it.
         *
         * "Maximise does nothing" can only be told apart from "maximise worked and
         * you cannot see it" by reading all three of Electron's idea of the state,
         * Windows' `IsZoomed`, and the style word — and then by being able to drive
         * each of the four ways a window changes size (the caption button, a bounds
         * write, `setFullScreen`, `setKiosk`) without a rebuild between attempts.
         */
        const w = getMainWindow();
        if (!w || w.isDestroyed()) {
          send(503, 'no window');
          return;
        }
        const doWhat = url.searchParams.get('do');
        const on = url.searchParams.get('on') !== '0';
        const v = url.searchParams.get('v') ?? '';
        try {
          if (doWhat === 'max') w.maximize();
          else if (doWhat === 'unmax') w.unmaximize();
          /*
           * The same two moves through `ShowWindow`, kept beside Electron's so the
           * difference between them is one request apart rather than one rebuild
           * apart: `max` leaves `IsZoomed` false and a sizing border of desktop
           * showing, `zoom` does not.
           */
          else if (doWhat === 'zoom') mpvWindow.zoom(w, true);
          else if (doWhat === 'unzoom') mpvWindow.zoom(w, false);
          else if (doWhat === 'min') w.minimize();
          else if (doWhat === 'restore') w.restore();
          else if (doWhat === 'fs') w.setFullScreen(on);
          else if (doWhat === 'kiosk') w.setKiosk(on);
          else if (doWhat === 'topmost') w.setAlwaysOnTop(on);
          else if (doWhat === 'resizable') w.setResizable(on);
          else if (doWhat === 'bounds') {
            const [x, y, bw, bh] = v.split(',').map(Number);
            w.setBounds({ x, y, width: bw, height: bh });
          } else if (doWhat === 'minw') {
            w.setMinimumSize(Number(v), 560);
          } else if (doWhat === 'minbox') {
            /*
             * Put `WS_MINIMIZEBOX` back on a window whose frame has been stripped, and
             * nothing else. `stripFrame` clears all five decoration bits at once, and one
             * of them is the flag that tells the shell this window is allowed to be
             * minimized — which is why Win+D walks past the takeover. This says whether
             * that one bit is the whole cause.
             */
            const r = mpvWindow.setMinimisable(w, on);
            send(200, JSON.stringify({ did: doWhat, ...r }));
            return;
          }
        } catch (e) {
          send(500, `${doWhat} threw: ${(e as Error).message}`);
          return;
        }
        send(
          200,
          JSON.stringify({
            did: doWhat ?? null,
            bounds: w.getBounds(),
            content: w.getContentBounds(),
            maximized: w.isMaximized(),
            zoomed: mpvWindow.isZoomed ? mpvWindow.isZoomed(w) : null,
            full: w.isFullScreen(),
            kiosk: w.isKiosk(),
            minimised: w.isMinimized(),
            visible: w.isVisible(),
            focused: w.isFocused(),
            resizable: w.isResizable(),
            maximisable: w.isMaximizable(),
            fullscreenable: w.isFullScreenable(),
            alwaysOnTop: w.isAlwaysOnTop(),
            style: mpvWindow.styleOf(w),
            styleBits: mpvWindow.styleBits(w),
            minSize: (w as any).getMinimumSize?.() ?? null,
            immersiveSaved: immersiveRestore,
            workArea: screen.getPrimaryDisplay().workArea,
            displayBounds: screen.getPrimaryDisplay().bounds,
          }),
        );
        return;
      }
      if (url.pathname === '/eval') {
        const js = url.searchParams.get('js') ?? '';
        win.webContents.executeJavaScript(js, true).then((result) => {
          send(200, JSON.stringify(result ?? null));
        }).catch((e) => send(500, String(e)));
        return;
      }
      if (url.pathname === '/move') {
        const x = Number(url.searchParams.get('x') ?? 0);
        const y = Number(url.searchParams.get('y') ?? 0);
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
        send(200, 'moved');
        return;
      }
      if (url.pathname === '/click') {
        const x = Number(url.searchParams.get('x') ?? 0);
        const y = Number(url.searchParams.get('y') ?? 0);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        send(200, 'clicked');
        return;
      }
      if (url.pathname === '/key') {
        const k = url.searchParams.get('k') ?? 'Escape';
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
        win.webContents.sendInputEvent({ type: 'char', keyCode: k });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
        send(200, 'key ' + k);
        return;
      }
      if (url.pathname === '/mpvwin') {
        // The native picture's own report: what the renderer asked for, what
        // `SetWindowPos` was given, and what Windows says the child actually
        // occupies. The three disagreeing is the whole of "the video is cropped".
        send(200, JSON.stringify(mpvWindow.debug()));
        return;
      }
      send(404, 'unknown endpoint');
    } catch (e) {
      send(500, String(e));
    }
  });
  server.listen(4711, '127.0.0.1');
}

/**
 * The bridge follows whichever window the user is actually looking at, so a
 * screenshot taken while the pill overlay is up captures the overlay instead of
 * the hidden library window behind it.
 */
function bridgeWindow(): BrowserWindow | null {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) return overlayWindow;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/*
 * Nothing here keeps a renderer alive any more: that promise is made per window,
 * in the `webPreferences` of the two windows that need it.
 *
 * Three switches used to sit on this line — `disable-renderer-backgrounding`,
 * `disable-backgrounding-occluded-windows` and `disable-background-timer-throttling`
 * — and each was right for the app that wrote it. Music used to be an `AudioContext`
 * fed by a media element in the library renderer, so a window Chromium decided
 * nobody was looking at had its timers clamped to 1 Hz and its compositor
 * deprioritised, which starves the Web Audio render thread: the crackle, the
 * drop-outs, the "it just stopped". Playback has since moved to mpv, a separately
 * spawned process that no Chromium switch reaches, and what is left inside a
 * renderer is the glass animation and a film's audio graph — both of which belong
 * to a window that is on screen, and both of which the per-window flag already
 * covers. What the switches bought after that move was nothing except the promise
 * that *no* window may ever go quiet: a minimised or covered window keeps painting,
 * keeps its compositor surfaces and keeps a 60 Hz frame loop on a machine with two
 * cores to spare. A command line is process-global and cannot be scoped, so they
 * went, and the flag that was already set on both windows is now the only thing
 * holding the original guarantee.
 *
 * Verified on the process itself rather than assumed: with the three gone, no
 * renderer, GPU or utility command line carries `disable-renderer-backgrounding`,
 * `disable-backgrounding-occluded-windows` or `disable-background-timer-throttling`,
 * while a track still loads, still pre-buffers its successor into the standby deck
 * and still survives a window reload underneath it. Note what that leaves for the
 * memory hunt: in the configuration that gets measured — one library window, visible
 * and focused, no widget built yet — nothing was ever backgrounded, so these switches
 * cannot have been the bytes. What they cost was CPU and full residency in the
 * configurations a clean-start snapshot does not show: a minimised window, a covered
 * window, a window sitting behind the thing the user is actually using. The fade and
 * the media keys were not re-tested here; they live in the main process and in mpv,
 * which is the argument for why they outlive a renderer being backgrounded, not a
 * measurement that says so.
 */

/*
 * Sibling of the three above, and the one that stays, because there is no
 * per-window API for it. Chromium on Windows walks the Z-order to decide whether a
 * window is actually visible, and a `transparent: true` frame is mostly
 * hit-test-transparent pixels that the enumerator can count as an occluding surface
 * — which would let it mark a widget nobody occluded as hidden. Our own two hosts
 * now refuse to be backgrounded regardless of what that probe concludes, so this
 * flag is no longer load-bearing for them; it is kept because the failure it guards
 * is a silent one, and because dropping it is a change to make while watching the
 * pill for a frame crawl, not one to slip into a memory pass. The measurement that
 * mattered (the mini card's film crawling at a frame a second) turned out to be the
 * glass shader rather than this.
 */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');


/*
 * Dev only, and for one specific reason: `performance.memory.usedJSHeapSize` is a
 * committed-heap figure, not a liveness figure, so a renderer that has allocated and
 * dropped 190 MB reports 190 MB until V8 decides to sweep. Without a way to force the
 * collection there is no way to tell a real retention from page cache, and the two want
 * opposite fixes. `gc()` on the console answers it in one measurement.
 */
if (!app.isPackaged) app.commandLine.appendSwitch('js-flags', '--expose-gc');

/**
 * Carry the scanned-library caches across the rename to ChaosX.
 *
 * Electron derives `userData` from the product name, so a rename moves
 * `%APPDATA%\Silent Chaos Music Player` out of the way and leaves the new folder
 * empty. Without this the app would quietly throw away the library cache and every
 * ffmpeg loudness analysis and rescan the whole collection — hours of work for the
 * user, and nothing on screen to explain why.
 *
 * Only files that are not already present are copied, so it is a one-way rescue
 * rather than a sync, and it stops mattering after the first run.
 */
function migrateLegacyUserData(): void {
  const current = app.getPath('userData');
  const legacy = path.join(path.dirname(current), 'Silent Chaos Music Player');
  if (legacy === current || !fs.existsSync(legacy)) return;
  try {
    for (const entry of fs.readdirSync(legacy)) {
      const from = path.join(legacy, entry);
      const to = path.join(current, entry);
      if (fs.existsSync(to)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  } catch {
    // A failed rescue is no worse than no rescue: the app simply rescans.
  }
}

/*
 * One instance, full stop.
 *
 * A second launch used to start a second app: two renderers, two scanned
 * libraries, and a gigabyte more RAM on the low-end machines this player is built
 * for. It also manufactured a phantom first run — the second process cannot open
 * the Chromium profile the first is holding, so its renderer came up with an empty
 * localStorage and asked the user through setup a second time.
 *
 * The lock is taken before the app is ready, because that is the only point at
 * which the losing process can still bow out cleanly, and `whenReady` is gated on
 * the result rather than left to race `app.quit()`.
 */
const holdsInstanceLock = app.requestSingleInstanceLock();
if (!holdsInstanceLock) app.quit();

app.on('second-instance', () => {
  /*
   * The launch was refused, so bring the app the user was trying to reach to them
   * instead. It may be parked in the tray, where it is hidden rather than closed,
   * so this has to show as well as focus.
   */
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!holdsInstanceLock) return;
  migrateLegacyUserData();
  // Battery, memory and processor for the Statistics page. Started here rather
  // than lazily so the first reading is already real when the page opens.
  registerSysInfo();

  // The transport keys are ours for as long as this app is open.
  mpvEngine.onPlayingChange = () => refreshMediaKeys();
  ipcMain.on('app:film-playing', () => refreshMediaKeys());
  /*
   * A hard restart, for the moments a reload will not fix.
   *
   * The app accumulates state that no in-app action can give back: an AudioContext
   * whose process keeps its ~87 MB after `close()`, WebGL render targets that only
   * shrink when the context is lost, a media element Chromium refuses to release,
   * mpv decks that were built for a file that stopped playing minutes ago. Every
   * one of those is a fresh-process problem, and asking the user to close the app
   * from the tray and find it again is the same job with three steps.
   *
   * `app.exit` rather than `app.quit`, because the close-to-tray handler intercepts
   * `close` on every window and `quit` would hide the app and then sit there with
   * nothing left to quit — but `exit` does not emit `will-quit`, so the two things
   * that handler does for us have to be done here instead. Chief among them
   * `mpvEngine.shutdown()`, which is the only thing that stops the spawned players
   * from outliving the process that owns them.
   *
   * `clearCache` is Chromium's HTTP cache and nothing else. `clearStorage` would
   * take localStorage with it, and that is where every setting in this app lives.
   */
  ipcMain.handle('app:restart', async () => {
    isQuitting = true;
    try {
      await session.defaultSession.clearCache();
    } catch {
      // A cache we could not clear is not worth failing the restart over.
    }
    /*
     * Under `npm run dev` the app is a child of the dev server, so killing it
     * takes the server down with it and the relaunched process comes back to a
     * dead `localhost:5173` and paints an error page. Measured exactly that.
     *
     * So the dev build reloads every window instead, which is the closest thing
     * to a restart that still has somewhere to come back to: it drops the
     * renderers, their WebGL contexts, their media elements and their heaps, and
     * re-runs the whole boot. What it cannot reach is the GPU process and the
     * main process, which is the part only the packaged restart actually clears.
     */
    if (!app.isPackaged) {
      /*
       * Put the decks down first, or the button frees nothing that matters.
       *
       * A reload takes the renderers — their heaps, their WebGL contexts, their
       * media elements — and leaves the main process and its two mpv children
       * exactly where they were, which is the part of the footprint a user pressing
       * this button is looking at. `halt()` empties both decks and arms the short
       * idle release, so the processes go within the second it takes the windows to
       * come back, and the next play boots one again.
       */
      mpvEngine.halt();
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.reload();
      }
      isQuitting = false;
      return true;
    }
    mpvEngine.shutdown();
    globalShortcut.unregisterAll();
    app.relaunch();
    app.exit(0);
    return true;
  });
  /*
   * The deck gained or lost a film, and the two facts about it are decided here.
   *
   * The picture moves: the two windows cannot be asked in advance which of them
   * will be holding a film, because mpv only knows it has a frame after
   * `file-loaded` and the card only knows it is on screen when the user put it
   * there — either can happen second.
   *
   * And a widget that is up when a film starts is put away. `setView` refuses to
   * open mini or pill over a video, but the queue can walk into a film on its own
   * from a strip the user opened while a song was playing, and leaving the card
   * there would be the arrangement that just got retired: a film with a transport
   * row floating across it. The library window is never hidden by a widget, so
   * collapsing costs nothing the user did not already have — the film simply
   * appears on the surface that can show it.
   */
  mpvEngine.onHasVideoChange = () => {
    syncFilmPictureTarget();
    if (overlayWindow && !overlayWindow.isDestroyed() && mpvEngine.hasFilmPicture()) {
      collapseOverlay();
    }
  };

  // Streams local files with proper HTTP range support so <video>/<audio>
  // can seek instantly instead of waiting for a full download.
  protocol.handle('media', async (request) => {
    const filePath = fromMediaUrl(request.url);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!stat.isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const total = stat.size;
    const headers = new Headers({
      'Content-Type': mimeForPath(filePath),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
      'Cache-Control': 'no-store',
    });

    const body = (start: number, end: number, status: number): Response => {
      headers.set('Content-Length', String(end - start + 1));
      if (status === 206) {
        headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
      }
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers });
    };

    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      let start = 0;
      let end = total - 1;
      if (match) {
        const [, rawStart, rawEnd] = match;
        if (rawStart === '' && rawEnd !== '') {
          // suffix range: last N bytes
          start = Math.max(0, total - Number(rawEnd));
        } else {
          start = Number(rawStart || 0);
          if (rawEnd !== '') end = Number(rawEnd);
        }
      }
      if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < total) {
        return body(start, Math.min(end, total - 1), 206);
      }
    }

    return body(0, total - 1, 200);
  });

  // Auto-grant display capture (used by the "live desktop" backdrop mode)
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources.length === 0) {
          callback({});
          return;
        }
        /*
         * The display to capture is the one the *asking* renderer lives on. The
         * widget is a separate window, and it is the widget that needs the
         * capture; resolving this from the library window meant a pill docked to
         * the second monitor refracted the first one.
         */
        const asker = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.webContents.mainFrame === request.frame?.top,
        );
        const wanted = asker && !asker.isDestroyed()
          ? screen.getDisplayMatching(asker.getBounds()).id
          : (() => {
              const win = getMainWindow();
              return win && !win.isDestroyed()
                ? screen.getDisplayMatching(win.getBounds()).id
                : null;
            })();
        const target =
          (wanted != null && sources.find((s) => s.display_id === String(wanted))) || sources[0];
        callback({ video: target });
      }).catch(() => callback({}));
    });
  } catch {
    // Older Electron without the handler
  }

  createWindow();

  // The mpv host registers its own IPC but starts its decks lazily on the first
  // transport call, so this costs nothing until the user actually presses play.
  registerMpvIpc();

  if (isDev) {
    startDebugBridge();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // A quit that is not a close: the tray interception has to stand aside or
  // `app.quit()` would hide the window and then sit with nothing left to quit.
  isQuitting = true;
  /*
   * Put the caption back before the window goes. A process that exits with the
   * style bits still stripped leaves the shell standing aside for a window that no
   * longer exists, and the one place a person cannot easily recover from is a
   * taskbar that has decided to hide itself for nobody.
   */
  if (immersiveRestore && mainWindow && !mainWindow.isDestroyed()) {
    disarmTaskbarHover();
    mpvWindow.restoreFrame(mainWindow);
    mainWindow.setBounds(immersiveRestore.bounds);
  }
  immersiveRestore = null;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  // Orphaned mpv.exe processes keep playing into a dead app and hold the pipe.
  mpvEngine.shutdown();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
