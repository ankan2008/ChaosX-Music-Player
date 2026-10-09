import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { cardGlass } from '../../utils/glass';
import { currentHour, makeOrder, quotePool, readQuote } from '../../utils/quoteRotation';
import type { Quote } from '../../data/quotes';
import Icon from '../ui/Icon';

/**
 * One quote, changed once an hour, with a squircle that changes it now.
 *
 * The rotation is keyed on the wall clock rather than on a countdown: a card
 * that advances every 3600 seconds from the moment the window opened shows a
 * different line to the same time of day on a different machine, and — worse —
 * never advances at all if the app is restarted each morning. Reading the hour
 * bucket means the quote is simply *the quote for this hour*, whatever happened
 * to the window in between.
 *
 * The advance walks a shuffled order and reshuffles when it wraps, so a line
 * cannot repeat until the whole pool has been shown.
 *
 * A change moves the glass itself. The old panel slides out to the right while
 * the new one arrives from the left behind it, so the card reads as a stack of
 * sheets you are turning through rather than a caption being rewritten in
 * place. Two panels exist for the length of that move, which is why the swipe
 * is short — a second shader surface is cheap for 460 ms and expensive as a
 * permanent fixture.
 */

/** How long one sheet takes to leave, and the next to arrive. */
const SWIPE_MS = 460;

/** Move to the next quote, rebuilding the walk when it runs out. */
function advanceQuote(): void {
  const s = usePlayerStore.getState();
  const pool = quotePool(s.customQuotes);
  const read = readQuote(pool, s.quoteOrder, s.quotePos);
  if (!read || pool.length === 0) return;
  const pos = (read.pos + 1) % pool.length;
  usePlayerStore.setState({
    quoteOrder: pos === 0 ? makeOrder(pool.length) : read.order,
    quotePos: pos,
    quoteHour: currentHour(),
  });
}

const Panel: React.FC<{ quote: Quote; className: string }> = ({ quote, className }) => (
  <div
    className={`liquid-glass-card small quote-glass ${className}`}
    data-glass
    data-config={cardGlass(18)}
    data-no-capture
  >
    <p className="quote-text">{quote.t}</p>
    <p className="quote-by">
      <span className="quote-dash" aria-hidden />
      {quote.a}
    </p>
  </div>
);

/**
 * The most height a quote panel may take before its type starts giving way.
 *
 * This is the sidebar's actual spare room, measured — the column fits at exactly
 * zero deficit with the quote at 104px, so anything taller puts the scrollbar
 * back, which is the one thing this card is not allowed to do.
 */
const QUOTE_MIN_H = 72;
const QUOTE_MIN_PX = 9;
const QUOTE_STEP_PX = 0.5;
/**
 * The size the sheet asks for, which `fitQuote` returns to before measuring.
 *
 * Only a fallback — the real figure is read back off the computed style — but it
 * has to stay in step with `.quote-text`'s `font-size` or the room estimate below
 * is off by however far apart the two drifted.
 */
const QUOTE_BASE_PX = 16;

/**
 * How much vertical room the quote card may actually have.
 *
 * This used to be a constant measured once against one sidebar. It is read from
 * the live column now: the card is the flexible element in `.sidebar-scroll`, so
 * its ceiling is whatever the nav card, the clock and the column's own padding
 * leave behind. Measuring it is what lets the type stay at full size — a quote
 * that needs four lines gets four lines, because the card grows into the space
 * that used to sit dead between the clock and the pomodoro.
 */
function quoteRoom(slide: HTMLElement): number {
  const section = slide.closest<HTMLElement>('section.quote-card');
  const scroller = section?.parentElement;
  if (!section || !scroller || !scroller.classList.contains('sidebar-scroll')) return QUOTE_BASE_PX * 8;
  const vMargin = (el: HTMLElement): number => {
    const cs = getComputedStyle(el);
    return (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  };
  let used = vMargin(section);
  for (const child of Array.from(scroller.children) as HTMLElement[]) {
    if (child !== section) used += child.offsetHeight + vMargin(child);
  }
  return Math.max(QUOTE_MIN_H, scroller.clientHeight - used);
}

/**
 * How tall the glass's content actually is.
 *
 * Not `card.scrollHeight`. The sheet gives the live glass `min-height: 100%` so
 * it fills the card and the line sits centred in it, and a box forced taller than
 * its own words reports a `scrollHeight` equal to that forced height — which is
 * set by the card's flex fill, which is the thing being measured against. The two
 * numbers chase each other, `scrollHeight > room` is true at every font size, and
 * the loop ran to the floor: asking for bigger text produced 8.9px text.
 *
 * Summing the in-flow children answers the question that is actually being asked
 * — how much room the words need — and ignores the box they are centred inside.
 * Absolutely-positioned children (the next-quote button) are skipped, because they
 * are taken out of the flow and cost the card nothing.
 */
function contentHeight(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  let h = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  for (const child of Array.from(el.children) as HTMLElement[]) {
    if (getComputedStyle(child).position === 'absolute') continue;
    const ccs = getComputedStyle(child);
    h +=
      child.offsetHeight +
      (parseFloat(ccs.marginTop) || 0) +
      (parseFloat(ccs.marginBottom) || 0);
  }
  return h;
}

/**
 * Shrink a long quote only when it genuinely cannot fit.
 *
 * The card column has a budget — nav, quote, clock, pomodoro — and a quote that
 * overflows it turns the whole strip into a scroller. A quote is something you
 * read at a glance, and a glance does not scroll, so past the room there is, the
 * type gives way rather than the layout. The room is measured, not assumed, which
 * is what keeps the size fixed for the ordinary two- and three-line quote.
 *
 * Measured rather than estimated from the character count, because the same 120
 * characters is four lines in one quote and six in another depending on where
 * the words fall. It runs twice, because the web font arrives after first paint
 * and a fit taken on the fallback's metrics is a fit for the wrong text.
 */
function fitQuote(slide: HTMLElement | null): void {
  if (!slide) return;
  const text = slide.querySelector<HTMLElement>('.quote-glass:not(.leaving) .quote-text');
  const card = text?.closest<HTMLElement>('.quote-glass');
  if (!text || !card) return;
  const room = quoteRoom(slide);
  // Back to the sheet's own size first, so a quote that needed 10px last hour
  // does not stay at 10px when this one has plenty of room.
  text.style.fontSize = '';
  let size = parseFloat(getComputedStyle(text).fontSize) || QUOTE_BASE_PX;
  for (let i = 0; i < 24 && contentHeight(card) > room && size > QUOTE_MIN_PX; i++) {
    size -= QUOTE_STEP_PX;
    text.style.fontSize = `${size}px`;
  }
}

const QuoteCard: React.FC = () => {
  const custom = usePlayerStore((s) => s.customQuotes);
  const order = usePlayerStore((s) => s.quoteOrder);
  const pos = usePlayerStore((s) => s.quotePos);
  const pool = useMemo(() => quotePool(custom), [custom]);
  const read = useMemo(() => readQuote(pool, order, pos), [pool, order, pos]);

  /*
   * Checked once a minute rather than with a timer set to the next hour: the
   * window sleeps when the machine does, and a `setTimeout` across the hour
   * boundary would then fire late — or never — where a comparison against the
   * clock simply finds the right quote on the next tick after it wakes.
   */
  useEffect(() => {
    if (usePlayerStore.getState().quoteHour !== currentHour()) advanceQuote();
    const id = window.setInterval(() => {
      if (usePlayerStore.getState().quoteHour !== currentHour()) advanceQuote();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [pool.length]);

  /*
   * The sheet being swiped out. Held in state because it has to stay mounted
   * for the length of the exit, and in a ref because the render has already
   * moved on to the new quote by the time the effect can notice.
   */
  const stamp = read ? `${read.pos}:${pool.length}` : '';
  const shown = useRef<{ stamp: string; quote: Quote } | null>(null);
  const [leaving, setLeaving] = useState<{ stamp: string; quote: Quote } | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!read) return;
    const previous = shown.current;
    shown.current = { stamp, quote: read.quote };
    if (!previous || previous.stamp === stamp) return;
    setLeaving(previous);
    const id = window.setTimeout(() => setLeaving(null), SWIPE_MS);
    return () => window.clearTimeout(id);
  }, [read, stamp]);

  /*
   * The fit runs after the swipe has settled, because the panel being measured
   * is the one arriving on a transform, and again once the web font has landed.
   *
   * It also re-runs whenever the sidebar itself changes size. The card is now the
   * flexible element in the column, so its room is whatever the nav, the clock and
   * the window leave over — and a fit taken before that layout settles shrinks
   * type that never needed shrinking. That is the "why is the quote so small"
   * report: the measurement was right, the moment was wrong.
   */
  useEffect(() => {
    fitQuote(slideRef.current);
    const id = window.setTimeout(() => fitQuote(slideRef.current), SWIPE_MS + 40);
    void document.fonts.ready.then(() => fitQuote(slideRef.current));
    const column = slideRef.current?.closest('.sidebar-scroll');
    let ro: ResizeObserver | null = null;
    if (column) {
      ro = new ResizeObserver(() => fitQuote(slideRef.current));
      ro.observe(column);
    }
    return () => {
      window.clearTimeout(id);
      ro?.disconnect();
    };
  }, [stamp]);

  if (!read) return null;

  return (
    <section className="quote-card">
      <div className="quote-slide" ref={slideRef}>
        {leaving ? <Panel quote={leaving.quote} className="leaving" /> : null}
        <Panel quote={read.quote} className={leaving ? 'entering' : 'settled'} />
      </div>
      <button
        type="button"
        className="quote-next liquid-glass-btn icon small squish"
        onClick={advanceQuote}
        data-tip="Next quote"
        aria-label="Next quote"
      >
        <Icon name="quote" size={13} />
      </button>
    </section>
  );
};

export default QuoteCard;
