import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/formatTime';
import TransportControls from './TransportControls';
import StatsControl from './StatsControl';
import RestartControl from './RestartControl';
import WaveformProgress from './WaveformProgress';
import VolumeControl from './VolumeControl';
import { EqControl, PitchControl } from './PitchEqControls';
import SpeedControl from './SpeedControl';
import QueueControl from './QueueControl';
import ViewSwitcher from '../ui/ViewSwitcher';
import Icon from '../ui/Icon';
import GlassClock from '../ui/GlassClock';
import MediaThumb from '../ui/MediaThumb';
import LyricsView from '../lyrics/LyricsView';
import QuoteCard from '../widgets/QuoteCard';
import VinylBackground from '../backdrop/VinylBackground';
import Elapsed from '../ui/Elapsed';

/**
 * Spicetify-style takeover. The room *is* the record: the artwork wrapped onto
 * an oversized vinyl turning behind a frosted card, with the player on top.
 *
 * Nothing here is on the WebGL shader. Its backdrop turns every frame, so every
 * panel would have to re-capture the scene every frame to keep up; plain
 * `backdrop-filter` is cheaper and cannot go stale. See the frost block at the
 * foot of `liquid-glass.css`.
 */
const NowPlayingFull: React.FC = () => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const lyricsEnabled = usePlayerStore((s) => s.lyricsEnabled);
  const clockInFullscreen = usePlayerStore((s) => s.clockInFullscreen);
  const quotesInFullscreen = usePlayerStore((s) => s.quotesInFullscreen);

  /*
   * The caption is gone while the takeover is up, and taking it away is the whole
   * reason the taskbar goes with it — the shell hides its bar for a window that has
   * no caption, no sizing border and a rectangle over the monitor, which is the
   * only mechanism on Windows that gets the bar out of the way *and* brings it back
   * when the pointer reaches the bottom edge. Electron's own fullscreen paths leave
   * the bar painted across the bottom of the page on a transparent window.
   *
   * But a window with no caption has no minimize, no restore and no close, and no
   * edge to drag it by. So the takeover grows its own, out of the way until the
   * pointer goes to the top of the screen — the same arrangement every film player
   * uses, and the reason the bar below carries `-webkit-app-region: drag`.
   */
  const [caption, setCaption] = React.useState(false);
  React.useEffect(() => {
    const onMove = (e: MouseEvent) => {
      /*
       * Two thresholds rather than one. A single cut-off makes the bar flicker
       * while the pointer travels along it, because the bar itself is what the
       * pointer is over — so it stays out once it is out, and only a move clearly
       * back into the page calls it in.
       */
      if (e.clientY <= 6) setCaption(true);
      else if (e.clientY > 58) setCaption(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  return (
    <div className="npf-root" data-no-capture>
      <div className={`npf-caption${caption ? ' is-out' : ''}`} data-no-capture>
        <span className="npf-caption-title">ChaosX</span>
        <span className="npf-caption-drag" aria-hidden />
        <button
          type="button"
          className="npf-cap-btn"
          aria-label="Minimize"
          data-tip="Minimize"
          onClick={() => void window.electronAPI?.minimizeWindow()}
        >
          <i className="cap-min" />
        </button>
        <button
          type="button"
          className="npf-cap-btn"
          aria-label="Restore"
          data-tip="Leave fullscreen"
          onClick={() => {
            /*
             * Not `maximizeWindow()`. This bar only exists while the takeover is
             * up, and the window is already the whole monitor with its caption
             * stripped — so asking Windows to maximize it is a no-op, which is the
             * dead button. What the middle button means here is "put the window
             * back", and putting it back means leaving the view that took it over.
             * `setImmersive(false)` then restores the frame and the size it had
             * before, maximised if that is how it was left.
             */
            const s = usePlayerStore.getState();
            if (s.videoFullscreen) s.setVideoFullscreen(false);
            if (s.nowPlayingFull) s.setNowPlayingFull(false);
          }}
        >
          <i className="cap-max" />
        </button>
        <button
          type="button"
          className="npf-cap-btn is-close"
          aria-label="Close"
          data-tip="Close"
          onClick={() => void window.electronAPI?.closeWindow()}
        >
          <i className="cap-x" />
        </button>
      </div>
      {/* The cover is blurred *before* it is wrapped onto the disc, so the
          record reads as a soft wash of the artwork rather than a stretched
          sleeve. The grooves are drawn after the blur, which is what keeps the
          turn legible — see the bake order in VinylBackground. */}
      <VinylBackground
        art={currentTrack?.albumArt ?? null}
        playing={isPlaying}
        blurPx={18}
      />
      <div className="npf-shade" />

      <div className="npf-body">
        <div className="npf-left">
          <MediaThumb track={currentTrack} className="npf-art" />
          <div className="npf-meta">
            <p className="npf-title">{currentTrack?.name || 'Nothing playing'}</p>
            <p className="npf-artist">
              {currentTrack?.artist || 'ChaosX'}
              {currentTrack?.album ? ` — ${currentTrack.album}` : ''}
            </p>
          </div>

          <div className="npf-wave-row">
            <Elapsed />
            <WaveformProgress
              peaks={currentTrack?.waveformPeaks ?? []}
              duration={currentTrack?.duration || 0}
              trackId={currentTrack?.id}
              className="npf-wave"
            />
            <span className="pill-time end">{formatTime(currentTrack?.duration || 0)}</span>
          </div>

          {/* Live frost over the turning record, deliberately not shader glass —
              see the `.npf-root` branch of `syncGlass` in App.tsx for the cost
              and the look that decided it. */}
          <div className="npf-bar">
            <TransportControls leading={<><StatsControl /><RestartControl /></>} />
            {/*
             * One strip, like the docked pill.
             *
             * The view buttons used to sit under it in their own glass capsule,
             * which cost a row of the column's height and read as a second player
             * parked below the first. They are the same four modes in the same
             * order, now inline with the transport they belong to.
             */}
            <div className="npf-extra">
              <ViewSwitcher
                className="npf-switcher"
                /*
                 * The same cross the film's pill carries. The takeover used to be
                 * left with no way out but pressing the mode button it was already
                 * lit on — which is the one control that looks like it should work
                 * and does nothing, because the mode is not changing.
                 */
                tail={
                  <button
                    type="button"
                    onClick={() => usePlayerStore.getState().setNowPlayingFull(false)}
                    className="liquid-glass-btn icon small squish view-exit"
                    data-tip="Close this view"
                    aria-label="Close this view"
                  >
                    <Icon name="close" size={13} />
                  </button>
                }
              />
              {/*
               * The two rates, then the queue, then the speaker and the equalizer at
               * the end — the same order the docked pill uses, so the hand never has
               * to look for a button it already knows. Volume and equalizer used to
               * sit outside this container, which is why the equalizer landed past
               * the capsule's edge instead of in the row.
               */}
              <PitchControl />
              <SpeedControl />
              <QueueControl />
              <VolumeControl />
              <EqControl />
            </div>
          </div>

          {/*
           * The clock and the quote answer to their own switches here and to nothing
           * else — `clockEnabled` and `quotesEnabled` belong to the sidebar. The
           * takeover is the artwork's page, and a person who wants the time over the
           * sleeve but not beside the track list, or the other way round, should be
           * able to say so twice rather than get one answer for both rooms.
           */}
          {clockInFullscreen && (
            <div className="liquid-glass-card npf-clock-card">
              <GlassClock digitHeight={54} className="npf-clock" plainDate />
            </div>
          )}

          {/*
           * The sidebar's own card, mounted here rather than redrawn. `QuoteCard`
           * reads the rotation out of the store — the hour bucket, the shuffled
           * order, the position in it — so the line in the takeover is the same line
           * the sidebar is showing and advances at the same moment, from one source.
           */}
          {quotesInFullscreen && (
            <div className="npf-quote">
              <QuoteCard />
            </div>
          )}
        </div>

        {/* The whole column goes with the switch, not just the card: an empty
            right half would leave the takeover's grid holding a gap where the
            words used to be. */}
        {lyricsEnabled && (
          <div className="npf-right">
            <LyricsView />
          </div>
        )}
      </div>
    </div>
  );
};

export default NowPlayingFull;
