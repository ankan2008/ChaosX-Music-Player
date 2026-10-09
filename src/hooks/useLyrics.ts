import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { LyricLine } from '../types';
import { usePlayerStore } from '../stores/playerStore';

interface UseLyricsResult {
  lyrics: LyricLine[];
  activeLineIndex: number;
  currentLyricLine: LyricLine | null;
  formattedTime: (seconds: number) => string;
  scrollToLine: (index: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** The travelling glass sheet that marks the line being sung. */
  sheetRef: React.RefObject<HTMLDivElement | null>;
  hasLyrics: boolean;
}

/** A jump this large is a reposition, not a line change, so do not animate it. */
const BIG_JUMP_LINES = 3;

/**
 * Extra height given to the highlighter, per edge. The row's own box is exactly
 * the text, so a sheet welded to it reads as a bar the words are crammed into;
 * this is the air that makes it read as a sheet the words are sitting on.
 */
const SHEET_PAD_Y = 6;

/** How long the sheet keeps re-measuring the row, in ms — see `placeSheet`. */
const SHEET_SETTLE_MS = 460;

/**
 * @param flat
 *   Read-all mode, from the lyrics card's own switch. No line is the current one,
 *   so nothing tracks the playhead: the sheet is hidden, the scroll is left alone,
 *   and the panel stops moving under the reader. This exists for the case the
 *   timings do not cover — a sheet that is wrong for this recording, where the
 *   highlight is not guidance but a lie told once a line.
 */
export function useLyrics(
  lyrics: LyricLine[] | null | undefined,
  isPlaying: boolean,
  currentTime: number,
  flat = false,
): UseLyricsResult {
  const [activeLineIndex, setActiveLineIndex] = useState(-1);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const lastIndexRef = useRef(-1);
  /**
   * Whether the panel has been positioned once for this lyric set. Lyrics
   * typically arrive a couple of seconds into a track from LRCLIB, and without
   * this the first scroll is treated like any other and animates from the top,
   * so the panel visibly crawls up through every line to catch the song.
   */
  const placedRef = useRef(false);

  /*
   * The lines are found by class rather than as `container.children`, because
   * the glass sheet is also a child of the scroller — it has to be, so that it
   * scrolls with the text instead of being re-derived from the scroll offset on
   * every frame.
   */
  const lineAt = useCallback((container: HTMLDivElement, index: number) => {
    const nodes = container.querySelectorAll<HTMLElement>('.lyric-line');
    return index >= 0 && index < nodes.length ? nodes[index] : null;
  }, []);

  /** Re-measurement chase for the row's own grow transition. */
  const chaseRef = useRef(0);
  const targetRef = useRef<HTMLElement | null>(null);
  const stopChase = useCallback(() => {
    if (chaseRef.current) cancelAnimationFrame(chaseRef.current);
    chaseRef.current = 0;
  }, []);

  const writeSheet = useCallback((line: HTMLElement) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    /*
     * Grown by the same amount above and below the row rather than made taller
     * from its top edge, which is what keeps the words on the sheet's own centre
     * line instead of drifting into its upper half.
     */
    sheet.style.visibility = 'visible';
    sheet.style.height = `${line.offsetHeight + SHEET_PAD_Y * 2}px`;
    sheet.style.top = `${line.offsetTop - SHEET_PAD_Y}px`;
  }, []);

  /**
   * Weld the sheet to a row, then keep it welded while the text reflows.
   *
   * The sheet sits in content space inside the scroller, so once placed it
   * travels with the text for free and only has to be moved when the active line
   * itself changes.
   *
   * The chase is the fix for the drift that used to show up as the highlighter
   * landing, then sliding off the words. Every line's `font-size` is transitioned
   * over 0.35s when its distance from the active line changes, so the rows above
   * the one being sung are growing or shrinking throughout that window — which
   * moves the active row's own `offsetTop` under the sheet. A single placement
   * measures the layout the row is leaving, and the one follow-up 400ms later
   * lands it with a visible snap. Re-measuring every other frame for the length
   * of the transition tracks the reflow instead of sampling it, and every other
   * frame is what keeps a `data-glass` surface from re-compositing at full rate
   * for a quarter of a second on a machine with integrated graphics.
   */
  const placeSheet = useCallback(
    (line: HTMLElement | null) => {
      if (!line || !line.isConnected) {
        const sheet = sheetRef.current;
        if (sheet) sheet.style.visibility = 'hidden';
        targetRef.current = null;
        stopChase();
        return;
      }
      targetRef.current = line;
      writeSheet(line);
      if (chaseRef.current) return;
      const t0 = performance.now();
      let tick = 0;
      const step = (now: number) => {
        const el = targetRef.current;
        if (!el || !el.isConnected || now - t0 > SHEET_SETTLE_MS) {
          chaseRef.current = 0;
          return;
        }
        if (++tick % 2 === 0) writeSheet(el);
        chaseRef.current = requestAnimationFrame(step);
      };
      chaseRef.current = requestAnimationFrame(step);
    },
    [stopChase, writeSheet],
  );

  useEffect(() => stopChase, [stopChase]);

  // Filter out empty lines. Memoised because the effect below keys off it: a
  // fresh array identity on every render made the dependency list meaningless
  // and re-ran the scroll logic on unrelated re-renders.
  const cleanLyrics = useMemo(
    () => (lyrics ?? []).filter((line) => line.text.trim().length > 0),
    [lyrics],
  );

  // Subscribed, not read from getState(), so moving the timing slider re-runs the
  // active-line pass on the same frame instead of waiting for the next tick.
  const lyricsOffsetMs = usePlayerStore((s) => s.lyricsOffsetMs);

  const hasLyrics = cleanLyrics.length > 0;

  // A new lyric set (different track, or a late fetch landing) has to be
  // re-placed from scratch.
  useEffect(() => {
    placedRef.current = false;
  }, [cleanLyrics]);

  // Find active line based on current time.
  useEffect(() => {
    if (flat) {
      /*
       * Release the sheet and the scroll, and stop chasing a re-measure that a
       * line change would otherwise keep running for half a second after the
       * switch was thrown.
       */
      stopChase();
      placeSheet(null);
      setActiveLineIndex(-1);
      lastIndexRef.current = -1;
      placedRef.current = false;
      return;
    }
    if (!hasLyrics) {
      setActiveLineIndex(-1);
      lastIndexRef.current = -1;
      return;
    }

    /*
     * The manual timing shift is applied here rather than written into `time_ms`.
     *
     * The cue list a window is showing may have been fetched by another window and
     * sent over the wire, or restored from the lyrics cache, so mutating it would
     * compound the offset every time the track came round — and a per-track edit
     * would also survive into Save, which is meant to write what LRCLIB returned.
     */
    const offsetS = lyricsOffsetMs / 1000;
    let activeIdx = 0;
    for (let i = cleanLyrics.length - 1; i >= 0; i--) {
      if (currentTime - offsetS >= cleanLyrics[i].time_ms / 1000) {
        activeIdx = i;
        break;
      }
    }

    setActiveLineIndex(activeIdx);

    /*
     * Position on time, not only while playing. The old guard bailed out
     * whenever the track was paused, so pausing partway through blanked the
     * panel to "no line" and resuming had to wait for the next line boundary to
     * show anything at all.
     */
    if (!scrollContainerRef.current) return;
    const jumped = Math.abs(activeIdx - lastIndexRef.current);
    if (activeIdx === lastIndexRef.current && placedRef.current) return;

    const container = scrollContainerRef.current;
    const activeElement = lineAt(container, activeIdx);
    if (!activeElement) return;

    lastIndexRef.current = activeIdx;
    const first = !placedRef.current;
    /*
     * Centre the line being sung. The old factor parked it at 40% of the panel,
     * and the click-a-line path scrolled it flush to the top edge, so the same
     * line sat in two different places depending on how you got there.
     */
    const targetScroll =
      activeElement.offsetTop - (container.clientHeight - activeElement.offsetHeight) / 2;
    placedRef.current = true;
    placeSheet(activeElement);

    container.scrollTo({
      top: targetScroll,
      // Instant for the first placement and for any large reposition (a seek, a
      // track change, a late lyrics fetch); smooth only for the ordinary
      // line-to-line advance where the motion is the point.
      behavior: first || jumped > BIG_JUMP_LINES ? 'auto' : 'smooth',
    });
  }, [currentTime, hasLyrics, cleanLyrics, lyricsOffsetMs, lineAt, placeSheet, flat, stopChase]);

  const currentLyricLine =
    hasLyrics && activeLineIndex >= 0 ? cleanLyrics[activeLineIndex] : null;

  const formattedTime = useCallback((seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }, []);

  const scrollToLine = useCallback((index: number) => {
    const container = scrollContainerRef.current;
    const element = container ? lineAt(container, index) : null;
    if (!container || !element) return;
    /*
     * The same centring as the automatic path. This used to scroll the line to
     * `offsetTop` with no offset at all, which is why clicking a lyric put the
     * highlight at the very top of the panel.
     */
    container.scrollTo({
      top: element.offsetTop - (container.clientHeight - element.offsetHeight) / 2,
      behavior: 'smooth',
    });
    placeSheet(element);
  }, [lineAt, placeSheet]);

  return {
    lyrics: cleanLyrics,
    activeLineIndex,
    currentLyricLine,
    formattedTime,
    scrollToLine,
    scrollContainerRef,
    sheetRef,
    hasLyrics,
  };
}