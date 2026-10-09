/**
 * The listen tally, in its own localStorage key.
 *
 * It used to live inside the persisted settings blob, which is shared by all
 * three renderers — the library window, the mini card and the strip — and each of
 * which writes the *whole* blob whenever its own state changes. An overlay never
 * starts a listen of its own, so the moment it wrote it wrote back the empty
 * tally it had hydrated minutes earlier, and the counts vanished. Dropping the
 * key from the overlay's `partialize` fixed the erasing and created a worse
 * problem: a listen started from the strip was recorded only in the strip's
 * memory and never persisted at all.
 *
 * A key of its own, written read-modify-write, means the last writer can only
 * ever add to what is already on disk. The dedupe lives in the stored
 * `lastPlayed` rather than in a `Map`, so it works across windows too: a handoff
 * between the strip and the library is one listen, not two.
 */

export interface PlayStat {
  count: number;
  lastPlayed: number;
}

export type PlayStats = Record<string, PlayStat>;

const KEY = 'chaosx-play-stats';
/** How long a recorded listen suppresses a second one for the same track. */
export const PLAY_DEDUPE_MS = 4000;

export function readPlayStats(): PlayStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PlayStats;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A torn write or a manual edit: start the tally over rather than crash the
    // three windows that hydrate from it.
    return {};
  }
}

/**
 * Count one listen. Returns the new table, or null when the track was already
 * counted inside the dedupe window.
 */
export function writePlayStat(trackId: string, at = Date.now()): PlayStats | null {
  const stats = readPlayStats();
  const prev = stats[trackId];
  if (prev && at - prev.lastPlayed < PLAY_DEDUPE_MS) return null;
  const next: PlayStats = {
    ...stats,
    [trackId]: { count: (prev?.count ?? 0) + 1, lastPlayed: at },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode, quota, or a disk that went away. The tally is not worth
    // losing playback over.
  }
  return next;
}

/**
 * Throw the tally away, in every window at once.
 *
 * `removeItem` is what broadcasts it: a `storage` event with a null value reaches
 * the two renderers that did not make the write, and they re-read the empty key.
 * The window that pressed the button has to be told by hand, because a document
 * never receives its own storage events — which is also why `recordPlay` sets the
 * store directly rather than reading back what it just wrote.
 */
export function clearPlayStats(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // A store that will not accept a write will not accept a delete either. The
    // caller still clears its own copy, so the page goes empty as asked.
  }
}

/**
 * Follow writes made by the *other* windows.
 *
 * `storage` events are delivered to every same-origin document except the one
 * that made the write, which is exactly the set that needs to be told.
 */
export function subscribePlayStats(fn: (stats: PlayStats) => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn(readPlayStats());
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
