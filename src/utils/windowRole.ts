/**
 * Which of the app's windows this renderer is.
 *
 * The overlay is a second `BrowserWindow` pointed at the same bundle with
 * `?view=pill` or `?view=mini` on the URL. It is frameless and always-on-top,
 * which is the whole reason it exists: Electron cannot flip `frame` on a live
 * window, so shrinking the library window could never give a floating card a
 * chrome-less edge — it just made a small window with a Windows title bar
 * welded across the top of it.
 *
 * Mini and pill share this one mechanism rather than each growing their own,
 * because everything they need is identical: no OS chrome, always-on-top, no
 * taskbar entry, and a drag strip in place of a title bar. Only the size and
 * which layer of the UI they show differ.
 *
 * Both windows run the same bundle, so the store, the library cache and the
 * glass engine are shared by construction. Playback is shared too now that mpv
 * lives in the main process — there is one deck set for every window, which is
 * what removed the need for the audio hand-off this file used to describe.
 */
const view =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('view')
    : null;

export type WindowRole = 'main' | 'pill' | 'mini';

export const WINDOW_ROLE: WindowRole = view === 'pill' || view === 'mini' ? view : 'main';

/** True in either floating window, false in the library window. */
export const IS_OVERLAY_WINDOW = WINDOW_ROLE !== 'main';

export const IS_PILL_WINDOW = WINDOW_ROLE === 'pill';
export const IS_MINI_WINDOW = WINDOW_ROLE === 'mini';

/**
 * The widget this window *is*, or null in the library window. Typed as the
 * overlay subset so consumers do not have to re-narrow `'main'` away.
 */
export const OVERLAY_ROLE: 'pill' | 'mini' | null = WINDOW_ROLE === 'main' ? null : WINDOW_ROLE;

export type PillSide = 'left' | 'right';

/**
 * Which edge the strip is docked to, as the main process launched it.
 *
 * Read from the URL rather than asked over IPC so the very first paint is
 * already mirrored. A round trip here means the strip renders on the right,
 * waits for an answer, and then jumps — on the control whose entire purpose is
 * to stay put.
 *
 * This is the *initial* value. The user can flip it at runtime, which the store
 * carries; the two only disagree until the next time the window is created, at
 * which point main has been told and they agree again.
 */
export const PILL_SIDE_FROM_URL: PillSide =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('side') === 'left'
    ? 'left'
    : 'right';
