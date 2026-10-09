import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { usePlayerStore } from './stores/playerStore';
import { createGlassEngine, type GlassEngine } from './glass';
import { setGlassEngine } from './glass/scene';
import { mountDesktopBackdrop, prewarmCapture } from './glass/capture';
import { useBackdropImage } from './hooks/useBackdropImage';
import Sidebar from './components/layout/Sidebar';
import SetupWizard from './components/onboarding/SetupWizard';
import PlayerBar from './components/player/PlayerBar';
import TransportControls from './components/player/TransportControls';
import StatsControl from './components/player/StatsControl';
import { EqControl, PitchControl } from './components/player/PitchEqControls';
import SpeedControl from './components/player/SpeedControl';
import VolumeControl from './components/player/VolumeControl';
import QueueControl from './components/player/QueueControl';
import WaveformProgress from './components/player/WaveformProgress';
import PillButton from './components/player/PillButton';
import BackdropLayer from './components/backdrop/BackdropLayer';
import VinylBackground from './components/backdrop/VinylBackground';
import { SearchBar } from './components/ui/SearchBar';
import PageStage from './components/layout/PageStage';
import SettingsPanel from './components/settings/SettingsPanel';
import { LibraryPage, StatisticsPage } from './components/pages/AppPages';
import HomePage from './components/pages/HomePage';
import { SongList } from './components/player/SongList';
import PillLyricsCard from './components/lyrics/PillLyricsCard';
import LyricsRefreshButton from './components/lyrics/LyricsRefreshButton';
import LyricsFlatButton from './components/lyrics/LyricsFlatButton';
import VideoStage from './components/player/VideoStage';
import NowPlayingFull from './components/player/NowPlayingFull';
import DropZone from './components/ui/DropZone';
import Icon from './components/ui/Icon';
import PageHead from './components/ui/PageHead';
import GlassButton from './components/ui/GlassButton';
import ViewSwitcher from './components/ui/ViewSwitcher';
import WindowControls from './components/ui/WindowControls';
import MediaThumb from './components/ui/MediaThumb';
import { dismissActivePanel } from './components/ui/MorphingGlassPanel';
import { useSceneRgb } from './hooks/useSceneColour';
import { useLibrary } from './hooks/useLibrary';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useMediaSession } from './hooks/useMediaSession';
import { useSceneScrim } from './hooks/useSceneScrim';
import { useLyrics } from './hooks/useLyrics';
import { getEngine } from './audio/engine';
import { cardGlass } from './utils/glass';
import { audioOnly, buildFolderRank, orderLibrary } from './utils/sorting';
import { IS_PILL_WINDOW, IS_MINI_WINDOW, IS_OVERLAY_WINDOW, WINDOW_ROLE } from './utils/windowRole';
import { extractAccentRgb } from './utils/accentColor';
import { publishThumbIcons } from './utils/thumbIcons';
import { formatTime } from './utils/formatTime';
import type { Track, ViewMode } from './types';
import { usePlaybackPosition } from './hooks/usePlaybackPosition';

/**
 * How long two layouts overlap while a mode switch glides.
 *
 * This is the mount lifetime of the layer being left, not a duration of anything:
 * `modeOut` is 0.58s and unmounting early cuts it mid-scale, which is the pop the
 * transition used to end on. `--fly-ms` and `--fly-out-ms` in `globals.css` have
 * to stay at or under this.
 */
const MODE_GLIDE_MS = 640;

/**
 * The gutter around the mini card; the window is the card plus this on all sides.
 *
 * It used to be 64px on three sides and 404 on the top, to give a flyout somewhere
 * to go. That bought one thing and cost the widget its position range: Windows keeps
 * a dragged window inside the work area, so with 404px of dead transparent window
 * above the card the card's own top edge could never be raised past y=404, and its
 * bottom could never reach the taskbar. The user read that as "the top and bottom
 * full horizontal area is blocked".
 *
 * The room is gone. Dropdowns open inside the card now (see
 * `MorphingGlassPanel`'s `project` prop), which is where they belong anyway, and
 * the queue — the one panel that still leaves — scales to fit the window.
 */

/**
 * Whether the pointer is on the widget, as the main process reports it.
 *
 * Not `mousemove` in this renderer: the card is `-webkit-app-region: drag` across
 * nearly its whole surface, and the window turns click-through the moment the
 * cursor leaves the boxes the widget reports, so a click-through window is not
 * told where the mouse is and the page sees events only intermittently. The poll
 * that routes those clicks already reads the real desktop cursor and says so here,
 * which makes "hover anywhere inside the card" true for both widgets instead of
 * only for the band the pointer happens to cross while events are flowing.
 */
function useOverlayHover() {
  const [over, setOver] = useState(false);
  useEffect(() => window.electronAPI?.overlay?.onHover?.(setOver) ?? undefined, []);
  return over;
}

function MiniPlayer() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackPosition = usePlaybackPosition();
  const showLyrics = usePlayerStore((s) => s.miniLyrics);
  const lyricsFlat = usePlayerStore((s) => s.lyricsFlat);
  const store = usePlayerStore.getState;

  const lyrics = currentTrack?.lyrics ?? null;
  const { activeLineIndex } = useLyrics(lyrics, isPlaying, playbackPosition);
  const line = lyrics?.[activeLineIndex]?.text || currentTrack?.name || 'Nothing playing';
  const nextLine = lyrics?.[activeLineIndex + 1]?.text || currentTrack?.artist || '';

  /*
   * A scrolling list, not a seven-line window.
   *
   * The window pinned the active line dead centre and rendered three above and
   * three below, which reads well for a glance at one song and badly for anything
   * else: there was no way to see what was coming, no way back to what was missed,
   * and — because the sheet cannot clip without the card clipping with it, see
   * `.mini-lyrics-glass` — a long line in All At Once mode simply ran past the box
   * and took the card's shape with it. A scroll container answers all three at
   * once, and the height it spends on off-screen lines is height the windowed
   * version was spending on nothing anyway.
   *
   * The auto-scroll still follows the singer; it just stops fighting the pointer
   * when the user has taken the wheel.
   */
  const lyricListRef = useRef<HTMLDivElement | null>(null);
  const activeLineRef = useRef<HTMLParagraphElement | null>(null);
  /** Until when the singer is not allowed to move the scroll. */
  const manualUntil = useRef(0);

  useEffect(() => {
    if (performance.now() < manualUntil.current) return;
    const box = lyricListRef.current;
    const el = activeLineRef.current;
    if (!box || !el) return;
    const within = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, within - (box.clientHeight - el.clientHeight) / 2);
  }, [activeLineIndex, lyrics?.length]);

  /*
   * The card's controls answer to the pointer being on the widget at all, rather
   * than to a band along its foot or a countdown that starts when the art loads.
   */
  const hovered = useOverlayHover();

  /*
   * The lyrics sheet carries its own blurred copy of the room, exactly as the
   * pill's flyouts do — see `carryOwnBlur` in `MorphingGlassPanel`.
   *
   * It used to be mica: a live `getDisplayMedia` grab of the desktop, blurred by
   * the compositor. That is a wider window into the machine than a card inside a
   * transparent overlay needs, and it was the fragile half of the arrangement —
   * the sheet came up unblurred, and a second open came up black, because the
   * element had been handed a stream that the first close already released. The
   * picture behind this card *is* the record, so the record is what it blurs, and
   * the sheet stops needing a screen grab to look like glass.
   *
   * It is not a `data-glass` surface and must not become one: that is what took
   * the record's spin down to roughly one frame a second.
   */
  const lyricsBlur = useBackdropImage();

  /*
   * Head row: cover on the left, title and artist in the middle, the mode
   * switcher as a 2x2 grid on the right. The switcher used to be its own
   * horizontal row underneath the controls, which is what forced the card to
   * be tall; moving it beside the art reclaims that whole row, and the grid
   * keeps it two buttons wide so it does not simply become a column.
   */
  const head = (
    <div className="mini-head">
      {/* The artwork is the lyrics switch: the card is too small to carry a
          dedicated control for it, and the cover is the one thing always in
          reach. */}
      <button
        type="button"
        className="mini-art-btn"
        onClick={() => store().setMiniLyrics(!showLyrics)}
        data-tip={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
        aria-label={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
        aria-pressed={showLyrics}
      >
        <MediaThumb track={currentTrack} className="mini-art" />
      </button>

      <div className="mini-meta">
        <p className="font-heading text-sm text-glass-text truncate">
          {currentTrack?.name || 'Nothing playing'}
        </p>
        <p className="text-xs text-glass-textMuted truncate">
          {currentTrack?.artist || 'ChaosX'}
        </p>
      </div>

      {/* Mini is a hand on the library window's player, not a second one, so
          it gets exactly two controls: become the pill, and collapse itself.
          Normal and Fullscreen belong to the window behind it. */}
      <div className="mini-switcher">
        <ViewSwitcher modes={['pill']} />
        {/* A cross, not an arrow. This control puts the widget away, and the
            arrow it used to carry read as "collapse into a smaller version of
            me" — which is what the *other* button on this card does. */}
        <PillButton
          icon="close"
          label="Collapse mini player"
          onClick={() => void window.electronAPI?.overlay?.collapse()}
        />
      </div>
    </div>
  );

  const scrub = (
    <>
      <WaveformProgress
        peaks={currentTrack?.waveformPeaks ?? []}
        duration={currentTrack?.duration || 0}
        position={playbackPosition}
        trackId={currentTrack?.id}
        className="mini-wave"
      />

      {/* The scrub is the only place position is shown on this card, and a bar
          with no numbers on it cannot be read precisely — so the elapsed and
          total times sit directly under it, aligned to its two ends. */}
      <div className="mini-times">
        <span className="pill-time">{formatTime(playbackPosition)}</span>
        <span className="pill-time end">{formatTime(currentTrack?.duration || 0)}</span>
      </div>
    </>
  );

  const extra = (
    <div className="mini-extra">
      <PitchControl />
      <SpeedControl />
      <VolumeControl />
      <EqControl />
      <QueueControl />
    </div>
  );

  /* The wrapper fades; the glass surface inside never animates opacity, which is
     what stalls a shader. */
  const lyricsSheet = (
    <div
      className="mini-lyrics"
      onClick={() => store().setMiniLyrics(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') store().setMiniLyrics(false);
      }}
      aria-hidden={!showLyrics}
    >
      {/*
       * No `data-glass`. This was the last shader surface in the mini window,
       * and it was the reason the record turned in jumps: the disc marks
       * itself `data-dynamic` while it spins so the glass will follow it, and
       * every frame of that turn re-composited this panel — a WebGL scene
       * pass, a blur and an upload per frame, on the same thread that runs
       * the spin's rAF loop. The loop integrates against a frame delta capped
       * at 64ms, so once the frames were arriving at roughly one a second the
       * disc advanced a fixed few degrees, waited, and advanced again —
       * exactly the stutter described. The sheet is a blurred fill now, which
       * is what it needed to be all along.
       */}
      <div className="mini-lyrics-glass" data-no-capture>
        {/*
         * The sheet's own piece of the room: a blurred, darkened copy of the picture
         * the window is wearing, clipped to the sheet's rounded box. The wrapper
         * exists to clip the overhang without making the sheet itself clip, which is
         * what used to cut long lyric lines off.
         */}
        <div className="lyrics-mica" aria-hidden>
          {lyricsBlur ? (
            <div className="panel-blur" style={{ backgroundImage: `url("${lyricsBlur}")` }} />
          ) : null}
          <div className="mica-tint" />
        </div>
        {lyrics && lyrics.length > 0 ? (
          <div
            className={`mini-lyric-window${lyricsFlat ? ' is-flat' : ''}`}
            ref={lyricListRef}
            onWheel={() => {
              manualUntil.current = performance.now() + 9000;
            }}
          >
            {lyrics.map((l, i) => (
              <p
                key={`${i}-${l.time_ms}`}
                ref={i === activeLineIndex ? activeLineRef : null}
                className={`mini-lyric-line${lyricsFlat || i !== activeLineIndex ? '' : ' active'}`}
              >
                {l.text}
              </p>
            ))}
          </div>
        ) : (
          <>
            <p className={`mini-lyric-line${lyricsFlat ? '' : ' active'}`}>{line}</p>
            <p className="mini-lyric-line">{nextLine}</p>
          </>
        )}
        <div className="mini-lyrics-tools">
          <LyricsRefreshButton />
          <LyricsFlatButton />
        </div>
        {/*
         * The sheet fills the card, so once it is open the only way back to the
         * record was the transport button that opened it — which the sheet covers.
         * A cross in the corner the refresh ring is not in.
         */}
        <button
          type="button"
          className="mini-lyrics-close"
          onClick={() => store().setMiniLyrics(false)}
          data-tip="Hide lyrics"
          aria-label="Hide lyrics"
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );

  /*
   * One layout, and it is the music card.
   *
   * There used to be a second return above this for a film: a rectangle sized to
   * the video's own ratio, the card's layers inverted so `VideoStage` could show
   * through it, and a poster for the containers that could not be drawn there at
   * all. Both forms of it — a second `<video>` decoding a file the deck already
   * had open, and mpv's native picture reparented onto this window — ended the same
   * way, with a scrub bar and a transport row floating across the middle of the
   * picture. Mini and pill are music surfaces now, and `setView` will not open them
   * over a video.
   */

  return (
    <div className="mini-stage">
      {/*
       * The record is a sibling of the card, not a child of it.
       *
       * The shader refuses to put a panel's own content into that panel's scene —
       * it would be refracting itself — and it applies the same refusal to every
       * descendant of any glass surface. While the record lived inside
       * `.mini-player`, therefore, it was not in the scene for *anything*: the
       * dropdowns over the card refracted the desktop capture and ignored the
       * record that was plainly turning behind them. Out here it is a root-level
       * contributor, which is the same trick the pill's backdrop already uses to
       * reach a renderer that cannot sample the screen.
       */}
      <VinylBackground
        art={currentTrack?.albumArt ?? null}
        playing={isPlaying}
        blurPx={9}
        pivotX={0.5}
        pivotY={0.5}
      />

      {/*
       * No `data-glass` here. The shader composites a panel from a scene it
       * rasterises, and the thing directly behind this card is a record that is
       * turning — so every frame of the spin re-composited the card on top of it,
       * which is what made the mini player the laggy one. The stylesheet already
       * carries the frosted look (`rgba(20,17,20,.42)` plus a 13px
       * `backdrop-filter`), and that runs on the compositor instead. Glass belongs
       * on the dropdowns, which is where it was always meant to stay.
       */}
      <div className={`mini-player ${showLyrics ? 'mini-lyrics-open' : ''} ${hovered ? 'mini-hot' : 'mini-cold'}`} data-no-capture>
        {/* The record overfills the card and carries the blurred cover across its
            whole surface, so a bright release puts a pale field behind pale
            controls. This is what keeps them readable. */}
        <div className="mini-scrim" aria-hidden />

        {/* A frameless window has no title bar to grab, and this strip only
            exists inside PillPlayer for the pill — which is why the mini card
            stopped being draggable when it moved into the overlay window. The
            card reserves padding-top for it, because `-webkit-app-region: drag`
            swallows the clicks of anything underneath. */}
        {IS_MINI_WINDOW && <div className="pill-drag" aria-hidden />}

        {head}

        {scrub}

        <TransportControls compact />

        {extra}

        {lyricsSheet}
      </div>
    </div>
  );
}

/**
 * Pill mode: the transport as a thin strip down the side of the monitor.
 *
 * Not a small version of the library window — a different shape with a different
 * geometry. The scrub is a fader in the left lane rising from the bottom edge;
 * the transport is a two-column grid of upright controls to its right, read from
 * the foot of the strip upward; and the record is a squircle cover with its title
 * and artist wrapped to three lines each across the bottom.
 *
 * The widget carries no Normal or Fullscreen button. Those belong to the library
 * window, which stays open behind this one — the pill is a hand on that player,
 * not a second one, so it gets the two things it can actually mean: become the
 * other widget, and collapse itself.
 *
 * The window is sized to the strip by the main process and docked to an edge, so
 * every flyout leaves sideways rather than up or down — see `MorphingGlassPanel`,
 * `panelDirection`, and the `.pill-overlay` rules.
 */
/**
 * The capsule's material is mica with acrylic grain over this window's own
 * wallpaper layer. It is not a question any more: the WebGL shader that used to
 * sit here rendered as a black slab whenever the quality governor dropped the
 * scene, and a plain painted element cannot fail that way.
 */

function PillPlayer() {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playbackPosition = usePlaybackPosition();
  const shuffle = usePlayerStore((s) => s.shuffle);
  const pillSide = usePlayerStore((s) => s.pillSide);
  const hasTracks = usePlayerStore((s) => s.queue.length > 0);
  const duration = currentTrack?.duration || 0;
  const store = usePlayerStore.getState;

  const name = currentTrack?.name || 'Nothing playing';
  const artist = currentTrack?.artist || 'ChaosX';
  /* The cover is the lyrics toggle, exactly as it is on the mini card. */
  const artRef = useRef<HTMLButtonElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);

  /*
   * The veil's colour comes from the record, not from the desktop.
   *
   * The blur's own source stays the wallpaper — that is what makes the strip read
   * as glass over the screen rather than as a coloured panel. But a neutral charcoal
   * veil over a frosted wallpaper is the same grey whatever is playing, and the user
   * asked for the strip to carry the album art's tint. So the sampled average colour
   * of the cover is written onto the capsule as three numbers and `.pill-tint` mixes
   * them in; the alpha stays the adaptive one so a bright desktop still lifts the
   * whole strip.
   */
  useEffect(() => {
    const el = pillRef.current;
    if (!el) return;
    const art = currentTrack?.albumArt;
    if (!art) {
      el.style.removeProperty('--art-rgb');
      return;
    }
    let alive = true;
    void extractAccentRgb(art).then(([r, g, b]) => {
      if (alive) el.style.setProperty('--art-rgb', `${r} ${g} ${b}`);
    });
    return () => {
      alive = false;
    };
  }, [currentTrack?.id, currentTrack?.albumArt]);

  return (
    <div className="pill-stage">
      {/*
       * Mica, not liquid glass — the same material the strip's own dropdowns use.
       *
       * The capsule was a WebGL shader surface bending the wallpaper layer mounted
       * at this window's root. That made it depend on the shader finding a scene,
       * registering the surface, and the quality governor holding it at full rate;
       * when any of those slipped the capsule rendered as a black slab, which is
       * what the user saw. Mica cannot fail that way: the blurred wallpaper is an
       * ordinary painted element, so the worst case is a dim panel, never a void.
       *
       * It is also the answer the user asked for by name — "exactly the way the
       * dropdowns look" — and the source here is the wallpaper rather than a screen
       * grab on purpose. The strip reserves its own band as an application desk bar,
       * so the wallpaper is genuinely all that can be behind it, and grabbing the
       * monitor at that spot would put the strip's own pixels into its backdrop.
       */}
      <div
        className="float-pill pill-vertical"
        ref={pillRef}
        data-no-capture
        /*
         * The grab behind every dropdown this strip can open is asked for on
         * hover rather than on click, so the glass is already there when the
         * panel morphs out of the button. See `prewarmCapture`.
         */
        onPointerEnter={prewarmCapture}
      >
        <div className="pill-tint" aria-hidden />

        {/*
         * No drag band, deliberately. The strip is docked to an edge by the main
         * process and reserves its own band of the work area as a desk bar; a
         * window the user can pull off that anchor leaves the reservation behind,
         * so the desktop keeps a gap nothing is in and the strip floats where the
         * poll loop drags it back to anyway. The edge it sits on is the choice,
         * and the button below is how you make it.
         */}

        {/*
         * Two lanes side by side.
         *
         * The left one is the strip's own housekeeping — become the card, put
         * itself away, jump to the other edge — as three stacked icons. They are
         * pulled out of the transport grid because they are not about the record:
         * mixed in with prev/next/seek they made the grid read as one undifferentiated
         * block, and the user asked for the previous arrangement back with these
         * three set apart.
         *
         * The right lane keeps the two-column transport grid:
         *   1. play/pause, across both columns   2. -5s, +5s
         *   3. previous, next                    4. speed, pitch
         *   5. volume, equalizer                 6. queue, shuffle
         *
         * Play takes the full width because it is the one control worth a
         * mis-click at the bottom of a strip you aim at by feel.
         */}
        <div className="pill-controls">
          <div className="pill-utility">
            <PillButton
              icon="close"
              label="Collapse pill"
              onClick={() => void window.electronAPI?.overlay?.collapse()}
            />
            <ViewSwitcher modes={['mini']} />
            {/*
             * Send the pill to the other edge of the screen. The layout mirrors
             * with it — see `.pill-left` — so the control nearest the screen edge
             * stays nearest that edge either way, and the flyouts keep opening
             * into the gutter rather than into the wallpaper.
             *
             * The glyph is the one thing that must NOT follow the layout mirror.
             * It is an arrow at a wall: drawn pointing right, at the right wall,
             * which is where it is going from the left edge. Docked right, it has
             * to turn around or it spends the whole button promising to move the
             * pill to the edge it is already on.
             */}
            <PillButton
              className="pill-dock-btn"
              icon="dock"
              label={pillSide === 'right' ? 'Move pill to the left edge' : 'Move pill to the right edge'}
              onClick={() => store().setPillSide(pillSide === 'right' ? 'left' : 'right')}
            />
            {/*
             * Below the housekeeping, in the same single column, rather than as a
             * thirteenth cell in the transport grid. It is a readout and not a
             * transport action, and the grid was full before it arrived.
             */}
            <StatsControl />
          </div>

          <div className="pill-buttons">
            <QueueControl />
            <PillButton icon="shuffle" label="Shuffle" active={shuffle} onClick={() => store().toggleShuffle()} />
            <VolumeControl />
            <EqControl />
            <SpeedControl />
            <PitchControl />
            <PillButton icon="previous" label="Previous track" disabled={!hasTracks} onClick={() => store().playPrevious()} />
            <PillButton icon="next" label="Next track" disabled={!hasTracks} onClick={() => store().playNext()} />
            <PillButton icon="back-5s" label="Back 5 seconds" disabled={!hasTracks} onClick={() => getEngine().seekBy(-5)} />
            <PillButton icon="forward-5s" label="Forward 5 seconds" disabled={!hasTracks} onClick={() => getEngine().seekBy(5)} />
            <PillButton
              className="pill-play-wide"
              icon={isPlaying ? 'pause' : 'play'}
              label={isPlaying ? 'Pause' : 'Play'}
              disabled={!hasTracks}
              onClick={() => void store().togglePlay()}
            />
          </div>
        </div>

        {/* The left lane: a fader that rises from the strip's bottom edge, with
            the total at its head and the elapsed at its foot. */}
        <div className="pill-scrub">
          <span className="pill-time end">{formatTime(duration)}</span>
          <WaveformProgress
            peaks={currentTrack?.waveformPeaks ?? []}
            duration={duration}
            position={playbackPosition}
            trackId={currentTrack?.id}
            orientation="vertical"
            className="pill-wave"
          />
          <span className="pill-time">{formatTime(playbackPosition)}</span>
        </div>

        {/*
         * Under both lanes, across the full width of the strip: the cover as a
         * squircle, then the title and the artist each wrapped to three lines.
         * Horizontal text on purpose — the strip is only just wider than two
         * button columns, so a vertically-written title would be clipped to a
         * glyph or two. What does not fit over three lines becomes an ellipsis,
         * and the tooltip spells it out in full.
         */}
        <div className="pill-identity">
          <button
            ref={artRef}
            type="button"
            className="pill-art-btn"
            data-tip="Lyrics"
            aria-label="Lyrics"
          >
            <MediaThumb track={currentTrack} className="pill-cover" />
          </button>
          {/* The tooltip sits on the wrapper, not the label: three-line clamping
              needs `overflow: hidden` on the text itself, and a `::after` cannot
              escape the box it is drawn from. */}
          <div className="pill-lines">
            <span className="pill-line" data-tip={name}>
              <p className="pill-name">{name}</p>
            </span>
            <span className="pill-line" data-tip={artist}>
              <p className="pill-artist">{artist}</p>
            </span>
          </div>
        </div>

        <PillLyricsCard triggerRef={artRef} track={currentTrack} />
      </div>
    </div>
  );
}

/**
 * The heading each section wears in the top row.
 *
 * Held here rather than inside the pages because the row is shared: the heading
 * and the search bar are two halves of one band, and a page that owned its own
 * title could not sit beside a bar the shell positions.
 */
const HEADS: Record<string, { title: string; sub: string }> = {
  home: { title: 'Home', sub: 'Where you left off, and what you keep coming back to' },
  library: { title: 'Library', sub: '' },
  statistics: { title: 'Statistics', sub: 'Your library, your listening, and your hardware at a glance' },
  settings: { title: 'Settings', sub: 'How the window looks, and how it behaves' },
};

export default function App() {
  const searchQuery = usePlayerStore((s) => s.searchQuery);
  const selectedFolderId = usePlayerStore((s) => s.selectedFolderId);
  const section = usePlayerStore((s) => s.section);
  const miniPlayer = usePlayerStore((s) => s.miniPlayer);
  const tintStrength = usePlayerStore((s) => s.tintStrength);
  const background = usePlayerStore((s) => s.background);
  const library = usePlayerStore((s) => s.library);
  const folders = usePlayerStore((s) => s.folders);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);
  const isScanning = usePlayerStore((s) => s.isScanning);
  const mediaHasVideo = usePlayerStore((s) => s.mediaHasVideo);
  /** The film is drawn by this page's own `<video>`, so the glass can sample it. */
  const videoInPage = usePlayerStore((s) => s.videoInPage);
  const videoFullscreen = usePlayerStore((s) => s.videoFullscreen);
  const nowPlayingFull = usePlayerStore((s) => s.nowPlayingFull);
  const pillMode = usePlayerStore((s) => s.pillMode);
  const onboarded = usePlayerStore((s) => s.onboarded);
  const songCount = useMemo(() => audioOnly(library).length, [library]);

  const view: ViewMode = pillMode ? 'pill' : miniPlayer ? 'mini' : nowPlayingFull ? 'full' : 'normal';

  /* ── Coming back from a floating widget ───────────────────────────────────
     Both widgets are separate overlay windows and `setView` asks the main process
     for them directly; the old effect that watched `view` and opened the pill is
     gone, because the library window no longer adopts either widget layout, so it
     could never have fired. What arrives here instead is the mode the user picked
     inside the widget, which is what converts this window. */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    return window.electronAPI?.onMainHandoff?.((state) => {
      void getEngine().applyHandoff(state);
      const mode = state.mode;
      // A widget mode in a hand-off would re-open the widget we just closed.
      usePlayerStore.getState().setView(mode === 'full' || mode === 'normal' ? mode : 'normal');
    });
  }, []);

  /*
   * The taskbar thumbnail's glyphs come from here, because this is the only side
   * that can draw them properly: the icons are SVG and PNG art already loaded by
   * the page, and Chromium rasterises them identically to the transport row. The
   * main process just wraps the bytes in an ICO and hands them to the shell.
   */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    void publishThumbIcons();
  }, []);

  /* Inside the overlay: take the hand-off, then stay put. Picking another mode
     from here is a request to go back, recorded rather than rendered — a 208px
     window cannot show a library, and the store keeps it drawing the pill. */
  const pillReturnTo = usePlayerStore((s) => s.pillReturnTo);
  /*
   * Which widget the main process has on screen. The library window cannot infer
   * this any more — the widget is a different window, and mini-to-pill happens
   * entirely inside it — so the switcher's active button is reported rather than
   * remembered locally.
   */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    return window.electronAPI?.overlay?.onRole((role) => {
      if (usePlayerStore.getState().overlayRole === role) return;
      usePlayerStore.setState({ overlayRole: role });
    });
  }, []);

  /*
   * The pill's window is wider than the strip it draws so that a tooltip or the
   * equalizer has somewhere to go sideways. Everything in that extra width has
   * to be click-through, or the widget silently swallows desktop clicks beside
   * itself.
   *
   * The renderer's only job here is to say *where the solid parts are*. Deciding
   * whether the cursor is on one of them is the main process's job, because a
   * window that ignores mouse events is never told where the mouse is: Electron's
   * `forward: true` is meant to patch that hole, and measured against a real
   * cursor it delivered no pointer events at all — so a renderer-driven latch
   * goes click-through once and can never come back. See `overlay:hit-rects`.
   */
  /*
   * The widget cannot see a press outside its own window: the pill is a separate
   * always-on-top surface, and anything beyond its bounds belongs to the desktop
   * or to another application. The main process already polls for exactly that
   * in order to decide who receives the click, so it says so here.
   */
  useEffect(() => {
    if (!IS_OVERLAY_WINDOW) return;
    return window.electronAPI?.overlay?.onDismiss?.(() => dismissActivePanel());
  }, []);

  /*
   * The capsule bends the desktop.
   *
   * Mounted for as long as the strip is on screen rather than on some trigger,
   * because "what is behind the pill" is the whole idea of it. The element it
   * attaches is the same `<video>` the dropdowns frost from, and it goes directly
   * into the app root: the shader composes its scene from root-level contributors,
   * and a `<video>` among them is drawn live every frame rather than snapshotted.
   *
   * The cost is honest and worth stating: while this runs the window is excluded
   * from screen captures, or the glass would refract a picture of itself into a
   * tunnel. So the pill is invisible to a screenshot for exactly as long as it is
   * showing somebody else's desktop.
   */
  useEffect(() => {
    /*
     * The screen grab is the single heaviest thing in the app — a 60 fps
     * monitor-sized `MediaStream` at native resolution times the device pixel
     * ratio, fed to a `<video>` carrying `blur(40px)` over a display-sized box,
     * plus a 60 ms timer that re-lays it out and samples it. It is also the only
     * thing that lets the capsule bend the desktop, which is the whole idea of it,
     * so it runs.
     */
    if (!IS_PILL_WINDOW) return;
    const root = rootRef.current;
    if (!root) return;
    let release: (() => void) | null = null;
    /*
     * Follow visibility rather than the window's life. Collapsing the pill only
     * hides it, and a hidden widget that keeps the capture alive burns a 60 Hz
     * screen grab and a frame of refraction for nobody — and holds the window
     * out of the user's screenshots while it is not even on screen.
     */
    const sync = () => {
      if (document.visibilityState === 'visible') release ??= mountDesktopBackdrop(root);
      else if (release) {
        release();
        release = null;
      }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      release?.();
    };
  }, []);

  useEffect(() => {
    if (!IS_OVERLAY_WINDOW) return;
    const api = window.electronAPI?.overlay;
    if (!api?.reportHit) return;
    let last = '';
    const send = api.reportHit;
    const report = () => {
      /*
       * `.mini-player` alongside `.float-pill`: the mini card now sits inside a
       * transparent gutter, and main decides who gets the click by testing the
       * cursor against exactly these boxes. Without the card in the list the
       * gutter poll would find nothing under the pointer and leave the whole
       * window click-through — a widget that renders and ignores everything.
       */
      const rects = [...document.querySelectorAll('.float-pill, .mini-player, .mini-video-box, .morph-panel')].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          x: Math.floor(r.left),
          y: Math.floor(r.top),
          w: Math.ceil(r.width),
          h: Math.ceil(r.height),
          /*
           * Named for main's sake. It has to tell a press on the card — which the
           * window manager swallows as a drag, and which therefore has to dismiss
           * the panel from up there — apart from a press on the panel's own slider,
           * which arrives normally and must not be interrupted.
           */
          panel: el.classList.contains('morph-panel'),
        };
      });
      // A panel is only in the DOM while it is open, so its presence is the
      // signal. While one is up the window takes clicks everywhere, which is what
      // lets a click anywhere outside it dismiss it.
      const payload = { rects, open: !!document.querySelector('.morph-panel') };
      const key = JSON.stringify(payload);
      if (key === last) return;
      last = key;
      send(payload);
    };
    report();
    const iv = window.setInterval(report, 90);
    return () => {
      window.clearInterval(iv);
      send({ rects: [], open: false });
    };
  }, []);

  useEffect(() => {
    if (!IS_OVERLAY_WINDOW) return;
    return window.electronAPI?.onPillHandoff?.((state) => {
      usePlayerStore.setState({ pillReturnTo: null });
      void getEngine().applyHandoff(state);
    });
  }, []);

  useEffect(() => {
    if (!IS_OVERLAY_WINDOW || !pillReturnTo) return;
    const engine = getEngine();
    const state = { ...engine.handoffState(), mode: pillReturnTo };
    engine.pauseForHandoff();
    void window.electronAPI?.closePill?.(state);
  }, [pillReturnTo]);

  // Keeps the main process able to recover playback if the overlay is closed
  // hard — Alt-F4, a task-bar close — rather than stranded with no window.
  useEffect(() => {
    if (!IS_OVERLAY_WINDOW) return;
    const iv = window.setInterval(
      () => window.electronAPI?.reportPillState?.(getEngine().handoffState()),
      1000,
    );
    return () => window.clearInterval(iv);
  }, []);

  // The outgoing layout stays mounted for one glide so a mode switch reads as
  // a single motion rather than a hard cut between two windows' worth of UI.
  const [settledView, setSettledView] = useState(view);
  const [gliding, setGliding] = useState(false);
  useEffect(() => {
    if (view === settledView) {
      setGliding(false);
      return;
    }
    setGliding(true);
    const t = window.setTimeout(() => {
      setSettledView(view);
      setGliding(false);
    }, MODE_GLIDE_MS);
    return () => window.clearTimeout(t);
  }, [view, settledView]);

  /** Layers for both the target and the mode being left exist during a glide. */
  const layerShown = (v: ViewMode) => view === v || settledView === v;
  const layerClass = (v: ViewMode) =>
    !gliding ? '' : view === v ? 'mode-enter' : 'mode-leave';

  const rootRef = useRef<HTMLDivElement | null>(null);
  const glassRef = useRef<GlassEngine | null>(null);

  useKeyboardShortcuts();
  useMediaSession();
  const { pinFolder, createPlaylist } = useLibrary();
  useSceneScrim();
  const settingsSection = usePlayerStore((s) => s.settingsSection);

  /*
   * Hold the shader at full rate while the video pill has a film to bend.
   *
   * The adaptive governor drops to a tier above 1 whenever the glass is spending
   * more than 30% of the wall clock rendering, and on that tier it skips frames —
   * refraction at 30 or 20 Hz. For an ordinary panel that is invisible and saves
   * real time. For the pill over a moving picture it *is* the defect: the bend
   * ticks behind the film. Nothing else about the pill changes, so when the film
   * stops the governor gets its throttle back.
   */
  useEffect(() => {
    if (glassRef.current) glassRef.current.holdQuality = videoFullscreen && videoInPage;
  }, [videoFullscreen, videoInPage]);

  /*
   * Whether the shell has this window zoomed, mirrored onto the root so the CSS can
   * stop rounding a window that fills the work area.
   *
   * Read from the main process rather than off the window's rectangle, because the
   * takeover covers the same ground by setting bounds and is not maximised in any
   * sense the shell agrees with.
   */
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || IS_PILL_WINDOW || IS_MINI_WINDOW) return undefined;
    void api.getWindowState().then((s) => setZoomed(Boolean(s?.isMaximized)));
    const off = api.onZoomed?.(setZoomed);
    return () => off?.();
  }, []);

  /*
   * Tell the main process once this page has composed, so it can put the window on
   * screen with something already in it.
   *
   * `ready-to-show` fires on the first frame, which is before the layout below has
   * settled a second time, and the window used to appear as a dark rectangle that
   * then filled in. Two animation frames is the shortest honest wait: the second one
   * is composited after the first has been measured and painted. The main process
   * still shows the window on its own timer if this never arrives.
   */
  useEffect(() => {
    if (IS_PILL_WINDOW || IS_MINI_WINDOW) return;
    let raf = 0;
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        void window.electronAPI?.notifyReady?.();
      });
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── WebGL liquid glass on every glass surface ──────────────
  // Cards are marked `data-glass` in the JSX; this effect boots the shader
  // on the pill and keeps the registered glass set in sync as cards mount,
  // unmount, or the mini player swaps the whole layout.
  useEffect(() => {
    let disposed = false;
    let observer: MutationObserver | null = null;

    /*
     * The mini window never boots this at all. Measured there with a film playing:
     * the renderer ran at 1 frame a second with the shader up and 165 with it down,
     * on the same track, in the same window. That is the whole of the "the video is
     * a still image" report — the picture is this window's own `<video>`, so it can
     * only be composited as often as the renderer produces a frame, and the scene
     * pass eats every one of them. The card already declines `data-glass` for
     * itself, so the only things losing their domes are the dropdowns, and
     * `.glass-cards` is added by this mount: not running it leaves their gaussian
     * `backdrop-filter` in place.
     *
     * Every other window runs the shader, and there is no longer a build that
     * declines it: the gaussian card material was deleted along with the potato
     * modes, so `.glass-cards` — the class that hands a surface to the engine — is
     * on the root for the life of the window.
     */
    if (IS_MINI_WINDOW) return;

    const syncGlass = (instance: GlassEngine | null) => {
      if (!instance || !rootRef.current) return;
      // While the takeover is up it covers the library completely, so every
      // shader surface underneath it is being re-composited for pixels nobody
      // can see. Dropping them is most of the fullscreen frame budget back.
      // Dropdown panels live in their own layer outside `.mode-layer`, so they
      // keep their glass and stay correct when opened over the takeover.
      const takeover = rootRef.current.querySelector('.npf-root');
      /*
       * The fullscreen video takeover, read off the strip rather than off a class:
       * the card and the panels this filter is deciding between are in the same DOM
       * snapshot, so they cannot disagree about which mode is up. Carrying `data-glass`
       * is the card's way of saying the film is the page's own `<video>` element — the
       * only form of it the scene pass can sample — so the surfaces over it refract the
       * picture itself, a frame at a time.
       */
      const filmCard = rootRef.current.querySelector('.video-pill-card');
      const videoTakeover = !!filmCard;
      const filmInPage = !!filmCard?.hasAttribute('data-glass');
      const live = new Set(
        Array.from(rootRef.current.querySelectorAll<HTMLElement>('[data-glass]')).filter(
          (el) => {
            /*
             * The takeover used to opt out of the shader wholesale, on the belief
             * that re-compositing a scene for pixels behind the record was most of
             * the fullscreen frame budget. That belief was measured while the mode
             * ran at 5 fps, and the cost turned out to be the playhead living in
             * the store — see #59. So the takeover's own surfaces are allowed back
             * in, but named rather than blanket-allowed: the clock's numerals and
             * the individual buttons were each their own shader surface before, and
             * putting them back would cost a dozen surfaces for no visual gain the
             * user asked for.
             */
            if (el.closest('.npf-root')) {
              /*
               * The takeover is live frost, not shader glass. Enabling the shader
               * here was tried and measured: it halves the frame rate of the mode
               * (46-52 fps down to 18-25, and one surface costs what three do,
               * because the scene is a moving 4839px record that can never be
               * marked clean), and the adaptive refresh governor only recovers
               * about two thirds of that — and the result looked worse than the
               * frost it replaced. So every surface in here keeps its
               * `backdrop-filter`, which tracks the record for free and cannot go
               * stale.
               */
              return false;
            }
            /*
             * Setup puts the same turning record behind the same kind of card, so
             * it gets the same answer for the same reason. A shader surface here
             * composited from a snapshot of a record that had already moved on,
             * which is the lag the user sees as the glass "not keeping up" —
             * `backdrop-filter` is recomposited by the compositor on exactly the
             * frame it is drawn, so it cannot drift.
             */
            if (el.closest('.setup-scrim')) return false;
            /*
             * The queue panel's row highlighter. It is the library's own sliding
             * sheet — same component, same clock, same placement — and the one
             * thing about it the user does not want shared: a lens bent around
             * whatever happens to be behind a row reads as a smudge when that
             * something is sixty scrolling covers. Gaussian frost costs nothing per
             * frame and keeps the sheet legible over any row it lands on.
             */
            if (el.closest('.queue-list')) return false;
            if (takeover && (el.closest('.mode-layer') || el.closest('.player-pill'))) return false;
            /*
             * Under the film the library is hidden outright (`.app-root.video-under`
             * takes its layer off), but a registered surface is still walked and
             * still answered to every dynamic frame — which is all of them once a
             * `<video>` is in the scene. So it loses its glass here, exactly as it
             * does under the music takeover, and only the strip and what it contains
             * keeps any.
             */
            if (videoTakeover && (el.closest('.mode-layer') || el.closest('.player-pill'))) return false;
            // The takeover's dropdowns portal into `.morph-layer`, which sits
            // outside `.npf-root`, so they used to keep their shader and
            // refract the record. That meant re-compositing the scene every
            // frame for as long as the disc turned, and the user asked for
            // plain live blur here instead — `backdrop-filter` tracks the
            // backdrop for free and cannot go stale.
            if (takeover && el.closest('.morph-layer')) return false;
            // Over a native (mpv-drawn) film there is no scene left to refract at
            // all, and a shader panel over an empty one is a black slab — so the
            // strip's flyouts fall back to their frost there too. With the picture
            // in the page they keep the shader, and bend the film.
            if (videoTakeover && !filmInPage && el.closest('.morph-layer')) return false;
            return true;
          },
        ),
      );
      const pill = rootRef.current.querySelector<HTMLElement>('.player-pill');
      if (pill && !takeover) live.add(pill);
      /*
       * The set is unchanged, so there is nothing to do.
       *
       * This is the hot path and it was not guarded. The observer below fires on
       * every childList mutation under the root, and scrolling the song list
       * mounts and unmounts rows on every frame — measured at 1,701
       * `addGlassElement` calls across one 4,800 px scroll, none of which added
       * anything, because not one of those rows is a glass surface. The pass costs
       * about 46 ms a frame on this machine, which is the whole of "scrolling is
       * not snappy": median frame gap during a scroll went from 90 ms to 44 ms with
       * this check in place.
       */
      if (live.size === instance.glassSet.size) {
        let same = true;
        for (const el of live) {
          if (!instance.glassSet.has(el)) {
            same = false;
            break;
          }
        }
        if (same) return;
      }
      for (const el of [...instance.glassSet]) {
        if (!live.has(el) || !rootRef.current?.contains(el)) instance.removeGlassElement(el);
      }
      for (const el of live) {
        // This app refracts the scene behind the window, never its own
        // interface: a captured panel shows a frozen snapshot of the UI,
        // which reads as ghosting the moment anything underneath scrolls.
        if (!el.hasAttribute('data-no-capture')) el.setAttribute('data-no-capture', '');
        instance.addGlassElement(el);
      }
      rootRef.current.classList.add('glass-cards');
    };

    const boot = async () => {
      try {
        await document.fonts.ready;
      } catch {
        // Font loading API unavailable
      }
      if (disposed || !rootRef.current || glassRef.current) return;
      glassRef.current = await createGlassEngine({
        root: rootRef.current,
        glassElements: [],
        realtime: true,
        defaults: {
          sceneFill: 'rgba(0,0,0,0)',
          cornerRadius: 43,
          zRadius: 26,
          blurAmount: 0.35,
          refraction: 0.7,
          chromAberration: 0.06,
          edgeHighlight: 0.07,
          fresnel: 0.9,
          specular: 0.2,
          shadowOpacity: 0.34,
          shadowSpread: 18,
          shadowOffsetY: 6,
          opacity: 1,
        },
      });
      if (disposed) return;
      syncGlass(glassRef.current);
      setGlassEngine(glassRef.current);
      // Live handle for the debug bridge: lets the glass be inspected and
      // retuned against the running window instead of by rebuild-and-guess.
      if (import.meta.env.DEV) {
        (window as unknown as { __glass: GlassEngine | null }).__glass = glassRef.current;
      }
      // Cards appear and disappear with React (lyrics, settings, HUD, mini
      // player) — resync the registered set whenever the DOM shifts.
      observer = new MutationObserver(() => syncGlass(glassRef.current));
      observer.observe(rootRef.current, { childList: true, subtree: true });
    };
    void boot();
    return () => {
      disposed = true;
      observer?.disconnect();
      observer = null;
      setGlassEngine(null);
      glassRef.current?.destroy();
      glassRef.current = null;
      rootRef.current?.classList.remove('glass-cards');
    };
    // Deliberately not keyed on `miniPlayer`: rebuilding the WebGL pipeline
    // for every mode switch is what made the toggle stutter. The observer
    // below already registers and releases surfaces as the layout swaps.
    // Nothing else can turn the engine off any more — the gaussian material
    // that used to be the alternative is gone.
  }, []);

  /*
   * The record's colour, published to the whole library window.
   *
   * The pill already samples the cover for its own veil, and the user asked for
   * the same source to drive the primary actions — "make the resume button in
   * home, and add folder and all songs highlighter adapt their tint as per the
   * colour of the album art of the current song playing". Doing it per button
   * would decode and sample the same cover four times over, so it is sampled
   * once here and handed down as a custom property every surface can already
   * read: `rgb(var(--art-rgb) / .4)` in a stylesheet, `var(--art-tint)` in a
   * component.
   */
  /*
   * The backdrop's own colour, published to the whole library window.
   *
   * Every accent-washed interface surface — the nav highlight, Add folder,
   * Resume, the folder strip, the quote's rule — reads `--art-rgb`, and this is
   * the one place that decides what it means. It used to be the playing
   * record's average, which made the interface change colour every track and
   * left it unrelated to the wall the glass is actually set against. It is now
   * the backdrop itself: the custom wallpaper, the live album-art mode, or the
   * desktop when that is what is showing, sampled from the same canvas the glass
   * bends so the six source paths cannot disagree about the answer.
   *
   * Sampled once here rather than per surface, because each of them decoding and
   * averaging the same picture is the same cost multiplied by the number of
   * buttons on screen.
   */
  const artId = usePlayerStore((s) => s.currentTrack?.id);
  const sceneRgb = useSceneRgb([background, wallpaperPath, artId]);
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    rootRef.current?.style.setProperty('--art-rgb', sceneRgb);
  }, [sceneRgb]);

  const visibleTracks = useMemo(() => {
    /*
     * `all` is the merged music list, so films stay out of it — the same rule
     * the Library page's All-songs tab applies, and the reason the queue the app
     * seeds on first load cannot start with a video nobody chose.
     */
    let tracks =
      selectedFolderId === 'all'
        ? audioOnly(library)
        : library.filter((t) => t.folderId === selectedFolderId);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      tracks = tracks.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q) ||
          t.path.toLowerCase().includes(q),
      );
    }
    return tracks;
  }, [library, selectedFolderId, searchQuery]);

  /*
   * A video has exactly one fullscreen mode, and it is not this one.
   *
   * The takeover is a page, and mpv's picture is a native window raised *above*
   * the page, so a video playing while the music takeover is up does not render
   * inside it — it renders over it, punching through the record and the lyrics
   * with a rectangle of film that nothing in the interface can style, dim or
   * control. There is no version of "the music view shows a video" that is not
   * that hole in the layout, so the view declines the video outright and hands
   * it to the mode built for it.
   */
  useEffect(() => {
    if (nowPlayingFull && mediaHasVideo && !videoFullscreen) {
      usePlayerStore.getState().setVideoFullscreen(true);
    }
  }, [nowPlayingFull, mediaHasVideo, videoFullscreen]);

  // Leaving a video (or pressing the key bound to it) drops out of the takeover
  // view. The key itself is handled by `useKeyboardShortcuts`, which is where the
  // user's own binding for it is read from.
  useEffect(() => {
    if (!mediaHasVideo && videoFullscreen) {
      usePlayerStore.getState().setVideoFullscreen(false);
    }
  }, [mediaHasVideo, videoFullscreen]);

  /*
   * A takeover owns the monitor, taskbar included.
   *
   * Both of them. The music view's quote card and the film's bottom edge were
   * previously cut off by a strip of desktop that stayed visible and clickable, and
   * the workaround was to keep the window inside the work area — which is the same
   * defect wearing the name of a design decision. Chrome and Windows Media Player
   * do not have this problem because they ask the shell to move, and so this does:
   * the handler lives in the main process, where only a window can talk to it.
   *
   * Deliberately not unwound on unmount. The library window's `beforeunload` runs
   * when the app quits, and a half-finished kiosk exit is the one way to leave a
   * user with no taskbar; the main process releases it on its own quit path.
   */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    const take = nowPlayingFull || videoFullscreen;
    void window.electronAPI?.setImmersive?.(take);
  }, [nowPlayingFull, videoFullscreen]);

  /*
   * Seed a playback queue so the transport has something to drive before the
   * user picks a row. In the list's own order, not scan order: the seeded queue
   * is what the next and previous buttons walk, and it disagreeing with the rows
   * the user is looking at is the worst possible time to discover it.
   *
   * Three things make this effect what it is rather than a one-liner.
   *
   * The library window only. A widget boots into the same store with an empty
   * library and fills it folder by folder, and `setQueue` announces the session —
   * so an unguarded widget hands the library a queue built from whatever few rows
   * it had read, and a four-hundred-song list becomes eight files.
   *
   * From the whole audio library, not `visibleTracks`. The folder filter and the
   * search box describe what is being *looked at*; the thing to press play on
   * before you have looked at anything is the library.
   *
   * And after the scan has settled, which is what the timer is for. The cache is
   * published folder by folder, so the first tick sees one folder's worth of
   * tracks and every later tick finds `queue.length > 0` and leaves it alone.
   * That is the whole of "the queue is only a few songs" and "next skips into a
   * folder I did not open".
   *
   * The row it stops on is drawn at random rather than taken from the top. The
   * list's first entry is the same file on every cold start, which made the app
   * look like it had remembered a song it had never played and gave the transport
   * somewhere obvious and wrong to be pointing; a random pick means the pill, the
   * record and the highlighter all have something of the user's actually in front
   * of them the moment the window opens.
   *
   * It is armed, so the deck opens that file without playing it. This was
   * deliberately *not* armed before, on the arithmetic that a two-core laptop
   * should not pay 52 MB of mpv plus a standby deck for a song nobody had asked to
   * hear — and that was the right call until the request came back the other way:
   * the pill showing a title is not the same as the pill being ready, and the
   * first play was paying the whole load cost on the press. Reverting this to
   * `false` is one argument and puts the memory back.
   */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW || isScanning || library.length === 0) return undefined;
    const id = window.setTimeout(() => {
      const s = usePlayerStore.getState();
      if (s.queue.length > 0) return;
      const songs = audioOnly(s.library);
      if (!songs.length) return;
      const ordered = orderLibrary(songs, s.sortMode, buildFolderRank(s.folders, songs), s.sortDesc);
      s.setQueue(ordered, Math.floor(Math.random() * ordered.length), true);
    }, 700);
    return () => window.clearTimeout(id);
  }, [library, isScanning]);

  /*
   * `--tint-alpha` is the dark veil over the backdrop, and it is written here
   * rather than in the stylesheet because it is a number the user drags. The
   * cards' blur is not: every card is a lens now, and a lens's blur is a term in
   * its optics rather than a radius on a dial.
   */
  const rootStyle = {
    '--tint-alpha': (tintStrength / 100) * 0.6,
  } as React.CSSProperties;

  // The takeover is an overlay on the library, so both stay mounted there;
  // the two floating modes replace it outright.
  const libraryShown = layerShown('normal') || layerShown('full');
  /* Once the takeover has settled it covers the library completely, so the
     rows underneath are painted for nobody: several hundred thumbnail images
     the compositor still has to keep current behind a turning record, and the
     shader still has to measure for every panel refresh. Hidden rather than
     unmounted so the list keeps its scroll position for the way back, and not
     during the glide so the layout transition still has something to fade out. */
  const libraryOccluded = view === 'full' && !gliding;
  /* The fullscreen music takeover restyles its own floating panels — see
     `.app-root.full-music .morph-panel` in liquid-glass.css. Keyed on `view`
     rather than the occlusion flag so the panels are already correct during
     the glide in, not a beat after it. */
  const fullMusic = view === 'full' && !videoFullscreen;
  const pillSide = usePlayerStore((s) => s.pillSide);

  /*
   * Tell main which edge the strip belongs to before it ever creates one.
   *
   * The preference lives in this renderer's persisted store and the window lives
   * in main, so on a cold start main's default — right — is what would go into
   * the overlay's URL and into the desk bar's `uEdge`, and a strip the user had
   * moved to the left would arrive at the right for one paint and then jump.
   * Pushing it from the library window, which is always up first, costs one
   * idempotent IPC and removes the disagreement.
   */
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    void window.electronAPI?.overlay?.setPillSide?.(pillSide);
  }, [pillSide]);

  return (
    <DropZone>
      <div className={`app-root ${zoomed ? 'is-zoomed' : ''} ${videoFullscreen ? 'video-fullscreen' : ''} ${fullMusic ? 'full-music' : ''} ${IS_PILL_WINDOW ? 'pill-overlay' : IS_MINI_WINDOW ? 'mini-overlay' : ''} ${IS_PILL_WINDOW && pillSide === 'left' ? 'pill-left' : ''} ${IS_PILL_WINDOW && pillSide === 'right' ? 'pill-right' : ''}`} ref={rootRef} style={rootStyle}>
        {/*
            Backdrop + tint render in every mode so the glass shader has a scene to
            sample — except in the floating windows, where the wallpaper is actively
            wrong: it covered the whole transparent frame, so it both drew the
            floral border around the card and became the strongest thing behind
            every glass surface.

            Out here the pill's capsule gets the live desktop itself, mounted as a
            display-aligned `<video>` clipped to the strip by `mountDesktopBackdrop`
            below, because liquid glass over the desktop has to bend the desktop — a
            blurred cover standing in for it is the artwork showing through, not the
            screen. Dropdowns ask nothing of it: in a widget they are heavy CSS glass,
            and the library's keep the shader and its own backdrop.

            Mini needs no root-level scene at all while idle — its whole surface is
            a record this renderer already draws.
        */}
        {!IS_OVERLAY_WINDOW && (
          <>
            {/*
             * One renderer for both backdrop sources. The blur slider is the only
             * difference between wearing the cover and wearing its colours, so
             * there is one dissolve and one implementation of "change the room".
             */}
            <BackdropLayer />
            <div className="tint-layer" data-no-capture style={{ opacity: 'var(--tint-alpha)' }} />
          </>
        )}

        {libraryShown && (
          <div
            className={`mode-layer ${layerClass('normal')} ${libraryOccluded ? 'occluded' : ''}`}
            data-no-capture
          >
            <div className="app-shell" data-no-capture>
              {/*
               * The strip that moves the window, and the reason there is now a 40px band
               * of backdrop above the cards where the titlebar used to be.
               *
               * It started life `position: fixed` behind everything, on the theory that
               * `-webkit-app-region` defaults to `no-drag` and Chromium reads the region
               * off the topmost element — so only bare backdrop would drag. Measured,
               * that is nothing: `elementFromPoint` returned the sidebar or `app-main` at
               * every point across the band, because those containers fill the window from
               * y=0 and are not the cards inside them. A band that is never topmost is a
               * band that never drags.
               *
               * So it is a real row in the layout instead, which is what a normal app does.
               * The controls sit inside it rather than over it: a child can opt out of its
               * parent's drag region with `no-drag`, and the strip keeps dragging right up
               * to the buttons' edges.
               *
               * It is a glass surface now, and that is a function rather than a flourish.
               * The band is the only thing on screen that says "there is a titlebar here",
               * which is what a window with no caption lost: without an edge to the strip,
               * nothing tells you where to hold to move the window or where to press twice
               * to maximize it.
               */}
              <div className="win-drag" data-glass data-config={cardGlass(18)} data-no-capture>
                <button
                  type="button"
                  className="win-title"
                  data-tip="Double-click to maximise or restore"
                  onDoubleClick={() => void window.electronAPI?.maximizeWindow()}
                >
                  ChaosX Mark x1.0
                  <em>- by Ankan</em>
                </button>
                <WindowControls />
              </div>
              <div className="app-body">
                <Sidebar />
                <main className="app-main liquid-glass-card" data-glass data-config={cardGlass(26)} data-no-capture>
                  {/*
                   * The page's name and the search bar share the top row.
                   *
                   * They used to be two stacked bands, which cost the page a
                   * hundred pixels of height — and on Home that was the
                   * difference between the six ranked rows fitting and the column
                   * growing a scrollbar. Pulling the heading into the bar's row
                   * puts it at the topmost left, which is where a title belongs
                   * anyway, and shifts the bar rightward by exactly the room it
                   * needs. The offset is on the row, not on a page, so every
                   * section gets the same bar position.
                   */}
                  <div className="main-top">
                    <PageHead
                      title={HEADS[section].title}
                      sub={
                        section === 'library'
                          ? `${songCount} ${songCount === 1 ? 'song' : 'songs'}`
                          : HEADS[section].sub
                      }
                      actions={
                        section === 'library' ? (
                          <>
                            <GlassButton
                              radius={18}
                              tint="var(--art-tint-strong)"
                              onClick={() => void pinFolder()}
                              disabled={isScanning}
                              data-tip="Pin another folder into the library"
                            >
                              <Icon name="plus" size={13} />
                              {isScanning ? 'Scanning…' : 'Add folder'}
                            </GlassButton>
                            <GlassButton
                              radius={18}
                              tint="var(--art-tint)"
                              onClick={() => void createPlaylist()}
                              data-tip="For your customized listening"
                            >
                              <Icon name="music" size={13} />
                              Add playlist
                            </GlassButton>
                          </>
                        ) : undefined
                      }
                    />
                    <SearchBar
                      placeholder="Search tracks, artists, albums..."
                      className="w-full"
                    />
                  </div>
                  <PageStage section={section}>
                  {section === 'library' ? (
                    <LibraryPage />
                  ) : section === 'statistics' ? (
                    <StatisticsPage />
                  ) : section === 'settings' ? (
                    <SettingsPanel />
                  ) : (
                    <div className="home-column">
                      {/*
                       * No docked film here.
                       *
                       * Home used to reserve a 16:9 rectangle at the top of the
                       * column for whatever mpv was drawing. On a wide window
                       * that rectangle is ~700px tall, the card under it is
                       * `flex: 1` against a `min-height: 0`, and so returning to
                       * Home mid-lecture showed a heading and nothing else — the
                       * continue-listening hero and both ranked lists had been
                       * squeezed to zero. Home's job is to say what you were
                       * watching, not to be the screen you watch it on; that is
                       * what Library, the card and fullscreen are for.
                       */}
                      <section
                        className="track-section liquid-glass-card small"
                        data-glass
                        data-config={cardGlass(20)}
                        data-no-capture
                      >
                        <HomePage onBrowse={() => usePlayerStore.getState().setSection('library')} />
                      </section>
                    </div>
                  )}
                  </PageStage>
                </main>
              </div>
            </div>

            <PlayerBar />
          </div>
        )}

        {layerShown('mini') && (
          <div className={`mode-layer ${layerClass('mini')}`} data-no-capture>
            <div className="app-shell mini-shell" data-no-capture>
              <MiniPlayer />
            </div>
          </div>
        )}

        {layerShown('pill') && (
          <div className={`mode-layer ${layerClass('pill')}`} data-no-capture>
            <div className="app-shell pill-shell" data-no-capture>
              <PillPlayer />
            </div>
          </div>
        )}

        {/* Always mounted so the shared <video> element never leaves the document */}
        <VideoStage />

        {/*
         * Asked once, in the one window that owns the answers. Overlays are a
         * transport with no library to configure, and the takeover views sit on top
         * of this layer — setup is a question for the app you are looking at, not
         * for a card floating over someone else's desktop.
         */}
        {!IS_OVERLAY_WINDOW && !onboarded && (
          <SetupWizard
            onPinFolder={pinFolder}
            onDone={() => usePlayerStore.getState().setOnboarded(true)}
          />
        )}

        {layerShown('full') && view !== 'mini' && view !== 'pill' && !videoFullscreen && (
          <NowPlayingFull />
        )}
      </div>
    </DropZone>
  );
}
