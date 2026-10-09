import React, { useEffect, useRef, useState } from 'react';
import { IS_MINI_WINDOW } from '../../utils/windowRole';
import { usePlayerStore } from '../../stores/playerStore';
import { cachedCover } from '../../utils/metadata';

/**
 * The disc is *laid out* at this size and then scaled up on the GPU.
 *
 * This is the difference between smooth and laggy. A composited layer is
 * rasterised at its own box, so a disc sized to cover the viewport from an
 * off-centre pivot — over 3000px a side here — means a ~3400²² texture, tens of
 * megabytes, re-rastered whenever the compositor decides to. Laying it out at
 * 900px and folding the remaining magnification into `transform: scale()` keeps
 * the texture at 900² and lets the GPU do the stretching it is built for. The
 * visible detail is unchanged: the source is a 1024px bake either way.
 */
const DISC_LAYOUT = 900;
/**
 * The disc is drawn once into a square this size and then stretched by CSS.
 * Bigger buys crisper grooves near the visible middle; the texture is uploaded
 * once per track, so this is memory, not per-frame cost.
 *
 * It is 2048 rather than 1024 because the takeover magnifies the disc roughly
 * 3.3x: at 1024 every groove edge was a 3px stair, and that is what read as
 * pixellation. At 2048 the same edge is under 2px and the eye stops resolving
 * it, for a texture that is still only ~16MB and baked once per artwork.
 */
const DISC_PX = 2048;
/**
 * Groove pitch in disc pixels — spacing between successive ridge rings.
 *
 * Widened from 7. At the old pitch the rings were dense enough to read as a
 * texture over the whole disc rather than as grooves near the edge, and on the
 * setup screen — where the record fills a much smaller box, so the same 2048 px
 * bake is squeezed harder — that came across as ribbing. Fewer, softer rings keep
 * the turn legible without painting a grille over the artwork.
 */
const GROOVE_STEP = 9;
/**
 * Ridge ink. Kept *thin and faint* on purpose: at the old 0.55 alpha over 80%
 * of the disc's width, the multiply pass was eating most of the artwork's
 * brightness, which is why the record read as a dark grey smudge instead of a
 * lit sleeve. The grooves still read because they are *regular*, not because
 * they are dark — which is what lets this sit at half its previous strength.
 */
const GROOVE_INK = 'rgba(0, 0, 0, 0.11)';
/** The catch-light on the far side of each groove — depth without darkness. */
const GROOVE_LIGHT = 'rgba(255, 255, 255, 0.045)';
/**
 * The radius is pushed this far past the distance to the farthest corner, so
 * the curved edge stays comfortably off screen at every angle instead of
 * grazing the corners as it turns.
 */
const RADIUS_MARGIN = 1.22;

/**
 * How long the outgoing sleeve takes to thin out over the incoming artwork.
 *
 * Deliberately the backdrop's own number rather than the disc's: the user asked for
 * the record to change picture "in the same transition" the room does, and two
 * objects in one view dissolving on two clocks is what reads as a glitch rather
 * than as a change of record.
 */
const VINYL_DISSOLVE_MS = 620;
/** Out of the gate fast, soft into the landing — the backdrop's own curve, so the two match. */
const easeFlow = (t: number) => 1 - Math.pow(1 - t, 3);
/**
 * Degrees per second. The rim travels `radius * ω` in screen pixels, so at this
 * scale a foreground-sized speed reads as a blur whipping across the display —
 * but the record is meant to be *seen* to turn, so it is set high enough that
 * the grooves cross the glass panels without the eye missing them.
 */
const MAX_VELOCITY = 58;
const SPIN_UP_MS = 500;
const SPIN_DOWN_MS = 1000;
const MAX_FRAME_MS = 64;

/**
 * How long the disc may keep wearing the previous sleeve while the new one is
 * fetched. Same deadline, same reason as the backdrop's — see `ART_HOLD_SETTLE_MS`
 * in `BackdropLayer`, which carries the measurement.
 *
 * Without it the record flashed to a blank dark sleeve on every track change: the
 * cover is no longer in the store the moment a song starts, and `art` null was read
 * as "this file has no artwork" rather than as "the artwork is on its way". A song
 * that genuinely has none still has to fall back, which is what the deadline — and
 * `cachedCover`'s already-known `null` — are for.
 */
const ART_HOLD_SETTLE_MS = 1600;

/** Distance from a pivot out to the farthest corner of a w x h box. */
function cornerDistance(w: number, h: number, pivotX: number, pivotY: number): number {
  const px = w * pivotX;
  const py = h * pivotY;
  return Math.max(
    Math.hypot(px, py),
    Math.hypot(w - px, py),
    Math.hypot(px, h - py),
    Math.hypot(w - px, h - py),
  );
}

/**
 * Baked discs, keyed on everything that goes into their pixels.
 *
 * The backdrop and the takeover are two *separate* mounts of this component, so
 * before this existed every mode switch decoded the cover again and re-ran the
 * whole 2048² crop-grooves-blur-vignette bake — a few hundred milliseconds of
 * main-thread work landing in the middle of the transition it was supposed to
 * be smooth. Caching on the inputs rather than on the mode makes a round trip
 * free while still letting a genuinely different surface bake its own.
 *
 * The map owns the blob URLs, which is why the component never revokes one.
 *
 * Two at a time. It was ten, chosen as "enough that a round trip between two
 * surfaces always hits" and never re-examined as what it costs, and the arithmetic
 * on that cost is frightening: ten 2048²² surfaces at RGBA is 167 MB, for a
 * decorative disc that can only ever show one.
 *
 * Measured, it is smaller than that and the reason matters. An entry here is a
 * *JPEG blob*, not a decoded surface, so what the map keeps alive is roughly 1.5 MB
 * of encoded bytes per sleeve; the 16.7 MB decoded frame exists only for the texture
 * an `<img>` is actually pointing at. The GPU process measured 371 MB with one bake
 * resident and 383 MB with eight of them retained across a fourteen-track browse — a
 * difference inside the noise of the takeover view's own surfaces, not the 120 MB the
 * worst case predicts. So this is not the item that was holding the GPU open; the
 * glass scene surfaces were, and the map is worth bounding anyway because nothing
 * else in the app grows with the length of a session rather than the size of the
 * window, and because one decoded frame per disc is the only honest ceiling.
 *
 * Residency is now *owned* rather than counted: each disc registers the key it is
 * displaying and releases it at the moment its element is pointed at the next texture
 * (see `retain`/`release`), which is also the instant the old pixels stop being
 * needed. Anything nothing is holding is revoked on the first track change after
 * that — a bake for the song before last can never be wanted again, and waiting for
 * the ladder to fill to evict it is precisely how it got to ten.
 */
const DISC_KEEP = 2;
const baked = new Map<string, string>();
const bakedOrder: string[] = [];
/** How many live discs are pointing at each key. An entry at zero is expendable. */
const holders = new Map<string, number>();

function touch(key: string): void {
  const i = bakedOrder.indexOf(key);
  if (i >= 0) bakedOrder.splice(i, 1);
  bakedOrder.push(key);
}

/** Drop the least-recently-shown bake that no disc is actually wearing. */
function trim(): void {
  while (bakedOrder.length > DISC_KEEP) {
    const old = bakedOrder.find((k) => !(holders.get(k) ?? 0));
    if (!old) return; // every entry in here is on screen; nothing may go
    bakedOrder.splice(bakedOrder.indexOf(old), 1);
    const stale = baked.get(old);
    if (stale) URL.revokeObjectURL(stale);
    baked.delete(old);
    holders.delete(old);
  }
}

/**
 * Revoke every bake no disc is holding. Called on a track change, which is the
 * only moment the previous song's textures become provably worthless.
 */
function sweep(): void {
  for (const key of [...baked.keys()]) {
    if (holders.get(key)) continue;
    const url = baked.get(key);
    if (url) URL.revokeObjectURL(url);
    baked.delete(key);
    const i = bakedOrder.indexOf(key);
    if (i >= 0) bakedOrder.splice(i, 1);
  }
}

/**
 * A disc is now showing this key. Returns the URL to point at, which may be a
 * sibling's identical bake rather than the one this surface just made.
 */
function retain(key: string, own?: string): string | null {
  const resident = baked.get(key);
  if (resident) {
    if (own && own !== resident) {
      // Two surfaces finished the same bake. The first one is already in use;
      // this one is a duplicate and must not be left unrevoked.
      URL.revokeObjectURL(own);
    }
    holders.set(key, (holders.get(key) ?? 0) + 1);
    touch(key);
    return resident;
  }
  if (!own) return null;
  holders.set(key, 1);
  baked.set(key, own);
  touch(key);
  trim();
  return own;
}

/**
 * Keep a finished bake that nothing is wearing, without taking a reference.
 * This is the mid-flight mode switch: the surface that asked for the texture is
 * gone, but the one replacing it wants exactly this bake, and re-decoding the
 * cover from nothing on arrival is the very hitch the cache exists to remove.
 * Unheld, so the cap and the next track change collect it like anything else.
 */
function stash(key: string, url: string): void {
  const resident = baked.get(key);
  if (resident) {
    if (resident !== url) URL.revokeObjectURL(url);
    touch(key);
    return;
  }
  baked.set(key, url);
  touch(key);
  trim();
}

/**
 * This disc has stopped wearing that key.
 *
 * Deliberately not revoked here: this is also the path a mode switch takes, and
 * the bake the old disc was wearing is exactly what the incoming one wants. The
 * cap collects it, and a track change revokes it outright.
 */
function release(key: string): void {
  const n = (holders.get(key) ?? 0) - 1;
  if (n > 0) holders.set(key, n);
  else holders.delete(key);
  trim();
}

/**
 * A short fingerprint of the artwork. The cover arrives as a data URL tens of
 * kilobytes long, which is a wasteful map key and a slow one to hash; sampling
 * every few hundred characters plus the length separates two different sleeves
 * for a hundred iterations.
 */
function artKey(art: string): string {  let h = 5381;
  for (let i = art.length - 1; i >= 0; i -= 397) h = ((h << 5) + h + art.charCodeAt(i)) | 0;
  return `${art.length.toString(36)}_${(h >>> 0).toString(36)}`;
}

interface VinylBackgroundProps {
  art: string | null;
  playing: boolean;
  /**
   * Gaussian blur in *screen* pixels, baked into the texture. Kept low on
   * purpose: the grooves are the only thing that says "this is turning", and a
   * thick blur erases them.
   */
  blurPx?: number;
  /** Pivot as a fraction of the container. */
  pivotX?: number;
  pivotY?: number;
}

/** What the canvas needs to place one face: the host's box and the disc's size. */
interface DiscGeometry {
  w: number;
  h: number;
  dpr: number;
  /** The disc's diameter in CSS pixels. */
  d: number;
  cx: number;
  cy: number;
}

const NO_GEOMETRY: DiscGeometry = { w: 0, h: 0, dpr: 1, d: 0, cx: 0, cy: 0 };

/** The dark sleeve a record with no artwork wears — see `.vinyl-bg-disc`. */
const SLEEVE_COLOUR = '#0b070c';

/**
 * One face, laid down rotated about the pivot.
 */
function drawFace(
  ctx: CanvasRenderingContext2D,
  g: DiscGeometry,
  img: HTMLImageElement,
  angleDeg: number,
  alpha: number,
): void {
  if (img.naturalWidth <= 0 || g.d <= 0) return;
  const half = g.d / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(g.cx, g.cy);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(img, -half, -half, g.d, g.d);
  ctx.restore();
}

/**
 * The backdrop and the takeover's record.
 *
 * Two renderers, because the two windows are throttled in opposite ways.
 *
 * Under the takeover the disc is drawn into a canvas the size of the *viewport* and
 * rotated inside the draw. That is the whole of the change, and it is the only way
 * to win on this class of machine: the record has to overfill the screen from an
 * off-centre pivot, so its own box is roughly 3400 px a side, and every way of
 * turning a box that big loses. Un-promoted, a transform change repaints it on the
 * main thread — measured at 34 fps. Promoted with `will-change`, Chromium rasters
 * the layer at the scaled size — a 3400²² texture — and measured 3 fps. Drawing the
 * visible slice instead costs one rotated quad into a 1440×900 layer, which is the
 * job a GPU is built for, and the turn stops being something the main thread has to
 * afford.
 *
 * In the mini card none of this applies and the opposite does: that window's
 * `requestAnimationFrame` was measured delivering two callbacks in three seconds,
 * because Chromium's occlusion tracking treats a small transparent always-on-top
 * window as covered even when the user is looking straight at it, and
 * `backgroundThrottling: false` does not lift that. So the card keeps its `<img>`
 * and a compositor keyframe, which no amount of main-thread starvation can stop.
 *
 * Everything expensive still happens once per track: the artwork, the concentric
 * groove ridges and the blur are composited into a single baked texture, and the
 * radius is converted from screen pixels into texture pixels using the
 * magnification this surface actually ends up at, so the same `blurPx` means the
 * same visible softness on a 230px card and a 1440px takeover.
 *
 * The angle lives in a ref and the pixels are written imperatively, so swapping
 * artwork on a track change can never remount the element or reset the rotation —
 * a record does not jump back to the start of the side.
 */
const VinylBackground: React.FC<VinylBackgroundProps> = ({
  art,
  playing,
  blurPx = 0,
  pivotX = 0.15,
  pivotY = 0.85,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const discRef = useRef<HTMLImageElement | null>(null);
  /** The outgoing sleeve, sitting on top of the live disc and fading out through it. */
  const ghostRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const spin = useRef({ angle: 0, velocity: 0, target: 0 });
  const scaleRef = useRef(1);
  const geoRef = useRef<DiscGeometry>(NO_GEOMETRY);

  /** The decoded face the canvas is showing, and the one fading off it. */
  const faceRef = useRef<HTMLImageElement | null>(null);
  const fadingRef = useRef<{ img: HTMLImageElement; started: number } | null>(null);

  /*
   * Set by the geometry effect so a resize can ask for one frame even at rest.
   * Assigned during render, never read during it, so the effects below are free to
   * call it without taking it as a dependency.
   */
  const drawRef = useRef<() => void>(() => {});
  /** Set by the rotation effect: ask for a frame, or keep the loop alive for a fade. */
  const kickRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    if (IS_MINI_WINDOW) return;
    const canvas = canvasRef.current;
    const g = geoRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || g.w <= 0 || g.h <= 0) return;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = SLEEVE_COLOUR;
    ctx.fillRect(0, 0, g.w, g.h);
    /* The turn is smoothed by the compositor's own filtering; a hard nearest-neighbour
       edge on a rotating 2048² source is what would read as flicker in the grooves. */
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const fading = fadingRef.current;
    const face = faceRef.current;
    if (fading) {
      const t = (performance.now() - fading.started) / VINYL_DISSOLVE_MS;
      if (t >= 1) fadingRef.current = null;
      else {
        if (face) drawFace(ctx, g, face, spin.current.angle, 1);
        drawFace(ctx, g, fading.img, spin.current.angle, 1 - easeFlow(Math.max(0, t)));
        return;
      }
    }
    if (face) drawFace(ctx, g, face, spin.current.angle, 1);
  };

  /*
   * The sleeve this disc is wearing, which during a track change is still the
   * previous song's.
   *
   * `art` comes straight off `currentTrack.albumArt`, and that field is now filled
   * asynchronously once a song starts, so the prop arrives as null first and the
   * record would paint itself as the blank dark sleeve for a second before the
   * artwork landed. The disc held the old cover when the store still carried it
   * synchronously, and it should keep holding it now: what changes is only how long
   * the layer has to wait for the answer.
   *
   * Keyed on the track id, because a file with no embedded artwork must still end up
   * as that plain dark sleeve it was designed to show — a hold that cannot expire is
   * how the record would wear the previous song forever. The cache answers `null`
   * for a file already known to carry no picture, and that case gives up at once
   * rather than sitting out the deadline.
   */
  const trackId = usePlayerStore((s) => s.currentTrack?.id ?? null);
  const trackPath = usePlayerStore((s) => s.currentTrack?.path ?? null);
  const [heldArt, setHeldArt] = useState<string | null>(art);
  const resolvedForRef = useRef<string | null>(art ? trackId : null);
  const settleRef = useRef(0);
  /** The bake this disc is wearing. One reference per disc, taken and handed back by `wear`. */
  const wornKeyRef = useRef<string | null>(null);

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
    // The prefetch in the backdrop may already have filled this file's cover, in
    // which case there is nothing to wait for and no frame to lose.
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

  /** Distance from the pivot out to the farthest corner, in screen pixels. */
  const maxDist = (host: HTMLElement) =>
    cornerDistance(host.clientWidth, host.clientHeight, pivotX, pivotY);

  // ── geometry: size the face so its edge is never visible ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    if (IS_MINI_WINDOW) {
      const disc = discRef.current;
      if (!disc) return;
      const measure = () => {
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (w <= 0 || h <= 0) return;
        scaleRef.current = (maxDist(host) * 2 * RADIUS_MARGIN) / DISC_LAYOUT;
        const ghost = ghostRef.current;
        // The ghost is a second copy of the same disc showing the previous sleeve, so
        // every geometry write has to land on both or the fade peels off the record
        // it is supposed to be dissolving out of.
        for (const el of ghost ? [disc, ghost] : [disc]) {
          el.style.width = `${DISC_LAYOUT}px`;
          el.style.height = `${DISC_LAYOUT}px`;
          el.style.left = `${w * pivotX - DISC_LAYOUT / 2}px`;
          el.style.top = `${h * pivotY - DISC_LAYOUT / 2}px`;
          // The CSS spin keyframes carry the scale, so it has to be published to
          // them rather than only written into the transform this loop owns.
          el.style.setProperty('--disc-scale', scaleRef.current.toFixed(4));
        }
      };
      measure();
      const roMini = new ResizeObserver(measure);
      roMini.observe(host);
      return () => roMini.disconnect();
    }

    /*
     * The canvas is the window, not the record. Resizing it wipes it, so every
     * measure has to end with a draw or the disc blinks out for a frame on a
     * resize — and the takeover is entered by resizing, which is how a smooth
     * spin would still have looked broken arriving at it.
     */
    const measure = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w <= 0 || h <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      geoRef.current = {
        w,
        h,
        dpr,
        d: maxDist(host) * 2 * RADIUS_MARGIN,
        cx: w * pivotX,
        cy: h * pivotY,
      };
      drawRef.current();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [pivotX, pivotY]);

  // ── texture: cover + grooves + blur, composited once per artwork ──
  useEffect(() => {
    const host = hostRef.current;
    const surface = IS_MINI_WINDOW ? discRef.current : canvasRef.current;
    if (!surface) return;

    /**
     * Put the bake for `key` on screen, dissolving the face it replaces.
     *
     * The mini card does this with two `<img>` and a CSS opacity transition, which
     * is free: the compositor fades a layer it already has. Out here the fade is
     * drawn, because there is only one layer and the thing coming off is a decoded
     * image this component holds — one extra rotated quad for 620 ms, on a frame
     * budget that just got a lot more room in it.
     */
    const show = (url: string, held: string | null) => {
      if (IS_MINI_WINDOW) {
        const el = discRef.current;
        if (!el) return;
        el.src = url;
        const ghost = ghostRef.current;
        const oldUrl = held ? baked.get(held) : undefined;
        if (held && oldUrl && ghost) {
          ghost.src = oldUrl;
          ghost.style.transition = 'none';
          ghost.style.opacity = '1';
          // The start state has to be committed before the transition is armed, or
          // Chromium coalesces the two writes and the fade never runs.
          void ghost.offsetWidth;
          ghost.style.transition = `opacity ${VINYL_DISSOLVE_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
          ghost.style.opacity = '0';
          window.setTimeout(() => {
            const node = ghostRef.current;
            if (node) {
              node.style.transition = '';
              node.removeAttribute('src');
            }
            if (held) {
              release(held);
              sweep();
            }
          }, VINYL_DISSOLVE_MS + 40);
        } else if (held) {
          release(held);
        }
        return;
      }

      const im = new Image();
      im.decoding = 'async';
      im.onload = () => {
        if (im.naturalWidth <= 0) return;
        /*
         * The face coming off keeps drawing at *this* angle for the length of the
         * fade, which is what makes the two sleeves read as one record changing
         * sides rather than two records passing each other.
         */
        if (faceRef.current) fadingRef.current = { img: faceRef.current, started: performance.now() };
        faceRef.current = im;
        kickRef.current();
      };
      im.src = url;
      /*
       * The texture the face coming off was drawn from stays referenced for the
       * length of the fade, and is handed back after it. Nothing is revoked on the
       * swap itself, because that is the frame the old sleeve is still painting.
       */
      if (held) {
        window.setTimeout(() => {
          release(held);
          sweep();
        }, VINYL_DISSOLVE_MS + 40);
      }
    };

    /**
     * Point the disc at the bake for `heldArt`, taking this disc's reference on it
     * and handing back the one it was wearing.
     *
     * The release happens *after* the new source is on the element, in the same
     * statement, because that is the moment the old pixels stop being needed. The
     * order is the whole trick behind bounding the cache without the record looking
     * any different: revoke a texture a frame before the element lets go of it and
     * the disc flashes to the dark sleeve; revoke it the instant the swap lands and
     * nothing was ever asked to draw with it again.
     */
    const wear = (own?: string): boolean => {
      if (wornKeyRef.current === key) {
        // Already wearing this one. A run that did not change the pixels — the same
        // artwork through a resize — must not take a second reference on it, or the
        // count would outlive the disc and the texture would never be freed.
        const resident = baked.get(key);
        if (resident) show(resident, null);
        return true;
      }
      const url = retain(key, own);
      if (!url) return false;
      /*
       * The outgoing sleeve is not handed back until the fade over it has finished,
       * which is the same dissolve the backdrop runs between two records — 620 ms of
       * `easeFlow`. Releasing on the swap, as this did, is what made a track change
       * *cut* the disc to the next artwork while everything else in the app flowed.
       *
       * The texture stays referenced for the length of the fade, so `sweep()` below
       * cannot collect the picture that is still drawing.
       */
      const prev = wornKeyRef.current;
      wornKeyRef.current = key;
      show(url, prev);
      /*
       * Nothing in the map that no disc is holding is a sleeve from a song that has
       * already finished playing. It will not be asked for again, so it goes now
       * rather than sitting out the rest of the session waiting for the ladder to
       * fill — which is how it filled to ten.
       */
      sweep();
      return true;
    };

    if (!heldArt) {
      // A file with no embedded cover still gets the record: the canvas is filled
      // with the same colour the `<img>` carries as its own `background-color`, so
      // dropping the face leaves the plain dark sleeve it always showed rather than
      // a hole in the backdrop.
      if (IS_MINI_WINDOW) {
        const el = discRef.current;
        if (el) el.removeAttribute('src');
        const ghost = ghostRef.current;
        if (ghost) {
          ghost.style.transition = '';
          ghost.style.opacity = '0';
          ghost.removeAttribute('src');
        }
      } else {
        faceRef.current = null;
        fadingRef.current = null;
        drawRef.current();
      }
      // With the source gone the texture belongs to nobody, so it is collected here
      // too — a sleeveless song is exactly the moment the disc should stop paying for
      // the last one.
      const prev = wornKeyRef.current;
      wornKeyRef.current = null;
      if (prev) {
        release(prev);
        sweep();
      }
      return;
    }

    let alive = true;
    /*
     * The blur radius the bake is about to apply, resolved before the artwork is
     * decoded because it is part of what the pixels *are*: the texture is
     * magnified on screen by `scale`, so a blur of blurPx screen pixels is a far
     * smaller radius in texture space, and two surfaces that agree on it can
     * share one texture while two that do not must each bake their own.
     */
    const texBlur =
      blurPx > 0 && host
        ? Math.max(0.5, blurPx / ((maxDist(host) * 2 * RADIUS_MARGIN) / DISC_PX))
        : 0;
    const key = `${artKey(heldArt)}|${texBlur.toFixed(2)}`;
    if (wear()) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive || img.naturalWidth <= 0) return;
      const c = document.createElement('canvas');
      c.width = DISC_PX;
      c.height = DISC_PX;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const r = DISC_PX / 2;

      // Cover-crop the artwork to the full disc, not a small centre label.
      // The brightness lift is deliberate: the disc is the app's backdrop, and
      // a sleeve that was never meant to fill a screen reads as a dim wash once
      // it does. 1.16 puts it back where the eye expects it after the grooves
      // and the vignette have taken their share.
      const s = Math.max(img.naturalWidth, img.naturalHeight);
      ctx.filter = 'brightness(1.16) saturate(1.08)';
      ctx.drawImage(
        img,
        (img.naturalWidth - s) / 2,
        (img.naturalHeight - s) / 2,
        s,
        s,
        0,
        0,
        DISC_PX,
        DISC_PX,
      );
      ctx.filter = 'none';

      let out = c;
      if (texBlur > 0) {
        const soft = document.createElement('canvas');
        soft.width = DISC_PX;
        soft.height = DISC_PX;
        const sctx = soft.getContext('2d');
        if (sctx) {
          // Overscan so the blur samples real artwork at the border instead of
          // pulling in transparency and leaving a halo.
          sctx.filter = `blur(${texBlur.toFixed(2)}px)`;
          sctx.drawImage(
            c,
            -texBlur * 2,
            -texBlur * 2,
            DISC_PX + texBlur * 4,
            DISC_PX + texBlur * 4,
          );
          out = soft;
        }
      }

      // Clip and detail go on *after* the blur. This is what keeps the ridges
      // visible: blurred together with the artwork they sand themselves flat at
      // anything above a few pixels of radius, so drawing them onto the blurred
      // result is what makes them survive, rather than pushing their opacity up
      // and muddy-ing the artwork instead.
      const face = document.createElement('canvas');
      face.width = DISC_PX;
      face.height = DISC_PX;
      const fctx = face.getContext('2d');
      if (!fctx) return;
      fctx.save();
      fctx.beginPath();
      fctx.arc(r, r, r, 0, Math.PI * 2);
      fctx.clip();
      fctx.drawImage(out, 0, 0);

      fctx.globalCompositeOperation = 'multiply';
      fctx.lineWidth = GROOVE_STEP * 0.5;
      fctx.strokeStyle = GROOVE_INK;
      for (let radius = r * 0.12; radius < r; radius += GROOVE_STEP) {
        fctx.beginPath();
        fctx.arc(r, r, radius, 0, Math.PI * 2);
        fctx.stroke();
      }

      // The ridge's catch-light, half a pitch out from the ink. Grooves read as
      // *raised* rather than as dirt on the sleeve because every shadow has a
      // highlight next to it; without this the only way to sell the texture was
      // to darken it, which is what made the record look muddy.
      fctx.globalCompositeOperation = 'lighter';
      fctx.lineWidth = GROOVE_STEP * 0.32;
      fctx.strokeStyle = GROOVE_LIGHT;
      for (let radius = r * 0.12 + GROOVE_STEP / 2; radius < r; radius += GROOVE_STEP) {
        fctx.beginPath();
        fctx.arc(r, r, radius, 0, Math.PI * 2);
        fctx.stroke();
      }

      // Soft fall-off toward the rim for some depth.
      fctx.globalCompositeOperation = 'source-over';
      const vignette = fctx.createRadialGradient(r, r, r * 0.5, r, r, r);
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
      fctx.fillStyle = vignette;
      fctx.fillRect(0, 0, DISC_PX, DISC_PX);
      fctx.restore();

      // Encoded async into a blob URL rather than synchronously into a data
      // URI: a 2048² `toDataURL` blocks the main thread for a few hundred
      // milliseconds on a mobile chip, which is exactly the moment the track
      // changes and every other surface is trying to animate.
      face.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        /*
         * Worn if this surface is still on screen, stashed if it is not: a mode
         * switch that landed mid-bake used to throw the finished texture away and
         * re-bake it from nothing on arrival, which is the very hitch this is meant
         * to remove. What changed is that it can no longer keep what it stashed —
         * the bake is unheld from the moment it is filed, so the cap and the first
         * track change after it own its lifetime, not the map forever.
         */
        if (alive && (IS_MINI_WINDOW ? discRef.current : canvasRef.current) === surface) wear(url);
        else stash(key, url);
      }, 'image/jpeg', 0.92);
    };
    img.src = heldArt;
    return () => {
      alive = false;
    };
  }, [heldArt, blurPx, pivotX, pivotY]);

  /*
   * The disc's one remaining hold, handed back when it leaves.
   *
   * Unmount is not a track change, so the bake is kept rather than revoked: the
   * takeover and the backdrop are two mounts of this same surface and a round trip
   * between them is meant to be free. Releasing the reference is what makes it
   * collectable — by the cap if a third thing arrives, by the next swap if nothing
   * does — and the element itself goes with its decoded frame, so nothing keeps the
   * texture alive on the strength of this map alone.
   */
  useEffect(
    () => () => {
      const prev = wornKeyRef.current;
      wornKeyRef.current = null;
      if (prev) release(prev);
    },
    [],
  );

  // ── rotation: angular velocity, eased, loop off at rest ──
  useEffect(() => {
    spin.current.target = playing ? MAX_VELOCITY : 0;

    /*
     * In the mini card the turn is a CSS animation and this loop does not run at
     * all, because that window's `requestAnimationFrame` was measured delivering
     * two callbacks in three seconds — Chromium's occlusion tracking treats a small
     * transparent always-on-top window as covered even when the user is looking
     * straight at it, and `backgroundThrottling: false` does not lift that. A
     * compositor animation is never starved by the main thread, so it simply turns,
     * and the card's disc is 230px, so the layer promotion costs nothing there.
     */
    if (IS_MINI_WINDOW) {
      const el = discRef.current;
      if (el) el.classList.toggle('spinning', playing);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    /* The record is a live scene contributor only while it actually turns.
       `data-dynamic` is what the `<video>` path already uses: the shader
       re-composites just the panels whose sample rect touches a dynamic
       contributor, on the animation frame that moves them, instead of on a
       timer. Marking the disc permanently would hold every panel over it in a
       per-frame re-composition it cannot afford, and leaving a fixed-interval
       refresh instead would have the glass catch up in visible four-times-a-second
       steps — which is what read as the refraction trailing the record. */
    const setLive = (live: boolean) => {
      if (live && !canvas.hasAttribute('data-dynamic')) canvas.setAttribute('data-dynamic', '');
      else if (!live && canvas.hasAttribute('data-dynamic')) canvas.removeAttribute('data-dynamic');
    };

    const tick = (now: number) => {
      rafRef.current = 0;
      const s = spin.current;
      const dt = lastRef.current ? Math.min(MAX_FRAME_MS, now - lastRef.current) : 1000 / 60;
      lastRef.current = now;

      const duration = s.target > s.velocity ? SPIN_UP_MS : SPIN_DOWN_MS;
      const step = (MAX_VELOCITY / duration) * dt;
      if (s.velocity < s.target) s.velocity = Math.min(s.target, s.velocity + step);
      else if (s.velocity > s.target) s.velocity = Math.max(s.target, s.velocity - step);

      s.angle = (s.angle + s.velocity * (dt / 1000)) % 360;

      /*
       * A layer under `display: none` has no `offsetParent`, and the fullscreen
       * video takeover hides the music layer exactly that way. Turning a disc nobody
       * can see kept `data-dynamic` set, which is the flag that tells the glass
       * engine "this is a live contributor" — so every panel above it re-composited
       * its scene, blur and texture upload once per frame for the entire length of a
       * film, on the frame budget that film needs for itself.
       */
      const shown = canvas.offsetParent !== null;
      if (shown) drawRef.current();
      setLive(s.velocity > 0 && shown);

      if (s.velocity === 0 && s.target === 0 && !fadingRef.current) {
        lastRef.current = 0;
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    /** Ask for a frame. The sleeve swap uses this to keep a fade moving at rest. */
    kickRef.current = () => {
      if (rafRef.current) return;
      lastRef.current = 0;
      rafRef.current = requestAnimationFrame(tick);
    };
    kickRef.current();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      lastRef.current = 0;
      setLive(false);
    };
  }, [playing]);

  return IS_MINI_WINDOW ? (
    <div ref={hostRef} className="vinyl-bg" aria-hidden>
      {/* An `<img>`, not a CSS background: the shader composes its scene by
          drawing `img`/`video`/`canvas` descendants, so a `background-image`
          is simply invisible to it and every panel over the record refracted
          the desktop wallpaper instead. */}
      <img ref={discRef} className="vinyl-bg-disc" alt="" draggable={false} />
      {/*
       * The sleeve coming off. An `<img>` for the same reason the disc is one: the
       * shader composes its scene out of `img`/`video`/`canvas` descendants, and a
       * `background-image` would be invisible to every panel over the record.
       *
       * It sits above the live disc and fades from fully opaque to nothing, so the
       * new artwork is what is revealed underneath rather than something that
       * arrives in a cut.
       */}
      <img ref={ghostRef} className="vinyl-bg-disc vinyl-bg-ghost" alt="" draggable={false} />
    </div>
  ) : (
    <div ref={hostRef} className="vinyl-bg" aria-hidden>
      {/*
       * A `<canvas>` the size of the window rather than an `<img>` the size of the
       * record, for the reason at the head of this file: the disc has to overfill the
       * screen, and the only way to turn a shape that big without either repainting
       * it on the main thread or rastering a several-thousand-pixel layer is to not
       * have a layer that big. The canvas is a `canvas` element, so the shader's
       * scene walk still finds it and the panels over the record bend the artwork
       * rather than the desktop.
       */}
      <canvas ref={canvasRef} className="vinyl-bg-face" aria-hidden />
    </div>
  );
};

export default VinylBackground;
