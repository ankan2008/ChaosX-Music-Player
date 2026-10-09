import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track, SortMode } from '../../types';
import { formatTime } from '../../utils/formatTime';
import MediaThumb from '../ui/MediaThumb';
import {
  buildFolderRank,
  orderLibrary,
  trackNumberLabel,
} from '../../utils/sorting';
import { usePlayerStore } from '../../stores/playerStore';
import Icon from '../ui/Icon';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import MorphOptionList from '../ui/MorphOptionList';
import SongContextMenu from './SongContextMenu';
import { cardGlass } from '../../utils/glass';
import { pickAndAddToList, songActions, type ListAccess } from '../../utils/songActions';
import { clamp, clamp01, travelPhase } from '../../utils/travel';

interface SongListProps {
  tracks: Track[];
  query?: string;
  /** Receives the track and the list in the order it is displayed, so the
      queue matches what the user sees rather than raw scan order. */
  onSelect?: (track: Track, list: Track[]) => void;
  className?: string;
  /**
   * What the row menu is allowed to offer.
   *
   * Only the library page has a list that can be edited, so only it passes this;
   * Home's ranked cards and every search result leave it off and get a menu
   * without "Remove", because there is no list to remove them from.
   */
  access?: ListAccess;
}

const SORT_OPTIONS = [
  { value: 'number', label: '# Number' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
  { value: 'album', label: 'Album' },
  { value: 'duration', label: 'Duration' },
  { value: 'dateAdded', label: 'Date Added' },
];

/** Idle and open shapes for the sort panel, in CSS pixels. */
const SORT_IDLE = { width: 110, height: 28, radius: 14 };
const SORT_OPEN = { width: 200, height: 240, radius: 20 };

/** A row glide and a page turn are different events and should feel so. */
const GLIDE_MS = 1000;
const PAGE_MS = 1000;

/**
 * What a list with no editable owner tells the row menu.
 *
 * Home's ranked cards, the search results and any list that never passes `access`
 * land here: no list to remove a row from, no room to add one, and nowhere for a
 * notice to go. A stable object so the menu's rows are not rebuilt on every render
 * for a list that has nothing to rebuild.
 */
const NO_LIST: ListAccess = { list: null, canAdd: false, notify: () => {} };

/**
 * Row pitch and drawn box height in CSS pixels.
 *
 * The list is windowed — only the rows crossing the viewport are mounted — so
 * a row's position is arithmetic (`index × pitch`) rather than whatever the
 * flow happens to give it. That makes these two numbers a contract with the
 * stylesheet, which is why `.song-row` carries an explicit height instead of
 * being sized by its padding and its 36px artwork.
 */
const ROW_H = 54;
const ROW_BOX = 52;
/**
 * Rows kept above and below the window so a fast flick never shows a gap.
 *
 * Six was a flick's worth of scroll at 52px, which a trackpad throw crosses in
 * well under the time it takes a scroll event to arrive, be measured and be
 * committed — so the rows simply were not mounted yet and the list painted
 * blank until they were. Twenty-two is roughly two screens each way: still ~60
 * mounted rows out of 427, so the windowing keeps doing its job, but a gesture
 * has to outrun two screens of buffer before it finds an empty band.
 */
const OVERSCAN = 22;

/*
 * The sheet's phase maths is shared with every other sliding highlighter in the
 * app — see `utils/travel`, which the folder strip and the ranked cards import
 * too, so one object moving between two rows cannot feel different from one
 * moving between two folders.
 */

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-accent-primary">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * One row, memoised.
 *
 * The window slides by three rows when the wheel moves a screen, but the list
 * re-renders all sixty of them, and sixty rows of two text nodes, a thumbnail
 * and a badge each is the 67 ms frame this list used to spend on a scroll that
 * should have cost 18. Memoising the row means only the rows that actually
 * entered or left the window are built.
 */
interface RowProps {
  track: Track;
  index: number;
  isCurrent: boolean;
  isPlaying: boolean;
  query: string;
  folderRank: Map<string, number>;
  list: Track[];
  onSelect?: (track: Track, list: Track[]) => void;
  onMenu: (track: Track, x: number, y: number) => void;
  /** Ticking a row over playing it. */
  selectMode: boolean;
  selected: boolean;
  onToggle: (track: Track, index: number, extend: boolean) => void;
}

const SongRow = React.memo(function SongRow({
  track,
  index,
  isCurrent,
  isPlaying,
  query,
  folderRank,
  list,
  onSelect,
  onMenu,
  selectMode,
  selected,
  onToggle,
}: RowProps) {
  const number = trackNumberLabel(track, folderRank);
  return (
    <div
      data-track-id={track.id}
      className={`sidebar-row song-row ${isCurrent ? 'active' : ''} ${selected ? 'selected' : ''}`}
      style={{ top: index * ROW_H }}
      onClick={(e) => {
        if (selectMode) onToggle(track, index, e.shiftKey);
        else onSelect?.(track, list);
      }}
      onDoubleClick={() => onSelect?.(track, list)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(track, e.clientX, e.clientY);
      }}
    >
      {/*
       * The number column doubles as the tick. A third column would move the
       * artwork sideways the moment select mode came on, and the travelling sheet
       * is welded to a row geometry that has not changed — the highlight would end
       * up beside its own row rather than under it.
       */}
      <div className="song-number flex items-center justify-center flex-shrink-0">
        {selectMode ? (
          <span className={`row-tick ${selected ? 'on' : ''}`} aria-hidden>
            {selected ? <Icon name="check" size={11} /> : null}
          </span>
        ) : isCurrent ? (
          <div className={`eq-bars ${isPlaying ? '' : 'paused'}`} aria-hidden>
            <span /><span /><span />
          </div>
        ) : number ? (
          <span className="font-heading text-xs text-accent-primary">{number}</span>
        ) : (
          <span className="text-xs text-glass-textDim">—</span>
        )}
      </div>

      {/*
       * `sync={false}` is the difference between an 18 ms frame and a 210 ms
       * one. A 900px throw mounts seventeen new rows, and seventeen blocking
       * base64 decodes in one frame is the spike. It used to be worth it
       * because an undecoded tile read as a missing thumbnail — but the row now
       * mounts roughly a thousand pixels before it is on screen, so the decode
       * finishes off-camera and the tile is there when the row arrives anyway.
       */}
      <MediaThumb track={track} sync={false} className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />

      <div className="flex-1 min-w-0">
        <p className="text-sm text-glass-text truncate">
          <Highlighted text={track.name} query={query} />
        </p>
        <p className="text-xs text-glass-textMuted truncate">
          <Highlighted text={track.artist} query={query} />
          {' • '}
          <Highlighted text={track.album} query={query} />
        </p>
      </div>

      <div className="flex items-center gap-2 text-xs flex-shrink-0">
        {track.bitrate > 0 && (
          <span className="glass-badge hidden lg:inline-flex">{track.bitrate}k</span>
        )}
        <span className="text-glass-textDim">{formatTime(track.duration)}</span>
      </div>
    </div>
  );
});

export const SongList: React.FC<SongListProps> = ({
  tracks,
  query = '',
  onSelect,
  className = '',
  access,
}) => {
  const sortRef = useRef<HTMLButtonElement | null>(null);
  const bulkRef = useRef<HTMLDivElement | null>(null);
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const sortMode = usePlayerStore((s) => s.sortMode);
  const sortDesc = usePlayerStore((s) => s.sortDesc);
  const folders = usePlayerStore((s) => s.folders);
  const store = usePlayerStore.getState;
  /*
   * The right-click menu, open at a point.
   *
   * Held in the list rather than per row: one menu on screen at a time, and the
   * row that opened it is virtualised away the moment the list scrolls, which
   * would take the menu with it.
   */
  const [menu, setMenu] = useState<{ tracks: Track[]; x: number; y: number } | null>(null);
  /*
   * Multi-select.
   *
   * A set of ids rather than of tracks, because the rows underneath are rebuilt on
   * every scan, sort and search keystroke — an id survives all three and a captured
   * object does not. The tracks the menu acts on are resolved out of `sortedTracks`
   * at the moment of the click, in list order, so "Play next" files them in the
   * order they are read rather than the order they were ticked.
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** The last row ticked, so shift-click has something to extend from. */
  const lastIndexRef = useRef<number | null>(null);
  /** Mirrors `selected` for the stable `openMenu` below, which cannot close over state. */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /**
   * Stable so the memoised row does not re-render because the menu moved.
   *
   * Right-clicking inside a selection acts on the whole selection — which is what
   * every file manager does, and what makes "remove these nine" one gesture instead
   * of nine. Right-clicking a row that is not part of it re-aims the menu at that
   * row alone, so a tick left over from earlier cannot silently change what the
   * pointer was pointing at.
   */
  const openMenu = useCallback((track: Track, x: number, y: number) => {
    const chosen = selectedRef.current;
    const group = chosen.has(track.id)
      ? (sortedRef.current ?? []).filter((t) => chosen.has(t.id))
      : [track];
    setMenu({ tracks: group.length ? group : [track], x, y });
  }, []);
  const listRef = useRef<HTMLDivElement | null>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  /**
   * Where the sheet sits in content coordinates — the row top it is welded to.
   * Every position the sheet ever takes is derived from this and the scroller's
   * real offset, so the highlighter can never disagree with its own row.
   */
  const anchorRef = useRef<number | null>(null);

  /* Ranks come from the pinned folders first, then from any folder still
     carrying tracks, so no two folders can ever share a leading number. */
  const folderRank = useMemo(() => buildFolderRank(folders, tracks), [folders, tracks]);

  const sortedTracks = useMemo(
    () => orderLibrary(tracks, sortMode, folderRank, sortDesc),
    [tracks, sortMode, sortDesc, folderRank],
  );
  /** The same array, reachable from the stable `openMenu` above. */
  const sortedRef = useRef(sortedTracks);
  sortedRef.current = sortedTracks;

  /**
   * Tick, untick, or extend the run to here.
   *
   * Shift extends from the last row touched rather than from the top of the
   * selection, because the gesture people reach for is "from that one to this one"
   * — and a range from the first tick would re-select the whole list the moment the
   * second row is shift-clicked.
   */
  const toggleRow = useCallback(
    (track: Track, index: number, extend: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (extend && lastIndexRef.current !== null) {
          const from = Math.min(lastIndexRef.current, index);
          const to = Math.max(lastIndexRef.current, index);
          for (let i = from; i <= to; i++) {
            const t = sortedRef.current[i];
            if (t) next.add(t.id);
          }
        } else if (next.has(track.id)) {
          next.delete(track.id);
        } else {
          next.add(track.id);
        }
        lastIndexRef.current = index;
        return next;
      });
    },
    [],
  );

  const leaveSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
    lastIndexRef.current = null;
    setMenu(null);
  };

  const selectAll = () => {
    setSelected(new Set(sortedTracks.map((t) => t.id)));
    lastIndexRef.current = null;
  };

  /*
   * The ticked rows, in the order they are on screen rather than the order they
   * were ticked — which is what makes "Play next" file a run of songs the way they
   * read down the list.
   *
   * Resolving ids against `sortedTracks` is also what prunes them: after a
   * "Remove from this list" the rows are gone from the array, so the count in the
   * strip falls to zero on the same render without a second cleanup pass, and a
   * stale id can never be acted on twice.
   */
  const selectedTracks = useMemo(
    () => (selected.size === 0 ? [] : sortedTracks.filter((t) => selected.has(t.id))),
    [sortedTracks, selected],
  );

  /*
   * Windowed rendering. The library is 427 tracks and every row carries its
   * cover art as a base64 string averaging 150 KB, so mounting them all put
   * roughly 65 MB of image sources and 4,000 nodes in the document for as long
   * as the library was open — a scroll, a search keystroke, a glass recomposite
   * and a mode switch all paid for that, and it is why a large folder felt
   * sluggish where a small one did not. Only the rows in view are mounted.
   */
  const [window_, setWindow] = useState({ start: 0, end: OVERSCAN * 2 + 4 });
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const start = Math.max(0, Math.floor(list.scrollTop / ROW_H) - OVERSCAN);
    const end = start + Math.ceil(list.clientHeight / ROW_H) + OVERSCAN * 2;
    setWindow((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  /*
   * One re-window per frame, not one per scroll event.
   *
   * A wheel can queue four or five events between two frames, and each one used
   * to remount the row window — sixty rows of 150 KB base64 artwork, decoded
   * synchronously, in the same frame the browser was trying to paint the scroll.
   * That is the jank, and it is also the blanking: the frame that would have
   * shown the new rows spent itself on the third of five identical re-renders.
   */
  const pendingRef = useRef(0);
  const scheduleMeasure = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = requestAnimationFrame(() => {
      pendingRef.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    measure();
    const onResize = () => measure();
    list.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      list.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', onResize);
    };
  }, [measure, scheduleMeasure]);

  useEffect(() => () => {
    if (pendingRef.current) cancelAnimationFrame(pendingRef.current);
  }, []);

  useEffect(() => {
    // A different list — a new folder, a new sort, a search filter — starts
    // from the top, and the window has to follow the fresh scroll position.
    measure();
  }, [measure, sortedTracks]);

  /**
   * The row the user aimed at, as opposed to the one the deck arrived at.
   *
   * Shuffle parks the sheet and scrolls the list under it, because a random
   * jump has no direction and a highlighter that teleports across forty rows
   * reads as a glitch. That is the right answer for next/previous — and the
   * wrong one for a click, where the user pointed at a row and the marker owes
   * them the trip to it. So the click records itself here and the effect below
   * treats that one arrival as unshuffled.
   */
  const manualPick = useRef<string | null>(null);
  const pick = useCallback(
    (track: Track, list: Track[]) => {
      manualPick.current = track.id;
      onSelect?.(track, list);
    },
    [onSelect],
  );

  /**
   * Places the sheet on a content-space row top at the scroller's real offset.
   * Reading `list.scrollTop` back after assigning it is deliberate: the
   * browser clamps a scroll to the scrollable range, and deriving the sheet
   * from the clamped value is what keeps it welded to its row at the ends of
   * the list instead of drifting past the first or last row.
   */
  const placeSheet = useCallback((anchor: number, scale = 1, lift = 0) => {
    const list = listRef.current;
    const slide = slideRef.current;
    if (!list || !slide) return;
    anchorRef.current = anchor;
    slide.style.transform =
      scale === 1
        ? `translateY(${anchor - list.scrollTop}px)`
        : `translateY(${anchor - list.scrollTop}px) scale(${scale.toFixed(4)})`;
    // Drives the drop shadow in CSS: the higher the sheet, the further its
    // shadow falls — which is the other half of "hovering above the rows".
    slide.style.setProperty('--lift', lift.toFixed(3));
    slide.classList.toggle('airborne', lift > 0.02);
  }, []);

  /**
   * One clock moves the sheet and scrolls the list, which is what keeps the
   * page turn reading as a single motion instead of two competing ones.
   */
  const moveSheet = useCallback(
    (rowTop: number, targetScroll: number, ms: number) => {
      const list = listRef.current;
      const slide = slideRef.current;
      if (!list || !slide) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      slide.style.height = `${ROW_BOX}px`;

      const fromScroll = list.scrollTop;
      const fromAnchor = anchorRef.current ?? rowTop;
      const toAnchor = rowTop;
      if (ms <= 0 || (Math.abs(fromAnchor - toAnchor) < 0.5 && Math.abs(fromScroll - targetScroll) < 0.5)) {
        list.scrollTop = targetScroll;
        placeSheet(toAnchor);
        return;
      }

      // The start time comes from the frame clock, not `performance.now()`: a
      // tween created mid-frame otherwise gets a negative progress on its first
      // step, and eased that way it lurches 2+ rows the wrong way before
      // correcting — the highlighter rubber-banding past its own row.
      let t0 = 0;
      const step = (now: number) => {
        if (!t0) t0 = now;
        const t = clamp01((now - t0) / ms);
        const { lift, scale, progress: e } = travelPhase(t);
        list.scrollTop = fromScroll + (targetScroll - fromScroll) * e;
        placeSheet(fromAnchor + (toAnchor - fromAnchor) * e, scale, lift);
        rafRef.current = t < 1 ? requestAnimationFrame(step) : 0;
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [placeSheet],
  );

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  // While the sheet is parked on a row, browsing the list carries it along.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let queued = 0;
    const onScroll = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        scheduleMeasure();
        if (rafRef.current) return;
        // The anchor is content-space, so keeping the sheet welded to its row is
        // just a matter of re-placing it against the new offset — no need for the
        // row to be mounted, which it will not be once the user has scrolled it
        // out of the window.
        if (anchorRef.current === null) return;
        placeSheet(anchorRef.current);
      });
    };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      list.removeEventListener('scroll', onScroll);
      if (queued) cancelAnimationFrame(queued);
    };
  }, [placeSheet, scheduleMeasure]);

  /**
   * Sequential playback walks the sheet down the visible window row by row
   * while the list holds still; the step past the last visible row turns the
   * page so the new song arrives at the top with the sheet. Shuffle lands
   * anywhere, so there the sheet stays put and the list slides under it.
   */
  useEffect(() => {
    const list = listRef.current;
    const slide = slideRef.current;
    if (!list || !slide) return;
    const index = currentTrackId ? sortedTracks.findIndex((t) => t.id === currentTrackId) : -1;
    if (index < 0) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      slide.style.visibility = 'hidden';
      anchorRef.current = null;
      return;
    }

    const first = slide.style.visibility !== 'visible';
    /*
     * The row's position is computed, not read from the DOM. The window only
     * mounts the rows in view, and the playing row is routinely outside them —
     * the sheet still has to land on it and turn the page to bring it back.
     */
    const rowTop = index * ROW_H;
    slide.style.visibility = 'visible';

    const slots = Math.max(1, Math.floor(list.clientHeight / ROW_H));
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight);
    const topIndex = Math.round(list.scrollTop / ROW_H);
    const visible = index >= topIndex && index <= topIndex + slots - 1;

    let targetScroll = list.scrollTop;
    if (shuffle && currentTrackId !== manualPick.current) {
      const y = (anchorRef.current ?? rowTop) - list.scrollTop;
      const slot = clamp(Math.round(y / ROW_H), 0, slots - 1);
      targetScroll = clamp((index - slot) * ROW_H, 0, maxScroll);
    } else if (!visible) {
      targetScroll = clamp(rowTop, 0, maxScroll);
    }

    const turned = Math.abs(targetScroll - list.scrollTop) > 0.5;
    moveSheet(rowTop, targetScroll, first ? 0 : turned ? PAGE_MS : GLIDE_MS);
  }, [currentTrackId, moveSheet, shuffle, sortedTracks]);

  const chosen = selectedTracks.length;

  /** Open the bulk menu under the select strip, at the strip's own left edge. */
  const openBulkMenu = () => {
    const box = bulkRef.current?.getBoundingClientRect();
    setMenu({
      tracks: selectedTracks,
      x: box ? box.left : 40,
      y: box ? box.bottom + 6 : 40,
    });
  };

  return (
    <>
      <div className="song-list-tools">
        {selectMode ? (
          <div className="song-select-tools" ref={bulkRef}>
            <span className="song-select-count">
              {chosen} {chosen === 1 ? 'song' : 'songs'}
            </span>
            <button
              type="button"
              className="home-btn home-btn-tight"
              onClick={selectAll}
              disabled={sortedTracks.length === 0}
            >
              <Icon name="list" size={12} />
              Select all
            </button>
            <button
              type="button"
              className="home-btn home-btn-tight"
              onClick={openBulkMenu}
              disabled={chosen === 0}
              data-tip="What to do with the ticked rows"
            >
              <Icon name="playlist" size={12} />
              Actions
            </button>
            <button
              type="button"
              className="home-btn home-btn-tight"
              onClick={leaveSelectMode}
              data-tip="Stop selecting"
            >
              <Icon name="close" size={12} />
              Done
            </button>
          </div>
        ) : null}
        <div className="song-list-tools-end">
          {/*
           * The same gesture the row menu offers, for the case where nothing is
           * playing yet and there is no row to right-click. Only lists the app owns
           * get it: a pinned folder's contents are a directory's contents, and
           * "add songs" there would mean copying real files into the user's music
           * folder to satisfy a button that looked like a list editor.
           */}
          {access?.canAdd && access.list ? (
            <button
              type="button"
              className="glass-select-trigger"
              onClick={() => void pickAndAddToList(access.list!.name, access.notify)}
              data-tip="Pick songs from the file manager and add them to this list"
            >
              <Icon name="plus" size={13} />
              <span>Add songs</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`glass-select-trigger ${selectMode ? 'active' : ''}`}
            onClick={() => (selectMode ? leaveSelectMode() : setSelectMode(true))}
            data-tip={selectMode ? 'Stop selecting' : 'Tick several songs'}
            aria-pressed={selectMode}
          >
            <Icon name={selectMode ? 'close' : 'check'} size={13} />
            <span>Select</span>
          </button>
          <button
            ref={sortRef}
            type="button"
            className="glass-select-trigger morph-trigger"
            data-tip="Sort tracks"
            aria-label="Sort tracks"
          >
            <Icon name="sort" size={13} />
            <span className="truncate">
              {SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? '# Number'}
            </span>
          </button>
        </div>
        {/* Drops downward: this control sits at the top of the list, so there
            is nothing above it for the panel to open into. */}
        <MorphingGlassPanel
          triggerRef={sortRef}
          idle={SORT_IDLE}
          open={SORT_OPEN}
          direction="down"
          align="right"
        >
          <MorphOptionList
            options={SORT_OPTIONS}
            value={sortMode}
            onSelect={(value) => store().setSort(value as SortMode, value === sortMode ? sortDesc : false)}
            renderTrailing={(option) => (
              <span
                className="sort-direction"
                role="button"
                tabIndex={0}
                aria-label={
                  option.value === sortMode && sortDesc ? 'Sort ascending' : 'Sort descending'
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (option.value !== sortMode) {
                    store().setSort(option.value as SortMode, false);
                  } else {
                    store().setSort(option.value as SortMode, !sortDesc);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.currentTarget.click();
                  }
                }}
              >
                <Icon name="collapse" size={11} rotate={sortDesc ? 180 : 0} />
              </span>
            )}
          />
        </MorphingGlassPanel>
      </div>
      {/* The sheet lives outside the scroller so it can hold a screen slot
          while the list moves underneath it. Rows are transparent by default,
          so the list sitting on top of it still lets it show through. */}
      <div className={`song-list-frame ${className}`}>
        <div
          ref={slideRef}
          className="row-glass"
          data-glass
          data-config={cardGlass(14)}
          data-no-capture
          aria-hidden
        />
        {/*
         * `data-no-scene` keeps the sixty covers in this window out of the
         * glass scene. They are interface, not backdrop — a panel refracting
         * them shows the list twice — and measuring them for every panel the
         * scroll dirties cost more than the scroll itself.
         */}
        <div ref={listRef} className="song-list" data-no-scene>
          <div className="song-rows" style={{ height: sortedTracks.length * ROW_H }}>
            {sortedTracks.slice(window_.start, window_.end).map((track, k) => (
              <SongRow
                key={track.id}
                track={track}
                index={window_.start + k}
                isCurrent={track.id === currentTrackId}
                isPlaying={isPlaying}
                query={query}
                folderRank={folderRank}
                list={sortedTracks}
                onSelect={pick}
                onMenu={openMenu}
                selectMode={selectMode}
                selected={selected.has(track.id)}
                onToggle={toggleRow}
              />
            ))}
          </div>
          {sortedTracks.length === 0 && (
            <div className="py-10 text-center text-glass-textMuted text-sm">
              No tracks found
            </div>
          )}
        </div>
      </div>
      {menu ? (
        <SongContextMenu
          tracks={menu.tracks}
          list={sortedTracks}
          x={menu.x}
          y={menu.y}
          header={menu.tracks.length > 1 ? `${menu.tracks.length} selected` : undefined}
          actions={songActions(menu.tracks, sortedTracks, access ?? NO_LIST)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
};
