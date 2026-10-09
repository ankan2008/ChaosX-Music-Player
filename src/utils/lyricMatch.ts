import type { LyricLine } from '../types';

/**
 * Turning a filename-ish track name into something LRCLIB can actually match.
 *
 * The library's rows carry whatever the tag scanner found, and for a folder of
 * ripped singles that is usually the filename with a serial prefix and a
 * descriptor tail still attached: `3-006 - N - Light em up x Radioactive (Lyrics).mp3`.
 * LRCLIB is keyed on real release metadata, so every one of those decorations
 * has to come off before the lookup, and the artist has to be recovered from
 * the `Artist - Title` shape when the file has no artist tag at all.
 *
 * Deliberately conservative about what it deletes: `(feat. Sean Paul)` is part
 * of the record and is normalised rather than stripped, while `(Official Video)`
 * is noise. Anything not on the noise list survives.
 */

/** Bracketed tails that never belong to the work itself. */
const NOISE_IN_BRACKETS =
  /^(lyrics?|l?yric video|official\s+(video|audio|lyrics?( video)?|mv|visuali[sz]er|clip|trailer|teaser)|audio( only)?|video|mv|hd|fhd|4k|full|complete|remaster(ed)?(\s+\d{4})?|live|explicit|clean|radio\s*edit|club\s*mix|sped\s*up|sl(o)?wed(\s*(down|reverb))?|nightcore|daycore|speed\s*up(\s+version)?| slowed version|visuali[sz]er|on\s*shot|one\s*shot|cover|\d{1,2}:\d{2}(\s*[\u2192-]\s*\d{1,2}:\d{2})?|topic|vevo|with\s+lyrics?( video)?|sub\.?\s*titles?|eng\s*sub)/i;

/** Leading channel or genre stamps that stand in for an artist label. */
const CHANNEL_TAG =
  /^(nightcore|ncs|monstercat|spinnin'?|maddix|nCS|lossless|aleks\s*and\s*om|pro\s*mixer|epic\s*music|lofi|lo-fi|chopnoti[sz]c|hardwell\s*presents|enhko|owsla|hexagon|anjunabeats|recovery|musical\s*freedom)/i;

const FILE_EXT = /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff|webm|mkv|mp4|ts|avi|mov|wma)$/i;

/** Anything in brackets: `(...)`, `[...]`, `{...}`, `<...>`. */
const BRACKETED = /[\[(<{]([^\])>]{0,80})[\])>]/g;

export interface LookupNames {
  artist: string;
  title: string;
  /** True when the artist came from splitting `A - B`, not from a tag. */
  guessedArtist: boolean;
}

/**
 * Strip the decorations a scanner inherits from a filename. Applied to the
 * raw stored name, never to a tag the file actually carries.
 */
export function cleanTitle(raw: string): string {
  let s = (raw || '').replace(FILE_EXT, '').trim();

  // Serial and folder-ordinal prefixes: "001 - ", "3-001 - ", "1-005 - ".
  s = s.replace(/^\d+(?:\s*-\s*\d+)?\s*[-_.]\s+/, '');

  // Remove noise brackets repeatedly, since `X (Lyrics) [Official]` leaves a
  // second tail once the first is gone.
  for (let pass = 0; pass < 3; pass++) {
    const next = s.replace(BRACKETED, (whole, inner: string) =>
      NOISE_IN_BRACKETS.test(inner.trim()) ? ' ' : whole,
    );
    if (next === s) break;
    s = next;
  }

  // A leading channel/genre stamp, or a bare single-letter tag like the
  // "N - " these rips carry, is not part of the title.
  s = s.replace(new RegExp('^' + CHANNEL_TAG.source + '\\s*[-–]\\s*', 'i'), '');
  s = s.replace(/^[A-Z]\s*[-–]\s+/, '');

  // Normalise the featuring forms so "ft." and "feat." query the same way. The
  // trailing `\.?` is consumed deliberately: `\b` stops before the dot, so
  // without it "feat." rewrites to "feat..".
  s = s.replace(/\b(f(e)?aturing|ft\.?|feat\.?)\b\.?/gi, 'feat.').replace(/\s{2,}/g, ' ');

  // Trailing separators only. Brackets are never stripped here: the noise pass
  // above removes a whole `(...)` group including its closer, so any bracket
  // still standing is balanced and belongs to the title — `(feat. Sean Paul)`.
  s = s.replace(/[\s\-–—·]+$/g, '').replace(/^[\s\-–—·]+/g, '').trim();

  return s || (raw || '').trim();
}

/**
 * Produce the artist/title pair to query with. When the file has no artist
 * tag, `Artist - Title` in the cleaned name is the only signal worth using.
 */
export function lookupNames(name: string, artistTag?: string, titleTag?: string): LookupNames {
  const cleaned = cleanTitle(name);
  const hasArtist = !!(artistTag && artistTag.trim() && !/unknown/i.test(artistTag));

  if (hasArtist) {
    return { artist: artistTag!.trim(), title: titleTag?.trim() || cleaned, guessedArtist: false };
  }

  const parts = cleaned.split(/\s+[-–]\s+/);
  if (parts.length >= 2 && parts[0].length > 1 && parts[1].length > 0) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(' - ').trim(),
      guessedArtist: true,
    };
  }
  return { artist: '', title: cleaned, guessedArtist: false };
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'ft', 'feat', 'with', 'official', 'lyrics', 'video']);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/**
 * Jaccard similarity over meaningful words. Used to rank LRCLIB's fuzzy
 * `/api/search` results, which returns whatever the query textually resembles
 * and leaves the caller to decide what is close enough.
 */
export function titleSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Rescale LRC timestamps onto a different tempo.
 *
 * A nightcore or sped-up rip is the same recording at a higher pitch and a
 * shorter duration, so the lyrics are correct and the clock is not. Comparing
 * durations needs no genre detection and covers sped-up and slowed versions
 * with one rule.
 */
export function rescaleLines(lines: LyricLine[], ratio: number): LyricLine[] {
  if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(ratio - 1) <= 0.03) return lines;
  return lines.map((l) => ({ ...l, time_ms: Math.max(0, Math.round(l.time_ms * ratio)) }));
}

/** How far apart two durations are, as a signed ratio. */
export function durationRatio(local: number, remote: number): number {
  if (!local || !remote) return 1;
  return local / remote;
}
