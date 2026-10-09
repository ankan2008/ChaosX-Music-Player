import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_ACCENT, extractAccentColor } from '../../utils/accentColor';
import { invalidateScene } from '../../glass/scene';
import { usePlayerStore } from '../../stores/playerStore';
import { cachedCover } from '../../utils/metadata';

/**
 * The wash is built at this size and stretched to fill. Big enough that the
 * stretch reads as a gradient rather than a mosaic, small enough that the
 * blur pass inside it costs almost nothing.
 */
const WASH = 192;
/** Gaussian radius applied while the wash is still small. */
const WASH_BLUR = 14;
/**
 * Everything is composed into a buffer this size and blown up once. The field
 * is pure gradient, so it loses nothing at 220px, and painting it at window
 * resolution cost three full-screen radial fills a frame.
 */
const BUF = 220;
/** Frames between repaints. The blooms drift on a scale of seconds. */
const FRAME_TICK = 30;
/** Frames of immediate refresh after the artwork swaps, to catch the change. */
const SCENE_BURST = 10;
/**
 * How long the field may keep wearing the previous sleeve while the new one is
 * fetched. See `ART_HOLD_SETTLE_MS` in `BackdropLayer` for the measurement behind
 * the number; the wash reads the same store field as the backdrop does, so it goes
 * empty on the same track change and has to wait out the same second.
 */
const ART_HOLD_SETTLE_MS = 1600;

function rgbOf(css: string): [number, number, number] {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [250, 95, 124];
}

/**
 * Rotate a colour through hue space in JS. `ctx.filter = 'hue-rotate(...)'`
 * does the same thing, but a filter forces the canvas onto a CPU path for the
 * whole filled region, which is the expensive half of this component.
 */
function hueShift([r, g, b]: [number, number, number], deg: number): [number, number, number] {
  if (!deg) return [r, g, b];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(r * m[0] + g * m[1] + b * m[2]),
    clamp(r * m[3] + g * m[4] + b * m[5]),
    clamp(r * m[6] + g * m[7] + b * m[8]),
  ];
}

/**
 * The colour field behind the takeover and mini views: the cover blown out
 * into a saturated wash, with slow blooms tinted from the artwork's own accent.
 *
 * It is painted into a canvas rather than built from CSS gradients for one
 * specific reason: the glass shader draws `img`/`video`/`canvas` descendants
 * into its scene even through a `data-no-capture` wrapper, but never CSS
 * backgrounds. As a canvas, the pill and the clock sitting on top of it
 * refract this exact light — red cover, red glass.
 *
 * A rotating pre-blurred cover was tried in place of this and measured 17fps
 * against 31fps with the rotation paused, on the 21 glass panels of the
 * takeover view: a 1000px clipped layer re-rasterising under a CSS rotation is
 * not free on integrated graphics. The pivot props are kept so it can return
 * on surfaces small enough to afford it.
 */
const AmbientFlow: React.FC<{
  art: string | null;
  className?: string;
  pivotX?: number;
  pivotY?: number;
}> = ({ art, className = '', pivotX = 0.5, pivotY = 0.5 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const washRef = useRef<HTMLCanvasElement | null>(null);
  const rgbRef = useRef<[number, number, number]>(rgbOf(DEFAULT_ACCENT));
  const burstRef = useRef(0);
  const pivotRef = useRef<[number, number]>([pivotX, pivotY]);
  pivotRef.current = [pivotX, pivotY];

  /*
   * The artwork the field is washed from, which is not always the one in the prop.
   *
   * `art` comes off `currentTrack.albumArt`, and that is fetched asynchronously now
   * that a song starts, so on a track change it arrives as null first — and the wash
   * dropped to the default accent for a second and then swam back. A missing cover
   * has to be told apart from a cover that has not landed yet, and only the second
   * one is worth holding the old colour field for.
   *
   * Keyed on the track id so a file with no artwork still fades to the plain field
   * it was built to show: `cachedCover` answers `null` outright for a file already
   * known to carry no picture, and everything else gets the bounded settle.
   */
  const trackId = usePlayerStore((s) => s.currentTrack?.id ?? null);
  const trackPath = usePlayerStore((s) => s.currentTrack?.path ?? null);
  const [heldArt, setHeldArt] = useState<string | null>(art);
  const resolvedForRef = useRef<string | null>(art ? trackId : null);
  const settleRef = useRef(0);

  useEffect(() => {
    const clear = () => {
      if (settleRef.current) {
        window.clearTimeout(settleRef.current);
        settleRef.current = 0;
      }
    };
    clear();

    if (!trackId) {
      resolvedForRef.current = null;
      setHeldArt(null);
      return;
    }
    if (art) {
      resolvedForRef.current = trackId;
      setHeldArt(art);
      return;
    }
    if (resolvedForRef.current === trackId) return;
    if (trackPath && cachedCover(trackPath) === null) {
      resolvedForRef.current = trackId;
      setHeldArt(null);
      return;
    }
    const known = trackPath ? cachedCover(trackPath) : undefined;
    if (known) {
      resolvedForRef.current = trackId;
      setHeldArt(known);
      return;
    }
    settleRef.current = window.setTimeout(() => {
      settleRef.current = 0;
      resolvedForRef.current = trackId;
      setHeldArt(null);
    }, ART_HOLD_SETTLE_MS);
    return clear;
  }, [art, trackId, trackPath]);

  useEffect(() => {
    let alive = true;
    if (!heldArt) {
      washRef.current = null;
      // The blooms take their colour from the artwork too, so a song with none
      // gives it back: holding the wash would be a mercy, holding the last
      // sleeve's *hue* forever would be a lie about what is playing.
      rgbRef.current = rgbOf(DEFAULT_ACCENT);
      burstRef.current = SCENE_BURST;
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive || img.naturalWidth <= 0) return;
      const tiny = document.createElement('canvas');
      tiny.width = WASH;
      tiny.height = WASH;
      const tctx = tiny.getContext('2d');
      if (!tctx) return;
      tctx.filter = `blur(${WASH_BLUR}px)`;
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
      const s = Math.max(img.naturalWidth, img.naturalHeight);
      tctx.drawImage(
        img,
        (img.naturalWidth - s) / 2,
        (img.naturalHeight - s) / 2,
        s,
        s,
        -WASH_BLUR,
        -WASH_BLUR,
        WASH + WASH_BLUR * 2,
        WASH + WASH_BLUR * 2,
      );
      washRef.current = tiny;
      // Armed when the pixels arrive, not when the request goes out —
      // otherwise it can expire mid-download and the new colour lands on a
      // panel that already stopped looking.
      burstRef.current = SCENE_BURST;
    };
    img.src = heldArt;
    void extractAccentColor(heldArt).then((c) => {
      if (!alive) return;
      rgbRef.current = rgbOf(c);
      burstRef.current = SCENE_BURST;
    });
    return () => {
      alive = false;
    };
  }, [heldArt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Painted at buffer size and stretched by CSS. A window-sized backing
    // store cost a full-screen stretch every frame plus a large texture on the
    // compositor, even during the seconds when nothing had changed.
    canvas.width = BUF;
    canvas.height = BUF;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let disposed = false;
    let tick = 0;

    const draw = (ms: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(draw);
      // Painting and the invalidation that follows are one event: the panels
      // above re-composite against these exact pixels.
      if (burstRef.current > 0) burstRef.current--;
      else if (++tick % FRAME_TICK !== 0) return;

      const wash = washRef.current;
      const t = ms / 1000;
      const rgb = rgbRef.current;
      const [fx, fy] = pivotRef.current;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b070c';
      ctx.fillRect(0, 0, BUF, BUF);

      if (wash) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.globalAlpha = 0.92;
        ctx.drawImage(wash, 0, 0, BUF, BUF);
        ctx.globalAlpha = 1;
      }

      // The blooms orbit the requested pivot rather than the middle, so the
      // field can read as projected from one side of the composition.
      const blooms: Array<[number, number, number, number, number]> = [
        [fx - 0.22 + 0.14 * Math.sin(t * 0.055), fy - 0.11 + 0.1 * Math.cos(t * 0.041), 0.85, 0.5, 0],
        [fx + 0.24 + 0.12 * Math.cos(t * 0.037), fy - 0.05 + 0.16 * Math.sin(t * 0.049), 0.7, 0.36, 46],
        [fx - 0.04 + 0.16 * Math.sin(t * 0.031 + 2), fy + 0.32 + 0.1 * Math.cos(t * 0.043), 0.78, 0.3, -52],
      ];

      ctx.globalCompositeOperation = 'screen';
      for (const [cx, cy, size, alpha, shift] of blooms) {
        const [r, g, b] = hueShift(rgb, shift);
        const rad = BUF * size * 0.62;
        const grad = ctx.createRadialGradient(BUF * cx, BUF * cy, 0, BUF * cx, BUF * cy, rad);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(BUF * cx - rad, BUF * cy - rad, rad * 2, rad * 2);
      }
      ctx.globalCompositeOperation = 'source-over';
      // Keep the field under the text: the wash is light, the content is not.
      ctx.fillStyle = 'rgba(8, 6, 10, 0.34)';
      ctx.fillRect(0, 0, BUF, BUF);

      invalidateScene();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className={`ambient-flow ${className}`} aria-hidden />;
};

export default AmbientFlow;
