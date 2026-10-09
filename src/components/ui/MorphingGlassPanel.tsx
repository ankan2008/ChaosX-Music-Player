import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dropdownGlass } from '../../utils/glass';
import { IS_MINI_WINDOW, IS_OVERLAY_WINDOW, IS_PILL_WINDOW } from '../../utils/windowRole';
import { useBackdropImage } from '../../hooks/useBackdropImage';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * A single glass surface that morphs between a small trigger shape and a
 * full panel, driven by one continuously interpolated box.
 *
 * The element is never swapped and its geometry is never rebuilt: width,
 * height and corner radius are lerped every frame from the same node, so a
 * squircle, a pill and the open panel are just three points on one shape
 * parameter space. The corner radius is eased on its own curve rather than
 * falling out of the size change, which is what stops the panel looking
 * mushy mid-bounce.
 *
 * Open and close are click-driven. Hover was the original trigger and it
 * made the panels unusable: the cursor had to cross a gap between button and
 * panel, and any stray exit closed the panel mid-reach.
 */

export interface MorphShape {
  width: number;
  height: number;
  /** Corner radius in CSS pixels. Half the short side makes a pill. */
  radius: number;
}

/** Window in which two presses on a trigger count as one double click. */
const DOUBLE_MS = 260;

export interface MorphingGlassPanelProps {
  /** The button the panel grows out of. */
  triggerRef: React.RefObject<HTMLElement>;
  /**
   * A second press on the trigger within `DOUBLE_MS` runs this instead of
   * opening the panel.
   *
   * Only the *opening* press is held back, and only on a trigger that has this
   * gesture: muting on a double tap is a thing people do on purpose, and the
   * app has to tell it apart from an opening single tap before it commits.
   * Closing is never ambiguous, so it stays instant.
   */
  doubleClickAction?: () => void;
  idle: MorphShape;
  open: MorphShape;
  /**
   * Which way the panel leaves the trigger. `left` is for a control docked
   * against a screen edge — the pill — where up/down would cover the button
   * that summoned it.
   */
  direction?: 'up' | 'down' | 'left' | 'right';
  align?: 'left' | 'right' | 'center';
  /**
   * In the mini card, whether this flyout is allowed to leave the card.
   *
   * The default is no: a menu that floats above the widget reads as a second
   * window, and it forced 340px of dead transparent room into the mini's own
   * window, which is what stopped the card being draggable to the top or bottom
   * of the screen. A panel that stays inside the card blurs the artwork behind
   * it, which is the material the user asked for.
   *
   * The queue is the one that says yes — it is a scrolling list of the whole
   * session and has nothing to be inside.
   */
  project?: boolean;
  /** Gap between the trigger edge and the settled panel, in CSS pixels. */
  gap?: number;
  children: React.ReactNode;
  /** Overrides the glass config for surfaces that need a different tint. */
  glassConfig?: (radius: number) => string;
}

const PHASE1_MS = 300;
const SHAPE_MS = 280;
const SETTLE_MS = 90;
/*
 * The content used to wait ninety milliseconds behind the box before it began its
 * own 170ms fade, so a panel that had already arrived still read as loading — an
 * empty surface, then a control that blinked in. Ninety of that gap was inherited
 * from a design where the mica genuinely needed the time; with the grab pre-warmed
 * and an opaque floor under it, nothing does, so the content starts almost with the
 * morph and finishes inside it.
 */
const CONTENT_DELAY_MS = 20;
const CONTENT_MS = 130;
/** Kept small on purpose: the lift has to read as a bounce, not a jump. */
const OVERSHOOT_PX = 8;
const CLOSE_MS = 320;
const CLOSE_CONTENT_MS = 120;
/** Fraction of the close spent travelling; the rest dissolves on the icon. */
const CLOSE_SHAPE_PART = 0.68;
/** The last slice of the close, once the box has reached its icon. */
const CLOSE_FADE_MS = 150;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The shape the panel collapses into: the trigger's own box, measured rather
 * than declared. Hard-coded idle sizes drifted from the real buttons (30px
 * icons declared as 32, 58px triggers declared as 44), so the closing panel
 * landed beside its icon instead of on it.
 *
 * The rect is un-transformed because the buttons scale on hover and on press,
 * and `getBoundingClientRect` reports the scaled box.
 */
function measureIdle(el: HTMLElement, fallback: MorphShape) {
  const rect = el.getBoundingClientRect();
  const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  const sx = Math.abs(matrix.a) || 1;
  const sy = Math.abs(matrix.d) || 1;
  const width = rect.width / sx;
  const height = rect.height / sy;
  if (width < 4 || height < 4) {
    return { x: rect.left, y: rect.top, w: fallback.width, h: fallback.height, r: fallback.radius };
  }
  // Undo the hover/press scale around the element's centre.
  const x = rect.left + rect.width / 2 - width / 2;
  const y = rect.top + rect.height / 2 - height / 2;
  const side = Math.min(width, height);
  const raw = getComputedStyle(el).borderTopLeftRadius;
  const percent = /^([\d.]+)%/.exec(raw);
  const pixels = /^([\d.]+)px/.exec(raw);
  const radius = percent
    ? (parseFloat(percent[1]) / 100) * side
    : pixels
      ? parseFloat(pixels[1])
      : fallback.radius;
  return { x, y, w: width, h: height, r: Math.min(radius, side / 2) };
}

/**
 * CSS `cubic-bezier(x1, y1, x2, y2)` solved in JavaScript. The animation is
 * driven from a rAF tween rather than CSS transitions because the corner
 * radius has to be written into the glass shader config on the same frame
 * as the box, so every property must share one clock.
 */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;

  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) return sampleY(t);
      const slope = sampleDX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= dx / slope;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-5) break;
      if (value < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

const easeOutCubic = cubicBezier(0.22, 1, 0.36, 1);
const easeInCubic = cubicBezier(0.64, 0, 0.78, 0);
/** Back-out: overshoots the target then comes back — the lift. */
const easeBackOut = cubicBezier(0.34, 1.56, 0.64, 1);

/**
 * Only one of these panels may be open at a time, and opening a second has
 * to close the first through its normal animation, not an instant cut.
 */
let closeActive: (() => void) | null = null;

/**
 * The same panel's *replacement* door, which is not the same gesture.
 *
 * Set to the fade-in-place variant, because a panel being superseded is not a
 * panel the user walked away from — the next frame is already busy with the one
 * arriving, and the walk home is the thing that made the switch jitter.
 */
let replaceActive: (() => void) | null = null;

/**
 * Close whatever panel is open, from outside React.
 *
 * The pill's window is click-through outside its strip, so a press on the
 * desktop beside it is never delivered to this renderer and no `pointerdown`
 * handler can see it. The main process decides who receives those clicks
 * already, so it says so here instead.
 */
export function dismissActivePanel(): void {
  const fn = closeActive;
  closeActive = null;
  if (fn) fn();
}

function ensureLayer(): HTMLElement | null {
  /*
   * Inside a floating widget the layer goes into the stage, not the app root.
   *
   * `backdrop-filter` samples its *backdrop root*, and an element that creates a
   * stacking context is one. `.morph-layer` is `position: fixed` with
   * `z-index: 70`, so as a direct child of `.app-root` it was its own backdrop
   * root — and its subtree held nothing but the panel, so there was genuinely
   * nothing to blur. That is why every dropdown in the mini card and the pill
   * read as a clear window with the record razor sharp through it, and why
   * raising the radius from 34px to 90px twice over changed nothing visible.
   *
   * Parented into the stage, the panel sits in the same stacking context as the
   * card and the disc, and the blur becomes real — verified by reparenting a
   * live panel and watching the same declaration start smearing the artwork.
   *
   * The layer keeps its `z-index`, because dropping it lets `.mini-player`
   * (z-index 1) paint over the panel instead; also verified.
   */
  const stage = IS_OVERLAY_WINDOW
    ? document.querySelector<HTMLElement>('.mini-stage, .pill-stage')
    : null;
  const root = stage ?? document.querySelector<HTMLElement>('.app-root');
  if (!root) return null;
  let layer = root.querySelector<HTMLElement>(':scope > .morph-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'morph-layer';
    // Without this the shader would freeze a snapshot of the panels into the
    // scene behind every other glass surface — the ghosting bug.
    layer.setAttribute('data-no-capture', '');
    /*
     * And without *this*, an open dropdown is refracted into the pill's own
     * capsule. `data-no-capture` keeps a layer's HTML out of the scene but never
     * its media: the walker queries every `img`/`video`/`canvas` beneath each
     * root child and draws the ones that touch a dirty panel. A flyout carries a
     * monitor-sized `<video>` for its mica plus the meter artwork, so the moment
     * one opens the strip starts bending the slider it just grew — the same
     * feedback loop the track list's covers used to cause. This layer is
     * interface, never backdrop.
     */
    layer.setAttribute('data-no-scene', '');
    root.appendChild(layer);
  }
  return layer;
}

export const MorphingGlassPanel: React.FC<MorphingGlassPanelProps> = ({
  triggerRef,
  idle,
  open,
  direction: askedDirection = 'up',
  align = 'left',
  project = false,
  gap = 8,
  children,
  glassConfig = dropdownGlass,
  doubleClickAction,
}) => {
  const [mounted, setMounted] = useState(false);
  /*
   * A caller that says `left` means "sideways, out into the gutter beside the
   * strip" — it does not know or care which edge the strip is docked to. The
   * gutter is always on the inner side, so a strip moved to the left edge of the
   * screen has its gutter, and therefore its panels, on the right.
   *
   * Resolved here rather than at the seven call sites because it is a property of
   * the widget's docking, which this component is already the authority on, and
   * because subscribing in one place keeps a mid-flight flip from leaving some
   * panels facing the old edge.
   */
  const pillSide = usePlayerStore((s) => s.pillSide);
  /** The picture the room is wearing, which a lateral panel has to blur for itself. */
  const backdrop = useBackdropImage();
  const direction =
    askedDirection === 'left' && IS_PILL_WINDOW && pillSide === 'left' ? 'right' : askedDirection;
  /** A panel that leaves an edge-docked strip sideways, in either direction. */
  const lateral = direction === 'left' || direction === 'right';
  const toRight = direction === 'right';
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof geometry> | null>(null);
  const mountedRef = useRef(false);
  /** Pending unmount from `fadeSelf`, so a reopen can cancel it. */
  const fadeTimer = useRef(0);
  /*
   * The layer's viewport offset and the last values written for the shader
   * config and the content zoom. The offset only moves when the window does, so
   * reading it once per tween keeps `paint` free of forced layouts; the other
   * two are guarded because rewriting them unchanged invalidates the subtree.
   */
  const hostOffset = useRef({ x: 0, y: 0 });
  const lastConfig = useRef('');
  const lastZoom = useRef('');
  /** Timestamp of the last press, for the double-tap gesture. */
  const lastClickAt = useRef(-1e9);
  /** The opening press, parked until the double-tap window closes. */
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Live box of the panel; a new tween always starts from wherever this is. */
  const current = useRef({ x: 0, y: 0, w: idle.width, h: idle.height, r: idle.radius, fit: 1 });

  function geometry() {
    const el = triggerRef.current;
    if (!el) return null;
    const trigger = el.getBoundingClientRect();
    const idleBox = measureIdle(el, idle);
    /*
     * `left` and `right` are for a widget docked against a screen edge — the pill
     * — where a panel that opened up or down would cover the very control that
     * summoned it. Here it leaves sideways, away from the edge, aligned
     * horizontally with its own button so the eye can follow which control it
     * came from.
     *
     * The budget and the anchor are both taken from the *strip's* edge, not the
     * button's. The button sits inside the strip, so measuring from it let a
     * 424px equalizer hang 64px across the row of controls that opened it — the
     * exact thing the pill spec rules out.
     */
    const pillBox = el.closest('.float-pill')?.getBoundingClientRect() ?? null;
    const edge = pillBox?.left ?? trigger.left;
    const outerEdge = pillBox?.right ?? trigger.right;
    /*
     * The card is the containing box for everything the mini player opens, except
     * the queue. Budgeting against the *window* let a flyout run up into the
     * transparent room above the card, which is what made every mini dropdown
     * look like a separate panel hovering over the widget.
     */
    const card = el.closest('.mini-player, .mini-video-box')?.getBoundingClientRect() ?? null;
    const inside = IS_MINI_WINDOW && !project && !!card && card.width > 40;
    const box = inside ? card! : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight, width: window.innerWidth, height: window.innerHeight };
    const pad = inside ? 10 : 8;
    const roomX = lateral
      ? Math.max(140, (toRight ? window.innerWidth - outerEdge : edge) - gap - 8)
      : box.width - pad * 2;
    const roomY = (lateral ? window.innerHeight : box.height) - pad * 2;
    const fit = Math.min(1, roomX / open.width, roomY / open.height);
    const w = open.width * fit;
    const h = open.height * fit;

    const openY = lateral
      ? trigger.top + trigger.height / 2 - h / 2
      : direction === 'up'
        ? trigger.top - gap - h
        : trigger.bottom + gap;
    /*
     * A panel that would spill above the card is pulled back down *into* it, so
     * its own bottom edge clears the button row it grew out of. It is not shrunk
     * further than `fit` already did — a menu that has to overlap its trigger to
     * fit is better than one that scales to unreadable.
     */
    const lifts =
      !lateral
      && inside
      && openY + h > card!.top
      && openY < card!.top;
    /*
     * In the pill, a panel that cannot fit above its button is lifted into the
     * transparent room above the card rather than landing on the row it came from.
     */
    const clears =
      !lateral
      && !inside
      && !!card
      && openY + h > card.top
      && card.top - gap - h >= 8;
    const minX = box.left + pad;
    const maxX = Math.max(minX, box.left + box.width - w - pad);
    const anchorX =
      align === 'center'
        ? trigger.left + trigger.width / 2 - w / 2
        : align === 'right'
          ? trigger.left + trigger.width - w
          : trigger.left;
    const x = lateral
      ? toRight
        ? Math.min(window.innerWidth - w - pad, outerEdge + gap)
        : Math.max(pad, edge - gap - w)
      : Math.min(Math.max(minX, anchorX), maxX);
    const y = lateral
      ? Math.min(Math.max(pad, openY), Math.max(pad, window.innerHeight - h - pad))
      : clears
        ? (card?.top ?? openY) - gap - h
        : Math.min(Math.max(box.top + pad, openY), Math.max(box.top + pad, box.bottom - h - pad));
    return {
      idle: idleBox,
      open: { x, y, w, h, r: open.radius, fit },
    };
  }

  const paint = useCallback(() => {
    const panel = panelRef.current;
    const box = current.current;
    if (!panel) return;
    /*
     * `box` is in viewport coordinates, taken from `getBoundingClientRect` on the
     * trigger. The layer is no longer guaranteed to start at the viewport origin
     * — inside a widget it lives in the stage, which is inset by the click-through
     * gutter — so the layer's own offset has to come back out or every panel lands
     * down and to the right of the control that opened it.
     */
    const { x: ox, y: oy } = hostOffset.current;
    panel.style.transform = `translate3d(${box.x - ox}px, ${box.y - oy}px, 0)`;
    panel.style.width = `${box.w}px`;
    panel.style.height = `${box.h}px`;
    panel.style.borderRadius = `${box.r}px`;
    // The engine forces `overflow: visible` inline on every glass element so
    // their shadow halos can spill, and it sizes the injected shader canvas
    // from offsetWidth at most once per frame — so a shrinking panel keeps a
    // larger, padded canvas that hangs SHADOW_PAD past the box on every side.
    // Uncipped, the closing overlay visibly dissolves below its icon. Written
    // every frame because the engine writes it too, later.
    panel.style.overflow = 'hidden';
    /*
     * The shader reads its radius from the config, and the content scales by
     * `zoom` — but both are rewritten only when they actually change. Writing an
     * attribute or a zoom every frame invalidates the whole subtree each time,
     * and on this machine those invalidations, not the tween maths, were the
     * 30ms-per-frame stutter inside an otherwise smooth open.
     */
    const cfg = glassConfig(box.r);
    if (cfg !== lastConfig.current) {
      lastConfig.current = cfg;
      panel.dataset.config = cfg;
    }
    /*
     * `zoom`, not a transform: the content already animates its own translateY
     * and two writes to `transform` would clobber each other.
     */
    const content = contentRef.current;
    if (content) {
      const zoom = String(box.fit ?? 1);
      if (zoom !== lastZoom.current) {
        lastZoom.current = zoom;
        content.style.zoom = zoom;
      }
    }
  }, [glassConfig]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  /** Runs the open or close tween from whatever the panel's current box is. */
  const animate = useCallback(
    (target: 'open' | 'closed', from?: ReturnType<typeof geometry>) => {
      const boxes = from ?? geometry();
      if (!boxes || !panelRef.current) return;
      stop();

      // The layer's offset feeds every transform `paint` writes; read it once
      // here rather than once per frame, where it forces a layout each time.
      const host = panelRef.current.parentElement;
      if (host) {
        const r = host.getBoundingClientRect();
        hostOffset.current = { x: r.left, y: r.top };
      }

      const start = { ...current.current };
      const t0 = performance.now();
      // The lift overshoots along the axis of travel, which is horizontal for
      // a panel that leaves an edge-docked control sideways — and the sign of
      // that axis is whichever edge the strip happens to be docked to.
      const up = direction === 'up' ? -1 : 1;
      const left = toRight ? 1 : -1;
      const content = contentRef.current;
      const panel = panelRef.current;

      const step = (now: number) => {
        const elapsed = now - t0;
        const box = current.current;

        if (target === 'closed') {
          // The box reaches the icon at 68% of the close and the surface then
          // dissolves in place. Easing the whole way would leave the last and
          // longest stretch of travel to two or three frames on a slow GPU, so
          // the panel appeared to vanish somewhere near the middle of the pill.
          const t = clamp01(elapsed / (CLOSE_MS * CLOSE_SHAPE_PART));
          const eased = easeInCubic(t);
          box.x = lerp(start.x, boxes.idle.x, eased);
          box.y = lerp(start.y, boxes.idle.y, eased);
          box.w = lerp(start.w, boxes.idle.w, eased);
          box.h = lerp(start.h, boxes.idle.h, eased);
          box.r = lerp(start.r, boxes.idle.r, eased);
          if (content) {
            const ct = clamp01(elapsed / CLOSE_CONTENT_MS);
            content.style.opacity = String(1 - ct);
            content.style.transform = `translateY(${lerp(0, 6, ct)}px)`;
          }
          if (panel) {
            const fade = clamp01((elapsed - (CLOSE_MS - CLOSE_FADE_MS)) / CLOSE_FADE_MS);
            panel.style.opacity = String(1 - easeInCubic(fade));
          }
          paint();
          if (t >= 1) {
            // Hold on the icon until the fade has finished as well.
            if (elapsed >= CLOSE_MS) {
              stop();
              mountedRef.current = false;
              setMounted(false);
            } else {
              rafRef.current = requestAnimationFrame(step);
            }
          } else {
            rafRef.current = requestAnimationFrame(step);
          }
          return;
        }

        // ---- open: phase 1 lift + morph, then a short settle ----
        if (panel) panel.style.opacity = '1';
        const shapeT = easeOutCubic(clamp01(elapsed / SHAPE_MS));
        box.w = lerp(start.w, boxes.open.w, shapeT);
        box.h = lerp(start.h, boxes.open.h, shapeT);
        // Radius is eased on its own clock rather than derived from the size.
        box.r = lerp(start.r, boxes.open.r, shapeT);

        const liftT = clamp01(elapsed / PHASE1_MS);
        const settleT = easeOutCubic(clamp01((elapsed - PHASE1_MS) / SETTLE_MS));
        if (lateral) {
          box.y = lerp(start.y, boxes.open.y, shapeT);
          const overshootX = boxes.open.x + left * OVERSHOOT_PX;
          box.x =
            elapsed <= PHASE1_MS
              ? lerp(start.x, overshootX, easeBackOut(liftT))
              : lerp(overshootX, boxes.open.x, settleT);
        } else {
          box.x = lerp(start.x, boxes.open.x, shapeT);
          const overshootY = boxes.open.y + up * OVERSHOOT_PX;
          box.y =
            elapsed <= PHASE1_MS
              ? lerp(start.y, overshootY, easeBackOut(liftT))
              : lerp(overshootY, boxes.open.y, settleT);
        }

        if (content) {
          const contentT = clamp01((elapsed - CONTENT_DELAY_MS) / CONTENT_MS);
          content.style.opacity = String(contentT);
          content.style.transform = `translateY(${lerp(8, 0, easeOutCubic(contentT))}px)`;
        }
        paint();

        if (elapsed >= PHASE1_MS + SETTLE_MS) {
          stop();
          if (content) {
            content.style.opacity = '1';
            content.style.transform = 'translateY(0)';
          }
        } else {
          rafRef.current = requestAnimationFrame(step);
        }
      };

      rafRef.current = requestAnimationFrame(step);
    },
    [direction, lateral, paint, stop],
  );

  const closeSelf = useCallback(() => {
    if (!panelRef.current) return;
    // The label has to clear out before the surface lands on the icon: with
    // the tooltip sitting directly underneath, the two pills overlap and the
    // collapse reads as closing onto the button's name instead of the button.
    triggerRef.current?.classList.add('morph-closing');
    animate('closed');
  }, [animate, triggerRef]);

  /*
   * Take this panel out where it stands, with no walk back to its icon.
   *
   * This is what happens to a panel that is being *replaced*. The outgoing box was
   * still travelling — writing width, height, radius and a transform every frame
   * for 320 ms — at the same time as the incoming box was writing the same four
   * properties on its way out from a different button, and on a two-core machine
   * that pair is the frame that drops. The user's description was exact: a shake
   * the length of a couple of frames, and only when a panel was already open, which
   * is the one case that runs two tweens instead of one.
   *
   * A fade is one property, on the compositor, and it leaves the arriving panel the
   * only thing moving.
   */
  const fadeSelf = useCallback(() => {
    const panel = panelRef.current;
    stop();
    if (!panel) {
      mountedRef.current = false;
      setMounted(false);
      return;
    }
    if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    panel.style.transition = `opacity ${CLOSE_FADE_MS}ms ease`;
    panel.style.opacity = '0';
    fadeTimer.current = window.setTimeout(() => {
      fadeTimer.current = 0;
      const node = panelRef.current;
      if (node) node.style.transition = '';
      mountedRef.current = false;
      setMounted(false);
    }, CLOSE_FADE_MS);
  }, [stop]);

  const openPanel = useCallback(() => {
    /*
     * A panel being superseded fades where it stands; a panel being dismissed walks
     * home to its own icon. See `fadeSelf`. The guard matters either way:
     * re-entering this panel's own trigger must not close it.
     */
    if (replaceActive && replaceActive !== fadeSelf) replaceActive();
    const boxes = geometry();
    if (!boxes) return;
    // Read the ref, not the state: a click listener attached during an
    // earlier render still sees `mounted === false`, and taking the mount
    // branch again reset the box to idle without ever re-running the layout
    // effect that starts the tween — the panel sat at button size forever.
    if (!mountedRef.current) {
      current.current = { ...boxes.idle, fit: boxes.open.fit };
      pendingRef.current = boxes;
      setMounted(true);
    } else {
      animate('open', boxes);
    }
  }, [animate, fadeSelf]);

  /**
   * The tween has to start after the portal has actually been committed, so
   * it is kicked off from a layout effect rather than a rAF scheduled from
   * the click handler, which can run before React attaches the element.
   */
  useLayoutEffect(() => {
    if (!mounted) return;
    mountedRef.current = true;
    // The button's name belongs under the icon while its panel is open; above
    // the icon is exactly where the panel has just grown into.
    const trigger = triggerRef.current;
    trigger?.classList.add('tip-below');
    trigger?.classList.remove('morph-closing');
    const boxes = pendingRef.current;
    if (boxes) {
      pendingRef.current = null;
      const host = panelRef.current?.parentElement;
      if (host) {
        const r = host.getBoundingClientRect();
        hostOffset.current = { x: r.left, y: r.top };
      }
      paint();
      animate('open', boxes);
    }
    return () => {
      trigger?.classList.remove('tip-below', 'morph-closing');
    };
  }, [animate, mounted, paint, triggerRef]);

  useEffect(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const act = () => {
      if (mountedRef.current) closeSelf();
      else openPanel();
    };
    const onTap = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const second = event.timeStamp - lastClickAt.current < DOUBLE_MS;
      lastClickAt.current = second ? -1e9 : event.timeStamp;
      if (second && doubleClickAction) {
        if (clickTimer.current) {
          clearTimeout(clickTimer.current);
          clickTimer.current = null;
        }
        doubleClickAction();
        return;
      }
      /*
       * Wait to see whether a second press follows only when there is a gesture
       * to wait for and the panel is not already open. Everything else — every
       * other button in the app, and every close — answers on the press.
       */
      if (doubleClickAction && !mountedRef.current) {
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => {
          clickTimer.current = null;
          act();
        }, DOUBLE_MS);
        return;
      }
      act();
    };
    trigger.addEventListener('click', onTap, true);
    return () => {
      trigger.removeEventListener('click', onTap, true);
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
    };
  }, [closeSelf, openPanel, triggerRef, doubleClickAction]);

  // Dismiss on a click anywhere outside the button and the panel itself.
  useEffect(() => {
    if (!mounted) return;
    const onDocDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closeSelf();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSelf();
    };
    window.addEventListener('mousedown', onDocDown);
    /*
     * `mousedown` alone is not enough inside the widgets. Their cards carry
     * `-webkit-app-region: drag`, and a drag region is consumed by the window
     * manager before the page sees a mouse event — so a press on empty space in
     * the mini card dismissed nothing, and the dropdown just sat there over the
     * artwork. Pointer and release events do reach the page, and `closeSelf` is
     * idempotent, so listening on all three costs nothing where it is redundant.
     */
    window.addEventListener('pointerdown', onDocDown as EventListener);
    window.addEventListener('mouseup', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('pointerdown', onDocDown as EventListener);
      window.removeEventListener('mouseup', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [closeSelf, mounted, triggerRef]);

  useEffect(() => {
    if (!mounted) return;
    closeActive = closeSelf;
    replaceActive = fadeSelf;
    /*
     * A panel is a modal surface even though nothing about it is modal: leaving
     * it open once the pointer has gone somewhere else means the next click
     * lands on a control the user was not aiming at. Anything that is neither
     * the panel nor the button that summoned it dismisses it, and losing window
     * focus counts — clicking into another application is the same intent as
     * clicking empty space, and the panel would otherwise be waiting there when
     * the user came back.
     */
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeSelf();
    };
    const onBlur = () => closeSelf();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('blur', onBlur);
      if (closeActive === closeSelf) closeActive = null;
      if (replaceActive === fadeSelf) replaceActive = null;
    };
  }, [closeSelf, fadeSelf, mounted, triggerRef]);

  useEffect(
    () => () => {
      stop();
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    },
    [stop],
  );

  if (!mounted) return null;
  const layer = ensureLayer();
  if (!layer) return null;

  /*
   * In the library the panel is shader glass: there is a real scene behind it —
   * the backdrop, the record, the track list — and bending it is the whole point
   * of the material.
   *
   * In a widget it is a plain gaussian `backdrop-filter`, which is real for the
   * mini card: a flyout there stays inside the card, and the card has the room's
   * own backdrop painted behind it. It is not real for a panel that leaves the
   * pill sideways — see `panel-blur` below.
   */
  const refractive = !IS_OVERLAY_WINDOW && !lateral;

  /*
   * A lateral panel's own piece of the room.
   *
   * The pill's backdrop canvas is clipped to the capsule on purpose — edge to edge
   * it would read as a dark rectangle and give the widget away as a window — so the
   * gutter the flyout grows into has nothing painted in it. The overlay window is
   * transparent there, and `backdrop-filter` can only sample what this window has
   * itself drawn, never the desktop behind it. That is the whole of the "the
   * dropdowns are still transparent" report: the declaration was running, on an
   * empty backdrop, and produced exactly nothing.
   *
   * So the panel carries a blurred copy of whatever the room is wearing. It is a
   * real gaussian blur, it is on screen from the first frame rather than whenever a
   * screen grab happens to deliver one, it costs no capture, and the panel's own
   * `overflow: hidden` clips it to the panel's perimeter — which is what "only
   * inside the dropdown" asks for. The negative inset is not slack: a blur fades
   * its own edges, and a frame cut to the box would put that fade right on the
   * border. No tint on top of it, because the ask was the blur and not a colour.
   */
  /*
   * Every panel in a widget carries its own blurred piece of the room.
   *
   * This used to be `lateral`, on the reasoning that only a flyout leaving the
   * pill's edge grows into unpainted space. The mini card proved the other half of
   * the rule wrong: a panel that leaves the *top* of the card escapes the card's
   * own painted box just as surely as one that leaves its side, and Up Next is
   * taller than the card it comes out of. Both of those read as "unblurred", and
   * the reason is always the same one — this window is `transparent: true`, so
   * `backdrop-filter` has no desktop to sample and can only smear pixels this
   * document already drew.
   *
   * Painting the room's own blurred copy behind a panel that happens to sit over
   * the record costs nothing it was not already showing, because behind the card
   * is the record.
   */
  const carryOwnBlur = IS_OVERLAY_WINDOW;

  return createPortal(
    <div
      ref={panelRef}
      /*
       * `morph-panel` is not decoration. The layer it is portalled into is
       * `pointer-events: none` so it never eats clicks over the rest of the app,
       * and this class is the one thing that hands them back to the panel — drop
       * it and the overlay opens, looks right, and swallows nothing, so every
       * slider inside it is dead. The pill's hit-report looks for the same class
       * to decide that a panel is open and the gutter is no longer click-through.
       */
      data-glass={refractive ? true : undefined}
      className={`morph-panel${refractive ? '' : ' desktop-glass'}`}
      data-no-capture
      data-config={glassConfig(idle.radius)}
    >
      {carryOwnBlur && backdrop ? (
        <div
          className="panel-blur"
          style={{ backgroundImage: `url("${backdrop}")` }}
          aria-hidden
        />
      ) : null}
      <div ref={contentRef} className="morph-content">
        {children}
      </div>
    </div>,
    layer,
  );
};

export default MorphingGlassPanel;
