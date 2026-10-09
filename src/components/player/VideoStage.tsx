import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import { formatTime } from '../../utils/formatTime';
import { getCachedPoster, loadVideoPoster } from '../../utils/videoPoster';
import { IS_OVERLAY_WINDOW } from '../../utils/windowRole';
import MediaThumb from '../ui/MediaThumb';
import TransportControls from './TransportControls';
import StatsControl from './StatsControl';
import RestartControl from './RestartControl';
import PitchEqControls from './PitchEqControls';
import VolumeControl from './VolumeControl';
import SpeedControl from './SpeedControl';
import QueueControl from './QueueControl';
import ViewSwitcher from '../ui/ViewSwitcher';

import WaveformProgress from './WaveformProgress';
import Icon from '../ui/Icon';
import { cardGlass } from '../../utils/glass';
import Elapsed from '../ui/Elapsed';

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * How long the video pill stays up after the last sign of the pointer.
 *
 * Three seconds, not the two a browsing surface would want: this sits over a
 * film, and a control bar that vanishes while you are still deciding whether you
 * meant to reach for it is worse than one that covers a few frames of picture.
 */
const VIDEO_PILL_HOLD_MS = 3000;

/** How close to the bottom edge counts as "reaching for the controls". */
const VIDEO_PILL_EDGE = 140;

/**
 * The video pill's own auto-hide, deliberately a separate mechanism from the
 * in-app pill's.
 *
 * `PlayerBar` has a `usePillAutoHide` hook that is switched off — the normal pill
 * is permanent, and the mini card and the fullscreen music pill are never meant
 * to move either. This is the only surface in the app that hides itself, so it
 * owns its own timer rather than sharing a hook the other modes pass
 * `enabled: false` to. Sharing it is how "the video pill hides" becomes "the
 * player pill hides too".
 *
 * Exported because the mini player's film borrows the same behaviour: controls
 * that stay out of the picture until the pointer asks for them.
 *
 * @param bounds The surface whose bottom edge means "reaching for the controls".
 *   It has to be asked for rather than read off `window.innerHeight`, because the
 *   mini card is 250px of a much larger transparent window: measured from the
 *   window the trigger band landed in the click-through gutter *below* the card,
 *   so the transport lit up from a pointer that was nowhere near the widget.
 */
export function useVideoPillVisibility(bounds?: () => DOMRect | null) {
  const pillRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(true);
  const hideTimer = useRef<number | null>(null);

  const arm = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
    }, VIDEO_PILL_HOLD_MS);
  }, []);

  /*
   * Revealing also *re-arms* the countdown.
   *
   * It used to cancel it, which meant the pill that a new film summons had no
   * timer left on it at all: it stayed over the picture indefinitely, and only a
   * later mouse movement put the hold back. Now "up for three seconds" means
   * three seconds from the moment it came up, whatever brought it up.
   */
  const reveal = useCallback(() => {
    setVisible(true);
    arm();
  }, [arm]);

  const schedule = useCallback(() => {
    if (hideTimer.current === null) arm();
  }, [arm]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const box = bounds?.() ?? null;
      /*
       * Anywhere inside the surface counts, when there is a surface to be
       * inside.
       *
       * The bottom-edge test was written for the takeover, where "the surface"
       * is the whole window and a band along its foot is the only thing that
       * reads as reaching for a control bar. The mini card borrowed the same
       * rule, and there the card is only ~225px tall — so the trigger band was
       * most of the widget, entering from the top lit nothing, and the pointer
       * had to travel two thirds of the way down the artwork before the
       * transport appeared. A card you have to reach into is a card you have
       * to aim at.
       */
      const inside = !!box
        && box.height > 0
        && event.clientX >= box.left
        && event.clientX <= box.right
        && event.clientY >= box.top
        && event.clientY <= box.bottom;
      const overPill = !!pillRef.current?.contains(event.target as Node);
      /*
       * With a surface to be inside, `inside` is the whole rule.
       *
       * The bottom-edge test used to run *as well*, against the surface's own
       * bottom — so a pointer in the transparent gutter below the mini card was
       * still within 140px of `box.bottom` and lit the transport. The reveal was
       * reaching outside the widget, which is the one thing a floating window
       * should never do: the picture answers to a cursor that is on somebody
       * else's desktop.
       *
       * With no surface to measure against — the fullscreen takeover, where the
       * window *is* the film — a band along the foot is still the right gesture.
       */
      if (box && box.height > 0) {
        if (inside || overPill) reveal();
      } else if (event.clientY >= window.innerHeight - VIDEO_PILL_EDGE || overPill) {
        reveal();
      }
      /*
       * Re-arm on *every* move, not only the ones away from the bottom.
       *
       * The spec is "hides after three seconds of inactivity", and inactivity is
       * measured from the last movement — so a pointer that arrives at the bottom
       * edge, reveals the pill, and then rests has to start the countdown too.
       * Revealing without re-arming left the pill up indefinitely after the first
       * trip to the bottom, which is the single case the feature exists for.
       */
      schedule();
    };
    const onLeave = () => setVisible(false);
    window.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    schedule();
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    };
  }, [bounds, reveal, schedule]);

  return { pillRef, visible, reveal, schedule };
}

/**
 * Hosts the engine's single <video> element: docked into the right column
 * while browsing, or stretched over the whole app when the user clicks it.
 * The element itself is never re-parented, so playback survives the switch.
 */
const VideoStage: React.FC = () => {
  const mediaHasVideo = usePlayerStore((s) => s.mediaHasVideo);
  /** The film is drawn by this page's own `<video>`, so the glass can sample it. */
  const filmInPage = usePlayerStore((s) => s.videoInPage);
  const fullscreen = usePlayerStore((s) => s.videoFullscreen);
  const nowPlayingFull = usePlayerStore((s) => s.nowPlayingFull);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const playbackError = usePlayerStore((s) => s.playbackError);
  const store = usePlayerStore.getState;
  const miniPlayer = usePlayerStore((s) => s.miniPlayer);
  const overlayRole = usePlayerStore((s) => s.overlayRole);
  /** Which page is up — the only thing that decides whether a slot exists. */
  const section = usePlayerStore((s) => s.section);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  /*
   * A still to paint the rectangle with before the decoder has produced a frame.
   *
   * The `<video>` element's own `poster` attribute only covers the picture box, and
   * the stage behind it is `#000` — so opening a film showed a black rectangle for
   * as long as the demuxer took, and the letterbox bars stayed black for the rest of
   * the clip. That is the user's "at the starting it just shows a black window".
   * Putting the still on the *host* fills the whole rounded box instead.
   *
   * The poster cache is keyed by file and is usually warm from thumbnailing, but a
   * video pinned seconds ago has none — and the track's own embedded artwork does,
   * so the fallback keeps the box from ever being black at all.
   */
  const [poster, setPoster] = useState<string | null>(null);
  useEffect(() => {
    const path = mediaHasVideo ? currentTrack?.path : null;
    if (!path) {
      setPoster(null);
      return;
    }
    setPoster(getCachedPoster(path) ?? currentTrack?.albumArt ?? null);
    if (getCachedPoster(path)) return;
    let stale = false;
    void loadVideoPoster(path).then((url) => {
      if (stale || !url) return;
      setPoster(url);
    });
    return () => { stale = true; };
  }, [mediaHasVideo, currentTrack?.path, currentTrack?.albumArt]);
  /*
   * When the mini card is open and this window is not in the takeover, the card is
   * showing the film — so the library's own rectangle shows the still instead.
   *
   * The element underneath is *not* paused. It is what the audio comes out of, and
   * the card's copy is muted, so stopping it would stop the film. Covering it is
   * the whole of "when the miniplayer starts playing the video, the video area in
   * normal mode doesn't get blacked out, it just keeps showing the thumbnail", and
   * because the decoder never stopped, closing the card uncovers a picture that is
   * already exactly where the film is — no hand-off, no seam, no catch-up.
   */
  const filmMirrored = !IS_OVERLAY_WINDOW && mediaHasVideo && overlayRole === 'mini' && !fullscreen;
  /**
   * The last rect the stage was docked to. Dropping the inline geometry in the
   * same commit that hides the box would collapse it before there is anything
   * left to animate, so the exit glide keeps using the final known position.
   */
  const lastRect = useRef<Rect | null>(null);
  const { pillRef, visible: pillVisible, reveal, schedule } = useVideoPillVisibility();

  useEffect(() => {
    if (mediaHasVideo) getEngine().mount(hostRef.current);
  }, [mediaHasVideo]);

  /*
   * The music takeover never carries a picture, so it never hands mpv a slot
   * either. `App` routes a video track out of that view; this is what makes the
   * view physically incapable of showing one, because the rect this element
   * reports *is* where the film is placed.
   *
   * Scoped to the takeover being *actually up*: once the video has claimed the
   * screen the music view is unmounted, and a bare `!nowPlayingFull` here would
   * have suppressed the pill the video mode needs to be driven at all.
   *
   * Mini is the exception that stays in: its film lives in this same stage,
   * docked to the rectangle the mini player cuts out for it.
   */
  const stageLive = mediaHasVideo && !(nowPlayingFull && !fullscreen);

  // Glue the docked box onto the slot that reserves its place in the layout
  useEffect(() => {
    if (!stageLive || fullscreen) return;
    /*
     * Only the page the user is *on* can ask for a picture.
     *
     * `PageStage` holds the outgoing page in the DOM for the whole length of the
     * gesture so the incoming one can land on top of it, and both layers are
     * siblings under the same root. A document-wide query therefore finds the
     * slot belonging to the page being left — which is exactly the overlay the
     * user kept seeing: play a video in Library, pause, go to Home, and the film
     * stayed glued to the library's card because that card was still mounted,
     * just on its way out, and nothing re-measured once it finally unmounted.
     */
    const findSlot = () =>
      document.querySelector('.page-layer:not(.page-leave) .video-slot.active')
      ?? document.querySelector('.mini-video-box');
    const measure = () => {
      /*
       * Mini has no library slot to dock into: its film fills the rectangle the
       * mini player cuts out for it, and that box is the anchor there.
       */
      const slot = findSlot();
      const root = document.querySelector('.app-root');
      if (!root) return;
      /*
       * No slot means this view is not asking for a picture, and the stage has
       * to say so out loud.
       *
       * It used to `return` here, which left `rect` holding the position the
       * previous page measured — so leaving Library for Home, which has no
       * docked rectangle at all, kept the stage glued to the slot the library
       * had just given up, and mpv's native window stayed painted exactly there,
       * above the page. A film that outlives its own card is the overlay the
       * user could not get rid of.
       */
      if (!slot) {
        lastRect.current = null;
        setRect(null);
        return;
      }
      const s = slot.getBoundingClientRect();
      const r = root.getBoundingClientRect();
      const next = { left: s.left - r.left, top: s.top - r.top, width: s.width, height: s.height };
      lastRect.current = next;
      setRect(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    const slot = findSlot();
    if (slot) observer.observe(slot);
    window.addEventListener('resize', measure);
    /*
     * Twice on purpose, and the second one has to outlast the page gesture.
     *
     * Both layers are mid-transform while they cross, and a rect taken from a
     * moving slot is the slot's *animated* box, not its layout box — which is
     * where the "the preview randomly misaligns" came from. 450ms catches a slot
     * that arrives with the card's own mount; 720ms is past `PageStage`'s 620ms,
     * so the box is measured once more with nothing in flight.
     */
    const early = window.setTimeout(measure, 450);
    const settle = window.setTimeout(measure, 720);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.clearTimeout(early);
      window.clearTimeout(settle);
    };
  }, [stageLive, fullscreen, currentTrack?.id, section]);

  /*
   * A new film is worth showing the controls for, and so is the moment the user
   * asks for the film to fill the screen — that click is the most interested
   * they have been all song, and making them wave the mouse at the bottom edge to
   * find the controls is a strange answer to it. Both reveal the strip, which then
   * holds for `VIDEO_PILL_HOLD_MS` and gets out of the way.
   */
  useEffect(() => {
    if (fullscreen) reveal();
  }, [currentTrack?.id, fullscreen, reveal]);

  /*
   * Tell the window — and the engine that places mpv's native window — that this
   * view is willing to give the picture the whole page. With the takeover up there
   * is nothing here worth painting over a film, so the layers that would cover it
   * come off (`.app-root.video-under` in the stylesheet), mpv drops below the
   * composited page, and the pill can be drawn on top of the picture rather than
   * in a dead band at its foot. `watchSlot` reads this same class, so the two
   * cannot disagree.
   */
  useEffect(() => {
    const root = document.querySelector('.app-root');
    if (!root) return;
    root.classList.toggle('video-under', fullscreen && stageLive);
    return () => root.classList.remove('video-under');
  }, [fullscreen, stageLive]);

  const docked = stageLive && !fullscreen;
  const takeover = fullscreen && stageLive;
  const anchor = docked ? rect : lastRect.current;
  const stageStyle: React.CSSProperties | undefined = {
    ...(!takeover && anchor
      ? {
          left: anchor.left,
          top: anchor.top,
          width: anchor.width,
          height: anchor.height,
          right: 'auto',
          bottom: 'auto',
        }
      : /*
         * Docked with nothing to dock to. Collapsed rather than left to the
         * stylesheet, because `.video-stage` is `position: absolute; inset: auto`
         * and with no inline box it grows to its content — 1522x1713 of stage
         * covering the page. `watchSlot` reads that zero and hands the picture
         * back, which is what stops a film following you onto a page that has
         * no rectangle for it.
         */
        docked
        ? { left: 0, top: 0, width: 0, height: 0, right: 'auto', bottom: 'auto' }
        : undefined),
    /*
     * The still goes on the host, not only on the element, so the whole rounded
     * rectangle has something in it from the first paint. It is handed over as
     * `--stage-poster` rather than as an inline `background-image` because the
     * inline form outranked `.video-stage.is-embedded`'s shorthand and left a
     * tiled mosaic over an mpv-drawn film — see the stylesheet.
     */
    ...(poster && stageLive
      ? ({ '--stage-poster': `url("${poster}")` } as React.CSSProperties)
      : undefined),
  };

  return (
    <>
      <div
        ref={hostRef}
        className={`video-stage ${takeover ? 'is-full' : 'is-docked'} ${stageLive ? '' : 'is-idle'} ${filmMirrored ? 'is-mirrored' : ''}`}
        style={stageStyle}
        data-no-capture
        title={docked && !miniPlayer ? 'Click to fill the app' : undefined}
        /*
         * Clicking the picture only ever *opens* it. It used to toggle, which made
         * the whole film a dismiss target — a stray click halfway through a video
         * threw the view away, and on a surface this large a stray click is not an
         * edge case. Closing is the collapse button's job now. Mini's film is
         * already the whole card, so there is no app left for it to fill.
         */
        onClick={() => {
          if (!fullscreen && !miniPlayer) store().setVideoFullscreen(true);
        }}
      >
        {docked && !miniPlayer && (
          <span className="video-dock-hint">
            <Icon name="expand" size={13} />
          </span>
        )}
      </div>

      {takeover && (
        <div
          ref={pillRef}
          className={`video-pill ${pillVisible ? '' : 'video-pill-hidden'}`}
          onMouseEnter={reveal}
          onMouseLeave={schedule}
          onClick={(e) => e.stopPropagation()}
        >
          {/*
           * Liquid glass when the film is page content, because then the shader has
           * real picture to bend and refracts it a frame at a time — the strip and
           * every dropdown under it show the film, not the artwork.
           *
           * mpv-only containers (`.ts`, `.mkv`, `.avi`) are the exception: their
           * picture is a native window, which is not something the scene pass can
           * read, and the app has no layer left to sample once the takeover is up.
           * A glass panel over an empty scene renders as a black slab, so those get
           * a plain translucent fill — the same answer the fullscreen music mode
           * gives when the shader cannot be honest.
           */}
          <div
            className={`video-pill-card ${filmInPage ? '' : 'is-frost'}`}
            data-glass={filmInPage ? '' : undefined}
            data-config={filmInPage ? cardGlass(30) : undefined}
            data-no-capture={filmInPage ? '' : undefined}
          >
            <div className="video-pill-row">
              <MediaThumb track={currentTrack} className="video-pill-art" />
              <div className="video-pill-meta">
                <p className="pill-title">{currentTrack?.name || 'Video'}</p>
                <p className="pill-artist">{currentTrack?.artist || ''}</p>
              </div>

              <TransportControls leading={<><StatsControl /><RestartControl /></>} />

              <div className="pill-right">
                {/*
                 * The same four modes the docked pill carries, plus the way out.
                 *
                 * Leaving them out of the takeover meant the one view you actually
                 * want to leave was the only view with no way to leave it but the
                 * cross — and the cross used to stand on its own at the end of a
                 * twenty-four-button row, where nothing about its position said
                 * "this one closes everything". It is a view control, so it lives
                 * with the view controls.
                 */}
                <ViewSwitcher
                  className="pill-view"
                  highlight
                  forVideo
                  tail={
                    <button
                      onClick={() => {
                        // Same pair as Esc: the takeover re-asserts the film if it
                        // is left up, so a lone `setVideoFullscreen(false)` looks dead.
                        if (usePlayerStore.getState().nowPlayingFull) store().setNowPlayingFull(false);
                        store().setVideoFullscreen(false);
                      }}
                      className="liquid-glass-btn icon small squish view-exit"
                      data-tip="Close this view (Esc)"
                      aria-label="Close this view"
                    >
                      <Icon name="close" size={13} />
                    </button>
                  }
                />
                <PitchEqControls />
                <SpeedControl />
                <QueueControl />
                <VolumeControl />
              </div>
            </div>

            <div className="video-pill-progress">
              <Elapsed />
              <WaveformProgress
                peaks={currentTrack?.waveformPeaks ?? []}
                duration={currentTrack?.duration || 0}
                trackId={currentTrack?.id}
                className="video-pill-wave"
              />
              <span className="pill-time end">{formatTime(currentTrack?.duration || 0)}</span>
            </div>
          </div>
        </div>
      )}

      {playbackError && currentTrack && (
        /* The entrance fades the wrapper, not the glass surface: an opacity
           animation on a `data-glass` element stalls its shader. */
        <div className="playback-error-anim">
          <div
            className="playback-error"
            data-glass
            data-config={cardGlass(22)}
            data-no-capture
          >
            <span className="playback-error-icon">
              <Icon name="music" size={16} />
            </span>
            <div className="playback-error-text">
              <p className="playback-error-title">{playbackError}</p>
              <p className="playback-error-sub">{currentTrack.name}</p>
            </div>
            <button
              className="liquid-glass-btn small-text squish"
              onClick={() => void window.electronAPI?.openPath(currentTrack.path)}
            >
              Open in default player
            </button>
            <button
              className="liquid-glass-btn icon small squish"
              onClick={() => usePlayerStore.setState({ playbackError: null })}
              data-tip="Dismiss"
              aria-label="Dismiss"
            >
              <Icon name="delete" size={13} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default VideoStage;
