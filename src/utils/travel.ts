/**
 * The travel curve behind every sliding glass highlighter.
 *
 * The song list invented it, and the folder strip, the ranked cards and the
 * sidebar view picker all had to feel like the *same* object moving, not four
 * animations that happen to look similar. So the phase maths lives here and is
 * imported by all of them — one curve, one feel.
 */

/** How much bigger the sheet gets while it is airborne. */
export const TRAVEL_GROW = 0.04;
/** Fraction of the travel spent rising, and the fraction spent landing. */
export const LIFT_PART = 0.18;
export const LAND_PART = 0.26;

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export interface Phase {
  /** 0 parked, 1 fully off the surface. Drives the shadow as well as the size. */
  lift: number;
  scale: number;
  /** Eased position progress — held back until the sheet has actually risen. */
  progress: number;
}

/**
 * Three phases rather than one curve: rise, carry, land.
 *
 * A single eased tween reads as a zoom on the same row. Holding `lift` at 1
 * across the middle of the travel — and easing the *position* only inside that
 * window — buys the time for it to look like the highlighter came off the
 * surface, floated over what was between, and set down on the new item.
 */
export function travelPhase(t: number): Phase {
  const rise = easeOutCubic(clamp01(t / LIFT_PART));
  const fall = easeOutCubic(clamp01((1 - t) / LAND_PART));
  const lift = Math.min(rise, fall);
  return {
    lift,
    scale: 1 + TRAVEL_GROW * lift,
    progress: easeInOutCubic(clamp01((t - LIFT_PART) / (1 - LIFT_PART - LAND_PART))),
  };
}
