import type { LyricLine, Track } from '../types';
import { looksLikeLrc, parseLrc } from './parseLrc';
import { durationRatio, lookupNames, rescaleLines, titleSimilarity } from './lyricMatch';

/**
 * Lyrics from LRCLIB, plus the user's own imports and search overrides.
 *
 * Everything is keyed by the track's *path*, not its id: the id is derived
 * during the scan, so a rescan can hand the same file a new one, and an import
 * that vanished on the next startup would be worse than never offering one.
 *
 * The store already renders `lyrics` (synced, highlighted, auto-scrolled) and
 * `plainLyrics` (static text), so this module's whole job is to fill those two
 * fields in. Nothing downstream changes.
 */

const STORE_KEY = 'silent-chaos-lyrics';
const API = 'https://lrclib.net/api';
/** Don't re-query a track nobody has matched for a day. */
const MISS_RETRY_MS = 24 * 60 * 60 * 1000;

export interface Entry {
  synced: string | null;
  plain: string | null;
  source: 'lrclib' | 'import';
  /** Tempo correction baked into `synced`, when the file is a variant. */
  ratio?: number;
}

interface LyricsRecord {
  entry?: Entry;
  /** When a lookup last came back empty, so a genuinely unmatchable file is
   *  not re-queried on every single play. */
  missAt?: number;
  /**
   * The user asked for this song's words to be put away.
   *
   * A separate flag rather than a deletion, because the two mean different
   * things: deleting throws the answer away and the next lookup has to find it
   * again on LRCLIB's servers, whereas hiding keeps the answer and stops showing
   * it. The distinction is what makes Refresh a restore rather than a re-roll —
   * a song whose timing you were happy with should come back identical, not
   * whatever the best match happens to be next week.
   */
  hidden?: boolean;
}

type Store = Record<string, LyricsRecord>;

let cache: Store | null = null;

function read(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Store;
  } catch {
    cache = {};
  }
  return cache;
}

/*
 * Every window is a separate document over the same origin, so each has its own
 * `cache` and its own lookups — and a match the library window found after this
 * window booted would be invisible to it forever. `storage` fires only in the
 * other documents, which is precisely the one place it is needed: drop the memo
 * and the next read sees what a sibling wrote.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY || e.key === null) cache = null;
  });
}

function write(next: Store): void {
  cache = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    // Quota or a disabled store: the session still works from memory.
  }
}

function patch(path: string, part: Partial<LyricsRecord>): void {
  write({ ...read(), [path]: { ...read()[path], ...part } });
}

export function storedLyrics(track: Track): Entry | null {
  return read()[track.path]?.entry ?? null;
}

export function hasManualImport(track: Track): boolean {
  return read()[track.path]?.entry?.source === 'import';
}

/**
 * Forget everything about a track's lyrics: the resolved entry, the cooldown, and
 * any search terms. Called when the sidecar is deleted, so a file the user just
 * removed does not reappear from memory on the next play.
 */
export function clearStoredLyrics(track: Track): void {
  const next = { ...read() };
  delete next[track.path];
  write(next);
}

/**
 * Forget what LRCLIB said about a track so it can be asked again.
 *
 * Clears the miss cooldown and any answer that came from the service, but never
 * an import: a `.lrc` the user supplied by hand is theirs, and pressing "search
 * again" must not throw it away. The sidecar beside the file is untouched for the
 * same reason — it is on disk, not in this store.
 */
export function forgetRemoteLyrics(track: Track): void {
  const store = read();
  const rec = store[track.path];
  if (!rec) return;
  if (rec.entry?.source === 'import') {
    rec.missAt = undefined;
  } else {
    delete store[track.path];
  }
  write(store);
}

/** True when a recent lookup already failed and we are still inside the window. */
export function lookupIsCoolingDown(track: Track): boolean {
  const at = read()[track.path]?.missAt;
  return !!at && Date.now() - at < MISS_RETRY_MS;
}

/**
 * Whether the user has put this song's lyrics away.
 *
 * Keyed by path like everything else here, so it belongs to the file rather than
 * to the scan: a rescan that hands the same song a new id leaves it hidden,
 * which is the point — the user made the decision about the song, not about a
 * row in a table.
 */
export function areLyricsHidden(track: Track): boolean {
  return !!read()[track.path]?.hidden;
}

/**
 * Stop showing this song's lyrics, and remember that across plays.
 *
 * Only this track's record is touched, so hiding one song's words leaves every
 * other song exactly as it was. The `.lrc` beside the file is not deleted and
 * the embedded block is not stripped from the file — this is a display decision
 * about the card, not an edit to the user's library on disk.
 */
export function hideLyrics(track: Track): void {
  patch(track.path, { hidden: true });
}

/**
 * Undo a hide.
 *
 * Returns whether anything was actually hidden, so the caller can tell a restore
 * apart from a plain re-search and say the right word about it.
 */
export function unhideLyrics(track: Track): boolean {
  const store = read();
  const rec = store[track.path];
  if (!rec?.hidden) return false;
  patch(track.path, { hidden: false });
  return true;
}

function markMiss(track: Track): void {
  patch(track.path, { missAt: Date.now() });
}

/**
 * The `.lrc` sitting beside the song, read straight off the disk.
 *
 * The scanner already does this, but only at scan time — so a lyrics file the
 * user drops into the folder while the app is running, or one this very session
 * wrote with the download button, is invisible until a rescan. Reading it here
 * closes that loop, and it is what makes the offline case work: with no network
 * the sidecar is the only lyrics there are.
 */
export async function readSidecar(track: Track): Promise<Entry | null> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (!api?.readFile) return null;
  const lrcPath = track.path.replace(/\.[^.]+$/, '.lrc');
  try {
    if (!(await api.pathExists(lrcPath))) return null;
    const content = await api.readFile(lrcPath);
    const trimmed = content.trim();
    if (!trimmed) return null;
    return looksLikeLrc(trimmed)
      ? { synced: trimmed, plain: null, source: 'import' }
      : { synced: null, plain: trimmed, source: 'import' };
  } catch {
    // Unreadable or vanished between the two calls: treat it as no sidecar.
    return null;
  }
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Render lyrics back to LRC text for the file on disk.
 *
 * Timestamps are written `[mm:ss.xx]`, the hundredths form every player reads.
 * Consecutive lines sharing a timestamp are not merged — the parsed array is
 * already one entry per tag, so a round trip through `parseLrc` returns exactly
 * what was written.
 */
export function toLrcText(lines: LyricLine[] | null, plain: string | null, track: Track): string {
  const head = [
    `[ti:${track.name}]`,
    track.artist && track.artist !== 'Unknown Artist' ? `[ar:${track.artist}]` : '',
    track.album && track.album !== 'Unknown Album' ? `[al:${track.album}]` : '',
    '[re:ChaosX]',
  ].filter(Boolean);

  if (lines?.length) {
    const body = lines.map((l) => {
      const ms = Math.max(0, l.time_ms);
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.floor((ms % 60000) / 1000);
      const hundredths = Math.floor((ms % 1000) / 10);
      return `[${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(hundredths, 2)}]${l.text}`;
    });
    return `${head.join('\n')}\n${body.join('\n')}\n`;
  }
  return `${head.join('\n')}\n${(plain ?? '').trim()}\n`;
}

/**
 * Fetch one LRCLIB endpoint.
 *
 * Resolves `null` for a 404, which is the service answering "there is no such
 * record", and throws for anything else — a 5xx, a refused connection, an abort.
 * The distinction is the whole point: the caller has to know whether it was told
 * there are no lyrics, or whether it never got to ask.
 */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { mode: 'cors', signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`lrclib ${res.status}`);
  return res.json();
}

interface ApiResult {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  duration?: number;
  artistName?: string;
  trackName?: string;
}

function usable(r: ApiResult | null): boolean {
  return !!(r && (r.syncedLyrics || r.plainLyrics));
}

/**
 * Resolve the names to query with: the filename, cleaned.
 */
function termsFor(track: Track): { artist: string; title: string } {
  const n = lookupNames(track.name, track.artist, undefined);
  return { artist: n.artist, title: n.title };
}

/**
 * Exact lookup first — `/api/get` needs all four fields and returns the single
 * best match. Search is the fallback and is fuzzy, so candidates are ranked by
 * how many real words the titles share, with duration as the tie-breaker: a
 * 3:14 studio cut and a 12:40 live version can share a title, and a nightcore
 * rip is a few seconds shorter than the original it matches.
 */
export async function fetchFromLrclib(track: Track, signal?: AbortSignal): Promise<Entry | null> {
  const { artist, title } = termsFor(track);
  const local = Math.round(track.duration || 0);

  // A manual import outranks anything found online, by definition.
  const existing = read()[track.path]?.entry;
  if (existing?.source === 'import') return existing;

  let hit: ApiResult | null = null;
  /*
   * True only when LRCLIB actually replied. Without this the two `catch` blocks
   * below collapsed "the service said no" and "the request never landed" into the
   * same outcome, and both called `markMiss` — a 24-hour lockout. Skipping past a
   * song aborts its in-flight lookup, so every fast skip used to blacklist the
   * track it left, and a moment offline at startup blacklisted whatever was
   * loading then. That is the whole of "these songs had lyrics yesterday".
   */
  let answered = false;

  if (artist && title && local) {
    const params = new URLSearchParams({
      artist_name: artist,
      track_name: title,
      album_name: track.album || '',
      duration: String(local),
    });
    try {
      const exact = (await getJson(`${API}/get?${params}`, signal)) as ApiResult | null;
      answered = true;
      if (exact && usable(exact)) hit = exact;
    } catch {
      // Never got an answer; the search below may still, and if neither does the
      // track is left eligible to ask again rather than cooled down.
    }
  }

  if (!hit && title) {
    const search = new URLSearchParams(
      artist ? { artist_name: artist, track_name: title } : { q: title },
    );
    try {
      const rows = (await getJson(`${API}/search?${search}`, signal)) as ApiResult[] | null;
      answered = true;
      if (Array.isArray(rows) && rows.length) {
        let best: ApiResult | null = null;
        let bestScore = -1;
        for (const row of rows) {
          if (!usable(row)) continue;
          const sim = titleSimilarity(title, row.trackName || '');
          const dPenalty = local && row.duration ? Math.min(1, Math.abs(row.duration - local) / 60) : 0;
          const score = sim * 2 - dPenalty;
          if (score > bestScore) {
            bestScore = score;
            best = row;
          }
        }
        // Below this the "match" is a different song that shares a word.
        if (best && bestScore > 0.35) hit = best;
      }
    } catch {
      // Offline or blocked — the caller keeps whatever embedded lyrics exist.
    }
  }

  if (!hit) {
    if (answered && !signal?.aborted) markMiss(track);
    return null;
  }

  const entry: Entry = {
    synced: hit.syncedLyrics || null,
    plain: hit.plainLyrics || null,
    source: 'lrclib',
    ratio: durationRatio(local, hit.duration || local),
  };
  patch(track.path, { entry, missAt: undefined });
  return entry;
}

/**
 * A `.lrc` or `.txt` the user supplied by hand. Anything that looks like LRC is
 * stored synced; the rest is plain text — exactly how the sidecar loader
 * behaves, so an import and a real `.lrc` beside the file can never disagree
 * about what they mean. An import also clears any cooldown, because the user
 * just told us the lookup was wrong.
 */
export function importLyrics(track: Track, content: string): Entry {
  const trimmed = content.trim();
  const entry: Entry = looksLikeLrc(trimmed)
    ? { synced: trimmed, plain: null, source: 'import' }
    : { synced: null, plain: trimmed, source: 'import' };
  patch(track.path, { entry, missAt: undefined });
  return entry;
}

/**
 * Split an entry into the two shapes the store renders. The tempo ratio is
 * applied here rather than at fetch time so a manual import — which is already
 * timed to *this* file — is never rescaled.
 */
export function toTrackFields(entry: Entry): {
  lyrics: LyricLine[] | null;
  plainLyrics: string | null;
  /** True when the synced lines were stretched to fit a sped-up or slowed file. */
  rescaled: boolean;
} {
  if (!entry.synced) return { lyrics: null, plainLyrics: entry.plain, rescaled: false };
  const parsed = parseLrc(entry.synced);
  const ratio = entry.source === 'import' ? 1 : entry.ratio ?? 1;
  const out = rescaleLines(parsed, ratio);
  return { lyrics: out, plainLyrics: null, rescaled: out !== parsed };
}
