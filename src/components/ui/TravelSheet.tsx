import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { cardGlass } from '../../utils/glass';
import { travelPhase } from '../../utils/travel';

/**
 * A sliding liquid-glass highlighter, horizontal or vertical.
 *
 * The song list already had one and the user asked for the folder strip, the
 * ranked cards and the view picker to carry the *same* object — "bends colours
 * like the vertical song highlighter". This is that sheet with the row maths
 * replaced by live measurement: these lists are short and fully mounted, so the
 * box can come from the item's own rect instead of `index × pitch`, and items
 * are allowed to be different widths.
 *
 * Placement is read in viewport space against the frame. That is what lets the
 * sheet ride any scroller without anchor arithmetic: on a scroll event both the
 * item and the frame are re-measured, so their difference already includes the
 * offset. The sheet lives in a non-clipping frame *next to* the scroller rather
 * than inside it, for the same reason the song sheet does — a scroller clips the
 * shadow and the mid-travel swell — and its box is clamped to the visible band
 * so a half-scrolled item cannot drag the highlight out over the page.
 */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TravelSheetProps {
  /** Element whose children are the highlightable items, in visual order. */
  itemsRef: React.RefObject<HTMLElement>;
  /** Index into `itemsRef`'s children, or -1 to park the sheet out of sight. */
  activeIndex: number;
  /** Travel time. The song list uses a second; a click wants less. */
  ms?: number;
  radius?: number;
  /**
   * Accent wash under the glass. The shader canvas is injected at z-index -1,
   * which still paints over the element's own background, so the tint has to be
   * a child element.
   */
  tint?: string;
  /**
   * Held above the list rather than sitting on it.
   *
   * The strip asks for this while its wheel is turning: a highlighter that stays
   * welded to a row sliding underneath it reads as a sticker, and one that lifts
   * and settles back when the gesture ends reads as an object the list moves
   * past. It is a redraw, not a tween — the box does not change, only the shadow
   * and the `airborne` class do.
   */
  lift?: boolean;
  className?: string;
}

const TravelSheet: React.FC<TravelSheetProps> = ({
  itemsRef,
  activeIndex,
  ms = 640,
  radius = 14,
  tint,
  lift = false,
  className = '',
}) => {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  /** The box the sheet is drawn at right now — every tween starts from it. */
  const currentRef = useRef<Box | null>(null);
  /** Which item the sheet is on, so a re-layout can be told from a selection. */
  const onRef = useRef<number>(-1);

  const measure = useCallback(
    (index: number): Box | null => {
      const items = itemsRef.current;
      const sheet = sheetRef.current;
      const frame = sheet?.parentElement;
      if (!items || !sheet || !frame) return null;
      const child = items.children[index] as HTMLElement | undefined;
      if (!child) return null;
      const r = child.getBoundingClientRect();
      const f = frame.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      /*
       * Clamp to the item list's own box, not the frame's. The list is the thing
       * that scrolls, so its rect is the visible band; the frame is a couple of
       * pixels larger all round, and clamping against it shaved 2px off every
       * sheet that was sitting happily in view.
       */
      const c = items.getBoundingClientRect();
      let left = Math.max(r.left, c.left);
      let right = Math.min(r.right, c.right);
      if (right - left < 10) {
        /*
         * The item has been scrolled clean out of the band. Returning null here is
         * what made the highlighter vanish from the selected folder — the strip is
         * narrower than its tab list, so an off-edge selection simply had no sheet.
         *
         * Park a nub at the edge it fell off instead. It is not the row, and it does
         * not pretend to be; it says *the one you picked is that way*, which is the
         * most a highlighter can honestly be when its item is off screen.
         */
        const nub = 12;
        if (r.right < c.left) {
          left = c.left;
          right = c.left + nub;
        } else {
          left = c.right - nub;
          right = c.right;
        }
      }
      return { x: left - f.left, y: r.top - f.top, w: right - left, h: r.height };
    },
    [itemsRef],
  );

  /** What `--lift` the sheet is drawn at, so the skip below cannot strand it. */
  const liftRef = useRef(0);

  const draw = useCallback((box: Box, scale = 1, lift = 0) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    /*
     * Skip the write when nothing moved. Every sheet in the app re-measures on
     * every scroll event of every ancestor, and on a page that is not scrolling
     * under its highlighter that is two rect reads and three style writes per
     * frame for a box that has not changed by a pixel.
     */
    const c = currentRef.current;
    if (
      c &&
      scale === 1 &&
      lift === liftRef.current &&
      Math.abs(c.x - box.x) < 0.5 &&
      Math.abs(c.y - box.y) < 0.5 &&
      Math.abs(c.w - box.w) < 0.5 &&
      Math.abs(c.h - box.h) < 0.5 &&
      sheet.style.visibility !== 'hidden'
    ) {
      return;
    }
    liftRef.current = lift;
    currentRef.current = box;
    sheet.style.width = `${box.w.toFixed(2)}px`;
    sheet.style.height = `${box.h.toFixed(2)}px`;
    sheet.style.transform =
      scale === 1
        ? `translate(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px)`
        : `translate(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px) scale(${scale.toFixed(4)})`;
    sheet.style.setProperty('--lift', lift.toFixed(3));
    sheet.classList.toggle('airborne', lift > 0.02);
  }, []);

  const hide = useCallback(() => {
    const sheet = sheetRef.current;
    if (sheet) sheet.style.visibility = 'hidden';
    currentRef.current = null;
    onRef.current = -1;
  }, []);

  /** Re-place without animating: the item moved, the selection did not. */
  const park = useCallback(
    (index: number) => {
      const box = measure(index);
      if (!box) return hide();
      onRef.current = index;
      const sheet = sheetRef.current;
      if (sheet) sheet.style.visibility = 'visible';
      // Whatever height it is currently holding, keep it — a scroll must not be
      // what puts the sheet back down.
      draw(box, 1, liftRef.current);
    },
    [draw, hide, measure],
  );

  const travel = useCallback(
    (index: number, time: number) => {
      const to = measure(index);
      if (!to) return hide();
      const from = currentRef.current;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      const sheet = sheetRef.current;
      if (sheet) sheet.style.visibility = 'visible';
      onRef.current = index;
      /*
       * The first placement snaps. A sheet that glides in from the corner of
       * the frame on mount is not selecting anything, it is announcing itself —
       * and every one of these lists is re-mounted when the page changes.
       */
      if (!from || time <= 0) {
        draw(to);
        return;
      }

      let t0 = 0;
      const step = (now: number) => {
        if (!t0) t0 = now;
        const t = Math.min(1, Math.max(0, (now - t0) / time));
        const { lift, scale, progress } = travelPhase(t);
        draw(
          {
            x: from.x + (to.x - from.x) * progress,
            y: from.y + (to.y - from.y) * progress,
            w: from.w + (to.w - from.w) * progress,
            h: from.h + (to.h - from.h) * progress,
          },
          scale,
          lift,
        );
        rafRef.current = t < 1 ? requestAnimationFrame(step) : 0;
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [draw, hide, measure],
  );

  useLayoutEffect(() => {
    if (activeIndex < 0) return hide();
    if (onRef.current === activeIndex) return park(activeIndex);
    travel(activeIndex, onRef.current === -1 && !currentRef.current ? 0 : ms);
  }, [activeIndex, hide, ms, park, travel]);

  /*
   * The lift, applied without moving the sheet. Skipped mid-travel because the
   * tween writes `--lift` on every frame and would fight this for the property.
   */
  useLayoutEffect(() => {
    const box = currentRef.current;
    if (!box || rafRef.current) return;
    draw(box, 1, lift ? 1 : 0);
  }, [draw, lift]);

  /*
   * Anything that moves the items without changing which one is active — a
   * scroll of any ancestor, a rename, a window resize, a late font — has to
   * re-read the box, or the highlight drifts off its row. Captured on the
   * window so it catches the page scroller, the strip scroller and the song
   * list scroller alike.
   */
  useEffect(() => {
    let queued = 0;
    const onMove = () => {
      if (rafRef.current || queued) return;
      /*
       * One re-measure per frame. Scroll events arrive several times between two
       * frames on a trackpad, and each one used to read two client rects and
       * write three styles — the same work the list beside it is doing, on top of
       * the glass re-composite a scroll already costs.
       */
      queued = requestAnimationFrame(() => {
        queued = 0;
        if (rafRef.current) return;
        if (onRef.current >= 0) park(onRef.current);
      });
    };
    window.addEventListener('scroll', onMove, { passive: true, capture: true });
    const ro = new ResizeObserver(onMove);
    if (itemsRef.current) ro.observe(itemsRef.current);
    return () => {
      window.removeEventListener('scroll', onMove, { capture: true });
      if (queued) cancelAnimationFrame(queued);
      ro.disconnect();
    };
  }, [itemsRef, park]);

  // Layout settles after the first paint; re-read once the browser has too.
  //
  // Guarded on the tween: this fires on the tick after the click that started
  // the travel, and parking then teleports the sheet onto its row and back —
  // the rAF loop keeps interpolating from the box it captured at the start, so
  // a snap in the middle reads as the highlighter rubber-banding past its item.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (rafRef.current || onRef.current < 0) return;
      park(onRef.current);
    }, 0);
    return () => window.clearTimeout(id);
  }, [activeIndex, park]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return (
    <div
      ref={sheetRef}
      className={`travel-sheet ${className}`}
      data-glass
      data-config={cardGlass(radius)}
      data-no-capture
      aria-hidden
      style={
        {
          '--sheet-tint': tint ?? 'transparent',
          borderRadius: `${radius}px`,
        } as React.CSSProperties
      }
    >
      <i className="sheet-tint" />
    </div>
  );
};

export default TravelSheet;
