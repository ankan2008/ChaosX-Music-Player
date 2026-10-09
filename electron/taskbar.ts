/**
 * Reaching the Windows shell's own taskbar from the main process.
 *
 * The takeover gets the bar out of the way by becoming a window the shell recognises as
 * fullscreen — see `stripFrame` in `mpv-window.ts`. What it does not come with is a way
 * back, because in the shell's model a person who wants their taskbar leaves fullscreen.
 * Chrome behaves the same way, and the same way looks broken to somebody who has just
 * been promised that hovering the edge brings it back.
 *
 * What the shell actually does is not hide the bar. Measured on this machine, all the way
 * through a takeover, `Shell_TrayWnd` stays `IsWindowVisible`, stays at
 * `0,1020 1920x60`, and reports appbar state 0 — it is simply *covered*, because Windows
 * lets a fullscreen window sit on top of the bar. That is why the two obvious reveals
 * both do nothing:
 *
 *   `ShowWindow(tray, SW_SHOW)`     — it was never hidden
 *   `ABM_SETSTATE(ABS_ALWAYSONTOP)` — the state was never what changed
 *   `SetWindowPos(tray, HWND_TOPMOST)` — reports success and reads back demoted a frame
 *                                       later; the shell re-applies its own answer for as
 *                                       long as we are fullscreen
 *
 * The bar's topmost bit belongs to the shell, and the shell decides it by looking at our
 * rectangle: while a window covers the monitor the tray reads back `topmost: false`, and
 * the moment the rectangle stops covering it the tray is `topmost: true` again and
 * painting over us. Measured, not inferred — the reveal here changes nothing but the
 * window's height, and the screen grab answers the rest.
 *
 * So the reveal is the rectangle. Back off by two pixels and the shell uncovers its own
 * bar, which it paints inset and rounded with the takeover still showing either side of
 * it — exactly what it does over every other fullscreen window. The app does not move,
 * and the bar is the shell's, so a button pressed on it does what a button should.
 *
 * **Nothing in this file may set `WS_EX_TOPMOST`.** The library window is deliberately
 * not topmost — `setAlwaysOnTop(false)` in the view-mode path of `main.ts` — and the
 * takeover covers the bar with its rectangle rather than with its band in the stack.
 * Asserting the bit on arm and restoring it on disarm left the library glued above
 * everything after the first fullscreen cycle: no other app could take the foreground,
 * and pressing a taskbar button did nothing at all.
 *
 * Three ways here are measured failures, kept because the header is the record:
 *
 *   `zorder` and `aboveme` ask the shell to move its own bar and are answered by the
 *       shell moving it back (above).
 *   `demote` gives up `WS_EX_TOPMOST` and waits. The bar stays covered, because the
 *       decision is made from the rectangle — and it is the same call that, once, made
 *       the app impossible to click past.
 *   `hole` cut the bar's row out of the window's region with `SetWindowRgn`. The call
 *       returned success, the region read back applied, and Chromium kept painting
 *       straight over it: a DirectComposition surface is not clipped by a window region.
 *
 * `shrink` is `peek` with the depth guessed wrong: taking the window down to the work
 * area lifts the page 60 pixels off the bottom of the screen and brings the bar across
 * the whole monitor width. It stays because it is the fallback for a shell that does not
 * uncover on a two-pixel shortfall.
 */
import type { BrowserWindow } from 'electron';
import { screen } from 'electron';
import { mpvWindow } from './mpv-window';

const SW_HIDE = 0;
const SW_SHOW = 5;

const ABM_GETSTATE = 0x00000004;
const ABM_SETSTATE = 0x0000000a;
const ABS_AUTOHIDE = 0x00000001;
const ABS_ALWAYSONTOP = 0x00000002;

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

/** `SetWindowPos` insert-after sentinels, as pointer-sized numbers. */
const HWND_TOPMOST = -1n;
const HWND_NOTOPMOST = -2n;

/** Move nothing, activate nothing — change only where the window sits in the stack. */
const SWP_NOADJUST = 0x0002 | 0x0001 | 0x0010;

/**
 * How deep a band at the foot of the monitor counts as "reaching for the bar".
 *
 * Physical pixels, because that is what `GetCursorPos` reports. Four was the first guess
 * and is too tight to hit deliberately on a laptop: the pointer has to be pressed against
 * a boundary it cannot see, since the bar that used to mark it is the thing being asked
 * for. Twelve is still below everything the takeover draws, so the transport cannot
 * trigger it on the way past.
 */
const EDGE_PX = 12;

type Rect = { left: number; top: number; right: number; bottom: number };

type Api = {
  findWindow: (cls: string, title: string | null) => bigint;
  showWindow: (hwnd: bigint, cmd: number) => boolean;
  isVisible: (hwnd: bigint) => boolean;
  cursorPos: () => { x: number; y: number } | null;
  /** Put the real pointer somewhere, to test an edge without a hand on the laptop. */
  setCursor: (x: number, y: number) => boolean;
  rect: (hwnd: bigint) => Rect | null;
  /** `GWL_EXSTYLE` — bit 3 is `WS_EX_TOPMOST`, which is where the bar lives. */
  exStyle: (hwnd: bigint) => number;
  isTopmost: (hwnd: bigint) => boolean | null;
  setWindowPos: (
    hwnd: bigint,
    insertAfter: bigint,
    x: number,
    y: number,
    w: number,
    h: number,
    flags: number,
  ) => boolean;
  /** Returns the appbar's raw reply, which for `ABM_GETSTATE` is the state itself. */
  appBar: (message: number, hWnd: bigint, lParam: number) => number;
  /** Client area as `(0, 0, width, height)`, and where it sits on the desktop. */
  clientRect: (hwnd: bigint) => Rect | null;
  clientOrigin: (hwnd: bigint) => { x: number; y: number } | null;
  /** Direct children of a window, with their class names and screen rects. */
  children: (hwnd: bigint) => { cls: string; rect: Rect | null; visible: boolean }[];
};

let api: Api | null = null;
let initError: string | null = null;
let tried = false;
let tray: bigint | null = null;
/** What we last told the bar to do, so a poll that changes nothing changes nothing. */
let shown = true;
let poll: NodeJS.Timeout | null = null;
/** Every mechanism the last manual command used, for the dev bridge to print. */
let lastAction = '';
/**
 * Which of the ways back the hover reveal is allowed to use.
 *
 * Chosen at runtime because which one survives is a property of the machine.
 *
 * `peek` backs the window off the bottom edge by a couple of pixels. The shell only
 * needs the rectangle to stop covering the monitor to uncover its own bar, and two
 * pixels is nothing a person can see move — while the bar that arrives is the shell's
 * painting: inset, rounded, with the takeover still showing either side of it, and with
 * its buttons live because the takeover never held the top of the stack.
 *
 * `shrink` is the same idea with the depth guessed wrong: down to the work area, so the
 * page lifts 60 pixels and the bar arrives across the whole monitor width. It stays as
 * the fallback for a shell that will not uncover on a two-pixel shortfall.
 */
let mechanism: 'peek' | 'shrink' = 'peek';
/** How far `peek` backs the window off the bottom edge, in physical pixels. */
let peekPx = 2;
/** The immersive window, so the reveal can move it. */
let owner: BrowserWindow | null = null;

function load(): Api | null {
  if (tried) return api;
  tried = true;
  let koffi: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi');
  } catch (e) {
    initError = 'koffi is not installed: ' + (e as Error).message;
    return null;
  }
  try {
    const user32 = koffi.load('user32.dll');
    const shell32 = koffi.load('shell32.dll');
    koffi.struct('POINT_API', { x: 'long', y: 'long' });
    koffi.struct('TRAY_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    /*
     * `appbar.ts` registers the identical layout under `APPBARDATA`. Reusing that name
     * from a second module makes koffi throw on the redefinition, and the two files load
     * in an order nothing controls — so this one has its own name and its own buffer, and
     * the 48-byte assertion below is repeated rather than trusted across the boundary.
     */
    koffi.struct('TRAY_APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'int64',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: 'TRAY_RECT',
      lParam: 'int64',
    });
    const barSize = Number(koffi.sizeof('TRAY_APPBARDATA'));
    if (barSize !== 48) {
      initError = 'unexpected APPBARDATA size ' + barSize + ', expected 48';
      return null;
    }
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(POINT_API *)');
    const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int, int)');
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(int64, TRAY_RECT*)');
    const GetClientRect = user32.func('bool __stdcall GetClientRect(int64, TRAY_RECT*)');
    const ClientToScreen = user32.func('bool __stdcall ClientToScreen(int64, POINT_API*)');
    const FindWindowEx = user32.func('int64 __stdcall FindWindowExW(int64, int64, str16, str16)');
    const GetClassName = user32.func('int __stdcall GetClassNameW(int64, uint16*)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(int64)');
    const getLong = user32.func('intptr_t __stdcall GetWindowLongW(int64, int)');
    const SHAppBarMessage = shell32.func(
      'uintptr_t __stdcall SHAppBarMessage(uint32, TRAY_APPBARDATA *)',
    );
    /*
     * One array type, built once, for class names. A spike in `mpv-window.ts` that called
     * `koffi.array(...)` per read returned the correct string twice and then "?" for every
     * call after it, so an anonymous type per call is not a thing to lean on.
     */
    const CLS_ARRAY = koffi.array('uint16', 64);
    const screenRect = (hwnd: bigint): Rect | null => {
      const buf = koffi.alloc('TRAY_RECT', 1);
      return GetWindowRect(hwnd, buf) ? (koffi.decode(buf, 'TRAY_RECT') as Rect) : null;
    };
    api = {
      findWindow: user32.func('int64 __stdcall FindWindowW(str16, str16)'),
      showWindow: user32.func('bool __stdcall ShowWindow(int64, int)'),
      isVisible: IsWindowVisible,
      setWindowPos: user32.func(
        'bool __stdcall SetWindowPos(int64, int64, int, int, int, int, uint32)',
      ),
      rect: screenRect,
      exStyle: (hwnd: bigint) => Number(getLong(hwnd, GWL_EXSTYLE)),
      isTopmost: (hwnd: bigint) => {
        try {
          return (Number(getLong(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) !== 0;
        } catch {
          return null;
        }
      },
      cursorPos: () => {
        /*
         * `koffi.alloc`, not a plain object. Handing `GetCursorPos` a JS object and
         * reading `p.x` afterwards looked right and returned 0,0 forever — koffi marshals
         * an object in but does not copy the struct back out unless the parameter is
         * declared `_Out_`, so the hover test compared a cursor that never moved against
         * an edge it never reached and the reveal never fired. Allocating the buffer and
         * decoding it is the same shape `appbar.ts` already uses for `GetWindowRect`.
         */
        const buf = koffi.alloc('POINT_API', 1);
        if (!GetCursorPos(buf)) return null;
        const p = koffi.decode(buf, 'POINT_API') as { x: number; y: number };
        return { x: p.x, y: p.y };
      },
      setCursor: (x: number, y: number) => SetCursorPos(x, y),
      clientRect: (hwnd: bigint) => {
        const buf = koffi.alloc('TRAY_RECT', 1);
        return GetClientRect(hwnd, buf) ? (koffi.decode(buf, 'TRAY_RECT') as Rect) : null;
      },
      clientOrigin: (hwnd: bigint) => {
        const buf = koffi.alloc('POINT_API', 1);
        koffi.encode(buf, 'POINT_API', { x: 0, y: 0 });
        if (!ClientToScreen(hwnd, buf)) return null;
        const p = koffi.decode(buf, 'POINT_API') as { x: number; y: number };
        return { x: p.x, y: p.y };
      },
      children: (hwnd: bigint) => {
        const out: { cls: string; rect: Rect | null; visible: boolean }[] = [];
        let child = FindWindowEx(hwnd, 0n, null, null);
        for (let i = 0; i < 24 && child && child !== 0n; i++) {
          const nameBuf = koffi.alloc('uint16', 64);
          let cls = '';
          try {
            const n = GetClassName(child, nameBuf);
            if (n > 0) {
              const words = koffi.decode(nameBuf, CLS_ARRAY) as number[];
              cls = String.fromCharCode(...words.slice(0, n));
            }
          } catch {
            cls = '';
          }
          out.push({ cls, rect: screenRect(child), visible: IsWindowVisible(child) });
          child = FindWindowEx(hwnd, child, null, null);
        }
        return out;
      },
      appBar: (message: number, hWnd: bigint, lParam: number) => {
        const d = koffi.alloc('TRAY_APPBARDATA', 1);
        koffi.encode(d, 'TRAY_APPBARDATA', {
          cbSize: barSize,
          hWnd,
          uCallbackMessage: 0,
          uEdge: 0,
          rc: { left: 0, top: 0, right: 0, bottom: 0 },
          lParam,
        });
        return Number(SHAppBarMessage(message, d));
      },
    };
  } catch (e) {
    initError = (e as Error).message;
    api = null;
  }
  return api;
}

function trayWnd(a: Api): bigint | null {
  if (tray !== null) return tray;
  try {
    const h = a.findWindow('Shell_TrayWnd', null);
    if (h && h !== 0n) tray = h;
  } catch {
    // No bar to talk to; the hover reveal simply is not offered.
  }
  return tray;
}

/**
 * Where the takeover window actually is, in the two coordinate spaces that matter.
 *
 * `ncOffset` is the caption and sizing border the window is wearing: it is zero while
 * `stripFrame` has the takeover in hand and nonzero the moment Electron recomputes the
 * style word, which is what `setBounds` and `setAlwaysOnTop` both do. Printing it is how
 * a reveal that landed 31 pixels too high gets explained instead of guessed at.
 */
function windowReport(a: Api | null): Record<string, unknown> | null {
  const win = owner;
  if (!a || !win || win.isDestroyed()) return null;
  try {
    const hwnd = win.getNativeWindowHandle().readBigInt64LE(0);
    const wr = a.rect(hwnd);
    const client = a.clientRect(hwnd);
    const origin = a.clientOrigin(hwnd);
    return {
      hwnd: String(hwnd),
      windowRect: wr,
      clientSize: client,
      clientOrigin: origin,
      ncOffset: wr && origin ? { x: origin.x - wr.left, y: origin.y - wr.top } : null,
      topmost: a.isTopmost(hwnd),
      focused: win.isFocused(),
      bounds: win.getBounds(),
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Everything true about the bar right now, in the shell's own units.
 *
 * The fields disagree by design and the disagreement is the diagnosis: `visible` is the
 * window's visibility bit, `topmost` is the band the shell has chosen to keep it in,
 * `state` is the appbar flag it consults before hiding anything, and `rect` is where it
 * actually is. A bar hidden by a fullscreen window has been seen with `visible` still
 * true, which `ShowWindow` cannot fix because it was never broken.
 */
export function probe(): Record<string, unknown> {
  const a = load();
  const h = a ? trayWnd(a) : null;
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  let visible: boolean | null = null;
  let state: number | null = null;
  let r: Rect | null = null;
  if (a && h) {
    try {
      visible = a.isVisible(h);
      state = a.appBar(ABM_GETSTATE, h, 0);
      r = a.rect(h);
    } catch (e) {
      initError = (e as Error).message;
    }
  }
  const p = a ? a.cursorPos() : null;
  return {
    available: !!a,
    error: initError,
    hwnd: h ? String(h) : null,
    visible,
    topmost: a && h ? a.isTopmost(h) : null,
    state,
    stateName: state === null ? null : state & ABS_AUTOHIDE ? 'autohide' : 'alwaysontop',
    rect: r,
    offscreen: r ? r.top >= d.bounds.y + Math.round(d.bounds.height * sf) - 2 : null,
    monitor: {
      bottom: d.bounds.y + Math.round(d.bounds.height * sf),
      workBottom: d.workArea.y + Math.round(d.workArea.height * sf),
    },
    mechanism,
    peekPx,
    window: windowReport(a),
    polling: !!poll,
    shown,
    lastAction,
    cursor: p,
    want: p && r ? p.y >= d.bounds.y + Math.round(d.bounds.height * sf) - EDGE_PX : null,
  };
}

/**
 * Put the bar where the pointer asked for it, by the mechanism currently selected.
 *
 * Shared by the hover poll and the dev bridge so the two cannot disagree about what
 * "reveal" means while one of them is being tested.
 */
function apply(a: Api, win: BrowserWindow, want: boolean): string {
  const d = screen.getDisplayMatching(win.getBounds());
  const sf = d.scaleFactor || 1;
  const back = want
    ? mechanism === 'shrink'
      ? d.bounds.height - d.workArea.height
      : Math.max(1, Math.ceil(peekPx / sf))
    : 0;
  /*
   * Stop covering the bar's row rather than trying to lift the bar over it. The shell
   * hides nothing — the bar stays visible and painting all through a takeover, it is
   * simply underneath us — so uncovering it needs no argument with anybody, and no
   * other window changes hands.
   *
   * Nothing here touches the window's band in the stack. The library window is not
   * topmost by design, and making it topmost is what stops every other app from being
   * clicked into.
   *
   * `setBounds` is the catch: Electron recomputes the whole style word on a bounds
   * change and puts the caption back, which would drop the titlebar into the middle of
   * the takeover. So the frame goes straight back off.
   */
  win.setBounds({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height - back,
  });
  const stripped = mpvWindow.stripFrame(win);
  return stripped.ok === true
    ? mechanism + '(' + back + ' DIP off)'
    : mechanism + ': frame could not be re-stripped';
}

/**
 * Run one mechanism by hand, from the dev bridge, and report what the shell says
 * afterwards. Returning the probe in the same response is what makes a mechanism that
 * "succeeded" and one that the shell reverted an hour later distinguishable.
 */
export function act(how: string, on: boolean, arg?: string): Record<string, unknown> {
  const a = load();
  const h = a ? trayWnd(a) : null;
  if (how === 'mode') {
    const next = ['peek', 'shrink'].includes(arg ?? '')
      ? (arg as typeof mechanism)
      : mechanism;
    // Switching mechanism mid-session has to undo what the last one did to the window.
    if (owner && !owner.isDestroyed()) {
      owner.setBounds(screen.getDisplayMatching(owner.getBounds()).bounds);
      mpvWindow.stripFrame(owner);
    }
    mechanism = next;
    lastAction = `mechanism = ${next}`;
    return probe();
  }
  if (how === 'peek' && arg) {
    const v = Number(arg);
    if (Number.isFinite(v) && v >= 0) peekPx = v;
    lastAction = 'peekPx = ' + peekPx;
    return probe();
  }
  if (how === 'children') {
    return { children: a && h ? a.children(h) : null, bar: a && h ? a.rect(h) : null };
  }
  if (!a || !h) {
    lastAction = how + ': no binding or no Shell_TrayWnd';
    return probe();
  }
  try {
    if (how === 'cursor') {
      /*
       * Move the real pointer, so an edge can be tested without a hand on the laptop.
       * Physical pixels, because that is what `GetCursorPos` reports and what a
       * per-monitor-DPI-aware process is addressed in — a DPI-unaware helper such as
       * PowerShell has the coordinates multiplied back down and cannot reach the last row
       * of a scaled screen at all.
       */
      const [x, y] = (arg ?? '').split(',').map(Number);
      const ok = Number.isFinite(x) && Number.isFinite(y) && a.setCursor(x, y);
      lastAction = `cursor(${x},${y})=${ok}`;
    } else if (how === 'reveal') {
      const win = owner;
      lastAction = win && !win.isDestroyed()
        ? `${apply(a, win, on)}(${on}) ok`
        : 'reveal: no immersive window';
    } else if (how === 'show') {
      a.showWindow(h, on ? SW_SHOW : SW_HIDE);
      lastAction = `show(${on}) ok`;
    } else if (how === 'state') {
      a.appBar(ABM_SETSTATE, h, on ? ABS_ALWAYSONTOP : ABS_AUTOHIDE);
      lastAction = `state(${on}) ok`;
    } else if (how === 'zorder') {
      a.setWindowPos(h, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOADJUST);
      lastAction = `zorder(${on}) ok`;
    } else {
      lastAction = `unknown: ${how}`;
    }
  } catch (e) {
    lastAction = `${how}(${on}) threw: ${(e as Error).message}`;
  }
  return probe();
}

/**
 * Put the bar where the pointer is going to look for it, or take it away again.
 *
 * The edge is the *monitor's* bottom, not the work area's — the work area is what is left
 * over once the bar has taken its slice, and while the bar is covered that is the whole
 * screen, so measuring from it would mean the pointer had to reach a row of pixels that no
 * longer exists.
 */
function tick(win: BrowserWindow): void {
  const a = api;
  if (!a || win.isDestroyed()) return;
  const h = trayWnd(a);
  if (!h) return;
  const p = a.cursorPos();
  if (!p) return;
  const d = screen.getDisplayMatching(win.getBounds());
  const sf = d.scaleFactor || 1;
  const bottom = d.bounds.y + Math.round(d.bounds.height * sf);
  const bar = a.rect(h);
  const barH = bar ? bar.bottom - bar.top : 48;
  /*
   * Two thresholds, because one line cannot answer two different questions.
   *
   * *Entering* has to be deliberate: the last `EDGE_PX` rows of the monitor, which sit
   * below everything the takeover draws, so the transport cannot summon the bar on its way
   * past.
   *
   * *Staying* revealed cannot use that same line. A person who reached the bar and then
   * moved up into it to press a button would leave a twelve-pixel trigger band, the reveal
   * would close, and the button would vanish under their finger. So while it is open the
   * hold is the bar's own row: it closes when the pointer leaves the bar, not when it stops
   * being exactly on its edge.
   */
  const want = shown ? p.y >= bottom - barH : p.y >= bottom - EDGE_PX;
  /*
   * Nothing here is re-asserted while the pointer holds the band, the way an earlier
   * attempt did: every mechanism left in this file moves our own window, which is not
   * something the shell argues with, and re-running `setBounds` ten times a second would
   * only make the page layout thrash.
   */
  if (want === shown) return;
  shown = want;
  try {
    lastAction = apply(a, win, want) + `(${want})`;
  } catch (e) {
    lastAction = 'tick threw: ' + (e as Error).message;
  }
}

/** Begin following the pointer. Idempotent, and cheap while idle. */
export function armTaskbarHover(win: BrowserWindow): void {
  if (!load()) return;
  owner = win;
  shown = false;
  /*
   * Nothing to put right with the window here. Arming used to assert `WS_EX_TOPMOST`
   * "so the bar starts covered", and that single line is what left the library above
   * every other app for the rest of the session — the bar is covered by the rectangle,
   * and the rectangle is already right because the takeover sized itself before this
   * was ever called.
   */
  if (poll) return;
  poll = setInterval(() => tick(win), 100);
}

/** Stop following it, and leave the bar visible whatever the pointer was doing. */
export function disarmTaskbarHover(): void {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  const a = api;
  const h = a ? trayWnd(a) : null;
  if (a && h && owner && !owner.isDestroyed()) {
    try {
      /*
       * Always undo the reveal, not only when the pointer last left it open: exiting
       * while the pointer happens to be away from the edge must still leave the window
       * full-screen and the bar where a person expects it. The window's place in the
       * stack is not touched, because it was never ours to change.
       *
       * `ABM_SETSTATE` is deliberately not written anywhere in this path. Measured on the
       * live shell it reads 0 both before and during the takeover — the fullscreen cover
       * is a z-order event, not an appbar state change — and writing that 0 back would
       * have cleared the user's own auto-hide setting.
       */
      owner.setBounds(screen.getDisplayMatching(owner.getBounds()).bounds);
      mpvWindow.stripFrame(owner);
    } catch {
      // The shell restores the bar with the fullscreen window anyway.
    }
  }
  shown = true;
  owner = null;
}

export const taskbar = {
  probe,
  act,
  get available(): boolean {
    return !!load();
  },
  get error(): string | null {
    return initError;
  },
};
