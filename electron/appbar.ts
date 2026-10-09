import { BrowserWindow, screen } from 'electron';

/**
 * Reserving screen space for the pill, the way Windows does for a docked toolbar.
 *
 * The pill is an always-on-top strip against the screen edge. Without this it
 * simply lies on top of whatever a maximized window does, which buries that
 * window's minimise / maximise / close buttons under an opaque bar: the user can
 * see the buttons are there and cannot reach them. Registering as an application
 * desk bar takes the strip's width out of the work area, so maximized windows
 * stop short of it and the two surfaces sit side by side like a split screen.
 *
 * `ABM_NEW` asks for a callback message so the shell can say "the layout moved".
 * No window procedure is installed to receive it: a koffi callback fired from a
 * WNDPROC on Electron's own message loop is a crash waiting to happen, and
 * `ABN_POSCHANGED` arrives at most a few times a session. Re-asserting the
 * position on a short timer costs one syscall and recovers from every case that
 * message covers, which is the same trick the shell's own bar clients use.
 *
 * Only the *visible* strip is reserved. The transparent gutter beside it is where
 * the flyouts go, and reserving it would take 400 pixels of desktop away to show
 * a 104-pixel widget.
 *
 * The reservation is half of what "nothing may sit on top of the strip" means,
 * and the two halves are easy to conflate. `ABM_SETPOS` constrains *maximised*
 * windows by shrinking the work area; it says nothing about an ordinary window
 * the user drags across the screen, and it does not raise the bar in the z-order
 * either. That is a separate, explicit `SetWindowPos(HWND_TOPMOST)`, which every
 * real desk-bar client issues alongside it and which this file used to omit —
 * leaving the strip topmost only by whatever `alwaysOnTop: true` happened to
 * leave behind at creation, and losing that to anything else that claimed the
 * topmost band.
 */

const ABM_NEW = 0x00000000;
const ABM_REMOVE = 0x00000001;
const ABM_QUERYPOS = 0x00000002;
const ABM_SETPOS = 0x00000003;
/** Tells the shell where the bar actually ended up, after we have moved it. */
const ABM_WINDOWPOSCHANGED = 0x00000009;
const ABE_LEFT = 0x00000000;
const ABE_RIGHT = 0x00000002;
/** Private message range, offset clear of anything else in this process. */
const AB_CALLBACK = 0x00004000 + 0x5c;

const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const SWP_NOZORDER = 0x0004;

/* Window-list plumbing for the overlap sweep — see `sweep` below. */
const GW_HWNDFIRST = 0;
const GW_HWNDNEXT = 2;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const DWMWA_CLOAKED = 14;
const VK_LBUTTON = 0x01;

/** Which edge the strip is docked to. Mirrors the renderer's `pillSide`. */
export type BarEdge = 'left' | 'right';

/**
 * What the last sweep looked at.
 *
 * The sweep runs in another process's window list, so without this the only way
 * to tell "it moved the window" from "the window moved itself back" is to guess
 * from the geometry — which is exactly the ambiguity that made the first version
 * of this feature look broken when it was not.
 */
export interface SweepReport {
  at: number;
  seen: number;
  candidates: number;
  moved: { hwnd: string; from: string; to: string; why: string }[];
}

let lastSweep: SweepReport = { at: 0, seen: 0, candidates: 0, moved: [] };

type BarRect = { left: number; top: number; right: number; bottom: number };

type AppBarApi = {
  alloc: () => unknown;
  size: number;
  write: (d: unknown, v: Record<string, unknown>) => void;
  send: (message: number, d: unknown) => void;
  /** `null` when user32 refused to bind; every caller treats that as "no pin". */
  setWindowPos:
    | ((hwnd: bigint, insertAfter: number, x: number, y: number, w: number, h: number, flags: number) => boolean)
    | null;
  /** Walks the top-level window list. `null` on any binding failure, which
   *  disables the sweep and leaves the reservation alone. */
  sweep: ((band: BarRect, own: bigint) => void) | null;
};

let api: AppBarApi | null = null;
let initError: string | null = null;
let tried = false;
let registeredHwnd: bigint | null = null;
let hold: NodeJS.Timeout | null = null;
let held: BrowserWindow | null = null;
let heldStrip = 0;
let edge: BarEdge = 'right';
/** Counts the 250 ms recovery ticks so the bar is only re-asserted once a second. */
let tick = 0;

function load(): AppBarApi | null {
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
    const shell32 = koffi.load('shell32.dll');
    koffi.struct('APPBAR_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    koffi.struct('APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'int64',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: 'APPBAR_RECT',
      lParam: 'int64',
    });
    const size = Number(koffi.sizeof('APPBARDATA'));
    /*
     * The documented x64 layout is 48 bytes. If the binding disagrees then the
     * struct is packed differently, and every call would hand the shell a
     * misaligned buffer — so refuse rather than guess.
     */
    if (size !== 48) {
      initError = 'unexpected APPBARDATA size ' + size + ', expected 48';
      return null;
    }
    const SHAppBarMessage = shell32.func('uintptr_t __stdcall SHAppBarMessage(uint32, APPBARDATA *)');
    /*
     * `SetWindowPos` is already bound and proven in `mpv-window.ts` with this
     * exact signature, so the only new surface here is the second handle
     * argument — `HWND_TOPMOST` is `-1` passed as a pointer-sized value, which
     * koffi accepts as a plain number.
     *
     * A failure to bind is deliberately not fatal: the reservation still works,
     * and a strip that is merely draggable-over is a worse widget, not a broken
     * application.
     */
    let setWindowPos: AppBarApi['setWindowPos'] = null;
    try {
      const user32 = koffi.load('user32.dll');
      setWindowPos = user32.func(
        'bool __stdcall SetWindowPos(int64, int64, int, int, int, int, uint32)',
      );
    } catch (e) {
      initError = 'SetWindowPos unavailable: ' + (e as Error).message;
    }

    /*
     * The sweep: push ordinary windows back out of the reserved band, and shrink
     * a fullscreen window to the work area so it cannot take the strip's space.
     *
     * `ABM_SETPOS` only constrains *maximised* windows — it shrinks the work area
     * they snap to, and says nothing about a window the user drags across the
     * edge, and nothing at all about a window that goes fullscreen, because
     * Windows lets a fullscreen window cover an application desk bar on purpose.
     * The only client that can enforce "this band is mine" is the one that asked
     * for it, so this walks the top-level list and moves whatever is sitting in
     * the band.
     *
     * The window list is filtered to the ones a user would recognise as windows:
     * visible, titled, not a tool window, not cloaked by the shell. Without that
     * the sweep would spend its time shoving `WorkerW` — the desktop wallpaper's
     * own window, which covers the monitor and would be "fixed" to the work area
     * every tick.
     *
     * And it never moves the window under the finger while the left button is
     * down. Fighting a drag mid-gesture is jitter the user feels as the app
     * refusing to be moved; pushing it the instant they let go reads as the band
     * being solid, which is the behaviour that was actually asked for.
     */
    let sweep: AppBarApi['sweep'] = null;
    try {
      const user32 = koffi.load('user32.dll');
      const dwmapi = koffi.load('dwmapi.dll');
      const getWindow = user32.func('int64 __stdcall GetWindow(int64, uint32)');
      const getShellWindow = user32.func('int64 __stdcall GetShellWindow()');
      const isVisible = user32.func('bool __stdcall IsWindowVisible(int64)');
      const getWindowRect = user32.func('bool __stdcall GetWindowRect(int64, APPBAR_RECT*)');
      const titleLength = user32.func('int __stdcall GetWindowTextLengthW(int64)');
      const getLong = user32.func('intptr_t __stdcall GetWindowLongW(int64, int)');
      const keyState = user32.func('short __stdcall GetAsyncKeyState(int)');
      const isZoomed = user32.func('bool __stdcall IsZoomed(int64)');
      const attribute = dwmapi.func('int __stdcall DwmGetWindowAttribute(int64, uint32, void *, uint32)');
      const move = setWindowPos;
      if (!move) throw new Error('SetWindowPos is required to move anything');

      sweep = (band: BarRect, own: bigint) => {
        const report: SweepReport = { at: Date.now(), seen: 0, candidates: 0, moved: [] };
        const rect = koffi.alloc('APPBAR_RECT', 1);
        const cloak = koffi.alloc('uint32', 1);
        /*
         * koffi hands an `int64` HWND back as a JS number whenever it fits in one,
         * and `own` arrives as a BigInt from `readBigInt64LE`. Compared directly
         * they are never equal, so the bar's own window sailed straight through the
         * `hwnd !== own` guard and the sweep pushed the strip out of the band it had
         * just reserved — after which `barWindowBox` pulled it back to the edge and
         * the next tick pushed it again. That is the loop the user watched from the
         * desktop, and the reason the floating strip painted over the docked pill.
         */
        const ownHwnd = Number(own);
        const dragging = (keyState(VK_LBUTTON) & 0x8000) !== 0;
        const display = screen.getPrimaryDisplay();
        const sf = display.scaleFactor || 1;
        const m = display.bounds;
        const wa = display.workArea;
        const ml = Math.round(m.x * sf);
        const mt = Math.round(m.y * sf);
        const mr = Math.round((m.x + m.width) * sf);
        const mb = Math.round((m.y + m.height) * sf);
        const wl = Math.round(wa.x * sf);
        const wy = Math.round(wa.y * sf);
        const wr = Math.round((wa.x + wa.width) * sf);
        const wb = Math.round((wa.y + wa.height) * sf);

        let hwnd = getWindow(getShellWindow(), GW_HWNDFIRST);
        let seen = 0;
        while (hwnd && seen++ < 400) {
          if (Number(hwnd) !== ownHwnd && isVisible(hwnd) && titleLength(hwnd) > 0) {
            const ex = Number(getLong(hwnd, GWL_EXSTYLE));
            if ((ex & WS_EX_TOOLWINDOW) === 0) {
              attribute(hwnd, DWMWA_CLOAKED, cloak, 4);
              const cloaked = Number(koffi.decode(cloak, 'uint32'));
              /*
               * A maximised window is already handled: `ABM_SETPOS` shrank the work
               * area it snaps to, and the 8px it appears to overlap is the invisible
               * resize border every maximised frame carries past its own edge. Moving
               * one takes it out of the shell's own placement for no gain.
               */
              if (!cloaked && !isZoomed(hwnd) && getWindowRect(hwnd, rect)) {
                const r = koffi.decode(rect, 'APPBAR_RECT') as BarRect;
                const across = Math.min(r.right, band.right) - Math.max(r.left, band.left);
                const down = Math.min(r.bottom, band.bottom) - Math.max(r.top, band.top);
                if (across > 2 && down > 2) {
                  report.candidates++;
                  const covers =
                    r.left <= ml + 2 && r.top <= mt + 2 && r.right >= mr - 2 && r.bottom >= mb - 2;
                  const from = `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`;
                  if (covers) {
                    move(hwnd, 0, wl, wy, wr - wl, wb - wy, SWP_NOZORDER | SWP_NOACTIVATE);
                    report.moved.push({
                      hwnd: String(hwnd),
                      from,
                      to: `${wl},${wy} ${wr - wl}x${wb - wy}`,
                      why: 'fullscreen',
                    });
                  } else if (!dragging) {
                    const w = r.right - r.left;
                    const h = r.bottom - r.top;
                    const x = edge === 'left'
                      ? Math.max(r.left, band.right)
                      : Math.min(r.left, band.left - w);
                    if (x < wl) {
                      // Wider than the space beside the band: give it the whole
                      // work area rather than leave it hanging over the strip.
                      move(hwnd, 0, wl, r.top, wr - wl, h, SWP_NOZORDER | SWP_NOACTIVATE);
                      report.moved.push({
                        hwnd: String(hwnd),
                        from,
                        to: `${wl},${r.top} ${wr - wl}x${h}`,
                        why: 'too wide to clear the band',
                      });
                    } else if (x !== r.left) {
                      move(hwnd, 0, x, r.top, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
                      report.moved.push({
                        hwnd: String(hwnd),
                        from,
                        to: `${x},${r.top} ${w}x${h}`,
                        why: 'overlap',
                      });
                    } else {
                      report.moved.push({ hwnd: String(hwnd), from, to: from, why: 'left alone' });
                    }
                  } else {
                    report.moved.push({
                      hwnd: String(hwnd),
                      from,
                      to: from,
                      why: 'left button down',
                    });
                  }
                }
              }
            }
          }
          hwnd = getWindow(hwnd, GW_HWNDNEXT);
        }
        report.seen = seen;
        lastSweep = report;
      };
    } catch (e) {
      initError = 'window sweep unavailable: ' + (e as Error).message;
      sweep = null;
    }
    api = {
      size,
      alloc: () => koffi.alloc('APPBARDATA', 1),
      write: (d, v) => koffi.encode(d, 'APPBARDATA', v),
      send: (message, d) => {
        SHAppBarMessage(message, d);
      },
      setWindowPos,
      sweep,
    };
  } catch (e) {
    initError = 'shell32 bindings failed: ' + (e as Error).message;
    api = null;
  }
  return api;
}

function payload(a: AppBarApi, hWnd: bigint, rc: BarRect): unknown {
  const d = a.alloc();
  a.write(d, {
    cbSize: a.size,
    hWnd,
    uCallbackMessage: AB_CALLBACK,
    uEdge: edge === 'left' ? ABE_LEFT : ABE_RIGHT,
    rc,
    lParam: 0,
  });
  return d;
}

/**
 * The bar's rectangle, in physical pixels: the shell's geometry is never DIPs.
 *
 * The anchored edge comes from the *monitor* bounds and the bottom from the work
 * area. Reading the width off the work area too looks equivalent and is not — it
 * is the quantity this call changes, so the next re-assert would measure itself
 * against the space it had already taken and shrink the bar by another strip
 * width every second. Measured: 1536 → 1432 → … → 184 DIP in thirteen seconds,
 * which is the desktop collapsing to a sliver.
 */
function barRect(win: BrowserWindow, stripDip: number): BarRect {
  const display = screen.getPrimaryDisplay();
  const sf = display.scaleFactor || 1;
  const bounds = display.bounds;
  const area = display.workArea;
  const pill = win.getBounds();
  const width = Math.round(stripDip * sf);
  const top = Math.round(pill.y * sf);
  const bottom = Math.round((area.y + area.height) * sf);
  if (edge === 'left') {
    const left = Math.round(bounds.x * sf);
    return { left, top, right: left + width, bottom };
  }
  const right = Math.round((bounds.x + bounds.width) * sf);
  return { left: right - width, top, right, bottom };
}

function assert(win: BrowserWindow, a: AppBarApi, stripDip: number): void {
  const hwnd = win.getNativeWindowHandle().readBigInt64LE(0);
  const rc = barRect(win, stripDip);
  // QUERYPOS first: the shell is allowed to clamp what we asked for.
  a.send(ABM_QUERYPOS, payload(a, hwnd, rc));
  a.send(ABM_SETPOS, payload(a, hwnd, rc));
  // And then say where we ended up, which is what lets the shell stop "correcting" us.
  a.send(ABM_WINDOWPOSCHANGED, payload(a, hwnd, rc));
  /*
   * The half `ABM_SETPOS` does not do: it carves the work area, but it does not
   * raise the window. Without this an ordinary application dragged across the
   * strip paints over it, because the strip's topmost state is whatever Electron
   * left at creation time and nothing has defended it since.
   */
  a.setWindowPos?.(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

/** Where the pill window belongs: flush against its edge, work area tall. */
function barWindowBox(win: BrowserWindow): Electron.Rectangle | null {
  const { bounds, workArea } = screen.getPrimaryDisplay();
  const size = win.getBounds();
  if (size.width <= 0) return null;
  return {
    x: Math.round(edge === 'left' ? bounds.x : bounds.x + bounds.width - size.width),
    y: Math.round(workArea.y),
    width: size.width,
    height: Math.max(320, workArea.height),
  };
}

/**
 * Hold `stripDip` DIPs at one edge of the work area for as long as the pill is on
 * screen. Called again whenever the pill is re-opened, resized or moved to the
 * other edge.
 */
function reserve(win: BrowserWindow, stripDip: number): void {
  const a = load();
  if (!a) return;
  held = win;
  heldStrip = stripDip;
  const hwnd = win.getNativeWindowHandle().readBigInt64LE(0);
  if (registeredHwnd !== hwnd) {
    a.send(ABM_NEW, payload(a, hwnd, { left: 0, top: 0, right: 0, bottom: 0 }));
    registeredHwnd = hwnd;
  }
  assert(win, a, stripDip);
  if (!hold) {
    /*
     * 250 ms, not the second the reservation alone wanted. The extra rate is for
     * Show Desktop: `Win+D` minimises every top-level window including a topmost
     * one, and with `skipTaskbar: true` the pill has no taskbar button left to
     * click, so a minimised strip is simply gone until the user finds the app
     * again. Nothing else in the app can undo that — `restore()` was only ever
     * wired to the library window — so the bar's own loop is the one place with
     * both the window reference and a timer already running.
     *
     * It is safe to unconditionally bring the window back from here because both
     * deliberate ways of putting the widget away (`closeOverlay`, and the
     * `overlay:collapse` handler) call `release()`, which stops this loop before
     * they hide anything. A tick can never race a collapse.
     */
    hold = setInterval(() => {
      const w = held;
      if (!w || w.isDestroyed()) {
        release();
        return;
      }
      if (!w.isVisible()) {
        w.show();
      } else if (w.isMinimized()) {
        w.restore();
      }
      if (tick++ % 4 === 0) {
        assert(w, a, heldStrip);
        /*
         * The same pull-back the first reservation does: every re-assert is a
         * work-area change as far as Windows is concerned, and a window whose edge
         * sits on the monitor gets clamped inside the new work area. Without this
         * the strip drifts one width away from the edge and a clear channel of
         * desktop opens beside it.
         */
        const box = barWindowBox(w);
        if (box) w.setBounds(box);
      } else {
        // Cheap enough to re-claim the top of the band on every tick.
        const h = w.getNativeWindowHandle().readBigInt64LE(0);
        a.setWindowPos?.(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      }
      /*
       * Twice a second, not every tick: the sweep is a walk of the window list,
       * and half a second is far below the time it takes a person to notice a
       * window has been nudged clear of the strip.
       */
      if (a.sweep && tick % 2 === 0) {
        try {
          a.sweep(barRect(w, heldStrip), w.getNativeWindowHandle().readBigInt64LE(0));
        } catch {
          // A window vanished mid-walk. The next tick sees the world again.
        }
      }
    }, 250);
  }
}

/**
 * Move the reservation to the other edge of the screen.
 *
 * The shell takes a different `uEdge` and a mirrored rectangle; there is no need
 * to deregister and re-register, which would drop the work area for a frame and
 * let a maximised window slide across the strip.
 */
function setEdge(next: BarEdge): void {
  if (edge === next) return;
  edge = next;
  const a = api;
  const w = held;
  if (!a || !w || w.isDestroyed()) return;
  assert(w, a, heldStrip);
  const box = barWindowBox(w);
  if (box) w.setBounds(box);
}

/** Give the space back. Safe to call when nothing is held, and repeatedly. */
function release(): void {
  if (hold) {
    clearInterval(hold);
    hold = null;
  }
  held = null;
  tick = 0;
  const a = api;
  if (registeredHwnd !== null && a) {
    try {
      a.send(ABM_REMOVE, payload(a, registeredHwnd, { left: 0, top: 0, right: 0, bottom: 0 }));
    } catch {
      // The shell drops the bar with the window anyway; nothing left to try.
    }
  }
  registeredHwnd = null;
}

export const appBar = {
  reserve,
  release,
  setEdge,
  get edge(): BarEdge {
    return edge;
  },
  /** What the overlap sweep did last time it ran. Dev bridge only. */
  get lastSweep(): SweepReport {
    return lastSweep;
  },
  get available(): boolean {
    return !!load();
  },
  get error(): string | null {
    return initError;
  },
  get isHolding(): boolean {
    return registeredHwnd !== null;
  },
};

process.on('exit', release);
