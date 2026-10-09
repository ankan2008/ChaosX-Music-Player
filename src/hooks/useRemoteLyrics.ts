import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import {
  areLyricsHidden,
  clearStoredLyrics,
  fetchFromLrclib,
  forgetRemoteLyrics,
  hideLyrics,
  importLyrics,
  lookupIsCoolingDown,
  readSidecar,
  storedLyrics,
  toLrcText,
  toTrackFields,
  unhideLyrics,
} from '../utils/lrclib';
import type { LyricLine, Track } from '../types';

/**
 * `hidden` is the user's own doing rather than an absence of data: the song has
 * lyrics, and they have been put away until Refresh is pressed.
 */
export type LyricsState = 'none' | 'embedded' | 'searching' | 'found' | 'missing' | 'hidden';

/**
 * Fills the lyrics card from LRCLIB when a track carries nothing embedded, and
 * accepts a manual `.lrc` / `.txt` import.
 *
 * Only runs for tracks with no embedded lyrics at all — a file that already
 * ships an `.lrc` sidecar or a USLT/SYLT block is authoritative, and silently
 * overwriting the user's own timing with a crowd-sourced one would be worse
 * than showing nothing.
 */
/**
 * Whether a lyric array already says exactly what we are about to write.
 *
 * Cheap on purpose — length plus the first and last line — because it runs on
 * every match attempt against lists that can be hundreds of lines long. Two
 * parses of the same LRC text always agree, which is the case that matters.
 */
function sameLyrics(a: LyricLine[] | null | undefined, b: LyricLine[] | null | undefined): boolean {
  if ((a?.length ?? 0) === 0 && (b?.length ?? 0) === 0) return true;
  if (!a || !b || a.length !== b.length) return false;
  const headEq = a[0].time_ms === b[0].time_ms && a[0].text === b[0].text;
  const tailA = a[a.length - 1];
  const tailB = b[b.length - 1];
  return headEq && tailA.time_ms === tailB.time_ms && tailA.text === tailB.text;
}

export function useRemoteLyrics(): {
  state: LyricsState;
  source: 'lrclib' | 'import' | null;
  rescaled: boolean;
  importFromFile: () => void;
  acceptDrop: (files: FileList | null) => void;
  downloadToFile: () => Promise<string | null>;
  deleteFile: () => Promise<string | null>;
  /** Drop any cached answer and query LRCLIB again for this exact track. */
  refresh: () => void;
  /**
   * Put this track's lyrics away until the next refresh. Affects this file only.
   *
   * Returns false when there was nothing to hide, so the card can say so rather
   * than reporting success for a no-op.
   */
  hide: () => boolean;
} {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const updateTrack = usePlayerStore((s) => s.updateTrack);
  const [state, setState] = useState<LyricsState>('none');
  const [source, setSource] = useState<'lrclib' | 'import' | null>(null);
  const [rescaled, setRescaled] = useState(false);
  // The request belongs to the track it was made for: a fast skip must not let
  // a late answer land on whatever is playing now.
  const ownerRef = useRef<string | null>(null);
  const trackRef = useRef<Track | null>(null);
  trackRef.current = currentTrack;
  /** Bumped by `refresh` so the lookup re-runs for the track already loaded. */
  const [nonce, setNonce] = useState(0);
  /** Set by `refresh`; the effect reads it once, on the run it triggered. */
  const forceRef = useRef(false);

  const apply = useCallback(
    (
      track: Track,
      entry: { synced: string | null; plain: string | null; source: 'lrclib' | 'import'; ratio?: number },
    ) => {
      const fields = toTrackFields(entry);
      if (!fields.lyrics && !fields.plainLyrics) return false;
      /*
       * Idempotent on purpose, and by content rather than by reference.
       * `toTrackFields` parses the LRC text into a brand-new array on every call,
       * so `track.lyrics === fields.lyrics` is never true and this write always
       * produced a fresh track object. The effect below keys on the track, so the
       * write re-triggered the effect, which wrote again: React stopped the cycle
       * with "Maximum update depth exceeded" and the renderer wedged solid about
       * two seconds after any track loaded.
       */
      if (sameLyrics(track.lyrics, fields.lyrics) && (track.plainLyrics ?? null) === (fields.plainLyrics ?? null)) {
        return false;
      }
      updateTrack({ id: track.id, lyrics: fields.lyrics, plainLyrics: fields.plainLyrics });
      setRescaled(fields.rescaled);
      return true;
    },
    [updateTrack],
  );

  useEffect(() => {
    if (!currentTrack) {
      setState('none');
      setSource(null);
      setRescaled(false);
      return;
    }
    /*
     * The user put this song's words away, so nothing is looked up and nothing is
     * shown — including the lyrics the scan already wrote onto the track object.
     *
     * The write is guarded on the track actually carrying something. Without the
     * guard this clears the fields, the effect re-runs because its key includes
     * the lyric length, it clears them again, and React kills the renderer with
     * "Maximum update depth exceeded" — the same trap `apply` documents below.
     */
    if (areLyricsHidden(currentTrack)) {
      forceRef.current = false;
      if (currentTrack.lyrics?.length || currentTrack.plainLyrics) {
        updateTrack({ id: currentTrack.id, lyrics: null, plainLyrics: null });
      }
      ownerRef.current = null;
      setState('hidden');
      setSource(null);
      setRescaled(false);
      return;
    }
    /*
     * A refresh is allowed past the "this file already has lyrics" short-circuit,
     * because that guard is exactly what would otherwise make the button do
     * nothing: the previous answer is sitting on the track object by the time the
     * user asks for a better one.
     */
    const forced = forceRef.current;
    forceRef.current = false;
    if (!forced && (currentTrack.lyrics?.length || currentTrack.plainLyrics)) {
      ownerRef.current = null;
      setState('embedded');
      // A track we filled in earlier still has its lyrics on the shelf, so the
      // credit has to survive the re-render that applying them causes —
      // otherwise everything reads as "embedded".
      const prior = storedLyrics(currentTrack);
      setSource(prior ? prior.source : null);
      setRescaled(false);
      return;
    }
    /*
     * The file beside the song is checked before anything else, and before the
     * cooldown in particular.
     *
     * `lookupIsCoolingDown` rate-limits *asking LRCLIB*, because a file nobody has
     * ever matched is not worth re-querying every play. A sidecar is not a query —
     * it is sitting on the disk right now — and the previous order consulted the
     * cooldown first, so a track that had once come back empty ignored the `.lrc`
     * the user saved beside it for a full day. That read as "Save worked, then
     * nothing happened".
     */
    const ac = new AbortController();
    ownerRef.current = currentTrack.id;
    const id = currentTrack.id;
    setState('searching');
    setSource(null);

    void readSidecar(currentTrack)
      .then((local) => {
        if (ownerRef.current !== id) return;
        if (local) {
          setState(apply(currentTrack, local) ? 'found' : 'missing');
          setSource(local.source);
          return;
        }
        const stored = storedLyrics(currentTrack);
        if (!forced && stored) {
          setState(apply(currentTrack, stored) ? 'found' : 'missing');
          setSource(stored.source);
          return;
        }
        if (lookupIsCoolingDown(currentTrack)) {
          setState('missing');
          setSource(null);
          return;
        }
        return fetchFromLrclib(currentTrack, ac.signal).then((entry) => {
          if (ownerRef.current !== id) return;
          if (!entry) {
            setState('missing');
            return;
          }
          setState(apply(currentTrack, entry) ? 'found' : 'missing');
          setSource(entry.source);
        });
      })
      .catch(() => {
        if (ownerRef.current === id) setState('missing');
      });
    return () => ac.abort();
    /*
     * Keyed on the track's identity, never on the object. `apply` writes back onto
     * the track, which replaces the object, so depending on it makes every
     * successful match re-run the effect that produced it.
     *
     * The lyric *length* is in the key on purpose, and it does not loop: `apply`
     * compares what it is about to write and returns false when the track already
     * carries those lines, so a re-run after a sibling window's write settles
     * without touching the store again. Without it, a widget whose own lookup ran
     * before the library found the song keeps showing "No words for this track
     * yet" over a full lyric set.
     */
  }, [currentTrack?.id, currentTrack?.duration, currentTrack?.lyrics?.length, apply, nonce]);

  /**
   * Ask LRCLIB again for the track that is already loaded.
   *
   * Needed because a lookup is cached hard: an empty answer set a 24-hour
   * cooldown, and a good one is kept on the track object, so a song that
   * matched badly — or that got blacklisted by a skip mid-request — had no way
   * back except waiting a day. This drops the record and re-runs the effect.
   *
   * It also lifts a hide, because that is the only way back from the hide
   * button, and a control labelled "search again" that refused to bring the
   * words back would leave hiding a song a permanent act with an invisible undo.
   */
  const refresh = useCallback(() => {
    const track = trackRef.current;
    if (track) {
      unhideLyrics(track);
      forgetRemoteLyrics(track);
    }
    forceRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  /**
   * Put the current song's lyrics away.
   *
   * Answers false when the track has nothing to hide, so the card can say that
   * instead of confirming an action that did nothing — the same reason the save
   * and delete buttons report their paths.
   */
  const hide = useCallback(() => {
    const track = trackRef.current;
    if (!track) return false;
    if (!track.lyrics?.length && !track.plainLyrics && !storedLyrics(track)) return false;
    hideLyrics(track);
    setNonce((n) => n + 1);
    return true;
  }, []);

  const readInto = useCallback(
    async (file: File) => {
      const track = trackRef.current;
      if (!track) return;
      const text = await file.text();
      if (!text.trim()) return;
      const entry = importLyrics(track, text);
      if (apply(track, entry)) {
        setState('found');
        setSource('import');
      }
    },
    [apply],
  );

  const importFromFile = useCallback(() => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = '.lrc,.txt,text/plain';
    el.style.display = 'none';
    el.addEventListener('change', () => {
      const file = el.files?.[0];
      if (file) void readInto(file);
      el.remove();
    });
    document.body.appendChild(el);
    el.click();
  }, [readInto]);

  const acceptDrop = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void readInto(file);
    },
    [readInto],
  );

  /**
   * Write the lyrics currently showing into the song's own folder as `<name>.lrc`.
   *
   * Returns the path written, or null on failure — the caller surfaces which,
   * because a button that silently does nothing on a read-only drive is the worst
   * possible outcome for a save.
   */
  const downloadToFile = useCallback(async (): Promise<string | null> => {
    const track = trackRef.current;
    const api = window.electronAPI;
    if (!track || !api?.saveLyrics) return null;
    const entry = storedLyrics(track);
    const text = toLrcText(
      track.lyrics?.length ? track.lyrics : null,
      entry?.synced ? null : (track.plainLyrics ?? entry?.plain ?? null),
      track,
    );
    if (!text.trim()) return null;
    const res = await api.saveLyrics(track.path, text);
    if (!res.ok) return null;
    // The file on disk is now the authority, so record it as such: an entry that
    // came from LRCLIB but is saved beside the song reads back as the user's own.
    patchStoredImport(track, entry);
    return res.path ?? null;
  }, []);

  /**
   * Remove the sidecar, and forget the lyrics with it.
   *
   * Both halves matter. Deleting the file alone would leave the in-memory and
   * localStorage entry in place, so the card would keep showing words the user
   * just threw away — and on the next play `readSidecar` would find nothing while
   * the stored entry answered for it, which looks exactly like the delete failed.
   */
  const deleteFile = useCallback(async (): Promise<string | null> => {
    const track = trackRef.current;
    const api = window.electronAPI;
    if (!track || !api?.deleteLyrics) return null;
    const res = await api.deleteLyrics(track.path);
    // Nothing is cleared on a failed delete. Wiping the card while the file is
    // still on disk would show the user an empty panel for lyrics they have not
    // removed, and the next play would bring them straight back.
    if (!res.ok) return null;
    clearStoredLyrics(track);
    usePlayerStore.getState().updateTrack({ id: track.id, lyrics: null, plainLyrics: null });
    setState('none');
    setSource(null);
    return res.path ?? null;
  }, []);

  return { state, source, rescaled, importFromFile, acceptDrop, downloadToFile, deleteFile, refresh, hide };
}

/**
 * Re-stamp a resolved entry as the user's own once it is on disk beside the song.
 *
 * The distinction is not cosmetic: `toTrackFields` only tempo-corrects entries
 * that came from LRCLIB, and a saved file is already timed to this exact recording
 * — rescaling it a second time would drift every line.
 */
function patchStoredImport(track: Track, entry: { synced: string | null; plain: string | null } | null): void {
  if (!entry) return;
  importLyrics(track, entry.synced ?? entry.plain ?? '');
}
