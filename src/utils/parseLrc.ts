import type { LyricLine } from '../types';

const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG_RE = /^\[(ti|ar|al|by|re|ve|au|length|au):/i;
const OFFSET_TAG_RE = /^\[offset:\s*([+-]?\d+)\s*\]/i;
const ENHANCED_WORD_RE = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function timeTagToMs(minutes: string, seconds: string, fraction: string | undefined): number {
  let ms = parseInt(minutes, 10) * 60000 + parseInt(seconds, 10) * 1000;
  if (fraction) {
    // [mm:ss.x] = tenths, [mm:ss.xx] = hundredths, [mm:ss.xxx] = milliseconds
    if (fraction.length === 1) ms += parseInt(fraction, 10) * 100;
    else if (fraction.length === 2) ms += parseInt(fraction, 10) * 10;
    else ms += parseInt(fraction.padEnd(3, '0').slice(0, 3), 10);
  }
  return ms;
}

/**
 * Parse LRC synced-lyrics text.
 * Handles multiple timestamps per line, [offset:±ms] shifts,
 * metadata tags, and strips enhanced-LRC word timing tags.
 */
export function parseLrc(content: string): LyricLine[] {
  if (!content) return [];

  let offset = 0;
  const lines: LyricLine[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const offsetMatch = line.match(OFFSET_TAG_RE);
    if (offsetMatch) {
      offset = parseInt(offsetMatch[1], 10);
      continue;
    }

    if (META_TAG_RE.test(line)) continue;

    const timeTags = [...line.matchAll(TIME_TAG_RE)];
    if (timeTags.length === 0) continue;

    const text = line
      .replace(TIME_TAG_RE, '')
      .replace(ENHANCED_WORD_RE, '')
      .trim();

    for (const tag of timeTags) {
      const ms = timeTagToMs(tag[1], tag[2], tag[3]) + offset;
      lines.push({ time_ms: Math.max(0, ms), text });
    }
  }

  lines.sort((a, b) => a.time_ms - b.time_ms);
  return lines;
}

/** Detect whether a text blob looks like LRC (contains [mm:ss] tags) */
export function looksLikeLrc(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}/.test(text);
}
