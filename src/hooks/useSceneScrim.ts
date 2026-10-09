import { useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';

const SAMPLE = 16;

/**
 * Linear blend between two `rgba()` colours, `t` from 0 to 1.
 *
 * Done in JS rather than in CSS because the two ends differ in alpha as well as
 * in channel values — the light-theme ink is translucent white, the deep one is a
 * nearly-opaque charcoal — and `color-mix` would interpolate the alpha against the
 * wrong axis for text.
 */
function mix(
  r0: number, g0: number, b0: number, a0: number,
  r1: number, g1: number, b1: number, a1: number,
  t: number,
): string {
  const l = (x: number, y: number) => Math.round(x + (y - x) * t);
  return `rgba(${l(r0, r1)}, ${l(g0, g1)}, ${l(b0, b1)}, ${(a0 + (a1 - a0) * t).toFixed(3)})`;
}

/**
 * Glass refracts whatever the backdrop layer painted, so a bright wallpaper
 * washes every card out and white text turns unreadable, while a dark one
 * looks fine. Rather than force the user to pick a darker image, measure the
 * scene and dim only the refracted copy inside glass panels — a dark
 * wallpaper leaves the look exactly as it was.
 *
 * The measurement is driven by the things that actually change the scene, not
 * by a clock. Reading the backdrop canvas is a full-size `drawImage` down to
 * the 16px sample, and in fullscreen music mode that canvas is the record:
 * measured at 29-33ms per read, which on a 600ms timer threw away one frame
 * twice a second — the periodic hitch in an otherwise smooth spin. The scene's
 * average brightness only moves when the artwork does, so artwork, mode,
 * resize and tab-visibility are the events worth listening for.
 */
export function useSceneScrim(): void {
  const artId = usePlayerStore((s) => s.currentTrack?.id ?? '');
  const mode = usePlayerStore((s) =>
    s.pillMode ? 'pill' : s.miniPlayer ? 'mini' : s.nowPlayingFull ? 'full' : 'normal',
  );
  /*
   * The scene is also repainted when the wallpaper or the backdrop source
   * changes, and neither of those used to re-measure. The effect keyed off
   * artwork and mode alone, so swapping in a bright custom background — or
   * turning album art on as the backdrop — left the scrim and the ink sitting at
   * whatever the previous scene had measured, until the next track started.
   */
  const background = usePlayerStore((s) => s.background);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);
  const wallpaperKind = usePlayerStore((s) => s.wallpaperKind);

  useEffect(() => {
    const scratch = document.createElement('canvas');
    scratch.width = SAMPLE;
    scratch.height = SAMPLE;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    let applied = -1;
    let lastLum = -1;
    let frame = 0;

    const measure = () => {
      const backdrop = document.querySelector<HTMLCanvasElement>('.backdrop-layer');
      // No in-app scene means the OS material shows through; it reads mid-dark.
      let luminance = 0.28;

      if (backdrop && backdrop.width > 0 && backdrop.height > 0) {
        try {
          ctx.drawImage(backdrop, 0, 0, SAMPLE, SAMPLE);
          const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
          let sum = 0;
          for (let i = 0; i < data.length; i += 4) {
            sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
          }
          luminance = sum / (data.length / 4);
        } catch {
          return;
        }
      }

      const excess = Math.min(0.5, Math.max(0, luminance - 0.32) * 1.1);
      const brightness = Math.round((1 - excess) * 1000) / 1000;
      if (brightness === applied && lastLum === luminance) return;
      applied = brightness;
      lastLum = luminance;
      document.documentElement.style.setProperty('--glass-bright', String(brightness));
      /*
       * Deepen the ink over a bright scene.
       *
       * The scrim above only darkens what is refracted *into a glass panel*. Text
       * that sits on the raw backdrop — the sidebar labels, the clock, the track
       * list rows — never passes through a panel, so a near-white album art as
       * the wallpaper leaves white-on-white and nothing else in the app can save
       * it. Roughly two thirds of covers are dark enough to leave this untouched;
       * it only starts biting past 0.52, where the scrim has already given up.
       */
      const ink = Math.min(1, Math.max(0, (luminance - 0.52) / 0.34));
      const root = document.documentElement.style;
      root.setProperty('--scene-ink', ink.toFixed(3));
      /*
       * These three are the app's whole text ladder, and they are written here
       * rather than only in the stylesheet — so a change to `--glass-text` in
       * `globals.css` that is not mirrored here does nothing at all. The base of
       * each mix is the stylesheet's value and must be kept equal to it by hand.
       */
      root.setProperty(
        '--glass-text',
        mix(255, 255, 255, 0.66, 22, 18, 28, 0.88, ink),
      );
      root.setProperty(
        '--glass-text-muted',
        mix(255, 255, 255, 0.46, 26, 22, 32, 0.74, ink),
      );
      root.setProperty(
        '--glass-text-dim',
        mix(255, 255, 255, 0.3, 26, 22, 32, 0.58, ink),
      );
    };

    /*
     * The backdrop is repainted by its own animation loop, so the frame right
     * after a scene change can still hold the previous artwork. Two frames is
     * enough for the new pixels to be there without waiting on a timer.
     */
    const run = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { frame = 0; measure(); });
      });
    };

    run();
    const onResize = () => run();
    const onVisible = () => { if (!document.hidden) run(); };
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [artId, mode, background, wallpaperPath, wallpaperKind]);
}
