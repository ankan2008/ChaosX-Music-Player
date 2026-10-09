import type { Quote } from '../data/quotes';
import { QUOTES } from '../data/quotes';

/**
 * The rotation behind the quote card.
 *
 * One quote per hour, in a shuffled order, with no repeats until the pool has
 * been walked — a random pick per hour gives the same line twice in an evening,
 * which is the one thing that makes a quote card feel like a slot machine
 * instead of a thought.
 */

export const HOUR_MS = 3_600_000;

/** The hour bucket we are in. Rotation is keyed on this, not on a timer. */
export const currentHour = (): number => Math.floor(Date.now() / HOUR_MS);

/** A shuffled list of `0..n-1`. */
export function makeOrder(n: number): number[] {
  const out = Array.from({ length: n }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = out[i];
    out[i] = out[j];
    out[j] = t;
  }
  return out;
}

/** Built-ins first, then whatever the user added, so indices stay stable. */
export function quotePool(custom: Quote[]): Quote[] {
  return custom.length ? [...QUOTES, ...custom] : QUOTES;
}

/**
 * The quote to show, repairing the rotation as it goes.
 *
 * Adding or removing a custom quote changes the pool size, and an order built
 * for a different size can point past the end. Rather than crash or show
 * nothing, the order is rebuilt when its length disagrees with the pool — which
 * also means the shuffle survives a restart, because a stored order of the
 * right length is left exactly as it was.
 */
export function readQuote(
  pool: Quote[],
  order: number[],
  pos: number,
): { quote: Quote; order: number[]; pos: number } | null {
  if (pool.length === 0) return null;
  const valid =
    order.length === pool.length &&
    order.every((i) => Number.isInteger(i) && i >= 0 && i < pool.length);
  const next = valid ? order : makeOrder(pool.length);
  const nextPos = Number.isInteger(pos) && pos >= 0 && pos < pool.length ? pos : 0;
  return { quote: pool[next[nextPos]], order: next, pos: nextPos };
}
