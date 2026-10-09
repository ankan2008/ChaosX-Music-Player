import type { GlassConfig } from '../vendor/liquidglass';

export interface GlassEngineOptions {
  root: HTMLElement;
  glassElements?: HTMLElement[] | NodeListOf<HTMLElement>;
  defaults?: Partial<GlassConfig>;
  /**
   * Re-evaluate every panel's geometry and refraction each animation frame
   * instead of only when something marks it dirty, so a panel that is
   * mid-animation refracts where it is rather than where it was created.
   */
  realtime?: boolean;
}

/**
 * The surface the app is written against. Both glass backends implement it,
 * which is what lets the renderer be swapped without touching a component.
 */
export interface GlassEngine {
  readonly glassSet: Set<HTMLElement>;
  readonly fps: number;
  /**
   * Pin the adaptive quality tier at 1 so every surface renders every frame.
   * For a panel whose job is bending something that moves at display rate —
   * the video pill over a film — where a skipped frame is the defect itself.
   */
  holdQuality: boolean;
  /**
   * Resolution multiplier for the pixels the glass allocates, as a live number.
   *
   * Reading it costs nothing; writing it re-sizes every render target, shader
   * canvas and backdrop snapshot in the pipeline, which is the same path a change
   * of display scale goes through. It is on the interface rather than left to the
   * vendored instance because the number is a decision the user makes by looking at
   * the running app, and the only way to compare two looks is to change one and
   * watch the other. `GLASS_RENDER_SCALE` in `liquidglass.ts` is where it is set for
   * real.
   */
  renderScale: number;
  addGlassElement(el: HTMLElement): void;
  removeGlassElement(el: HTMLElement): void;
  /**
   * Re-composite every panel once on the next frame. Needed whenever a
   * backdrop repaints without touching the DOM — otherwise a panel that
   * never moves keeps refracting the scene from before the change.
   */
  refresh(): void;
  destroy(): void;
}
