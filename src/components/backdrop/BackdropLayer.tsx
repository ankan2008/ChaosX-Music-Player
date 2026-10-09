import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine, toMediaUrl } from '../../audio/engine';
import { invalidateScene } from '../../glass/scene';
import { IS_OVERLAY_WINDOW } from '../../utils/windowRole';
import { ART_MAX_PX, cachedCover, coverFor, shrinkCoverTo } from '../../utils/metadata';

/** A decoded picture, already bounded to what the backdrop can actually use. */
interface Pixels {
  el: CanvasImageSource;
  w: number;
  h: number;
}

/**
 * What the custom backdrop is wearing: a still, or a moving picture to read
 * frames out of. Mutually exclusive, which is the point.
 */
type Wall = { kind: 'image'; px: Pixels } | { kind: 'video'; el: HTMLVideoElement };

/**
 * The backdrop, painted in two stages instead of one.
 *
 * The old path asked the canvas to draw a cover stretched across the whole window
 * *under a gaussian filter*, which runs the kernel over every destination pixel:
 * measured at 79-97 ms a frame on this machine, which is ten frames a second and
 * the reason a track change looked like a stutter rather than a dissolve. The
 * window does not need that many pixels. Nothing behind a twenty-four point blur
 * does.
 *
 * So the blur now happens on a small buffer and only the upscale crosses the
 * window. The buffer is sized so one of its texels lands no wider than
 * `TEXELS_PER_BLUR` of the blur radius — the same rule the old source ladder
 * applied to the *cover*, applied to the buffer instead — which takes the kernel
 * from a million and a half pixels to a few thousand. The result is the same
 * picture, because the blur was going to erase everything finer than that anyway,
 * and `imageSmoothingQuality: 'high'` on the upscale is what keeps the buffer's
 * own grid from showing through.
 */
const TEXELS_PER_BLUR = 0.34;
/** Below this the field goes coarse enough that the upscale's ramps start to read. */
const BUFFER_MIN_PX = 24;
/**
 * The buffer never needs more than the source has to give it — and at a zero blur
 * it needs the window's own pixels, which is why the caller decodes the wallpaper
 * past this and `bufferSize` ignores it entirely for that case.
 */
const BUFFER_MAX_PX = 1024;

/**
 * How far past the frame the blur reaches for pixels to average.
 *
 * A blur with nothing outside the frame to average pulls the edge toward the
 * buffer's own fill colour, which reads as a vignette nobody chose. So the source
 * crop is one radius wider than the buffer on every side and is drawn from outside
 * the origin; the buffer stays exactly window-shaped and its edges are clean.
 */
const BLEED = 1.15;

/*
 * The floor on the widgets' own backdrop.
 *
 * The pill's canvas is clipped to the capsule and is the only thing painted behind
 * it, so the strip's whole sense of being a surface rather than a hole in the
 * desktop comes down to how blurred that one picture is. At the library's default
 * 24 the strip is wearing the same wallpaper, at very nearly the same sharpness, as
 * the desktop behind it — and the eye correctly concludes there is nothing there.
 * That is the "even the pill itself is transparent" report; no filter of any kind
 * was missing. Nothing a person can resolve at 24 px they resolve worse at 40, and
 * the buffer this pushes the source into is smaller, not larger.
 */
const OVERLAY_MIN_BLUR = IS_OVERLAY_WINDOW ? 40 : 0;

/** How long one sleeve takes to become the next one. */
const DISSOLVE_MS = 620;

/** Out of the gate fast, soft into the landing, so it reads as one move. */
const easeFlow = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Seconds before the end of a song at which the next one's cover is fetched.
 *
 * The swap is only as fast as the fetch behind it, so the fix for a slow swap is
 * to stop it being a swap at all: `coverFor` fills the same bounded cache the
 * engine's own `fillCurrentCover` reads from, and a cover already there resolves
 * synchronously on the very render the track changes.
 */
const PREFETCH_LEAD_SEC = 10;
const PREFETCH_TICK_MS = 1000;

/** See the note on `saturate` in `fillBuffer`: it composes cleanly, so zero means zero. */
const COLOUR_DEPTH_MAX = 2.5;

/**
 * What the last frame was baked from.
 *
 * Lives outside the paint effect because that effect is torn down and rebuilt by
 * the very track change whose dissolve it has to survive: a cover arriving is a
 * dependency change, a dependency change is a new closure, and the outgoing pixels
 * cannot be locals of the closure about to be thrown away. One of these per window,
 * reused for the life of the page.
 */
interface Bake {
  cur: HTMLCanvasElement;
  curCtx: CanvasRenderingContext2D;
  old: HTMLCanvasElement;
  oldCtx: CanvasRenderingContext2D;
  /** Where the two sleeves are blended, so the window only ever sees one draw. */
  mix: HTMLCanvasElement;
  mixCtx: CanvasRenderingContext2D;
  /** What is baked into `cur`, so a change of picture is told from a re-tune. */
  image: CanvasImageSource | null;
  w: number;
  h: number;
  /** Buffer pixels of picture lying outside the window on each side. */
  bleed: number;
  radius: number;
  sat: number;
  /**
   * True once `cur` actually holds a baked picture.
   *
   * This is the difference between "the buffer is sized" and "the buffer is filled",
   * and conflating them is what let a stale field sit on screen indefinitely: the
   * cover arrives after the record does, so the first paint found no picture, bailed
   * out of `fillBuffer` partway through, and still left the buffer looking primed.
   * Nothing after that had a reason to ask again.
   */
  ready: boolean;
  /** True once `old` holds a copy worth compositing against. */
  hasOld: boolean;
  dissolveFrom: number;
}

function makeBake(): Bake | null {
  const cur = document.createElement('canvas');
  const old = document.createElement('canvas');
  const mix = document.createElement('canvas');
  const curCtx = cur.getContext('2d', { alpha: false });
  const oldCtx = old.getContext('2d', { alpha: false });
  const mixCtx = mix.getContext('2d', { alpha: false });
  if (!curCtx || !oldCtx || !mixCtx) return null;
  return {
    cur,
    curCtx,
    old,
    oldCtx,
    mix,
    mixCtx,
    image: null,
    w: 0,
    h: 0,
    bleed: 0,
    radius: -1,
    sat: 1,
    ready: false,
    hasOld: false,
    dissolveFrom: 0,
  };
}

/**
 * Full-window backdrop layer.
 *
 * Whatever sits behind the UI is painted into a single canvas so the blur is baked
 * into real pixels rather than left to a CSS filter, which is what lets the
 * liquid-glass shader sample exactly what the user sees. Two sources, one
 * renderer, so both get the same blur and the same dissolve:
 *   - `custom`   the wallpaper the user chose, image or video
 *   - `art`      the playing record's cover
 *
 * Painting stays demand-driven. A still cover needs exactly one repaint per change;
 * looping at sixty to discover that was the whole app's worth of wasted compositing
 * on integrated graphics. Only the dissolve and a video wallpaper hold a loop open.
 */
const BackdropLayer: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const background = usePlayerStore((s) => s.background);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);
  const wallpaperKind = usePlayerStore((s) => s.wallpaperKind);

  const artBackdrop = background === 'art';
  const trackId = usePlayerStore((s) => s.currentTrack?.id ?? null);
  const trackPath = usePlayerStore((s) => s.currentTrack?.path ?? null);
  const rawArt = usePlayerStore((s) => s.currentTrack?.albumArt ?? null);

  /*
   * The cover this layer paints, which is not always the one in the store.
   *
   * The artwork is fetched rather than arriving with the record, so for a moment
   * after a change `albumArt` is null. There used to be a deadline on that moment,
   * and when it ran out this layer gave up and painted nothing — which is the black
   * room between two songs. The field behind the glass now only ever changes from
   * one sleeve to another: a cover that has not resolved yet, or that never will
   * because the file carries none, leaves the previous picture standing. The room is
   * allowed to be one song behind, and it is not allowed to be empty.
   */
  const [albumArt, setAlbumArt] = useState<string | null>(null);
  const resolvedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!artBackdrop) {
      resolvedForRef.current = null;
      setAlbumArt(null);
      return;
    }
    if (!trackId) return;

    if (rawArt) {
      resolvedForRef.current = trackId;
      setAlbumArt(rawArt);
      return;
    }
    if (resolvedForRef.current === trackId) return;
    resolvedForRef.current = trackId;

    const known = trackPath ? cachedCover(trackPath) : undefined;
    if (known) {
      setAlbumArt(known);
      return;
    }
    if (!trackPath) return;

    /*
     * Ask for the cover here rather than waiting on the engine's own lazy fill of
     * the store. Both read the same bounded cache and the same three-reader pool, so
     * this costs at most one slot that the store's fill would have taken anyway, and
     * it means the backdrop does not have to wait for a `set` that only exists to
     * hand the picture to the rows.
     */
    let alive = true;
    void coverFor(trackPath, ART_MAX_PX)
      .then((url) => {
        if (alive && url) setAlbumArt(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [artBackdrop, trackId, trackPath, rawArt]);

  /*
   * Ask for the next song's cover while this one is still ending, so the hold
   * above is never actually waited on for a normal skip.
   */
  const prefetchedRef = useRef<string | null>(null);
  useEffect(() => {
    prefetchedRef.current = null;
    if (!artBackdrop || !trackId) return;
    const id = window.setInterval(() => {
      const st = usePlayerStore.getState();
      const cur = st.currentTrack;
      if (!cur || !st.isPlaying) return;
      if (!(cur.duration > 0)) return;
      const engine = getEngine();
      let position = 0;
      try {
        position = engine.getPosition();
      } catch {
        return;
      }
      if (cur.duration - position > PREFETCH_LEAD_SEC) return;
      const next = engine.upcomingTracks(1)[0];
      if (!next || next.id === cur.id || next.albumArt) return;
      if (prefetchedRef.current === next.id) return;
      prefetchedRef.current = next.id;
      void coverFor(next.path, ART_MAX_PX).catch(() => {});
    }, PREFETCH_TICK_MS);
    return () => window.clearInterval(id);
  }, [artBackdrop, trackId]);

  const [artPixels, setArtPixels] = useState<Pixels | null>(null);

  const useArt = artBackdrop && !!albumArt;
  /*
   * The wallpaper stays decoded while the mode points at the cover but the cover has
   * not produced pixels yet — which is the whole of the gap between choosing Album
   * art with a custom wallpaper behind you and the first frame of the new cover.
   *
   * Both sources feed one `pixels ?? wall.px` choice further down, so the wallpaper
   * was always the fallback; the bug was that `background === 'custom'` alone
   * decided whether it existed, so the moment the mode changed the fallback was
   * released and there was nothing left to fall back to. Every glass card then
   * sampled an empty scene for a beat and rendered its own grey — the flash, on the
   * art-bound leg only, because going back to a custom wallpaper needs nothing to
   * resolve first.
   *
   * Released as soon as the cover lands, so the steady state costs what it used to.
   */
  const useWallpaper = !!wallpaperPath && (background === 'custom' || !artPixels);
  const active = useWallpaper || useArt;

  const blur = usePlayerStore((s) => s.wallpaperBlur);
  const dim = usePlayerStore((s) => s.backdropDim);
  const sat = usePlayerStore((s) => s.backdropSat);

  /*
   * Read at paint time rather than taken as dependencies, so dragging a slider
   * costs a frame instead of a re-mount of the whole source: the wallpaper does not
   * change when its colour gets deeper, and tearing down a decoded cover only to
   * re-decode it identically is the one thing a dependency list must never be asked
   * to do.
   */
  const tuneRef = useRef({ radius: 24, dim: 0, sat: 1 });
  tuneRef.current = {
    radius: Math.max(OVERLAY_MIN_BLUR, blur),
    dim: dim / 100,
    sat: 1 + (sat / 100) * (COLOUR_DEPTH_MAX - 1),
  };

  const bakeRef = useRef<Bake | null>(null);
  /** Set by the paint effect so slider drags can ask for one fresh frame. */
  const repaintRef = useRef<(() => void) | null>(null);

  /*
   * The picture for this render, from whichever source the mode points at.
   *
   * Both branches resolve through `shrinkCoverTo` and nothing else, because it is
   * the one place in the app that resamples through Chromium's highest-quality
   * filter: a box downsample of a 4K wallpaper aliases, and behind a blur an alias
   * is not noise, it is a colour that was never in the picture.
   */
  useEffect(() => {
    if (!useArt || !albumArt) {
      setArtPixels(null);
      return;
    }
    let alive = true;
    void shrinkCoverTo(albumArt, BUFFER_MAX_PX).then((shrunk) => {
      if (!alive) return;
      // A cover that will not decode is a cover the room should not be wearing.
      if (!shrunk) setAlbumArt(null);
      else setArtPixels({ el: shrunk.el, w: shrunk.w, h: shrunk.h });
    });
    return () => {
      alive = false;
    };
  }, [useArt, albumArt]);

  /*
   * The wallpaper's decoded picture, one state for both kinds.
   *
   * This used to be two — `wallPixels` and `wallVideo` — and the pair was the
   * reason picking a video over an image did nothing until the mode was cycled.
   * The video branch set its own half and left the other holding the outgoing
   * still, and the paint read `pixels ?? video`, so the room kept wearing the
   * wallpaper that was replaced. One field cannot be in two states at once.
   */
  const [wall, setWall] = useState<Wall | null>(null);
  useEffect(() => {
    if (!useWallpaper || !wallpaperPath) {
      setWall(null);
      return;
    }
    let alive = true;
    let video: HTMLVideoElement | null = null;
    const url = toMediaUrl(wallpaperPath);
    if (wallpaperKind === 'video') {
      video = document.createElement('video');
      video.src = url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      void video.play().catch(() => undefined);
      setWall({ kind: 'video', el: video });
    } else {
      /*
       * A wallpaper is decoded at the screen's own resolution, not at the cover
       * cap. Behind any real blur the two are indistinguishable and the buffer
       * throws the extra away anyway — but at zero blur the cap is the only thing
       * between the user and the picture they picked, and there is no reason to
       * resample a file down to something that then has to be blown back up.
       */
      const dpr = window.devicePixelRatio || 1;
      const cap = Math.max(
        1280,
        Math.round(Math.max(window.innerWidth, window.innerHeight) * dpr),
      );
      void shrinkCoverTo(url, cap, 8192).then((shrunk) => {
        if (!alive || !shrunk) return;
        setWall({
          kind: 'image',
          px: { el: shrunk.el, w: shrunk.w, h: shrunk.h },
        });
      });
    }
    return () => {
      alive = false;
      if (video) {
        video.pause();
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [useWallpaper, wallpaperPath, wallpaperKind]);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!bakeRef.current) bakeRef.current = makeBake();
    const bake = bakeRef.current;
    if (!bake) return;

    let disposed = false;
    let raf = 0;
    let lastFrame = -1;

    const pixels = artPixels ?? (wall?.kind === 'image' ? wall.px : null);
    const video = wall?.kind === 'video' ? wall.el : null;
    if (!pixels && !video) return;

    /** The buffer's shape for a window and the blur in force. */
    const bufferSize = (w: number, h: number) => {
      const r = tuneRef.current.radius;
      /*
       * At zero there is nothing to average, so the reason the buffer is small —
       * that a twenty-four point blur was going to erase everything finer than a
       * texel — has gone away. The buffer becomes the window at its own device
       * resolution and the wallpaper reads exactly as sharply as the file on
       * disk, which is what the blur slider being at zero is supposed to mean.
       */
      if (r <= 0.01) {
        const dpr = window.devicePixelRatio || 1;
        const tw = Math.min(4096, Math.max(1, Math.round(w * dpr)));
        return { tw, th: Math.max(1, Math.round((tw * h) / w)) };
      }
      const need = Math.round(Math.max(w, h) / (TEXELS_PER_BLUR * Math.max(r, 1)));
      const tw = Math.max(BUFFER_MIN_PX, Math.min(BUFFER_MAX_PX, need));
      return { tw, th: Math.max(1, Math.round((tw * h) / w)) };
    };

    /**
     * Fill the buffer from the source: downsample, then blur at the small size.
     *
     * Both in one pass, because the downsample is already resampling and the blur
     * then only has a few thousand pixels to walk.
     *
     * The buffer is the window's shape *plus* one blur radius of bleed on every
     * side, and the cover-crop is solved against that whole area. Solving it
     * against the window's shape and then drawing wider was the earlier version,
     * and it was wrong: the source rectangle came out several times larger than
     * the source itself, `drawImage` clipped it back inside the picture and shrank
     * the result to match, and the room was a postage stamp of colour floating in
     * black. Covering the buffer means the scale is always one the picture can
     * actually supply.
     *
     * The saturation lift belongs here rather than on the panels for the reason the
     * whole control lives here: the canvas is the one surface present in every mode
     * the app can be in, while the frost is a different `backdrop-filter` on each of
     * perhaps thirty panels and several of those have no frost at all — and a lift
     * on a panel would tint the panel's own text. It also does not cancel what those
     * filters already carry: saturate is `S(s) = L + s(I - L)` with `L` the rank-one
     * luma projector and `L(I - L) = 0`, so `S(a)S(b) = S(ab)` and the two compose
     * into one product instead of fighting. At zero this contributes `S(1) = I`.
     */
    const fillBuffer = (w: number, h: number): boolean => {
      const { radius, sat: saturation } = tuneRef.current;
      const { tw, th } = bufferSize(w, h);
      /*
       * No blur, no bleed. The margin exists only to give the kernel real
       * picture to average at the edges, and at a zero radius there is no
       * kernel — leaving it in would make the upscale a 0.9976× resample rather
       * than a pixel-for-pixel copy, which is the difference between the
       * wallpaper being crisp and it being very nearly crisp.
       */
      /*
       * Whole texels. `bleed` is a radius times a ratio and lands on a fraction more
       * often than not, and a canvas cannot be 144.158 across — the dimensions get
       * truncated, so the buffer it holds and the buffer this arithmetic thinks it
       * drew are two different sizes.
       */
      const bleed = radius > 0.01
        ? Math.round(Math.max(2, (radius * tw) / w) * BLEED)
        : 0;
      const bw = tw + bleed * 2;
      const bh = th + bleed * 2;
      if (bake.cur.width !== bw || bake.cur.height !== bh) {
        bake.cur.width = bw;
        bake.cur.height = bh;
      }
      bake.w = tw;
      bake.h = th;
      bake.bleed = bleed;
      bake.radius = radius;
      bake.sat = saturation;

      const ctx = bake.curCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      /*
       * The reconstruction filter Chromium picks for the resample. 'high' is a
       * Lanczos-family pass, which is what stops a still sleeve's texel grid
       * showing through its own upscale — and which is far too expensive to run
       * over a film sixty times a second. A video frame arriving at the buffer is
       * already the smoothest thing in the pipeline, so it takes the cheap filter
       * and the frame budget goes to the decoder instead.
       */
      ctx.imageSmoothingQuality = video ? 'low' : 'high';
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0a0e';
      ctx.fillRect(0, 0, bw, bh);

      const el: CanvasImageSource | null = pixels ? pixels.el : video;
      const ew = pixels ? pixels.w : video ? video.videoWidth : 0;
      const eh = pixels ? pixels.h : video ? video.videoHeight : 0;
      if (!el || !ew || !eh) return false;

      // The least the source must be enlarged to cover the whole bled buffer, and
      // so the most of it that has to be cropped away. Never more than there is.
      const scale = Math.max(bw / ew, bh / eh);
      const sw = bw / scale;
      const sh = bh / scale;

      const parts: string[] = [];
      // `bw / (w + 2*outX)` reduces to `tw / w`, so this is the radius the buffer
      // needs whatever bleed is currently in force.
      if (radius > 0.2) parts.push(`blur(${((radius * tw) / w).toFixed(2)}px)`);
      /*
       * The colour-depth slider stays a CSS `saturate` rather than becoming a
       * filter chain of its own, because the picture is the user's own wallpaper or
       * cover at whatever sharpness they asked for and there is no narrow band to
       * stretch. Saturate composes cleanly (`S(a)S(b) = S(ab)`), so it multiplies
       * with whatever the frost panels add rather than fighting them, and zero is
       * the identity.
       */
      if (saturation > 1.001) parts.push(`saturate(${saturation.toFixed(3)})`);
      ctx.filter = parts.length ? parts.join(' ') : 'none';
      ctx.drawImage(el, (ew - sw) / 2, (eh - sh) / 2, sw, sh, 0, 0, bw, bh);
      ctx.filter = 'none';

      return true;
    };

    /**
     * Lay the outgoing sleeve over the new one and let it thin out.
     *
     * The buffer arrives already blurred, so the only thing crossing the window is
     * a textured quad — which is why this can run every frame of a dissolve and the
     * full-resolution filter it replaced could not.
     */
    const paint = () => {
      raf = 0;
      if (disposed) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const targetW = Math.min(Math.round(w * dpr), 8192);
      const targetH = Math.min(Math.round(h * dpr), 8192);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.setTransform(targetW / w, 0, 0, targetH / h, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = video ? 'low' : 'high';
      ctx.globalAlpha = 1;
      ctx.filter = 'none';

      const { tw, th } = bufferSize(w, h);
      const { radius, sat: saturation } = tuneRef.current;
      const incoming: CanvasImageSource | null = pixels ? pixels.el : video;
      const reframe = bake.w !== tw || bake.h !== th;
      /*
       * Whether the picture being read out of is a different object from the one
       * last baked. A video element is the same object all the way through, so
       * this is false for it on every frame — which is right, because there is no
       * outgoing sleeve to retire when the same film is still the source.
       */
      const sourceChanged = bake.image !== incoming;
      const pictureChanged = sourceChanged && !video && bake.ready;
      const retune = bake.radius !== radius || bake.sat !== saturation || reframe;

      /*
       * `video` is its own term because a moving source has to be re-read every
       * frame whatever the tuning is doing; the other three are cases where a
       * still source is being asked of the buffer for a reason.
       */
      if (video || sourceChanged || retune || !bake.ready) {
        if (pictureChanged) {
          /*
           * Retire what is on screen before overwriting it, so the first frame of
           * the new sleeve has something to dissolve out from under. `old` keeps its
           * own shape; both buffers stretch to the same destination rect, so a
           * resize mid-swap costs a resample and not a jump.
           */
          if (!bake.hasOld || bake.old.width !== bake.cur.width || bake.old.height !== bake.cur.height) {
            bake.old.width = bake.cur.width;
            bake.old.height = bake.cur.height;
          }
          bake.oldCtx.setTransform(1, 0, 0, 1, 0, 0);
          bake.oldCtx.globalAlpha = 1;
          bake.oldCtx.drawImage(bake.cur, 0, 0, bake.old.width, bake.old.height);
          bake.hasOld = true;
          bake.dissolveFrom = performance.now();
        }
        if (!fillBuffer(w, h)) {
          /*
           * The cover has not decoded yet. There is nothing to show, and showing the
           * buffer's own fill colour would be worse — a flat dark rectangle is what
           * the old "flash to the desktop" complaint looked like from in here.
           */
          return;
        }
        bake.image = incoming;
        bake.ready = true;
      }

      const raw = bake.hasOld ? Math.min(1, (performance.now() - bake.dissolveFrom) / DISSOLVE_MS) : 1;
      const e = easeFlow(raw);

      /*
       * Blend the two sleeves on the small buffers and cross one image over the
       * window, rather than cross-fading two full-window draws.
       *
       * The upscale is the expensive half of this frame — measured at 15 ms for a
       * full-window blurred draw at this app's own size, which is the whole 60 Hz
       * budget and the reason the old dissolve ran like it did. Compositing two
       * of them doubled it. Two hundred and forty pixels of blend costs a fraction
       * of a millisecond, so the dissolve now costs one pass no matter how many
       * sleeves are in it.
       */
      let shown: HTMLCanvasElement = bake.cur;
      if (bake.hasOld && raw < 1) {
        const mix = bake.mix;
        if (mix.width !== bake.cur.width || mix.height !== bake.cur.height) {
          mix.width = bake.cur.width;
          mix.height = bake.cur.height;
        }
        const mc = bake.mixCtx;
        mc.setTransform(1, 0, 0, 1, 0, 0);
        mc.globalAlpha = 1;
        mc.imageSmoothingQuality = 'high';
        mc.drawImage(bake.old, 0, 0, mix.width, mix.height);
        mc.globalAlpha = e;
        mc.drawImage(bake.cur, 0, 0, mix.width, mix.height);
        mc.globalAlpha = 1;
        shown = mix;
      }
      /*
       * The buffer carries one blur radius of picture outside the window on every
       * side, so it is laid down wider than the window and the bleed is what gets
       * thrown away. Drawing it to `0,0,w,h` would squash the bleed back in and
       * shrink the room.
       */
      const outX = bake.bleed * (w / Math.max(1, bake.w));
      const outY = bake.bleed * (h / Math.max(1, bake.h));
      ctx.drawImage(
        shown,
        0,
        0,
        shown.width,
        shown.height,
        -outX,
        -outY,
        w + outX * 2,
        h + outY * 2,
      );
      ctx.globalAlpha = 1;


      // Darkness goes on last and unfiltered, which is what keeps the two sliders
      // independent: a saturation matrix leaves the picture's luma where it was.
      const veil = tuneRef.current.dim;

      if (veil > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${(veil * 0.8).toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
      }

      // The canvas changed pixels but no node moved, so nothing else would
      // ever tell the glass to look again.
      invalidateScene();

      if (bake.hasOld && raw < 1 && !disposed) raf = requestAnimationFrame(paint);
      else if (bake.hasOld) bake.hasOld = false;
    };

    /** Coalesce repeat requests into one repaint on the next frame. */
    const schedule = () => {
      if (disposed || raf) return;
      raf = requestAnimationFrame(paint);
    };

    const loop = () => {
      if (disposed || !video) return;
      /*
       * A display frame that carries no new decoded frame still costs a buffer
       * fill and a full-window upscale, and on a two-core machine that is the
       * difference between the film and the interface competing for the same
       * pair of threads. Skipping it is not a quality loss — the pixels on the
       * canvas are already the ones the decoder last produced.
       */
      if (video.currentTime !== lastFrame) {
        lastFrame = video.currentTime;
        paint();
      }
      raf = requestAnimationFrame(loop);
    };

    const onResize = () => schedule();
    window.addEventListener('resize', onResize);

    if (video) loop();
    else {
      repaintRef.current = schedule;
      schedule();
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      repaintRef.current = null;
      window.removeEventListener('resize', onResize);
    };
  }, [active, artPixels, wall]);

  // Blur, darkness and colour depth are read at paint time, so a drag that never
  // swaps the source still pushes one frame through.
  useEffect(() => {
    repaintRef.current?.();
  }, [blur, dim, sat]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="backdrop-layer"
      data-no-capture
      {...(wall?.kind === 'video' ? { 'data-dynamic': '' } : {})}
      aria-hidden
    />
  );
};

export default BackdropLayer;
