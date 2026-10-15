import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import MediaThumb from '../ui/MediaThumb';
import Icon from '../ui/Icon';
import SongContextMenu from '../player/SongContextMenu';
import TravelSheet from '../ui/TravelSheet';
import { formatTime } from '../../utils/formatTime';
import type { Track } from '../../types';

/**
 * The Most played / Last played pair, shared by Home and Library.
 *
 * Extracted because the user asked for the same two cards on both pages, and a
 * second copy of the ranking would be a second thing to keep in step — the app
 * has already been bitten twice by two surfaces disagreeing about one state.
 */

export interface Ranked {
  track: Track;
  count: number;
  lastPlayed: number;
}

/** Rank the library by listens, dropping anything never played or deleted. */
export function useRanked(): Ranked[] {
  const library = usePlayerStore((s) => s.library);
  const stats = usePlayerStore((s) => s.playStats);
  return useMemo(() => {
    const byId = new Map(library.map((t) => [t.id, t]));
    const out: Ranked[] = [];
    for (const [id, s] of Object.entries(stats)) {
      const track = byId.get(id);
      if (track) out.push({ track, count: s.count, lastPlayed: s.lastPlayed });
    }
    return out;
  }, [library, stats]);
}

const EMPTY =
  'Nothing counted yet — plays start being tallied from this build onwards.';

interface MenuRequest {
  track: Track;
  list: Track[];
  x: number;
  y: number;
}

/**
 * One card. Module scope, not nested in `PlayCards`: it now holds refs and a
 * subscription, and a component defined inside render gets a new identity every
 * pass, which unmounts its highlighter and drops it back on its row with no
 * travel at all.
 */
const Card: React.FC<{
  title: string;
  rows: Ranked[];
  limit: number;
  onMenu: (menu: MenuRequest) => void;
}> = ({ title, rows, limit, onMenu }) => {
  const shown = useMemo(() => rows.slice(0, limit), [rows, limit]);
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  /*
   * The sheet parks when the card holds nothing that is playing. Both cards
   * highlight independently for the same reason the list does: the highlighter
   * says where you are, and an empty slot is not somewhere.
   */
  const index = shown.findIndex((r) => r.track.id === currentTrackId);
  const list = useMemo(() => shown.map((r) => r.track), [shown]);

  return (
    <section className="home-list-card">
      <h3 className="home-list-title">{title}</h3>
      {shown.length === 0 ? (
        <p className="app-page-hint">{EMPTY}</p>
      ) : (
        <div className="travel-frame home-rows-frame">
          <TravelSheet itemsRef={rowsRef} activeIndex={index} radius={11} ms={560} />
          <div className="home-rows" ref={rowsRef}>
            {shown.map((r, i) => (
              <button
                key={r.track.id}
                type="button"
                className="home-row"
                onClick={() => void getEngine().playList(list, r.track)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu({ track: r.track, list, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="home-row-rank">{i + 1}</span>
                <MediaThumb track={r.track} className="home-row-thumb" />
                <span className="home-row-names">
                  <span className="home-row-title truncate">{r.track.name}</span>
                  <span className="home-row-artist truncate">
                    {r.track.artist || 'Unknown artist'}
                  </span>
                </span>
                <span className="home-row-plays">
                  {r.count} {r.count === 1 ? 'play' : 'plays'}
                </span>
                <span className="home-row-time">{formatTime(r.track.duration)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
};

/**
 * How many ranked rows a window this short can actually carry.
 *
 * Six was chosen against a 900-pixel-tall window and never revisited, so on a
 * 1366x768 panel the pair ran past the bottom of the glass card they stand in — the
 * plate stops where the layout says it does and the rows keep going, which is what
 * "the cards have spilled over their background" looks like. A row is 52px and the
 * card around it costs about 64 more, and the page it sits on owes a heading, a hero
 * and the transport pill before either number applies.
 *
 * Trimming the list is the right cut rather than shrinking the row: a ranked card is
 * read top-down, and the fourth entry is the last one anybody was ever going to
 * click from a window this size.
 */
function rankedRows(innerHeight: number, wanted: number): number {
  return Math.max(2, Math.min(wanted, Math.floor((innerHeight - 340) / 52)));
}

const PlayCards: React.FC<{ limit?: number; stacked?: boolean }> = ({
  limit = 6,
  stacked = false,
}) => {
  const ranked = useRanked();
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [rows, setRows] = useState(() => rankedRows(window.innerHeight, limit));

  useEffect(() => {
    const onResize = () => setRows(rankedRows(window.innerHeight, limit));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [limit]);

  const most = useMemo(
    () => [...ranked].sort((a, b) => b.count - a.count || b.lastPlayed - a.lastPlayed),
    [ranked],
  );
  const last = useMemo(() => [...ranked].sort((a, b) => b.lastPlayed - a.lastPlayed), [ranked]);

  return (
    <>
      {/*
       * One press, and the two cards under it are empty. That is the point of it:
       * the tally is only worth reading as *this* stretch of listening, and the
       * only way to start that stretch over is to erase the disk copy — the
       * counts deliberately survive a restart, so clearing the page's own state
       * would have them back on the next launch.
       */}
      <div className="home-lists-head">
        <button
          type="button"
          className="play-stats-reset"
          onClick={() => usePlayerStore.getState().resetPlayStats()}
          disabled={!ranked.length}
          data-tip="Start the tallies over from zero"
          aria-label="Reset play statistics"
        >
          <Icon name="refresh" size={12} />
          Reset statistics
        </button>
      </div>
      <div className={`home-lists ${stacked ? 'stacked' : ''}`}>
        <Card title="Most played" rows={most} limit={rows} onMenu={setMenu} />
        <Card title="Last played" rows={last} limit={rows} onMenu={setMenu} />
      </div>
      {menu ? (
        <SongContextMenu
          tracks={[menu.track]}
          list={menu.list}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
};

export default PlayCards;
