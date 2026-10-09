/**
 * The native side of the app window: Win32 bindings shared by two jobs that are
 * really one job — putting another window's pixels inside this one, and keeping
 * the frame behaving like a normal window while we do it.
 *
 * `--wid` embedding for mpv's video (see the notes on the class below), and
 * `restoreSizingFrame()` for the caption buttons.
 *
 * koffi is an optional dependency. If it is missing or a binding fails, this
 * module reports itself unavailable and both jobs degrade: video falls back to
 * the DOM `<video>` path rather than disappearing.
 */
import type { BrowserWindow } from 'electron';
import { screen } from 'electron';

export interface VideoSlot {
  /** CSS pixels, relative to the window's client area. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Place the picture *under* the composited page instead of above it.
   *
   * Two surfaces ask for this, for the same reason and by different routes.
   *
   * The renderer asks while the fullscreen video takeover is up, because that is
   * the one state where it can also stop painting anything over the picture. It is
   * what lets the control pill sit on top of the film: a surface in the page can
   * only be above mpv if mpv is below the page.
   *
   * The mini card asks from the main process (`miniPictureRect()`), which never
   * renders a tint or backdrop layer at all — see the note on the z-order in
   * `apply()` — so its card needs the same arrangement without needing any of the
   * layer-switching that makes the takeover's version safe.
   */
  under?: boolean;
}

interface ChildInfo {
  hwnd: bigint;
  cls: string;
  visible: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
}

/** What Chromium owns in this window, so anything else is mpv's. */
const CHROMIUM_CHILD_CLASSES = [
  'Chrome_RenderWidgetHostHWND',
  'Intermediate D3D Window',
  'Chrome_AppBar_Container_Sibling_Window',
  'Chrome_WidgetWin_0',
  'Chrome_WidgetWin_1',
  'SysShadow',
  'Tooltip',
  'msctls_trackbar32',
];

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const SWP_HIDEWINDOW = 0x0080;
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
/** `ShowWindow` commands that drive Windows' own maximise state machine. */
const SW_MAXIMIZE = 3;
const SW_RESTORE = 9;
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;

/* `RedrawWindow` flags, for forcing the non-client area back under DWM. */
const RDW_INVALIDATE = 0x0001;
const RDW_ERASE = 0x0004;
const RDW_UPDATENOW = 0x0100;
const RDW_FRAME = 0x0400;
const WS_VISIBLE = 0x10000000;
const WS_THICKFRAME = 0x00040000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
const SWP_FRAMECHANGED = 0x0020;
/*
 * The style bits a reparented picture has to end up with. mpv creates its window
 * `WS_CHILD` under the handle it is given, so on this machine these are a
 * formality — but `SetParent` between a top-level and a popup is exactly the
 * transition at which a window stops being positioned in its parent's client
 * area, and getting that wrong costs a picture that sits at the right size in
 * the wrong half of the screen with no error anywhere to say so.
 */
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CLIPCHILDREN = 0x02000000;
/** The caption itself — the "top ribbon" the takeover is asked to put away. */
const WS_CAPTION = 0x00c00000;
/** The box that carries the close button and the window menu. */
const WS_SYSMENU = 0x00080000;

type Bindings = {
  IsWindow: (hwnd: bigint) => boolean;
  GetWindowRect: (hwnd: bigint) => { x: number; y: number; w: number; h: number } | null;
  FindWindowEx: (hwnd: bigint, after: bigint, className: string | null, title: string | null) => bigint;
  /**
   * Move a window into a different parent. Returns the previous parent, or 0 on
   * failure — which is only detectable by reading the child back, so `movePicture`
   * does exactly that rather than trusting the return.
   */
  SetParent: (child: bigint, parent: bigint) => bigint;
  /** The child's current parent, or 0 when it has none or the lookup failed. */
  GetParent: (hwnd: bigint) => bigint;
  SetWindowPos: (hwnd: bigint, insertAfter: bigint | number, x: number, y: number, width: number, height: number, flags: number) => boolean;
  GetWindowLongPtr: (hwnd: bigint, index: number) => bigint;
  /** Windows' own "is this maximised", which the shared WS_MAXIMIZE/WS_MAXIMIZEBOX bit cannot answer alone. */
  IsZoomed: (hwnd: bigint) => boolean;
  /** Force a repaint of a region; with RDW_FRAME, of the non-client area. `0, 0` are the null RECT and HRGN. */
  RedrawWindow: (hwnd: bigint, rect: number, rgn: number, flags: number) => boolean;
  SetWindowLongPtr: (hwnd: bigint, index: number, value: bigint) => bigint;
  ShowWindow: (hwnd: bigint, cmd: number) => boolean;
  /** Empty string when the lookup fails, which is a real possibility. */
  className: (hwnd: bigint) => string;
  /** Physical screen pixels, or null if the lookup failed. */
  cursor: () => { x: number; y: number } | null;
  /** Whether the left mouse button is held, right now, anywhere on the desktop. */
  leftButton: () => boolean;
};

function loadBindings(): { koffi: any; api: Bindings; error: string | null } | null {
  let koffi: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    koffi = require('koffi');
  } catch (e) {
    // The one failure that is not a bug: the dependency is simply not installed.
    return { koffi: null, api: null as unknown as Bindings, error: 'koffi is not installed: ' + (e as Error).message };
  }
  try {
    const user32 = koffi.load('user32.dll');
    koffi.struct('MPV_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
    koffi.struct('MPV_POINT', { x: 'int', y: 'int' });
    /*
     * The global cursor, in *physical* screen pixels. Needed because a widget
     * that passes clicks through to the desktop cannot be woken up by pointer
     * events of its own: an ignored window is not told where the mouse is, so
     * "is the pointer over me?" has to be answered from outside the window.
     */
    const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ MPV_POINT *)');
    /*
     * Polled rather than subscribed to: the pill's window is click-through
     * outside its strip, so a press on the desktop beside it is delivered to
     * whatever is under the cursor and never to this process at all. The only way
     * to learn that the user clicked away is to ask the desktop directly.
     */
    const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int)');
    /*
     * Handles are bound as int64 rather than void*: koffi has no HWND type, and
     * SetWindowPos's second argument has to carry small sentinels like 1.
     */
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(int64, _Out_ MPV_RECT *)');
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(int64, uint16*)');
    /*
     * One array type, built once. A spike that called `koffi.array(...)` inside
     * this function returned the correct class for its first two calls and then
     * "?" for every call after that — an anonymous type per call is not a thing
     * to lean on.
     */
    const CLS_ARRAY = koffi.array('uint16', 64);
    return {
      koffi,
      error: null,
      api: {
        IsWindow: user32.func('bool __stdcall IsWindow(int64)'),
        GetWindowRect: (h: bigint) => {
          const r = {} as { left: number; top: number; right: number; bottom: number };
          return GetWindowRect(h, r) ? { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top } : null;
        },
        FindWindowEx: user32.func('int64 __stdcall FindWindowExW(int64, int64, str16, str16)'),
        /*
         * `SetParent` rather than `SetWindowLongPtr(GWL_HWNDPARENT)`, and the
         * difference matters here: mpv's window belongs to a *different process*,
         * and writing the parent field by hand is documented for windows in the
         * calling thread's own process. `SetParent` is the one that re-associates
         * the two input queues on a cross-process move.
         */
        SetParent: user32.func('int64 __stdcall SetParent(int64, int64)'),
        GetParent: user32.func('int64 __stdcall GetParent(int64)'),
        SetWindowPos: user32.func('bool __stdcall SetWindowPos(int64, int64, int, int, int, int, uint32)'),
        GetWindowLongPtr: user32.func('int64 __stdcall GetWindowLongPtrW(int64, int)'),
        IsZoomed: user32.func('bool __stdcall IsZoomed(int64)'),
        RedrawWindow: user32.func('bool __stdcall RedrawWindow(int64, int64, int64, uint32)'),
        SetWindowLongPtr: user32.func('int64 __stdcall SetWindowLongPtrW(int64, int, int64)'),
        ShowWindow: user32.func('bool __stdcall ShowWindow(int64, int)'),
        className: (h: bigint) => {
          try {
            const buf = koffi.alloc('uint16', 64);
            const n = GetClassNameW(h, buf);
            if (n <= 0) return '';
            const words = koffi.decode(buf, CLS_ARRAY) as number[];
            return String.fromCharCode(...words.slice(0, n));
          } catch {
            return '';
          }
        },
        cursor: () => {
          try {
            const p = { x: 0, y: 0 };
            return GetCursorPos(p) ? p : null;
          } catch {
            return null;
          }
        },
        leftButton: () => {
          try {
            // VK_LBUTTON; the high bit is the current state, the low bit is
            // "since someone last asked", which is why this is read as an edge.
            return (GetAsyncKeyState(0x01) & 0x8000) !== 0;
          } catch {
            return false;
          }
        },
      },
    };
  } catch (e) {
    return { koffi: null, api: null as unknown as Bindings, error: 'user32 bindings failed: ' + (e as Error).message };
  }
}

/**
 * mpv renders into a native child window of whatever HWND it is given with
 * `--wid`, and that child is a sibling of Chromium's own render surface. Which
 * one wins is therefore a z-order question, and the answer is `HWND_BOTTOM`:
 * mpv goes behind the composited page, and anywhere the page paints nothing the
 * video shows through. That is the cutout — a transparent rectangle in the DOM,
 * positioned by the same layout that used to hold a `<video>` element.
 *
 * Two consequences are load-bearing. The window has to be created
 * `transparent: true`: measured, an opaque window renders the cutout as a black
 * rectangle, because what sits behind the page is the window's own background
 * rather than another window. And nothing in the page can *see* the video — CSS
 * alpha still blends over it correctly, but `backdrop-filter` and the
 * liquid-glass shader sample the page, not the screen, so a surface that sits
 * over the cutout has to be a translucent fill rather than a refractor.
 *
 * Child windows are positioned in the parent's client area in *physical*
 * pixels while the DOM reports CSS pixels, so every rect is multiplied by the
 * display's scale factor. Measured at 125%: placement error is exactly zero on
 * all four edges.
 */
class MpvWindowHost {
  private api: Bindings | null = null;
  private root = 0n;
  /** The host window, so the scale factor can be read from it rather than the cursor. */
  private host: BrowserWindow | null = null;
  /**
   * The library window and its handle, kept for the whole session.
   *
   * The picture is handed *from* the widget back to this window when a card is
   * put away, and by then the overlay's `BrowserWindow` is destroyed — so the
   * place it came from has to be remembered rather than looked up.
   */
  private library: { win: BrowserWindow; root: bigint } | null = null;
  /**
   * The handle the picture was last seen under, after a retarget.
   *
   * mpv creates its window under the `--wid` handle it was spawned with, which is
   * the library's and is never going to change. So asking the widget for a picture
   * can race two ways: the child may already be sitting in the library and need
   * moving, or it may not exist yet and get created there a beat later while the
   * retry loop is looking for it in the widget. Keeping the handle we just left is
   * what lets either one be adopted instead of lost.
   */
  private altRoot = 0n;
  /** Send `SWP_FRAMECHANGED` with the next placement: a window has just moved parent. */
  private reframeNext = false;
  /** Class names seen while no video could have been on screen. */
  private chromiumClasses = new Set<string>(CHROMIUM_CHILD_CLASSES);
  private lastPlaced: { hwnd: string; slot: VideoSlot | null; physical: VideoSlot | null } | null = null;
  private failures: string[] = [];
  /** Why the Win32 bindings are missing, if they are. */
  private initError: string | null = null;
  /** The slot the renderer last asked for, kept so a late child can be placed. */
  private wanted: VideoSlot | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retriesLeft = 25;

  constructor() {
    const loaded = loadBindings();
    this.api = loaded?.api ?? null;
    this.initError = loaded?.error ?? null;
    if (this.initError) this.failures.push(this.initError);
  }

  get available(): boolean {
    return !!this.api;
  }

  /** The global cursor in physical screen pixels, or null without the bindings. */
  cursor(): { x: number; y: number } | null {
    return this.api?.cursor() ?? null;
  }

  /** Whether the left button is held on the desktop, or false without the bindings. */
  leftDown(): boolean {
    return this.api?.leftButton() ?? false;
  }

  get lastError(): string | null {
    return this.failures[this.failures.length - 1] ?? null;
  }

  /** The HWND mpv is told to draw into, or 0 before a window is attached. */
  get wid(): number {
    return this.root ? Number(this.root) : 0;
  }

  attach(win: BrowserWindow): void {
    const api = this.api;
    if (!api) return;
    try {
      this.root = win.getNativeWindowHandle().readBigInt64LE(0);
      this.host = win;
      this.library = { win, root: this.root };
      /*
       * Recorded rather than trusted: this is the only moment we know for certain
       * that no video is on screen, so any child that already exists is Chromium's.
       * `Intermediate D3D Window` is created after this point as well, which is
       * exactly why identification is by class and not by a snapshot.
       */
      this.markAsHostChrome(this.root);
    } catch (e) {
      this.failures.push('attach: ' + (e as Error).message);
      this.root = 0n;
    }
  }

  /**
   * The handle the picture is parented to right now, and the window that owns it.
   *
   * True while the film's native window lives in the floating widget rather than
   * the library, which is the one fact every other part of this arrangement needs:
   * a rectangle reported by the library is not a placement while the picture is
   * over there, because those coordinates would be read against the widget.
   */
  get pictureInWidget(): boolean {
    return !!this.library && this.root !== 0n && this.root !== this.library.root;
  }

  /**
   * Move the native picture between windows, or back to the library.
   *
   * `null` is the library. Nothing is destroyed and nothing is re-spawned: mpv's
   * window object survives the move, only its parent changes, so the decoder, its
   * swap chain and the frames already queued all stay exactly where they were. That
   * is the whole reason this is possible — a second `--wid` deck would cost the
   * second decoder this exists to remove.
   *
   * The child itself may not exist yet, or may exist under the handle we are
   * leaving: both are handled by `pictureChildren()`, which adopts on sight. So
   * this only has to decide *which window is the host from now on* and re-assert
   * the placement against it.
   */
  retarget(win: BrowserWindow | null): { ok: boolean; detail?: unknown; error?: string } {
    const api = this.api;
    if (!api) return { ok: false, error: 'koffi is not available' };
    const library = this.library;
    if (!library) return { ok: false, error: 'no window has ever been attached' };
    let nextRoot = library.root;
    let nextHost: BrowserWindow = library.win;
    if (win && win !== library.win && !win.isDestroyed()) {
      try {
        nextRoot = win.getNativeWindowHandle().readBigInt64LE(0);
        nextHost = win;
      } catch (e) {
        return { ok: false, error: 'retarget: ' + (e as Error).message };
      }
    }
    if (nextRoot === this.root) return { ok: true, detail: { moved: false, reason: 'already the host' } };
    this.altRoot = this.root;
    this.root = nextRoot;
    this.host = nextHost;
    /*
     * Whatever Chromium owns over there is not the picture. Done before the child
     * is moved in, so the mpv window itself cannot be swept into the set — the
     * class check below is what keeps a move back and forth from doing that.
     */
    this.markAsHostChrome(nextRoot);
    /*
     * A window that changes parent has to be told its frame changed, or it keeps
     * whatever non-client geometry it computed against the old one, and every
     * `SetWindowPos` afterwards is resolved against a client area that no longer
     * matches. Set once here rather than on every placement: the library path pays
     * nothing it did not pay before.
     */
    this.reframeNext = true;
    this.place(this.wanted);
    return { ok: true, detail: { moved: true, to: '0x' + nextRoot.toString(16), wanted: this.wanted } };
  }

  /** Record every class already living in `root` as belonging to the browser. */
  private markAsHostChrome(root: bigint): void {
    const api = this.api;
    if (!api) return;
    for (const c of this.childrenOf(root)) if (c.cls && c.cls !== 'mpv') this.chromiumClasses.add(c.cls);
  }

  /**
   * Give the window back the frame bits Electron drops for a transparent window.
   *
   * Measured on this exact build, same code, one flag different:
   * `frame: true` opaque  -> style 0x16cf0000, WS_THICKFRAME and WS_MAXIMIZEBOX set.
   * `frame: true` transparent -> style 0x16ca0000, **both cleared**.
   *
   * So `transparent: true` — which the embedded video requires — silently costs the
   * sizing border and the maximize button: the caption's middle button does nothing
   * and dragging an edge cannot resize. Re-adding the bits and sending
   * SWP_FRAMECHANGED puts both back without giving up transparency, which is the
   * only reason this function exists.
   */
  restoreFrame(win: BrowserWindow): { ok: boolean; before?: string; after?: string; error?: string } {
    const api = this.api;
    if (!api) return { ok: false, error: this.initError ?? 'koffi is not available' };
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      const before = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      /*
       * Never recompute the frame of a window Windows believes is maximised.
       *
       * The style write itself is innocent; `SWP_FRAMECHANGED` is not. It makes the
       * shell re-derive the maximised rectangle and repaint the non-client area
       * against it, and for a window left flagged as zoomed with no caption
       * underneath — which is exactly what stripping the bits out of a snapped
       * window produces — that paint faults the process. Measured: a caption-less
       * `IsZoomed` window handed `restoreFrame` killed the main process with a
       * segmentation fault and left both renderers running orphaned.
       *
       * Skipping costs nothing. A zoomed window cannot be edge-dragged, so a
       * missing `WS_THICKFRAME` has no effect while it is up, and the show-state
       * change that ends the zoom fires `keepFrame` again on a window that is safe
       * to touch.
       */
      if (api.IsZoomed(h)) {
        return { ok: true, before: '0x' + before.toString(16), after: '0x' + before.toString(16) };
      }
      /*
       * `WS_CAPTION` and `WS_SYSMENU` are in here for the same reason the other
       * three are: `stripFrame` takes all five off for the takeover, and a restore
       * that only puts back three leaves the window borderless with no close box
       * once the user leaves fullscreen. Measured on the first round trip — style
       * went 0x16cf0000 down to 0x16000000 and back up to only 0x16070000.
       */
      const after =
        (before | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) >>> 0;
      if (after === before) return { ok: true, before: '0x' + before.toString(16), after: '0x' + before.toString(16) };
      api.SetWindowLongPtr(h, GWL_STYLE, BigInt(after));
      api.SetWindowPos(h, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
      /*
       * `SWP_FRAMECHANGED` makes the window recalculate its non-client area, and it
       * recalculates into the default frame — on Windows 11 a flat white caption
       * from before DWM themed it. That is the "title bar turns weird" reported
       * after using the snap flyout: the snap works, and the caption is left
       * unpainted. Forcing a frame repaint hands it back to DWM, and `UPDATENOW`
       * rather than the deferred kind because the next thing is usually a maximize
       * that a queued invalidate can end up sitting behind.
       */
      api.RedrawWindow(h, 0, 0, RDW_INVALIDATE | RDW_FRAME | RDW_UPDATENOW | RDW_ERASE);
      const now = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      return { ok: true, before: '0x' + before.toString(16), after: '0x' + now.toString(16) };
    } catch (e) {
      const msg = (e as Error).message;
      this.failures.push('restoreFrame: ' + msg);
      return { ok: false, error: msg };
    }
  }

  /**
   * Take the caption away, which is also what gets the taskbar to move.
   *
   * Windows decides that an application has gone fullscreen by looking at the
   * window in front of it: no caption, no sizing border, and a rectangle covering
   * the whole monitor. When all three are true the shell hides the bar and lets the
   * app have the screen, and hovering the bottom edge brings the bar back — which is
   * the exact behaviour Chrome and Media Player have and this app did not.
   *
   * Electron's own `setFullScreen` and `setKiosk` were tried first and neither
   * produced it on a `transparent: true` window: the page grew to the monitor and
   * the taskbar stayed painted over the bottom of it, because the layered window
   * never presented as a fullscreen top-level to the shell. Clearing the bits by
   * hand and sending `SWP_FRAMECHANGED` is the same operation the shell is looking
   * for, done where it can see it.
   *
   * `restoreFrame` is the way back, and it is already the function the caption's
   * maximize button depends on.
   */
  stripFrame(win: BrowserWindow): { ok: boolean; before?: string; after?: string; error: string | null } {
    const api = this.api;
    if (!api) return { ok: false, error: this.initError ?? 'koffi is not available' };
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      const before = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      /*
       * Give up the zoom before giving up the caption.
       *
       * Clearing the decoration bits does not clear `WS_MAXIMIZE` — that is a
       * different bit from `WS_MAXIMIZEBOX` — so stripping the frame off a
       * maximised window leaves a window with no caption that Windows still paints
       * as maximised. That is the state `restoreFrame` now refuses to touch and the
       * state the shell's non-client repaint faults on, and it is also why the
       * takeover came up with the taskbar still showing: a zoomed window ignores a
       * bounds change. Restoring first ends both, and it is one call that is
       * already cheap.
       */
      if (api.IsZoomed(h)) api.ShowWindow(h, SW_RESTORE);
      const after = (before & ~(WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) >>> 0;
      if (after === before) return { ok: true, before: '0x' + before.toString(16), after: '0x' + before.toString(16), error: null };
      api.SetWindowLongPtr(h, GWL_STYLE, BigInt(after));
      api.SetWindowPos(h, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
      const now = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      return { ok: true, before: '0x' + before.toString(16), after: '0x' + now.toString(16), error: null };
    } catch (e) {
      const msg = (e as Error).message;
      this.failures.push('stripFrame: ' + msg);
      return { ok: false, error: msg };
    }
  }

  /**
   * Hand `WS_MINIMIZEBOX` back without touching anything else about the frame.
   *
   * `stripFrame` clears all five decoration bits at once because that is what the
   * shell's fullscreen test asks for, and one of the five is the thing that tells the
   * shell a window *can* be minimized — so Win+D walks past the takeover and leaves it
   * on screen. This is the probe for whether that single bit is the whole cause: no
   * `SWP_FRAMECHANGED`, because a window with no caption has no non-client area to
   * repaint and the repaint is the one thing that used to turn the titlebar white.
   */
  setMinimisable(win: BrowserWindow, on: boolean): { ok: boolean; before?: string; after?: string; error?: string } {
    const api = this.api;
    if (!api) return { ok: false, error: this.initError ?? 'koffi is not available' };
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      const before = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      const after = on
        ? (before | WS_MINIMIZEBOX) >>> 0
        : (before & ~WS_MINIMIZEBOX) >>> 0;
      if (after !== before) api.SetWindowLongPtr(h, GWL_STYLE, BigInt(after));
      const now = Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0;
      return { ok: true, before: '0x' + before.toString(16), after: '0x' + now.toString(16) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Give up — or, for diagnostics, take on — Windows' own maximised state.
   *
   * The app only ever uses the `off` direction now. Electron's `maximize()` places
   * this window on the work area with `WS_MAXIMIZE` clear, which is *correct* for a
   * frameless window: there is no caption and no sizing border for the client to sit
   * inside, so the work-area rectangle and the client rectangle are the same thing.
   *
   * Promoting it to a real `SW_MAXIMIZE` was tried, and it is what made the app
   * swallow the taskbar — for a window with no caption, Windows answers that call
   * with the monitor rather than the work area. The `on` direction stays available on
   * the dev bridge to make that measurable.
   *
   * The `off` direction still matters, because the shell's snap-layout preset does set
   * `WS_MAXIMIZE`, and a window left zoomed under the takeover ignores a bounds change
   * and comes up with the taskbar painted across the bottom of it.
   */
  zoom(win: BrowserWindow, on: boolean): { ok: boolean; zoomed?: boolean; error?: string } {
    const api = this.api;
    if (!api) return { ok: false, error: this.initError ?? 'koffi is not available' };
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      api.ShowWindow(h, on ? SW_MAXIMIZE : SW_RESTORE);
      return { ok: true, zoomed: api.IsZoomed(h) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** The live `GWL_STYLE` word, for the dev bridge to compare against its own record. */    styleOf(win: BrowserWindow): string | null {
    const api = this.api;
    if (!api) return null;
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      return '0x' + (Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0).toString(16);
    } catch {
      return null;
    }
  }

  /**
   * The same word, split into the names that matter for a caption.
   *
   * `maxbox` and `maximized` are separate bits (`0x00010000` and `0x01000000`), and
   * the bridge needs both: the first is "has a maximise button", the second is "is
   * maximised", and reading only one of them is how a dead button got mistaken for
   * a window that was already where it was going. `IsZoomed` remains the authority
   * on the second, because Windows sets it from the window's state rather than from
   * the bit alone.
   */
  styleBits(win: BrowserWindow): Record<string, boolean> | null {
    const api = this.api;
    if (!api) return null;
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      const s = (Number(api.GetWindowLongPtr(h, GWL_STYLE)) >>> 0);
      const ex = (Number(api.GetWindowLongPtr(h, GWL_EXSTYLE)) >>> 0);
      const has = (b: number) => (s & b) !== 0;
      return {
        caption: has(0x00c00000),
        thickframe: has(0x00040000),
        sysmenu: has(0x00080000),
        minbox: has(0x00020000),
        maxbox: has(0x00010000),
        maximized: has(0x01000000),
        visible: has(0x10000000),
        child: has(0x40000000),
        popup: has(0x80000000),
        ex_layered: (ex & 0x00080000) !== 0,
        ex_topmost: (ex & 0x00000008) !== 0,
        ex_toolwindow: (ex & 0x00000080) !== 0,
      };
    } catch {
      return null;
    }
  }

  /** `IsZoomed` — Windows' own answer to "is this window maximised". */
  isZoomed(win: BrowserWindow): boolean | null {
    const api = this.api;
    if (!api) return null;
    try {
      const h = win.getNativeWindowHandle().readBigInt64LE(0);
      return api.IsZoomed(h);
    } catch {
      return null;
    }
  }

  detach(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.root = 0n;
    this.host = null;
    this.library = null;
    this.altRoot = 0n;
    this.reframeNext = false;
    this.wanted = null;
    this.lastPlaced = null;
  }

  private children(): ChildInfo[] {
    return this.childrenOf(this.root);
  }

  /**
   * The direct children of one window.
   *
   * Parameterised because the picture is no longer guaranteed to live under
   * `this.root`: after a retarget it is under the handle we *left* until the first
   * placement finds it and moves it across.
   */
  private childrenOf(root: bigint): ChildInfo[] {
    const api = this.api;
    if (!api || !root || !api.IsWindow(root)) return [];
    const out: ChildInfo[] = [];
    /* Null, null for the class and title filters: this enumerates everything. */
    let c = api.FindWindowEx(root, 0n, null, null);
    for (let i = 0; c && i < 32; i++) {
      const style = Number(api.GetWindowLongPtr(c, GWL_STYLE)) >>> 0;
      out.push({ hwnd: c, cls: api.className(c), visible: !!(style & WS_VISIBLE), rect: api.GetWindowRect(c) });
      c = api.FindWindowEx(root, c, null, null);
    }
    return out;
  }

  /**
   * mpv's child window, if it has one.
   *
   * By class, with "not one of Chromium's own" as the fallback. A version that
   * only diffed against the child set captured when the window was created got
   * this wrong: Chromium adds its `Intermediate D3D Window` child *after* that
   * moment, so the snapshot treated Chromium's own window as the newcomer and
   * never saw the real one — the placement then applied to the wrong window and
   * the video stayed hidden.
   *
   * The fallback is only allowed in the library, which is where it was measured.
   * A widget this module has never enumerated is a fresh set of browser surfaces
   * with no snapshot behind them, and guessing there would mean re-parenting
   * whatever Chromium window the guess happened to hit. mpv's class is literally
   * `mpv`, so naming it is not a fragile dependency.
   */
  private mpvChildren(): ChildInfo[] {
    const all = this.children();
    const byClass = all.filter((c) => c.cls === 'mpv');
    if (byClass.length) return byClass;
    if (!this.library || this.root !== this.library.root) return [];
    return all.filter((c) => c.cls && !this.chromiumClasses.has(c.cls));
  }

  /**
   * The picture's window, wherever it currently lives, moved into this host.
   *
   * The one place the two halves of a retarget meet. If the child is already under
   * the handle we are drawing into, nothing happens. If it is not, it is looked for
   * under the handle we came from and adopted: adopted on the way *in* because mpv
   * only ever creates its window under the `--wid` it was spawned with — the
   * library's — so a card that asks for a picture the deck is already showing finds it
   * sitting in a window nobody is looking at; and adopted on the way *out*, from the
   * widget, for the mirror reason.
   *
   * Abroad the match is on the class name alone. The by-elimination fallback that
   * finds the window at home is a guess about which of several browser surfaces is
   * the newcomer; abroad, the only thing worth taking is one mpv definitely made.
   */
  private pictureChildren(): ChildInfo[] {
    const api = this.api;
    if (!api) return [];
    /*
     * Named by class, here. The whole job in one check, and the answer everyone
     * else in this file is working towards.
     */
    const here = this.children().filter((c) => c.cls === 'mpv');
    if (here.length) return here;
    /*
     * Named by class, abroad — so bring it home.
     *
     * Tried *before* the by-elimination guess below, and deliberately: the guess is
     * the reason that fallback exists at all, but a window it can also match is a
     * Chromium surface, and right now there is a definite `mpv` window somewhere
     * else. Choosing the guess over the certainty would re-parent the browser's own
     * rendering surface and leave the film where it was.
     */
    const abroad = this.abroad();
    if (abroad.length) {
      return this.movePicture(abroad[0].hwnd, this.root)
        ? [{ ...abroad[0], rect: api.GetWindowRect(abroad[0].hwnd) }]
        : [];
    }
    /*
     * Guessed by elimination, and only ever in the library.
     *
     * `mpvChildren()` already ran the class check above, so what it can add here is
     * the fallback alone — which is the half that is safe only in a window whose
     * every other child was snapshotted before any video could exist.
     */
    return this.library && this.root === this.library.root ? this.mpvChildren() : [];
  }

  /**
   * mpv's window, still living under the handle a retarget left behind.
   *
   * Read-only, so `debug()` can show a stranded picture without dragging it across
   * processes on the way past.
   */
  private abroad(): ChildInfo[] {
    const api = this.api;
    if (!api || !this.altRoot || this.altRoot === this.root || !api.IsWindow(this.altRoot)) return [];
    return this.childrenOf(this.altRoot).filter((c) => c.cls === 'mpv');
  }

  /**
   * Reparent the picture, then make sure it is still a child.
   *
   * The style pass is not decoration. `SetParent` accepts a popup and turns it into
   * a child without touching its style bits, and a window that is still `WS_POPUP`
   * after the move keeps being positioned against the screen rather than against
   * its parent's client area — every placement then lands somewhere plausible and
   * nothing is ever visibly wrong except the picture being in the wrong place.
   */
  private movePicture(child: bigint, parent: bigint): boolean {
    const api = this.api;
    if (!api) return false;
    try {
      /*
       * Its visibility is its own business, and it has to survive the trip. A
       * picture being handed back from a card that is about to be destroyed is
       * normally hidden already — and force-showing it would paint the last frame
       * of the film, at the card's coordinates, inside the library window for as
       * long as it takes the next placement to hide it again.
       */
      const wasVisible = (Number(api.GetWindowLongPtr(child, GWL_STYLE)) >>> 0 & WS_VISIBLE) !== 0;
      api.SetParent(child, parent);
      if (api.GetParent(child) !== parent) {
        this.failures.push('reparent: GetParent did not return the new host');
        return false;
      }
      const style = Number(api.GetWindowLongPtr(child, GWL_STYLE)) >>> 0;
      if (!(style & WS_CHILD)) {
        const fixed = ((style & ~WS_POPUP) | WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN) >>> 0;
        api.SetWindowLongPtr(child, GWL_STYLE, BigInt(fixed));
      }
      api.ShowWindow(child, wasVisible ? SW_SHOWNOACTIVATE : SW_HIDE);
      this.reframeNext = true;
      return true;
    } catch (e) {
      this.failures.push('reparent: ' + (e as Error).message);
      return false;
    }
  }

  /**
   * Move mpv's window behind the page and over the slot. A null slot hides it:
   * that is the state between tracks, and while audio plays.
   *
   * The child only exists once mpv has decoded a video frame, which lands a
   * beat after `vid` is set — so a placement request for a window that is not
   * there yet is normal, and is retried rather than dropped. Without the retry
   * the first frames of every video show at mpv's own full-window size.
   *
   * Every placement goes through `pictureChildren()`, which also *moves* the
   * window when it is living under the handle we left. So a placement is what
   * completes a retarget, and the retry covers a retarget asked for before the
   * decoder had produced anything to move.
   */
  place(slot: VideoSlot | null): { ok: boolean; detail?: unknown; error?: string } {
    const api = this.api;
    if (!api) return { ok: false, error: 'koffi is not available' };
    this.wanted = slot;
    if (slot) this.retriesLeft = 25;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const kids = this.pictureChildren();
    if (!kids.length) {
      if (slot) this.scheduleRetry();
      return { ok: true, detail: { placed: false, reason: slot ? 'no mpv window yet' : 'nothing to hide' } };
    }
    return this.apply(api, kids, slot);
  }

  private scheduleRetry(): void {
    if (this.retriesLeft <= 0) return;
    this.retriesLeft -= 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted) return;
      this.place(this.wanted);
    }, 80);
  }

  private apply(api: Bindings, kids: ChildInfo[], slot: VideoSlot | null): { ok: boolean; detail?: unknown } {
    /*
     * The scale factor of the *window*, not of whatever monitor the cursor
     * happens to be over.
     *
     * The rectangle being converted is parent-client CSS pixels — it only means
     * something relative to this window — so asking the display under the
     * pointer asks the wrong question. Put the cursor on a second monitor at a
     * different scale and every placement is off by the ratio between them,
     * which lands the picture outside the card it belongs to; and because the
     * child is raised above the page, on top of whatever else is there.
     */
    let sf = 1;
    try {
      const bounds = this.host && !this.host.isDestroyed() ? this.host.getBounds() : null;
      sf = bounds
        ? screen.getDisplayMatching(bounds).scaleFactor
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).scaleFactor;
    } catch {
      sf = 1;
    }
    if (slot === null) {
      for (const k of kids) api.ShowWindow(k.hwnd, SW_HIDE);
      this.lastPlaced = { hwnd: kids[0].hwnd.toString(16), slot: null, physical: null };
      return { ok: true, detail: { placed: false, hidden: kids.length } };
    }
    /*
     * No client-area inset is added here, and adding one is what put the film
     * outside its card.
     *
     * `SetWindowPos` on mpv's window takes *parent-client* coordinates, and the
     * rectangle the page sends is already measured against the viewport, which is
     * the client area — the two are the same space and need no bridge. The inset
     * used to be added on the strength of a reading of `GetWindowRect` that showed
     * a slot at 973,124 landing at 1225,193 when 1216,155 was asked for. That was
     * never a placement error: `GetWindowRect` answers in *screen* coordinates, so
     * a child sitting exactly where it was put in its parent's client area still
     * reports the parent's client origin added on. Measured directly after the
     * change, on this window at 125%: asked for 1225,185, `GetWindowRect` says
     * 1234,223 — the same +9,+38 the inset was supplying, once instead of twice.
     *
     * The cost of the double count was 9 and 38 physical pixels, 7 and 30 CSS, of
     * film sliding down and right out of the rounded card it belongs to — the user
     * asking for the picture "more upward and a bit toward the left", with the
     * card's own corner showing through on the other two sides.
     */
    const phys = {
      x: Math.round(slot.x * sf),
      y: Math.round(slot.y * sf),
      w: Math.round(slot.w * sf),
      h: Math.round(slot.h * sf),
    };
    let ok = true;
    for (const k of kids) {
      /*
       * Only the first child is the live deck's; a second one would mean the
       * standby deck turned video on as well, which the engine prevents. It is
       * hidden rather than left on top of the visible one.
       *
       * The z-order is per-mode, and the two halves of this comment are the two
       * halves of the design.
       *
       * Docked: HWND_TOP. The plan was always to slip mpv behind the composited
       * page and punch a transparent hole in the DOM, and the hole is real at the
       * DOM level — `elementFromPoint` over the slot returns nothing but
       * transparent ancestors — but not at the window level: `.tint-layer` is a
       * full-window `rgb(13,10,13)` at 51% and the backdrop canvas covers the same
       * rect, and both are page content sitting above a sibling at the bottom.
       * Measured: held at BOTTOM the docked slot was a washed-out dark smear;
       * raised to TOP the same window rendered the frame correctly. Those layers
       * cannot be switched off there, because the docked card sits *inside* the
       * library the user is browsing.
       *
       * Fullscreen takeover: HWND_BOTTOM, on the renderer's say-so. That is the
       * one view where the page has nothing it wants to keep over the film, so it
       * hides those layers itself (`.app-root.video-under` in globals.css) and the
       * picture comes through. What that buys is the thing TOP makes impossible:
       * the control pill drawn *over* the film instead of a dead band at its foot.
       *
       * The mini card is BOTTOM too, for the same reason and by a different route:
       * it has no tint or backdrop layer at all — `App.tsx` refuses to render them
       * into an overlay window — so the only page content over the picture is the
       * card's own scrub bar, its transport row and the head, and those have to be
       * *above* the film or the widget cannot be driven at all. Raised to TOP the
       * native window would swallow every one of them along with their clicks.
       */
      const z = slot.under ? HWND_BOTTOM : HWND_TOP;
      /*
       * `SWP_FRAMECHANGED` exactly once after a reparent, never on an ordinary
       * placement. Windows recomputes a child's non-client geometry lazily, so the
       * first position after `SetParent` can be resolved against the frame the
       * window had under its previous host; on a card the size of this one that is
       * a few pixels of film outside the rounded corner, which reads as the widget
       * being drawn slightly wrong rather than as a window-management bug.
       */
      const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (this.reframeNext ? SWP_FRAMECHANGED : 0);
      ok = api.SetWindowPos(k.hwnd, z, phys.x, phys.y, phys.w, phys.h, flags) && ok;
    }
    this.reframeNext = false;
    if (kids.length > 1) for (const k of kids.slice(1)) api.ShowWindow(k.hwnd, SW_HIDE);
    this.lastPlaced = { hwnd: kids[0].hwnd.toString(16), slot, physical: phys };
    return { ok, detail: { placed: true, scale: sf, z: slot.under ? 'bottom' : 'top', wanted: phys, got: api.GetWindowRect(kids[0].hwnd) } };
  }

  /** Re-assert the last placement, e.g. after a resize or a DPI change. */
  sync(): void {
    if (this.root) this.place(this.wanted);
  }

  bringToFrontForTest(): void {
    const api = this.api;
    const k = this.mpvChildren()[0];
    if (api && k) api.SetWindowPos(k.hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
  }

  debug(): Record<string, unknown> {
    const kids = this.mpvChildren();
    return {
      available: this.available,
      initError: this.initError,
      root: this.root ? '0x' + this.root.toString(16) : null,
      /** Which window the picture is parented to, and the one it came from. */
      inWidget: this.pictureInWidget,
      libraryRoot: this.library ? '0x' + this.library.root.toString(16) : null,
      altRoot: this.altRoot ? '0x' + this.altRoot.toString(16) : null,
      abroad: this.abroad().map((c) => ({ hwnd: '0x' + c.hwnd.toString(16), cls: c.cls, rect: c.rect })),
      chromiumClasses: [...this.chromiumClasses],
      allChildren: this.children().map((c) => ({ hwnd: '0x' + c.hwnd.toString(16), cls: c.cls, visible: c.visible, rect: c.rect })),
      mpvChildren: kids.map((c) => ({ hwnd: '0x' + c.hwnd.toString(16), cls: c.cls, visible: c.visible, rect: c.rect })),
      lastPlaced: this.lastPlaced
        ? { ...this.lastPlaced, hwnd: '0x' + this.lastPlaced.hwnd }
        : null,
      failures: this.failures,
      lastError: this.lastError,
    };
  }
}


export const mpvWindow = new MpvWindowHost();
export const SWP_FLAGS = { SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_HIDEWINDOW };
export const Z_ORDER = { HWND_TOP, HWND_BOTTOM, SW_HIDE, SW_SHOWNOACTIVATE };
