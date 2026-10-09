import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { useLyrics } from '../../hooks/useLyrics';
import { useRemoteLyrics } from '../../hooks/useRemoteLyrics';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import Icon from '../ui/Icon';
import LyricsFlatButton from './LyricsFlatButton';
import { panelDirection } from '../../utils/surface';
import type { Track } from '../../types';
import { usePlaybackPosition } from '../../hooks/usePlaybackPosition';

const IDLE = { width: 34, height: 34, radius: 11 };
const OPEN = { width: 300, height: 420, radius: 22 };

/**
 * The lyrics of the playing track, in a card that leaves the pill sideways.
 *
 * It hangs off the cover rather than a button of its own because the strip has
 * no spare cell — every one of them is a transport control — and the cover is
 * already the "what is playing" object. Same gesture as the mini card, where
 * tapping the artwork is what brings the words up.
 */
const PillLyricsCard: React.FC<{
  triggerRef: React.RefObject<HTMLElement>;
  track: Track | null;
}> = ({ triggerRef, track }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const flat = usePlayerStore((s) => s.lyricsFlat);
  const position = usePlaybackPosition();
  const lyrics = track?.lyrics ?? null;
  const plain = track?.plainLyrics ?? null;
  const { activeLineIndex } = useLyrics(lyrics, isPlaying, position, flat);
  /*
   * The words are fetched by whoever displays them, and this card is the only
   * thing in the widget that does. Without it the pill could never show lyrics at
   * all: the library window's copy of the track is a different object in a
   * different renderer, and only ids cross between them.
   */
  const { state, refresh } = useRemoteLyrics();
  /*
   * The card re-renders a window of lines but never moves the scroll position, so
   * a song past the first screen showed the same three lines forever. Scrolling
   * the active line to the middle is what gives the panel its slide, and
   * `scroll-behavior: smooth` on the container is what makes it eased rather than
   * jumped.
   *
   * The target is measured against the box, not against the page. This used to read
   * `line.offsetTop - box.offsetTop` and *add* it to `scrollTop`, which is wrong
   * twice over: `offsetTop` is a layout position that does not move with scroll, so
   * line forty is 1,200 px down the content whatever the box is showing, and adding
   * that to the current position every time the line changes races the words far
   * ahead of the singer and parks the panel at its own bottom. Rectangles are the
   * honest measurement here because they already carry the transform and the scroll
   * of every ancestor, and the box's own `scrollTop` converts the answer back into
   * content coordinates.
   */
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const activeRef = React.useRef<HTMLParagraphElement | null>(null);
  React.useEffect(() => {
    const box = scrollRef.current;
    const line = activeRef.current;
    if (!box || !line) return;
    const within =
      line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const target = within - (box.clientHeight - line.clientHeight) / 2;
    box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, target));
  }, [activeLineIndex, lyrics?.length]);

  return (
    <MorphingGlassPanel
      triggerRef={triggerRef}
      idle={IDLE}
      open={OPEN}
      direction={panelDirection}
      align="center"
    >
      <div className="pill-lyrics">
        <div className="pill-lyrics-head-row">
          <p className="pill-lyrics-head">{track?.name || 'Nothing playing'}</p>
          <div className="pill-lyrics-tools">
            <button
              type="button"
              className="lyrics-refresh-btn"
              onClick={refresh}
              disabled={state === 'searching'}
              data-tip="Search LRCLIB again"
              aria-label="Search LRCLIB again"
            >
              <Icon name="refresh" size={12} />
            </button>
            <LyricsFlatButton />
          </div>
        </div>
        <div className={`pill-lyrics-scroll${flat ? ' is-flat' : ''}`} ref={scrollRef}>
          {!lyrics || lyrics.length === 0 ? (
            /*
             * A sheet with no timestamps is still the words to this song, and the
             * library knows that — `LyricsView` has a whole branch for it. This card
             * only ever looked at `track.lyrics`, so an untimed file rendered as
             * "No words for this track yet" in the widget while the same song showed
             * every line in the library.
             */
            plain ? (
              <p className="pill-lyrics-plain">{plain}</p>
            ) : (
              <p className="pill-lyrics-empty">
                {state === 'searching' ? 'Looking for the words…' : 'No words for this track yet.'}
              </p>
            )
          ) : (
            lyrics.map((line, i) => {
              const step = flat || i !== activeLineIndex ? '' : 'active';
              return (
                <p
                  key={`${i}-${line.time_ms}`}
                  ref={i === activeLineIndex ? activeRef : null}
                  className={`pill-lyrics-line ${step}`}
                >
                  {line.text}
                </p>
              );
            })
          )}
        </div>
      </div>
    </MorphingGlassPanel>
  );
};

export default PillLyricsCard;
