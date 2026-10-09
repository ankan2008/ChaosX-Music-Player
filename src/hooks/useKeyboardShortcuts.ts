import { useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { getEngine } from '../audio/engine';
import { claimMediaKey } from '../utils/mediaGuard';
import { bindIndex, keyOf, type BindId } from '../utils/keybinds';

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

/*
 * The zoom, applied to the document root.
 *
 * `Ctrl+Shift+"+"` and `Ctrl+"-"` always did something in this app, and none of it
 * was the app's doing: Chromium zooms a page on those keys and the renderer just
 * watched. That is why the two rows could not be rebound — the combination that was
 * *listed* in the settings table and the combination that actually fired lived in
 * different programs. They are entries in the table now, and the handler below is
 * the only thing that zooms.
 *
 * The default is suppressed rather than lived with. Measured against the running
 * app with a capture-phase listener that calls `preventDefault()` on the keydown:
 * without it `devicePixelRatio` walks 1.25 → 1.141 on one press of Ctrl+"-", and
 * with it the ratio does not move at all. So the browser does stand down when the
 * page cancels the event, and cancelling is what keeps one press worth one step —
 * the double-zoom that a handler which only *added* its own scaling would have
 * produced.
 *
 * It is an inline style on `<html>` and not a field in the store, which is the
 * whole of "does not come back next launch": the store is persisted and a reload
 * is not. Reading it back off the same style rather than keeping a counter beside
 * it means a hot reload that leaves the element styled cannot desynchronise the
 * number the next step is computed from.
 */
const ZOOM_STEP = 1.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

function rootZoom(): number {
  const raw = parseFloat(document.documentElement.style.getPropertyValue('zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function setRootZoom(next: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
  document.documentElement.style.setProperty('zoom', clamped.toFixed(4));
}

/**
 * Local keyboard shortcuts (app focused) + global hardware media keys
 * forwarded from the Electron main process.
 *
 * The map is data — see `utils/keybinds` — because the Settings page lets the
 * user rewrite it, and a `switch` on `e.code` with the modifier tests inlined in
 * each arm cannot be shown, edited or clash-checked by anything else.
 */
export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const store = usePlayerStore.getState();
      const id: BindId | undefined = bindIndex(store.binds).get(keyOf(e));
      if (!id) return;

      /*
       * Plain arrows seek; Ctrl moves between tracks.
       *
       * Both used to seek, with Shift doing the track skip — three bindings for
       * two actions, and the Settings page listed all three. Shift is the mode
       * modifier, so it came off the arrows. Those two rows are now just entries
       * in the table with a modifier on one of them, which is why the modifier
       * test that used to live here is gone: the lookup key already carries it.
       */
      switch (id) {
        case 'playpause':
          e.preventDefault();
          void store.togglePlay();
          break;
        case 'seek-back':
          e.preventDefault();
          getEngine().seekBy(-5);
          break;
        case 'seek-forward':
          e.preventDefault();
          getEngine().seekBy(5);
          break;
        case 'previous':
          e.preventDefault();
          store.playPrevious();
          break;
        case 'next':
          e.preventDefault();
          store.playNext();
          break;
        case 'volume-up':
          e.preventDefault();
          store.setVolume(store.volume + 0.05);
          break;
        case 'volume-down':
          e.preventDefault();
          store.setVolume(store.volume - 0.05);
          break;
        case 'mute':
          e.preventDefault();
          store.toggleMute();
          break;
        case 'fullscreen':
          e.preventDefault();
          store.setNowPlayingFull(!store.nowPlayingFull);
          break;
        /*
         * Closing a widget goes through `overlay.collapse()`, not `setView('normal')`.
         * In the library window `setView` deliberately leaves the widget alone —
         * Normal vs Fullscreen there is a statement about the library, and the
         * strip beside it is unaffected — so routing the toggle through it pressed
         * the key and did nothing visible. The cross-conversion (pill → mini) still
         * goes through `setView`, because mini and pill share one overlay window and
         * asking for the other one retargets it.
         */
        case 'pill':
          e.preventDefault();
          if (store.overlayRole === 'pill') void window.electronAPI?.overlay?.collapse?.();
          else store.setView('pill');
          break;
        case 'mini':
          e.preventDefault();
          if (store.overlayRole === 'mini') void window.electronAPI?.overlay?.collapse?.();
          else store.setView('mini');
          break;
        case 'escape': {
          /*
           * A video that is fullscreen is left first, and the takeover with it: the
           * effect that keeps a film out of the music takeover re-asserts
           * `videoFullscreen` the moment it finds both up, so closing only the film
           * looked like a key that did nothing at all.
           */
          const s = usePlayerStore.getState();
          if (s.videoFullscreen) {
            s.setVideoFullscreen(false);
            if (s.nowPlayingFull) s.setNowPlayingFull(false);
          } else if (s.nowPlayingFull) {
            s.setNowPlayingFull(false);
          }
          break;
        }
        /*
         * Cancelled before anything else, including at the clamp: at 200% a press
         * that has nowhere to go still has to swallow the key, or Chromium zooms
         * the page on a row that visibly did nothing and the two scales start
         * drifting apart.
         */
        case 'zoom-in':
          e.preventDefault();
          setRootZoom(rootZoom() * ZOOM_STEP);
          break;
        case 'zoom-out':
          e.preventDefault();
          setRootZoom(rootZoom() / ZOOM_STEP);
          break;
      }
    };

    const onKeyDownEsc = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      /*
       * Escape means "put the app back". The video takeover is the one full-screen
       * surface a user can get into without meaning to — a single click on the
       * picture — and the pill's own exit button already promises Esc does the
       * same thing, so the key has to actually do it. A dropdown that is open
       * closes itself first and stops the event, so this only ever fires when
       * nothing smaller is on screen to dismiss.
       */
      const s = usePlayerStore.getState();
      if (s.videoFullscreen) {
        s.setVideoFullscreen(false);
        if (s.nowPlayingFull) s.setNowPlayingFull(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onKeyDownEsc);

    const offMediaKey = window.electronAPI?.onMediaKey((action: string) => {
      // The SMTC session may already have acted on this same button press.
      if (!claimMediaKey()) return;
      const store = usePlayerStore.getState();
      switch (action) {
        case 'playpause':
          void store.togglePlay();
          break;
        case 'next':
          store.playNext();
          break;
        case 'previous':
          store.playPrevious();
          break;
        case 'stop':
          store.stop();
          break;
      }
    });

    return () => {
      /*
       * Both listeners, not just the first. The Escape one was added and never
       * removed, so every remount of the hook — and a hot reload remounts it —
       * stacked another copy of the whole key handler on the window. For the rows
       * that merely toggle something a stacked handler is invisible; for zoom,
       * which multiplies the root's scale once per handler that sees the press, it
       * is the double-zoom again from the opposite direction.
       */
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onKeyDownEsc);
      offMediaKey?.();
    };
  }, []);
}
