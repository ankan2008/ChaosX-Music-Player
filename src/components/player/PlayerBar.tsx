import React, { useCallback, useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/formatTime';
import { getEngine } from '../../audio/engine';
import MediaThumb from '../ui/MediaThumb';
import WaveformProgress from './WaveformProgress';
import TransportControls from './TransportControls';
import StatsControl from './StatsControl';
import RestartControl from './RestartControl';
import { PitchControl, EqControl } from './PitchEqControls';
import ViewSwitcher from '../ui/ViewSwitcher';
import VolumeControl from './VolumeControl';
import SpeedControl from './SpeedControl';
import QueueControl from './QueueControl';
import Elapsed from '../ui/Elapsed';
import { transportGlass } from '../../utils/glass';

/** Matches the 46 px `border-radius` the stylesheet gives the capsule. */
const TRANSPORT_GLASS = transportGlass(46);

/**
 * The Dynamic-Island-style player pill: a floating, translucent glass bar
 * centred over the bottom of the window. It is the element the WebGL liquid
 * glass shader renders, so its own content stays flat/live (data-no-capture)
 * while the glass itself refracts whatever is behind it.
 *
 * It never hides itself. The only surface in the app that does is the fullscreen
 * *video* pill, which has to get out of the way of a film; this one sits over the
 * library, and a bar that slides away under a list you are scrolling is a bar you
 * then have to go hunting for.
 *
 * The view picker lives at the head of the control block, between repeat and
 * pitch. It used to be a card in the sidebar, which put the mode you are leaving
 * on the far side of the window from the transport you are pressing — and cost a
 * card in a column that had to be scrolled to read.
 */
const PlayerBar: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const videoFullscreen = usePlayerStore((s) => s.videoFullscreen);
  const nowPlayingFull = usePlayerStore((s) => s.nowPlayingFull);

  /*
   * Wheel over the seek strip to scrub.
   *
   * Bound to the progress row rather than the whole pill so a wheel over a
   * button stays a wheel over a button. `passive: false` is required — the
   * default would let the gesture also scroll whatever is behind the pill.
   *
   * The step is a fraction of the track, not a fixed number of seconds, so one
   * notch covers the same ground on a 40-second demo as on a 90-minute lecture.
   *
   * Wired from a callback ref because this bar unmounts itself in the two
   * takeover views: an effect with an empty dependency list would run once,
   * find no node, and never attach.
   */
  const wheelRef = useRef<{ el: HTMLDivElement; off: () => void } | null>(null);
  const attachProgress = useCallback((el: HTMLDivElement | null) => {
    wheelRef.current?.off();
    wheelRef.current = null;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const duration = usePlayerStore.getState().currentTrack?.duration || 0;
      if (duration <= 0) return;
      event.preventDefault();
      const notch = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const step = Math.max(2, duration * 0.01) * (notch > 0 ? -1 : 1);
      void getEngine().seekBy(step);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    wheelRef.current = { el, off: () => el.removeEventListener('wheel', onWheel) };
  }, []);

  /*
   * No cleanup effect. React calls a callback ref with `null` when the node
   * goes away, which is the detach — and under StrictMode the mount/unmount/
   * remount pair runs the effect cleanup *after* the ref has already attached
   * and before it is called again, so an `off()` here silently unhooked the
   * gesture on the first render of every session.
   */
  if (videoFullscreen || nowPlayingFull) return null;

  return (
    <footer className="player-pill" data-no-capture data-no-scene data-config={TRANSPORT_GLASS}>
      <div className="pill-row pill-row-main">
        {/*
         * The cover is the door to the takeover view, and the mode has no
         * takeover view. `setView` refuses it, so the click would already do
         * nothing — but a button whose tooltip promises a page it will not show is
         * the one thing a disabled affordance must never be, so it stops being a
         * button here and stays a picture.
         */}
        <button
          className="pill-art-btn"
          onClick={() => usePlayerStore.getState().setNowPlayingFull(true)}
          data-tip="Now playing view"
          aria-label="Open now playing view"
        >
          <MediaThumb track={currentTrack} className="pill-art" />
        </button>
        <div className="pill-meta">
          {/* Artist is deliberately absent: the pill's job is the title, and it
              gets the width the artist line used to take. */}
          <p className="pill-title">{currentTrack?.name || 'Nothing playing'}</p>
        </div>

        {/*
         * The view picker and the statistics flyout both sit at the ends of this
         * row. They are the two things on it that open something rather than
         * control the record, so they are the first things a narrow window drops —
         * but nothing drops them by default any more.
         */}
        <TransportControls
          leading={
            <>
              <StatsControl />
              <RestartControl />
            </>
          }
        />

        <div className="pill-right">
          <ViewSwitcher className="pill-view" highlight />

          {/* Pitch and speed side by side — both are "how fast does this play" —
              then Up Next, then the speaker, and the equalizer last because it is
              the one that opens a panel and wants clear air on the side it opens
              from. Same order as the takeover bar above, so the hand finds the
              queue in the same place in both.

              Up Next used to be left out here on the argument that the library is
              already on screen behind the pill. That argument did not survive
              using it: the panel is not the library, it is the six rows the deck
              is about to play, which the list does not show unless you have
              already worked out the shuffle order for yourself. */}
          <PitchControl />
          <SpeedControl />
          <QueueControl />
          <VolumeControl />
          <EqControl />
        </div>
      </div>

      <div className="pill-row pill-row-progress" ref={attachProgress}>
        <Elapsed />
        <WaveformProgress
          peaks={currentTrack?.waveformPeaks ?? []}
          duration={currentTrack?.duration || 0}
          trackId={currentTrack?.id}
          className="pill-wave"
        />
        <span className="pill-time end">{formatTime(currentTrack?.duration || 0)}</span>
      </div>
    </footer>
  );
};

export default PlayerBar;
