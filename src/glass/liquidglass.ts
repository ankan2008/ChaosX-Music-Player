import { LiquidGlass } from '../vendor/liquidglass';
import type { GlassEngine, GlassEngineOptions } from './types';

/**
 * THE ONE SWITCH for the idle-CPU fix. Set it to `false` and the liquid-glass
 * render loop goes back to exactly what it was: an animation frame scheduled
 * for ever, whether or not anything on screen has changed, sweeping every
 * registered surface for a new rectangle and a new size each time (~0.8 ms of
 * forced layout per frame with 26 surfaces and nothing to draw), only stopping
 * when `destroy()` is called.
 *
 * Left `true`, the loop parks itself once the scene has been genuinely static
 * for three frames — no rAF is requested, so no rect sweep, no `getComputedStyle`,
 * no capture pass, no texture upload, no shader — and restarts on the next frame
 * the moment anything that could change a pixel happens: a DOM mutation, a
 * scroll, a resize, a pointer or drag, a CSS transition or animation starting,
 * a panel moving or resizing with no event at all (a geometry check every 120 ms
 * for the first second of the rest, then every 400 ms, is the backstop for that
 * one), a WebGL context restore, a live `<video>` appearing, an
 * html-to-image capture finishing, or the app's own `invalidateScene()` /
 * `refresh()` / `markSceneStale()` call that says the backdrop repainted without
 * touching the DOM.
 *
 * Nothing else needs editing to undo this: the vendored engine gates every new
 * behaviour behind the option this constant feeds, and defaults it to off.
 *
 * Currently `false` — the user asked for the original always-rendering loop back.
 * The rest/wake machinery stays in the vendor tree untouched and dormant; flip
 * this to `true` to re-enable it.
 */
export const GLASS_REST_WHEN_IDLE = false;

/**
 * THE ONE SWITCH for the glass's memory. A number, and `1` is today: everything the
 * glass allocates for itself is sized from `devicePixelRatio * GLASS_RENDER_SCALE`,
 * so at 1 the arithmetic this app does is bit-for-bit the arithmetic it did before
 * and nothing about the picture changes.
 *
 * What it costs, and what it actually saves — measured on 2026-10-06 through the
 * debug bridge with `memoryReport()`, which counts the allocations rather than
 * guessing at them. With the library window maximised at 1920x1080 and a ratio of
 * 1.25, 28 surfaces at scale 1 hold:
 *
 *   render-target pool (3 RGBA textures per distinct size)   44.9 MB
 *   the per-panel shader canvases, 3.75 Mpx                  15.0 MB
 *   the scene canvas and the GL drawing buffer, 1.42 Mpx      5.7 MB
 *   html-to-image backdrop snapshots                           0 MB (see below)
 *   -----------------------------------------------------------  ~66 MB
 *
 * and at 0.75 the same three come back as 25.3 / 8.4 / 3.2 MB — ~37 MB, a saving of
 * about 29. The square-of-the-number arithmetic in the original version of this
 * comment was right; the "biggest number on the board" framing was not. Two thirds
 * of the GPU process is Chromium's own compositing of 28 transparent, always-on-top
 * surfaces and their layer trees, which this lever does not touch, so 0.75 is a
 * ~30 MB lever and not a 100-200 MB one. Say that plainly before anyone plans a
 * release around it.
 *
 * What it costs visually, also measured rather than described. The glass refracts a
 * *blurred* backdrop: the bend samples a source the shader has already smeared six
 * times over, so a softer source is almost invisible in the bend — the refraction is
 * a displacement of something with no high-frequency detail left to lose. That claim
 * held up. Sweeping 551 columns of the pill's top rim in two screenshots of the same
 * frame gave a highlight amplitude of 38.3 at scale 1 against 35.7 at 0.75 (7% down)
 * and a highlight that spreads from 4.5 device pixels to 6.4 — a crisp line becomes a
 * short gradient, exactly as feared, and it is the only thing in the picture that
 * does. Scene-wide high-frequency energy fell 6%.
 *
 * The second fear, sharp text seen through a panel, needs correcting: in the library
 * window there is no such text. Every glass surface there is stamped `data-no-capture`
 * and refracts the album-art backdrop, and the labels are DOM painted *above* the
 * canvas, so they are not rendered by this number at all — the two screenshots are
 * pixel-identical across the quote block (mean difference 0.24 of 255). Glyphs only
 * enter the refraction source in the widget's dropdowns, which bend a live screen
 * grab and so bend whatever the neighbouring application is drawing. Judge 0.75 by
 * opening one of those over a text editor, not from the library.
 *
 * It also cannot be judged from a description. Nothing needs restarting: the engine
 * re-arms every surface the moment the number changes, so it is live in the running
 * app, and the comparison to make is two screenshots of the same screen at 1 and at
 * the new value. The first value to try is 0.75, which puts the effective ratio at
 * 0.94 device pixels per CSS pixel — the panel is drawn at essentially its own
 * on-screen size instead of 1.25 times it — and takes 44% off the allocation.
 *
 * Everything it touches is an allocation. The pixel constants the shader authors
 * by hand — anti-aliasing band, stroke width, refraction reach, blur radius — are
 * multiplied by this number too, deliberately, so that lowering it costs
 * resolution and not geometry: an unscaled constant would deepen the bend and the
 * frost as the target shrank, which is a different look rather than a cheaper one.
 *
 * Currently `1`. Do not set it below that without the user asking, and do not
 * "optimize" it to something adaptive: the point of one number in one file is that
 * the decision is visible. If the goal is fewer bytes without touching the look, the
 * lever is the render-target pool's *keying*, not its size: 28 surfaces currently
 * hold 28 distinct sizes because the cache is keyed on exact pixels, and quantising
 * that key would fold several sets into one at full resolution.
 */
export const GLASS_RENDER_SCALE = 1;

/**
 * Thin wrapper over the vendored shader, and the only place its optional
 * behaviours are switched on.
 *
 * The library files under `src/vendor/liquidglass/` are edited — `restWhenIdle`
 * and `renderScale` would not exist otherwise — but every line added there is
 * gated behind an option that this file hands it, and defaults to what the shipped
 * library did. So the fallback path is kept a different way than the original
 * promised: not by the vendor tree being untouched, but by the two constants above
 * being the whole of the diff a reader has to distrust. Set them to `false` and `1`
 * and this app renders the picture that shipped.
 */
export async function createLiquidGlassEngine(
  options: GlassEngineOptions,
): Promise<GlassEngine> {
  const instance = await LiquidGlass.init({
    root: options.root,
    glassElements: options.glassElements ?? [],
    defaults: options.defaults,
    realtime: options.realtime,
    restWhenIdle: GLASS_REST_WHEN_IDLE,
    renderScale: GLASS_RENDER_SCALE,
  });

  return {
    get glassSet() {
      return instance.glassSet;
    },
    get fps() {
      return instance.fps;
    },
    get holdQuality() {
      return instance.holdQuality;
    },
    set holdQuality(v: boolean) {
      instance.holdQuality = v;
    },
    get renderScale() {
      return instance.renderScale;
    },
    set renderScale(v: number) {
      instance.renderScale = v;
    },
    addGlassElement: (el) => instance.addGlassElement(el),
    removeGlassElement: (el) => instance.removeGlassElement(el),
    refresh: () => instance.markSceneStale(),
    destroy: () => instance.destroy(),
    // The debug bridge profiles through this; nothing in the app reads it.
    instance: import.meta.env.DEV ? instance : undefined,
  } as GlassEngine & { instance: LiquidGlass | undefined };
}
