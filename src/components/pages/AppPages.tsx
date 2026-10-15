import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import {
  removeFromPlaylist,
  useLibrary,
  playlistTracks,
} from '../../hooks/useLibrary';
import { getEngine } from '../../audio/engine';
import Icon from '../ui/Icon';
import { SongList } from '../player/SongList';
import NowPlaying from '../player/NowPlaying';
import LyricsView from '../lyrics/LyricsView';
import PlayCards from './PlayCards';
import SystemMeters from '../widgets/SystemMeters';
import TravelSheet from '../ui/TravelSheet';
import { cardGlass } from '../../utils/glass';
import { filterLibrary } from '../../utils/search';
import { audioOnly, videoOnly } from '../../utils/sorting';
import type { ListAccess } from '../../utils/songActions';
import type { Track } from '../../types';

/**
 * The two pages that are not the track list.
 *
 * The sidebar used to carry every pinned folder as its own row, so the navigation
 * grew with the library and there was nowhere to manage the folders from. Home is
 * the player; these are the places you go to change what it contains.
 */

function formatTotal(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Library management and browsing: pin, unpin, rescan, and read what is in each
 * folder.
 *
 * A folder tab is a directory the user pinned and the scanner walked; a playlist tab
 * is a `.m3u8` this app wrote in its own data folder, listing paths rather than
 * holding files. They are the same kind of tab — one list of rows, press Play and it
 * is the running order — and nothing else: the scanner never sees a playlist, so it
 * cannot rescan one, and a playlist never sees the scan, so it cannot grow on its own.
 * A folder is renamed wherever it lives, and a playlist is renamed here.
 *
 * The tab row replaces the Songs / Albums / Artists split: this app has no album or
 * artist pages to land on, so those two tabs would have been a promise with nothing
 * behind it. One tab per folder and per playlist is the same shape and every one of
 * them already works.
 */
/**
 * The tab id for the cross-folder video list. A sentinel rather than a folder id,
 * because a real folder could be named anything and this one is not a directory.
 */
const VIDEOS_TAB = '__videos__';

export const LibraryPage: React.FC = () => {
  const folders = usePlayerStore((s) => s.folders);
  const library = usePlayerStore((s) => s.library);
  const query = usePlayerStore((s) => s.searchQuery);
  const mediaHasVideo = usePlayerStore((s) => s.mediaHasVideo);
  const videoFullscreen = usePlayerStore((s) => s.videoFullscreen);
  const lyricsEnabled = usePlayerStore((s) => s.lyricsEnabled);
  const {
    unpinFolder,
    rescanFolder,
    playlists,
    renamePlaylist,
    addToPlaylist,
    removePlaylist,
  } = useLibrary();
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const [tab, setTab] = useState<string>('all');
  const [notice, setNotice] = useState<string | null>(null);
  /** The playlist being renamed, keyed by the file it lives at while the name is typed. */
  const [renaming, setRenaming] = useState<{ path: string; draft: string } | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  /** The strip's highlighter, held above the tabs while the wheel is turning. */
  const [stripLift, setStripLift] = useState(false);
  const liftBack = useRef(0);

  React.useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /*
   * Wheel over the folder strip scrolls it sideways, and lifts the highlighter.
   *
   * The strip is a horizontal scroller, so a wheel — which every other surface in
   * this app reads as vertical — did nothing at all over it. A vertical gesture is
   * translated into a horizontal one here rather than swapped for shift-wheel,
   * because the strip is the only thing under the cursor and there is no other
   * reading worth honouring.
   *
   * The sign is the one the user asked for by name: pushing the wheel down slides
   * the strip left, pulling it up slides it right. It reads as grabbing the strip
   * and dragging it with the wheel rather than as scrolling a page sideways.
   *
   * While it is moving, the highlighter lifts off the tabs and settles back when
   * the gesture stops — the same object the song list's sheet makes mid-travel,
   * asked for here by name. The timer is rearmed per event rather than armed once,
   * so "stopped" means stopped.
   */
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return undefined;
    const onWheel = (event: WheelEvent) => {
      const dy = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? 0 : event.deltaY;
      const dx = dy ? -dy : event.deltaX;
      if (!dx) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      event.preventDefault();
      el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + dx));
      if (!stripLift) setStripLift(true);
      if (liftBack.current) window.clearTimeout(liftBack.current);
      liftBack.current = window.setTimeout(() => {
        liftBack.current = 0;
        setStripLift(false);
      }, 220);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (liftBack.current) window.clearTimeout(liftBack.current);
    };
  }, [stripLift]);

  /*
   * The same predicate the search bar uses to build its suggestions, so the list
   * this page shows and the result the bar offered cannot disagree — which is
   * the difference between searching finding songs, and searching finding songs
   * *and then the page showing something else*.
   *
   * `All songs` is the merged music list, so films stay out of it; a folder tab
   * is that directory's contents, films included, because pinning a folder
   * containing video is the only way to reach them.
   */
  const songs = useMemo(() => audioOnly(library), [library]);
  const films = useMemo(() => videoOnly(library), [library]);
  const hiddenPaths = usePlayerStore((s) => s.hiddenPaths);
  const shown = useMemo(() => {
    const playlist = playlists.find((p) => p.path === tab);
    const base =
      tab === 'all'
        ? songs
        : tab === VIDEOS_TAB
          ? films
          : playlist
            ? playlistTracks(playlist, library)
            : library.filter((t) => t.folderId === tab);
    /*
     * Filtered here as well as at the scan. The scanner drops hidden paths when it
     * publishes, but a removal takes effect on the row the moment it is asked for,
     * not on the next ten-minute poll — and a list that kept showing a row the menu
     * had just said it removed is the bug this whole field exists to avoid.
     */
    const hidden = new Set(hiddenPaths);
    const visible = hidden.size ? base.filter((t) => !hidden.has(t.path)) : base;
    return filterLibrary(visible, folders, query);
  }, [library, songs, films, folders, playlists, tab, query, hiddenPaths]);

  /*
   * Honour a "just made this list" request: open its tab and slide the strip along
   * until the chip is in the middle of it.
   *
   * The request comes from the store rather than from watching `playlists` grow,
   * because the two ways that used to fail are both ordinary. A first run with no
   * playlists left the comparison ref at `null`, which is also what "I have not
   * looked yet" reads as, so the very first list ever made was recorded instead of
   * opened. And making one from Home meant this page was not mounted to notice, so
   * by the time it was, the event had passed.
   *
   * The rAF is not decoration. The chip for a new list is in the same commit as the
   * `revealPlaylist` that names it, and measuring a node before the browser has laid
   * it out centres the strip on a zero-width rect.
   */
  const reveal = usePlayerStore((s) => s.revealPlaylist);
  useEffect(() => {
    if (!reveal) return undefined;
    setTab(reveal);
    const raf = requestAnimationFrame(() => {
      const strip = tabsRef.current;
      const chip = strip?.querySelector<HTMLElement>('.library-tab[aria-selected="true"]');
      if (strip && chip) {
        const sr = strip.getBoundingClientRect();
        const cr = chip.getBoundingClientRect();
        const delta = cr.left - sr.left - (sr.width - cr.width) / 2;
        if (Math.abs(delta) > 1) strip.scrollBy({ left: delta, behavior: 'smooth' });
      }
      usePlayerStore.getState().clearRevealPlaylist();
    });
    return () => cancelAnimationFrame(raf);
  }, [reveal]);

  /* A folder dropped out from under the open tab — fall back rather than show nothing. */
  const activeId =
    tab === 'all' ||
    tab === VIDEOS_TAB ||
    folders.some((f) => f.id === tab) ||
    playlists.some((p) => p.path === tab)
      ? tab
      : 'all';
  const active = folders.find((f) => f.id === activeId) ?? null;
  const activePlaylist = playlists.find((p) => p.path === activeId) ?? null;
  /*
   * What the row menu and the list toolbar are allowed to offer.
   *
   * Every named list can lose a row. What differs is the mechanism, and the notice
   * the user is given afterwards has to say so: a playlist is a file of references
   * this app wrote, so removing rewrites it; a folder tab is a directory the
   * scanner walked, so removing hides the file from ChaosX and leaves it on disk.
   */
  const access: ListAccess = useMemo(() => {
    if (activePlaylist) {
      const playlist = activePlaylist;
      return {
        list: {
          name: playlist.name,
          notice: 'The files are untouched.',
          remove: (paths) => removeFromPlaylist(playlist, paths),
        },
        canAdd: true,
        notify: setNotice,
      };
    }
    return {
      list: {
        name: 'the library',
        notice: 'It is hidden from ChaosX only — the file is still where it was.',
        remove: async (paths) => {
          usePlayerStore.getState().hideTracks(paths);
          return {};
        },
      },
      /* A pinned folder's list *is* its directory; see `ListAccess.canAdd`. */
      canAdd: !active,
      notify: setNotice,
    };
  }, [activePlaylist, active]);

  /** Hidden files that belong to the list on screen, so they can be offered back. */
  const hiddenHere = useMemo(() => {
    if (activePlaylist) return [];
    const hidden = new Set(hiddenPaths);
    const scope = active ? `${active.path.toLowerCase()}\\` : null;
    return [...hidden].filter(
      (p) => scope === null || p.toLowerCase().startsWith(scope),
    );
  }, [hiddenPaths, active, activePlaylist]);

  /*
   * The sheet indexes the strip's DOM children — `All songs`, then `All videos`,
   * then one tab per pinned folder and then one per playlist, in the order they are
   * rendered — so the index is counted from the same array the markup maps over,
   * never from a stored position.
   */
  const tabIndex =
    activeId === 'all'
      ? 0
      : activeId === VIDEOS_TAB
        ? 1
        : active
          ? folders.indexOf(active) + 2
          : folders.length + 2 + playlists.findIndex((p) => p.path === activeId);

  const listenTo = (tracks: Track[]) => {
    if (tracks.length === 0) {
      setNotice(
        activePlaylist
          ? 'That playlist has nothing in it yet — play a song and add it from here.'
          : 'That folder has no tracks yet — rescan it, or put some music in it.',
      );
      return;
    }
    void getEngine().playList(tracks, tracks[0]);
  };

  /*
   * Rename commits on Enter and on leaving the field. Leaving it is the one that
   * matters: a person who has typed a name reaches for the mouse, not for a key they
   * have not seen asked for since the last dialog. The tab follows the file, because
   * the file is what the tab is keyed by.
   */
  const commitRename = async () => {
    if (!renaming) return;
    const playlist = playlists.find((p) => p.path === renaming.path);
    const draft = renaming.draft;
    setRenaming(null);
    if (!playlist) return;
    const done = await renamePlaylist(playlist, draft);
    if (done.error) setNotice(done.error);
    else if (done.path && done.path !== playlist.path) setTab(done.path);
  };

  const addPlayingTo = async (playlist: (typeof playlists)[number]) => {
    if (!currentTrack) return;
    const done = await addToPlaylist(playlist, currentTrack.path);
    if (done.error) setNotice(done.error);
  };

  return (
    <div className="main-grid">
      {/*
       * The same two columns Home uses, in the same order: the list on the left
       * inside its own card, the record and its lyric sheet down the right. The
       * library's folder tabs and its tools sit where Home puts the
       * continue-listening hero, because that slot is the top of the left
       * column and this page has its own header for it.
       */}
      <section
        className="track-section liquid-glass-card small"
        data-glass
        data-config={cardGlass(20)}
        data-no-capture
      >
        <div className="library-page">
          {notice ? <p className="lyrics-notice">{notice}</p> : null}

          {/*
           * The folder strip carries the same travelling sheet as the song list, on
           * its side. The sheet sits beside the scroller rather than inside it so
           * `overflow-x` cannot clip the swell, and it bends the backdrop instead of
           * painting a flat pill — which is what made the old active-tab fill read as
           * a sticker. Its wash comes from the record that is playing, so the strip
           * is the same colour as the artwork the rest of the window is wearing.
           */}
          <div className="library-tabs-frame travel-frame">
            <TravelSheet
              itemsRef={tabsRef}
              activeIndex={tabIndex}
              radius={17}
              ms={900}
              lift={stripLift}
              tint="var(--art-tint)"
            />
            <div className="library-tabs" ref={tabsRef} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={activeId === 'all'}
                className={`library-tab ${activeId === 'all' ? 'active' : ''}`}
                onClick={() => setTab('all')}
              >
                <Icon name="list" size={13} />
                All songs
                <span className="library-tab-count">{songs.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeId === VIDEOS_TAB}
                className={`library-tab ${activeId === VIDEOS_TAB ? 'active' : ''}`}
                onClick={() => setTab(VIDEOS_TAB)}
                title="Every video across every pinned folder"
              >
                <Icon name="theatre" size={13} />
                All videos
                <span className="library-tab-count">{films.length}</span>
              </button>
              {folders.map((folder) => {
                const count = library.filter((t) => t.folderId === folder.id).length;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="tab"
                    aria-selected={activeId === folder.id}
                    className={`library-tab ${activeId === folder.id ? 'active' : ''}`}
                    onClick={() => setTab(folder.id)}
                    title={folder.path}
                  >
                    <Icon name="playlist" size={13} />
                    <span className="library-tab-name truncate">{folder.name}</span>
                    <span className="library-tab-count">{count}</span>
                  </button>
                );
              })}
              {playlists.map((playlist) => (
                <button
                  key={playlist.path}
                  type="button"
                  role="tab"
                  aria-selected={activeId === playlist.path}
                  className={`library-tab ${activeId === playlist.path ? 'active' : ''}`}
                  onClick={() => setTab(playlist.path)}
                  title={playlist.path}
                >
                  <Icon name="music" size={13} />
                  <span className="library-tab-name truncate">{playlist.name}</span>
                  <span className="library-tab-count">{playlist.tracks.length}</span>
                </button>
              ))}
            </div>
          </div>

          {active ? (
            <div className="library-folder-bar">
              <span className="library-folder-path truncate">{active.path}</span>
              <button
                type="button"
                className="home-btn home-btn-tight"
                onClick={() => listenTo(shown)}
              >
                <Icon name="play" size={12} />
                Play folder
              </button>
              <button
                type="button"
                className="home-btn home-btn-tight"
                onClick={() => void rescanFolder(active)}
                data-tip="Look for files added or changed since the last scan"
              >
                <Icon name="refresh" size={12} />
                Rescan
              </button>
              <button
                type="button"
                className="home-btn home-btn-tight danger"
                onClick={() => unpinFolder(active.id)}
                data-tip="Remove it from the library. Nothing on disk is deleted."
              >
                <Icon name="delete" size={12} />
                Unpin
              </button>
              {hiddenHere.length ? (
                /*
                 * The way back. A row removed from a folder tab is hidden rather
                 * than deleted, and a hide with no visible undo is a file the user
                 * can never find again from inside the app.
                 */
                <button
                  type="button"
                  className="home-btn home-btn-tight"
                  onClick={() => {
                    usePlayerStore.getState().unhideTracks(hiddenHere);
                    setNotice(`Showed ${hiddenHere.length} hidden again`);
                  }}
                  data-tip="Put back the songs removed from this list"
                >
                  <Icon name="refresh" size={12} />
                  Show {hiddenHere.length} hidden
                </button>
              ) : null}
            </div>
          ) : null}

          {activePlaylist ? (
            <div className="library-folder-bar">
              {renaming?.path === activePlaylist.path ? (
                <input
                  className="playlist-name-input"
                  autoFocus
                  value={renaming.draft}
                  placeholder={activePlaylist.name}
                  spellCheck={false}
                  onChange={(event) => setRenaming({ path: activePlaylist.path, draft: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename();
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <span className="library-folder-path truncate">{activePlaylist.path}</span>
              )}
              <button
                type="button"
                className="home-btn home-btn-tight"
                onClick={() => listenTo(shown)}
              >
                <Icon name="play" size={12} />
                Play list
              </button>
              {currentTrack ? (
                <button
                  type="button"
                  className="home-btn home-btn-tight"
                  onClick={() => void addPlayingTo(activePlaylist)}
                  data-tip="Put the song that is playing on the end of this list"
                >
                  <Icon name="play" size={12} />
                  Add playing
                </button>
              ) : null}
              <button
                type="button"
                className="home-btn home-btn-tight"
                onClick={() => setRenaming({ path: activePlaylist.path, draft: activePlaylist.name })}
                data-tip="Rename it. The songs stay where they are."
              >
                <Icon name="pencil" size={12} />
                Rename
              </button>
              <button
                type="button"
                className="home-btn home-btn-tight danger"
                onClick={() =>
                  void removePlaylist(activePlaylist).then((done) => {
                    if (done.error) setNotice(done.error);
                  })
                }
                data-tip="Delete the playlist file. The songs it pointed at are untouched."
              >
                <Icon name="delete" size={12} />
                Delete
              </button>
            </div>
          ) : null}

          {/*
           * `All songs` and `All videos` have no bar of their own — there is no
           * folder to rescan and nothing to unpin — but they do take removals now,
           * so they need the same way back the folder tab has.
           */}
          {!active && !activePlaylist && hiddenHere.length ? (
            <div className="library-folder-bar">
              <span className="library-folder-path truncate">
                {hiddenHere.length} {hiddenHere.length === 1 ? 'song' : 'songs'} hidden from
                this list
              </span>
              <button
                type="button"
                className="home-btn home-btn-tight"
                onClick={() => {
                  usePlayerStore.getState().unhideTracks(hiddenHere);
                  setNotice(`Showed ${hiddenHere.length} hidden again`);
                }}
                data-tip="Put back every song removed from this list"
              >
                <Icon name="refresh" size={12} />
                Show them
              </button>
            </div>
          ) : null}

          <div className="library-list">
            <SongList
              tracks={shown}
              query={query}
              onSelect={(track, list) => void getEngine().playList(list, track)}
              access={access}
            />
          </div>
        </div>
      </section>

      <section className="nowplaying-section">
        {/*
         * The rectangle a docked film is placed into. `VideoStage` looks for
         * `.video-slot` in the document, so a page without one leaves an
         * mpv-drawn picture with nowhere to go — which is why this sits here as
         * well as on Home, and why it is the first child rather than a card
         * that can be scrolled past.
         */}
        <div className={`video-slot ${mediaHasVideo && !videoFullscreen ? 'active' : ''}`}>
          <div className="video-slot-box" />
        </div>
        <NowPlaying />
        {/*
         * A film and a lyric sheet want the same rectangle. The lyric card slides
         * down and out as the preview takes the slot from above, rather than being
         * swapped in one frame, because the picture arriving is the event and the
         * words leaving should read as getting out of its way.
         *
         * Small Potato Mode used to leave the sheet out. That was over-cutting
         * dressed up as optimisation: the panel is DOM text and one CSS transition
         * on the highlighter, and the only recurring cost is a network lookup that
         * happens once per song and is then cached in `chaosx-lyrics`. The
         * mode's real budget goes to the WebGL scene pass, which it already declines
         * at `App.tsx`. So the card answers to `lyricsEnabled` and to nothing else.
         */}
        {!lyricsEnabled ? null : (
          <div className={`lyrics-swap ${mediaHasVideo && !videoFullscreen ? 'film-in' : ''}`}>
            <LyricsView />
          </div>
        )}
      </section>
    </div>
  );
};

/**
 * The machine this library lives on.
 *
 * A name and a shape, nothing else — the meters underneath already say what the
 * computer is *doing*, and a card that duplicates the processor model would be a
 * fourth place on this page to read the same string. The glyph is chosen from
 * `battery.present` rather than from a product API because that is the one
 * question Windows answers without a WMI round trip: a machine that can run off a
 * cell is a laptop.
 */
const DeviceCard: React.FC = () => {
  const [name, setName] = useState('');
  const [portable, setPortable] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.electronAPI?.getUser?.().then((info) => {
      if (alive && info?.device) setName(info.device);
    });
    void window.electronAPI?.getSysInfo?.().then((v) => {
      if (alive && v) setPortable(v.battery.present);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      className="device-card liquid-glass-card small"
      data-glass
      data-config={cardGlass(18)}
      data-no-capture
    >
      <span className="device-plate">
        <Icon name={portable ? 'laptop' : 'desktop'} size={22} />
      </span>
      <span className="device-copy">
        <span className="device-kind">{portable ? 'Laptop' : 'Desktop'}</span>
        <span className="device-name truncate">{name || 'This computer'}</span>
      </span>
    </div>
  );
};

/**
 * What the scanned library adds up to.
 *
 * Everything here is derived at render from `library`, which is the only honest
 * source — a persisted tally would disagree with the folder list the moment
 * something was pinned or unpinned, and that disagreement is exactly the class of
 * bug this app has already been bitten by twice.
 */
export const StatisticsPage: React.FC = () => {
  const library = usePlayerStore((s) => s.library);
  const folders = usePlayerStore((s) => s.folders);

  const computed = useMemo(() => {
    const byFolder = new Map<string, number>();
    const byFormat = new Map<string, number>();
    let seconds = 0;
    let video = 0;

    for (const t of library) {
      seconds += t.duration || 0;
      if (t.kind === 'video') video++;
      byFolder.set(t.folderId ?? '?', (byFolder.get(t.folderId ?? '?') ?? 0) + 1);
      const ext = (t.format || 'unknown').toLowerCase();
      byFormat.set(ext, (byFormat.get(ext) ?? 0) + 1);
    }

    const nameOf = (id: string) => folders.find((f) => f.id === id)?.name ?? 'Dropped';

    return {
      total: library.length,
      seconds,
      video,
      folders: [...byFolder.entries()]
        .map(([id, count]) => ({ name: nameOf(id), count }))
        .sort((a, b) => b.count - a.count)
        .filter((f) => f.count > 0),
      /*
       * Every container actually present, and nothing else. The tally is built
       * by walking the scanned tracks, so an extension appears the moment a
       * file with it lands in a pinned folder — `.m4a`, `.opus`, `.wma`, a
       * `.alc` nobody has heard of — and one that is nowhere in the library
       * never appears at all. There is no format table to keep current, which
       * means there is no row of zeros to hide.
       */
      formats: [...byFormat.entries()]
        .map(([name, count]) => ({ name, count }))
        .filter((f) => f.count > 0)
        .sort((a, b) => b.count - a.count),
    };
  }, [library, folders]);

  /*
   * No artwork tally. "413/437 have a cover" is a fact about the files, not about
   * the listening, and once the meters moved above this strip the row of four was
   * spending its width on the one number nobody acts on.
   */
  const cards = [
    { label: 'Songs', value: String(computed.total) },
    { label: 'Length', value: formatTotal(computed.seconds) },
    /* A library with no films has nothing to say about films. */
    ...(computed.video > 0 ? [{ label: 'Videos', value: String(computed.video) }] : []),
  ];

  return (
    <section className="app-page stats-page" data-glass data-config={cardGlass(22)} data-no-capture>
      <div className="app-page-scroll">
        <div className="stats-inner">
          <DeviceCard />

          {/*
           * The machine first, then the library. This page opens by saying what
           * you are listening on, and the meters are the same question asked of
           * the present moment rather than of the whole collection.
           */}
          <SystemMeters />

          <div className="stat-strip">
            {cards.map((card) => (
              <div key={card.label} className="stat-card">
                <span className="stat-value">{card.value}</span>
                <span className="stat-label">{card.label}</span>
              </div>
            ))}
          </div>

          {/*
           * Distinct containers, not a lossy/lossless split. "How many formats" is
           * the question that tells you something about the library — a two-format
           * collection and a seven-format one came from different places — and it
           * is answered straight off the scanned metadata instead of off a table of
           * which codecs happen to be classed as lossless.
           */}
          <div className="stat-chips">
            <span className="stat-chip lead">
              {computed.formats.length} {computed.formats.length === 1 ? 'format' : 'formats'}
            </span>
            {computed.formats.map((f) => (
              <span key={f.name} className="stat-chip">
                {f.name.toUpperCase()} <b>{f.count}</b>
              </span>
            ))}
            <span className="stat-chip">{folders.length} folders</span>
          </div>

          {/*
           * The count is the whole story here, so it is written beside the name
           * instead of being drawn as a bar scaled against the largest folder —
           * a bar says "this one is bigger" and costs 300px of width to say it.
           *
           * Centred, on a plate of its own: the list used to run the full width
           * of the column, which put a folder's name and its number 700px apart
           * and made the eye carry the gap on every row.
           */}
          <h3 className="app-page-section-title centred">File Count per Folder</h3>
          {computed.folders.length === 0 ? (
            <p className="app-page-hint centred">Nothing scanned yet.</p>
          ) : (
            <div
              className="folder-counts-card liquid-glass-card small"
              data-glass
              data-config={cardGlass(18)}
              data-no-capture
              /*
               * Out of the glass scene. This card sits at the bottom of the
               * column, directly behind the player pill, and the pill's lens
               * was bending it — a second, warped copy of the folder list
               * floating inside the transport.
               */
              data-no-scene
            >
              <ul className="folder-counts">
                {computed.folders.map((f) => (
                  <li key={f.name}>
                    <span className="folder-count-name truncate">{f.name}</span>
                    <span className="folder-count-value">{f.count}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The same two cards Home runs, at the same 15 rows, side by side
              because this column is wide enough for them to sit together. */}
          <PlayCards limit={15} />
        </div>
      </div>
    </section>
  );
};
