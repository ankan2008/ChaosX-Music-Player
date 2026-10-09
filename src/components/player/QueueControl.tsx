import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import { formatTime } from '../../utils/formatTime';
import { clamp } from '../../utils/travel';
import Icon from '../ui/Icon';
import MediaThumb from '../ui/MediaThumb';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import { panelDirection } from '../../utils/surface';
import { IS_MINI_WINDOW } from '../../utils/windowRole';

const IDLE = { width: 32, height: 32, radius: 11 };

/*
 * Six rows at the pitch below, in the box the old queue panel used. Mini gets the
 * smaller one because its window is the card plus a gutter, and a panel that has to
 * be scaled down to fit is a panel whose rows have been made unreadable by the
 * arithmetic that sized it.
 */
const OPEN = IS_MINI_WINDOW
  ? { width: 300, height: 330, radius: 24 }
  : { width: 380, height: 424, radius: 26 };

const WINDOW = 6;

/**
 * Row pitch in CSS pixels, matched to `.upnext-row` in the stylesheet.
 *
 * A drag moves a row by whole pitches, so the two have to agree or the drop lands a
 * row away from where the pointer was — and the list is not scrolled, so the pitch is
 * the only geometry the drag needs.
 */
const ROW_PITCH = IS_MINI_WINDOW ? 44 : 52;

/**
 * The next six songs, in the order the deck will play them.
 *
 * This used to be the queue: a second list you built by hand, with a second play
 * order, a second shuffle and a drag-to-reorder of its own — and every one of those
 * was a thing that could disagree with the library about what was playing next. It is
 * gone. What is left reads the order the engine itself walks, so the rows here are
 * the rows that are about to sound: the shuffled permutation while shuffle is on,
 * this list's own serial order from the current row forward while it is not.
 *
 * Only the shuffled walk can be dragged. With shuffle off the rows are the folder's
 * numbering, and rearranging them would be editing the user's files' order on disk
 * in all but name — a thing this panel cannot honestly promise to keep.
 */
const QueueControl: React.FC = () => {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const engine = getEngine();

  /*
   * The arrangement lives in the engine, not the store, so a drop has to say so
   * itself or the memo hands back the rows from before the drag.
   */
  const [revision, setRevision] = useState(0);
  const rows = useMemo(
    () => engine.upcomingTracks(WINDOW),
    [engine, queue, currentIndex, currentTrackId, shuffle, revision],
  );

  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const dragRef = useRef<{ from: number; to: number; startY: number; dy: number } | null>(null);
  /** A drag that never moved is a click on a row, and a click means play it. */
  const movedRef = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const canDrag = shuffle && rows.length > 1;

  const moveDrag = useCallback((event: PointerEvent) => {
    const held = dragRef.current;
    if (!held) return;
    const dy = event.clientY - held.startY;
    const to = clamp(held.from + Math.round(dy / ROW_PITCH), 0, rowsRef.current.length - 1);
    if (Math.abs(dy) > 4) movedRef.current = true;
    if (dy === held.dy && to === held.to) return;
    dragRef.current = { ...held, to, dy };
    setDrag({ from: held.from, to, dy });
  }, []);

  const stopDrag = useCallback(() => {
    window.removeEventListener('pointermove', moveDrag);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
    const held = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!held || held.to === held.from) return;
    const next = [...rowsRef.current];
    next.splice(held.to, 0, next.splice(held.from, 1)[0]);
    engine.setUpcomingOrder(next);
    setRevision((value) => value + 1);
  }, [engine, moveDrag]);

  /*
   * The pointer is followed on the window rather than captured by the row: the rows
   * are rebuilt from the store while a drag is in flight, and a capture taken by a row
   * that has been replaced goes with it — which leaves the row parked where the finger
   * died and the order never committed.
   */
  const beginDrag = (event: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (!canDrag || event.button !== 0) return;
    event.preventDefault();
    movedRef.current = false;
    dragRef.current = { from: index, to: index, startY: event.clientY, dy: 0 };
    setDrag({ from: index, to: index, dy: 0 });
    window.addEventListener('pointermove', moveDrag);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', moveDrag);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    },
    [stopDrag],
  );

  /** Where a row sits while the drag is in flight: its own offset, or the gap it made. */
  const offsetFor = (index: number) => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -ROW_PITCH;
    if (drag.from > drag.to && index < drag.from && index >= drag.to) return ROW_PITCH;
    return 0;
  };

  const hint = shuffle
    ? 'Drag a row to change what plays next.'
    : 'Turn shuffle on to rearrange these.';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="liquid-glass-btn icon small squish"
        data-tip="Up Next"
        aria-label="Up Next"
      >
        <Icon name="queue" size={15} />
      </button>

      <MorphingGlassPanel
        triggerRef={triggerRef}
        idle={IDLE}
        open={OPEN}
        direction={panelDirection}
        align="center"
        project
      >
        <div className="queue-panel">
          <div className="queue-head">
            <span className="queue-title">Up Next</span>
            <span className="queue-sub">
              {rows.length === 0 ? 'nothing queued' : `${rows.length} to play`}
            </span>
          </div>

          <div className="queue-list">
            {rows.map((track, index) => (
              <div
                key={track.id}
                className="sidebar-row upnext-row"
                style={{ transform: `translateY(${offsetFor(index)}px)` }}
                data-dragging={drag?.from === index || undefined}
                onPointerDown={(event) => beginDrag(event, index)}
                onClick={() => {
                  if (movedRef.current) return;
                  void engine.playTrack(track);
                }}
              >
                <span className="upnext-pos">{index + 1}</span>
                <MediaThumb track={track} sync={false} className="upnext-cover" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-glass-text truncate">{track.name}</p>
                  <p className="text-xs text-glass-textMuted truncate">{track.artist}</p>
                </div>
                <span className="upnext-time">{formatTime(track.duration)}</span>
              </div>
            ))}
            {rows.length === 0 ? (
              <p className="upnext-empty">
                {queue.length === 0 ? 'Nothing queued yet.' : 'This is the last song.'}
              </p>
            ) : null}
          </div>

          {rows.length === 0 ? null : <p className="queue-hint">{hint}</p>}
        </div>
      </MorphingGlassPanel>
    </>
  );
};

export default QueueControl;
