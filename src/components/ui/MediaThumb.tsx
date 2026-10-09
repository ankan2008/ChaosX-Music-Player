import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_ALBUM_ART } from '../../assets/assets';
import { isVideoPath } from '../../utils/media';
import { getCachedPoster, loadVideoPoster } from '../../utils/videoPoster';
import { cachedCover, coverFor } from '../../utils/metadata';
import type { Track } from '../../types';

interface MediaThumbProps {
  track: Track | null | undefined;
  className?: string;
  /**
   * Wait for the decode before painting. Right for the library list, where a
   * row that arrives with no artwork reads as a bug; wrong for a panel that is
   * opening, where thirty of them decoded inline is the difference between the
   * panel appearing now and appearing a quarter of a second from now.
   */
  sync?: boolean;
}

/**
 * How far ahead of the viewport a row's cover is read, in CSS pixels.
 *
 * The list mounts rows about two screens before they are looked at, and reading
 * every mounted row would put sixty tag reads on the disk to paint twelve — so the
 * tile asks when it is close instead. Six rows of warning is roughly the distance
 * an unhurried scroll crosses while one tag read and a decode are in flight; wider
 * buys nothing but queue, and narrower shows the default tile as the row arrives.
 */
const WATCH_BAND_PX = 340;

/**
 * Album art when there is any; otherwise a frame pulled from the video file
 * itself, or the cover read from an audio file the store keeps without one.
 * Audio files with no art at all fall back to the default tile.
 *
 * No store row carries the library's artwork, so a cover belongs to the tile that
 * is painted rather than to the record it describes: a row asks for its art when it
 * comes near the screen, and a row nobody has scrolled to has never opened its
 * file. The answer lives in `utils/metadata`'s bounded cache, shared with every
 * other surface that wants the same cover.
 */
const MediaThumb: React.FC<MediaThumbProps> = ({ track, className = '', sync = true }) => {
  const embedded = track?.albumArt ?? null;
  const isVideo = track ? (track.kind ? track.kind === 'video' : isVideoPath(track.path)) : false;
  const [poster, setPoster] = useState<string | null>(null);
  const nodeRef = useRef<HTMLImageElement | null>(null);
  /** Latched once: a row that has been near the screen stays near it, memory-wise. */
  const [nearView, setNearView] = useState(false);

  /*
   * The observer watches the `<img>` itself rather than a wrapper, because the
   * element is the thing that has to be painted and every caller already gives this
   * component its box. It is one-way on purpose: a row that scrolls away and back
   * should not queue its read a second time, and the windowed list unmounts the row
   * — and its `poster` — long before the cache cap has to.
   *
   * `IntersectionObserver` clips through the scroller the rows live in, so a row
   * mounted in the overscan band above or below the visible window is not
   * "intersecting" even though it is in the document.
   */
  useEffect(() => {
    const node = nodeRef.current;
    if (!node || !track || embedded || isVideo) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNearView(true);
      return;
    }
    const io = new IntersectionObserver(
      (crossings) => {
        if (!crossings.some((c) => c.isIntersecting)) return;
        setNearView(true);
        io.disconnect();
      },
      { rootMargin: `${WATCH_BAND_PX}px 0px` },
    );
    io.observe(node);
    return () => io.disconnect();
    // The path, not the row: a cover belongs to the file, and a re-scan handing
    // back the same file must not re-arm a tile that has already been answered.
  }, [track?.path, embedded, isVideo]);

  /*
   * A video row is its own story and it is left exactly as it was: the poster is a
   * frame pulled out of the file rather than a tag, its cache is `videoPoster`'s and
   * not the cover cache, and every mounted row has always asked for one. Holding it
   * to the viewport too is a separate change with a separate risk — a film's tile
   * blanking on a flick — and none of the memory this rewrite is chasing is in it.
   */
  useEffect(() => {
    if (!track || !isVideo || embedded) return;
    const cached = getCachedPoster(track.path);
    if (cached) {
      setPoster(cached);
      return;
    }
    setPoster(null);
    let alive = true;
    void loadVideoPoster(track.path).then((url) => {
      if (alive && url) setPoster(url);
    });
    return () => {
      alive = false;
    };
  }, [track?.id, track?.path, isVideo, embedded]);

  /*
   * An audio row with no embedded cover is a row the store stripped: neither window
   * is handed the 22 MB of base64, and the tiles that are looked at ask for their
   * art. `cachedCover` distinguishes "this file has no picture" from "nobody has
   * looked yet", so a row that has already been answered repaints instantly
   * instead of flashing the default tile.
   */
  useEffect(() => {
    if (!track || isVideo || embedded) return;
    /*
     * The cache is consulted before the state is cleared. Nulling first and
     * looking afterwards put one frame of the default tile on screen every time a
     * row remounted, which over a scrolled list is indistinguishable from the
     * artwork having disappeared.
     */
    const known = cachedCover(track.path);
    if (known !== undefined) {
      setPoster(known);
      return;
    }
    setPoster(null);
    // Nobody has asked, and nobody is looking yet either.
    if (!nearView) return;
    let alive = true;
    void coverFor(track.path).then((url) => {
      if (alive) setPoster(url);
    });
    return () => {
      alive = false;
    };
  }, [track?.id, track?.path, isVideo, embedded, nearView]);

  /*
   * `decoding="sync"` is the difference between a thumbnail that is there and
   * one that arrives. Left on the default `auto`, Chromium is free to paint the
   * element empty and fill it on a later frame, which over a windowed list reads
   * as the artwork vanishing on a fast scroll and coming back — even though the
   * bytes are already decoded in memory. These tiles are 36px; waiting for one is
   * not a frame budget anyone notices.
   */
  return (
    <img
      ref={nodeRef}
      src={embedded || poster || DEFAULT_ALBUM_ART}
      alt=""
      className={className}
      decoding={sync ? 'sync' : 'async'}
      loading="eager"
    />
  );
};

export default MediaThumb;
