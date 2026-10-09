import React, { useRef } from 'react';
import { useLyrics } from '../../hooks/useLyrics';
import { useRemoteLyrics } from '../../hooks/useRemoteLyrics';
import { usePlayerStore } from '../../stores/playerStore';
import { cardGlass } from '../../utils/glass';
import Icon from '../ui/Icon';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import { usePlaybackPosition } from '../../hooks/usePlaybackPosition';

/** Idle and settled shapes for the timing flyout, in CSS pixels. */
const TIMING_IDLE = { width: 118, height: 30, radius: 15 };
const TIMING_OPEN = { width: 336, height: 108, radius: 20 };

/** The offset range, in milliseconds, either side of zero. */
const TIMING_MAX = 20000;

/**
 * A button that keeps going while it is held.
 *
 * One millisecond is the right step for a line that is very slightly off, and
 * the wrong one for a sheet that is four seconds out: clicking it into place
 * takes a hundred presses. Holding the same button repeats it — slow to start so
 * a deliberate press still means one step, then accelerating — which is what
 * makes the ±20s range usable rather than just available.
 */
const HoldButton: React.FC<{
  label: string;
  tip: string;
  onStep: () => void;
}> = ({ label, tip, onStep }) => {
  const timer = useRef(0);
  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = 0;
  };
  React.useEffect(() => stop, []);

  const start = () => {
    onStep();
    stop();
    let delay = 340;
    const arm = () => {
      timer.current = window.setTimeout(() => {
        onStep();
        delay = Math.max(24, delay * 0.82);
        arm();
      }, delay) as unknown as number;
    };
    arm();
  };

  return (
    <button
      type="button"
      className="lyrics-step"
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStep();
        }
      }}
      data-tip={tip}
      aria-label={tip}
    >
      {label}
    </button>
  );
};

const LyricsView: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackPosition = usePlaybackPosition();

  const lyrics = currentTrack?.lyrics ?? null;
  const plainLyrics = currentTrack?.plainLyrics ?? null;
  const { state, importFromFile, acceptDrop, downloadToFile, deleteFile, refresh } =
    useRemoteLyrics();
  const [notice, setNotice] = React.useState<string | null>(null);
  const timingRef = useRef<HTMLButtonElement | null>(null);
  const lyricsOffsetMs = usePlayerStore((s) => s.lyricsOffsetMs);
  const setLyricsOffset = usePlayerStore((s) => s.setLyricsOffset);
  const lyricsFlat = usePlayerStore((s) => s.lyricsFlat);
  const setLyricsFlat = usePlayerStore((s) => s.setLyricsFlat);

  const { activeLineIndex, hasLyrics, scrollContainerRef, sheetRef } = useLyrics(
    lyrics,
    isPlaying,
    playbackPosition,
    lyricsFlat,
  );

  /*
   * The save and the delete report where the file went, or that it failed.
   * A write to a read-only folder, or to a path the user cannot write, answers
   * with nothing at all otherwise — and "did it save?" is not something anyone
   * should have to guess at.
   */
  const save = async () => {
    const p = await downloadToFile();
    setNotice(p ? `Saved ${p.split(/[\\/]/).pop()}` : 'Could not save — the folder refused the write');
  };
  const remove = async () => {
    const p = await deleteFile();
    setNotice(
      p
        ? `Deleted ${p.split(/[\\/]/).pop()}`
        : 'Nothing was deleted — the file is still there, or the folder refused it',
    );
  };
  React.useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  /*
   * Six controls, no heading and no source label.
   *
   * The card already says what it holds by holding it, and the two lines of
   * lettering above the row were costing the sheet two rows of words on a panel
   * that only ever shows seven. The grid is the layout in both modes — six
   * columns in the library's own lyrics card, three by two in the takeover view —
   * and the order below is the order they land in either case.
   */
  const actions = (
    <div className={`lyrics-actions${hasLyrics ? '' : ' is-brief'}`}>
      <button
        type="button"
        className="lyrics-import"
        onClick={importFromFile}
        data-tip="Import a .lrc or .txt file"
        aria-label="Import lyrics from a file"
      >
        <Icon name="plus" size={13} />
        Import
      </button>
      {hasLyrics || plainLyrics ? (
        <button
          type="button"
          className="lyrics-import"
          onClick={() => void save()}
          data-tip="Save these lyrics as an .lrc beside the song"
          aria-label="Save lyrics to the song's folder"
        >
          <Icon name="download" size={13} />
          Save
        </button>
      ) : null}
      {hasLyrics || plainLyrics ? (
        <button
          type="button"
          className="lyrics-import"
          onClick={() => void remove()}
          data-tip="Delete the .lrc beside the song"
          aria-label="Delete the lyrics file"
        >
          <Icon name="delete" size={13} />
          Delete
        </button>
      ) : null}
      {/*
       * Read-all mode. A sheet whose timings do not fit this recording highlights
       * the wrong line once a bar, which is worse than no highlight at all — so
       * this takes the travelling glass away and puts every line at the same
       * weight, size and brightness, and leaves the panel still.
       *
       * The label names the reading you are about to get, which is why it changes
       * when pressed: "All At Once" is what the press gives you, and once you are
       * there the press gives you the other one back.
       *
       * Gone when there is no sheet, because with nothing on the page the two
       * readings are the same reading and the control is a choice between two
       * nothings.
       */}
      {hasLyrics || plainLyrics ? (
        <button
          type="button"
          className={`lyrics-import lyrics-flat-toggle ${lyricsFlat ? 'is-on' : ''}`}
          onClick={() => setLyricsFlat(!lyricsFlat)}
          aria-pressed={lyricsFlat}
          data-tip={
            lyricsFlat ? 'Follow one line at a time' : 'Show every line at the same weight'
          }
        >
          <Icon name="lyrics" size={13} />
          <span className="lyrics-flat-label">{lyricsFlat ? 'Line By Line' : 'All At Once'}</span>
        </button>
      ) : null}
      {hasLyrics ? (
        <button
          ref={timingRef}
          type="button"
          className="lyrics-import"
          data-tip="Shift the lyric timing for this session"
          aria-label="Lyrics timing"
        >
          <Icon name="clock" size={13} />
          Lyrics timing
        </button>
      ) : null}
      <button
        type="button"
        className="lyrics-import"
        onClick={refresh}
        disabled={state === 'searching'}
        data-tip="Search LRCLIB again for this track"
        aria-label="Search LRCLIB again"
      >
        <Icon name="refresh" size={13} />
        Refresh
      </button>
    </div>
  );

  /*
   * The timing flyout is outside the action grid.
   *
   * It used to sit beside its trigger inside the row, where a grid cell was just
   * waiting to be filled by something that is not a button — and in the takeover
   * view's three-column layout it pushed Refresh onto a row of its own.
   */
  const timingFlyout = hasLyrics ? (
    <MorphingGlassPanel triggerRef={timingRef} idle={TIMING_IDLE} open={TIMING_OPEN} direction="up" align="right">
      <div className="lyrics-timing">
        {/*
         * One millisecond a step, because that is what a lyric line being
         * "slightly off" actually is. A coarser step overshoots in one click and
         * the user has no way back to where they were; the slider spans ±20s so a
         * sheet written for a different recording is still reachable, and the two
         * buttons either end nudge past the pointer's resolution — and keep going
         * when held.
         */}
        <HoldButton
          label="-1ms"
          tip="Earlier — hold to keep stepping"
          onStep={() => setLyricsOffset(Math.max(-TIMING_MAX, lyricsOffsetMs - 1))}
        />
        <input
          type="range"
          className="glass-slider lyrics-timing-slider"
          min={-TIMING_MAX}
          max={TIMING_MAX}
          step={1}
          value={lyricsOffsetMs}
          onChange={(e) => setLyricsOffset(parseInt(e.target.value, 10))}
          style={{ '--progress': `${((lyricsOffsetMs + TIMING_MAX) / (TIMING_MAX * 2)) * 100}%` } as React.CSSProperties}
          aria-label="Lyrics timing offset"
        />
        <HoldButton
          label="+1ms"
          tip="Later — hold to keep stepping"
          onStep={() => setLyricsOffset(Math.min(TIMING_MAX, lyricsOffsetMs + 1))}
        />
        <span className="lyrics-timing-value">
          {lyricsOffsetMs > 0 ? '+' : ''}
          {lyricsOffsetMs} ms
        </span>
        {lyricsOffsetMs !== 0 ? (
          /*
           * Only offered once there is something to undo. A manual offset is a
           * patch over a sheet that drifted — from a seek that landed mid-line, a
           * fetch that arrived late, or a tempo the file was not written for — and
           * this drops the patch and asks LRCLIB again from scratch rather than
           * just zeroing the number.
           */
          <button
            type="button"
            className="lyrics-import timing-reset"
            onClick={() => {
              setLyricsOffset(0);
              refresh();
            }}
            data-tip="Drop the offset and fetch the sheet again"
            aria-label="Resync lyrics"
          >
            <Icon name="refresh" size={12} />
            Resync
          </button>
        ) : null}
      </div>
    </MorphingGlassPanel>
  ) : null;


  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      acceptDrop(event.dataTransfer.files);
    },
  };

  if (!hasLyrics && !plainLyrics) {
    const searching = state === 'searching';
    return (
      <section
        className="liquid-glass-card small lyrics-panel flex items-center justify-center"
        data-glass
        data-config={cardGlass(20)}
        data-no-capture
        {...dropProps}
      >
        <div className="lyrics-empty">
          <p className="text-glass-textMuted text-sm">
            {!currentTrack
              ? 'Play something to see lyrics'
              : state === 'hidden'
                ? 'Lyrics hidden for this song'
                : searching
                  ? 'Searching LRCLIB…'
                  : state === 'missing'
                    ? 'No lyrics found for this track'
                    : 'Loading lyrics…'}
          </p>
          {currentTrack && !searching && actions}
          {notice && <p className="lyrics-notice">{notice}</p>}
        </div>
      </section>
    );
  }

  if (plainLyrics && !hasLyrics) {
    return (
      <section
        className="liquid-glass-card small lyrics-panel flex flex-col"
        data-glass
        data-config={cardGlass(20)}
        data-no-capture
        {...dropProps}
      >
        <div className="lyrics-head">{actions}</div>
        {notice && <p className="lyrics-notice">{notice}</p>}
        <div className="flex-1 overflow-y-auto text-sm text-glass-textMuted leading-relaxed whitespace-pre-wrap px-1">
          {plainLyrics}
        </div>
      </section>
    );
  }

  return (
    <section
      className="liquid-glass-card small lyrics-panel flex flex-col"
      data-glass
      data-config={cardGlass(20)}
      data-no-capture
      {...dropProps}
    >
      <div className="lyrics-head">{actions}</div>
      {timingFlyout}
      {notice && <p className="lyrics-notice">{notice}</p>}
      <div
        ref={scrollContainerRef as React.RefObject<HTMLDivElement>}
        className={`flex-1 overflow-y-auto lyrics-scroll px-2 ${lyricsFlat ? 'is-flat' : ''}`}
      >
        {/*
           The line being sung, carried on a sheet of real glass that travels
           between rows — the same treatment the song list gives its playing
           row, and the reason the two surfaces read as one system. It lives
           inside the scroller in content space so it scrolls with the text
           rather than being re-derived from the scroll offset every frame.
         */}
        <div
          ref={sheetRef as React.RefObject<HTMLDivElement>}
          className="lyric-glass"
          data-glass
          data-config={cardGlass(12)}
          aria-hidden
        />
        {lyrics?.map((line, i) => {
          const isActive = i === activeLineIndex;
          return (
            <div
              key={`${line.time_ms}-${i}`}
              className={`lyric-line ${lyricsFlat || !isActive ? '' : 'active'}`}
            >
              {line.text || '♪'}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default LyricsView;
