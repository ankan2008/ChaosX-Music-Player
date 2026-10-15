import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine, toMediaUrl } from '../../audio/engine';
import { EQ_BANDS_HZ } from '../../../shared/audio';
import Icon from '../ui/Icon';
import BrandMark from '../ui/BrandMark';
import PageHead from '../ui/PageHead';
import { QUOTES } from '../../data/quotes';
import { cardGlass } from '../../utils/glass';
import {
  BIND_LABELS,
  BIND_ORDER,
  bindFromEvent,
  bindLabel,
  readBind,
  type BindId,
  type KeyBind,
} from '../../utils/keybinds';

const EQ_PRESETS: Record<string, number[]> = {
  Flat: EQ_BANDS_HZ.map(() => 0),
  'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 1, 2],
  Vocal: [-3, -2, 0, 2, 4, 4, 3, 1, -1, -2],
  Treble: [-4, -3, -2, -1, 0, 0, 1, 3, 5, 6],
  Electronic: [5, 4, 1, -2, -1, 2, 4, 5, 4, 3],
  Acoustic: [3, 2, 1, 2, 3, 3, 2, 2, 1, 1],
};

/*
 * The keyboard map is no longer a table written here.
 *
 * It used to be, and it disagreed with the `switch` that actually acted on keys:
 * four rows described two seeks because the hook had been changed and this copy
 * had not. Both halves now read one table in `utils/keybinds`, and the row below
 * is the only place that renders it.
 */
const BindRow: React.FC<{ id: BindId }> = ({ id }) => {
  const bind = usePlayerStore((s) => readBind(s.binds, id));
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<KeyBind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    /*
     * Capture phase, and it stops the event. The app's own shortcut listener is on
     * the same window in the bubble phase; without this, pressing the key you are
     * testing would also *do* the thing it is bound to — mute while rebinding
     * mute, or close the takeover while rebinding Escape.
     */
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (pending && e.key === 'Enter') {
        const clash = usePlayerStore.getState().setBind(id, pending);
        setError(clash);
        if (!clash) {
          setRecording(false);
          setPending(null);
        }
        return;
      }
      if (e.key === 'Escape') {
        setRecording(false);
        setPending(null);
        setError(null);
        return;
      }
      const next = bindFromEvent(e);
      if (next) setPending(next);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, pending, id]);

  const shown = pending ?? bind;

  return (
    <div className={`shortcut-row ${recording ? 'recording' : ''}`}>
      <span className="shortcut-desc">{BIND_LABELS[id]}</span>
      <span className="shortcut-bind">
        <button
          type="button"
          className={`glass-badge bind-key ${recording ? 'pending' : ''}`}
          onClick={() => {
            setRecording((v) => !v);
            setPending(null);
            setError(null);
          }}
          data-tip={recording ? 'Press a combination, then Enter. Esc cancels.' : 'Click, then press the combination you want'}
          aria-label={`Rebind ${BIND_LABELS[id]}`}
        >
          {recording ? (pending ? bindLabel(pending) : 'Press keys…') : bindLabel(shown)}
        </button>
        {recording ? (
          <span className="bind-hint">
            {pending ? 'Enter to confirm' : 'Waiting for a key'}
            {' · Esc cancels'}
          </span>
        ) : null}
      </span>
      {error ? <p className="settings-hint bind-error">{error}</p> : null}
    </div>
  );
};

/*
 * Every format the app can put behind its glass, not a hand-picked shortlist.
 *
 * The file dialog used to open on the Images filter with Videos as a second
 * choice, which meant a clip had to be hunted for by switching the dropdown
 * first — and anything outside the five containers listed there was invisible
 * unless the user found "All files" and picked through every document on the
 * disk. One filter, both families, and the lists are wide enough that a `.heic`
 * or a `.m2ts` shows up without the user having to know the word for it.
 */
const IMAGE_EXT = [
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'apng', 'bmp', 'dib',
  'avif', 'heic', 'heif', 'tif', 'tiff', 'svg', 'ico', 'cur', 'raw', 'arw',
  'cr2', 'nef', 'dng', 'tga', 'pcx', 'wmf', 'emf', 'qoi',
];
const VIDEO_EXT = [
  'mp4', 'm4v', 'mkv', 'mk3d', 'webm', 'mov', 'avi', 'divx', 'wmv', 'asf',
  'mpg', 'mpeg', 'mpe', 'm1v', 'm2v', 'ts', 'm2ts', 'mts', 'vob', 'ogv',
  'ogm', '3gp', '3g2', 'f4v', 'flv', 'h264', 'h265', 'hevc', 'av1',
];
const MEDIA_EXT = [...IMAGE_EXT, ...VIDEO_EXT];

/**
 * The colophon at the foot of Settings.
 *
 * Written to say what this app actually is rather than to list licences: an
 * offline player whose glass is real screen frost, whose three surfaces share one
 * clock, and which has no server to phone. The rows are links and one-liners, not
 * a legal table — anyone who wants the licence can find it in the repository.
 */
const CREDITS_LINKS: Array<{
  label: string;
  note: string;
  handle: string;
  url: string;
  avatars: string[];
}> = [
  {
    label: 'GitHub',
    note: 'Sources, issues, bug reports, and feature requests',
    handle: 'ankan2008',
    url: 'https://github.com/ankan2008',
    /*
     * Tried in order, first hit wins.
     *
     * GitHub publishes an avatar at a stable URL derived from the username, so
     * that one needs nothing from anyone. Instagram does not: its profile
     * picture sits behind a logged-in session, the public page no longer
     * carries an `og:image`, and the free avatar proxies all refuse the
     * provider — so the only honest source is the user's own copy of the
     * picture, dropped into `public/brand/`. A local file also survives offline
     * starts, which a CDN link does not.
     */
    avatars: ['./brand/github.png', 'https://github.com/ankan2008.png?size=128'],
  },
  {
    label: 'Instagram',
    note: "If you fell in love with 'Me' instead of mah app",
    handle: '@silentchaos_2008',
    url: 'https://www.instagram.com/silentchaos_2008/',
    avatars: ['./brand/instagram.png', './brand/instagram.jpg'],
  },
];

/**
 * The account's face, or a letter if no source resolves.
 *
 * Each candidate is tried in turn and the first that decodes wins. The walk has
 * to happen here rather than being left to the `<img>`: a broken-image glyph
 * inside a 34px squircle is the one thing in this card that would read as a bug
 * rather than as a choice.
 */
const CreditAvatar: React.FC<{ sources: string[]; handle: string }> = ({ sources, handle }) => {
  const [at, setAt] = useState(0);
  const letter = (handle.match(/[A-Za-z]/)?.[0] ?? '@').toUpperCase();
  const src = sources[at];
  if (!src) {
    return (
      <span className="credits-avatar is-mono" aria-hidden>
        {letter}
      </span>
    );
  }
  return (
    <img
      className="credits-avatar"
      src={src}
      alt=""
      width={34}
      height={34}
      loading="lazy"
      onError={() => setAt((n) => n + 1)}
    />
  );
};

const Credits: React.FC = () => {
  const open = (url: string) => void window.electronAPI?.openExternal?.(url);

  return (
    <section className="credits">
      <span className="credits-eyebrow">Credits</span>
      {/*
       * The name as drawn art rather than as a string in a script face: the
       * artwork on a liquid-glass squircle, the wordmark on a liquid-glass pill
       * beside it. The same mark opens the sidebar, so the two agree.
       */}
      <BrandMark className="credits-brand" />
      <p className="credits-byline">
        Vibecoded with passion, by <b>Ankan</b> (though I coded more than the damn AI)
      </p>
      {/*
       * What the links below are *for*. The card used to carry four paragraphs of
       * prose about the architecture, which repeated the README and pushed the
       * things a person might actually want to do off the bottom of the column.
       */}
      <p className="credits-contact">Contact the dev, report bugs, and offer more ideas</p>
      {/*
       * The mark number is the release name: `ChaosX Mark x<Major>.<Minor>`, minor
       * for small updates, major for the ones the dev calls big. Keep it in step
       * with `version` in package.json when either ticks.
       */}
      <span className="credits-version">ChaosX Mark x1.0</span>

      {CREDITS_LINKS.map((row) => (
        <button key={row.label} type="button" className="credits-row" onClick={() => open(row.url)}>
          <CreditAvatar sources={row.avatars} handle={row.handle} />
          <span className="credits-row-main">
            <span className="credits-row-title">{row.label}</span>
            <span className="credits-row-note">{row.note}</span>
          </span>
          <span className="credits-row-handle">{row.handle}</span>
        </button>
      ))}
    </section>
  );
};

const SettingsPanel: React.FC = () => {
  const background = usePlayerStore((s) => s.background);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);
  const wallpaperKind = usePlayerStore((s) => s.wallpaperKind);
  const wallpaperBlur = usePlayerStore((s) => s.wallpaperBlur);
  const tintStrength = usePlayerStore((s) => s.tintStrength);
  const backdropDim = usePlayerStore((s) => s.backdropDim);
  const backdropSat = usePlayerStore((s) => s.backdropSat);
  const volume = usePlayerStore((s) => s.volume);
  const speed = usePlayerStore((s) => s.speed);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const miniPlayer = usePlayerStore((s) => s.miniPlayer);
  const eq = usePlayerStore((s) => s.eq);
  const clipGuard = usePlayerStore((s) => s.clipGuard);
  const clockEnabled = usePlayerStore((s) => s.clockEnabled);
  const quotesEnabled = usePlayerStore((s) => s.quotesEnabled);
  const pomodoroEnabled = usePlayerStore((s) => s.pomodoroEnabled);
  const clockInFullscreen = usePlayerStore((s) => s.clockInFullscreen);
  const quotesInFullscreen = usePlayerStore((s) => s.quotesInFullscreen);
  const lyricsEnabled = usePlayerStore((s) => s.lyricsEnabled);
  const customQuotes = usePlayerStore((s) => s.customQuotes);
  const [quoteText, setQuoteText] = useState('');
  const [quoteAuthor, setQuoteAuthor] = useState('');
  const autoStartup = usePlayerStore((s) => s.autoStartup);
  const closeToTray = usePlayerStore((s) => s.closeToTray);
  const store = usePlayerStore.getState;
  const section = usePlayerStore((s) => s.settingsSection);
  const [picking, setPicking] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /*
   * The shipped wallpaper set, read off disk rather than hard-coded.
   *
   * Main hands back the folder *and* its contents, so what the picker offers is
   * what is actually installed — and a user who drops another picture or film into
   * that folder sees it here on the next open without anything being rebuilt. That
   * is also why the path is printed under the Replace button rather than hidden:
   * the sentence is only useful if it names the folder it means.
   */
  const [stock, setStock] = useState<{
    dir: string;
    items: { name: string; path: string; kind: 'image' | 'video' }[];
  }>({ dir: '', items: [] });

  useEffect(() => {
    void window.electronAPI?.getStockWallpapers?.().then((got) => {
      if (got) setStock(got);
    });
  }, []);

  /*
   * Read from the shell rather than remembered. A taskbar button is the shell's
   * object, and the user can unpin it without ever opening this app — a switch that
   * kept its own copy of the answer would lie.
   */
  const [pinned, setPinned] = useState(false);
  /** Windows has the prompt up and the answer has not come back yet. */
  const [pinPending, setPinPending] = useState(false);
  /** Why the last attempt failed, in the shell's words rather than a shrug. */
  const [pinError, setPinError] = useState<string | null>(null);
  useEffect(() => {
    void window.electronAPI?.isTaskbarPinned?.().then((on) => setPinned(on === true));
    /*
     * The login item is the other thing on this page that Windows can change
     * behind the app's back. Task Manager's Startup tab switches a login item off
     * without deleting it, and nothing about `setLoginItemSettings` ever mentions
     * the veto — so the only way this row can tell the truth is to ask the shell
     * what will actually happen at the next sign-in.
     */
    store().syncAutoStartup();
  }, []);

  const togglePin = () => {
    const next = !pinned;
    setPinError(null);
    /*
     * On is a request Windows may take its time over, so the button says what is
     * happening rather than guessing: the state is only touched once the shell has
     * answered, and a refusal re-reads the bar instead of assuming the old answer.
     */
    if (next) setPinPending(true);
    else setPinned(false);
    void window.electronAPI
      ?.setTaskbarPinned?.(next)
      .then(async (reply) => {
        const on = await window.electronAPI?.isTaskbarPinned?.();
        setPinned(on === true);
        if (reply && !reply.ok) setPinError(reply.error ?? 'Windows did not add the pin');
      })
      .finally(() => setPinPending(false));
  };

  const chooseStock = (item: { path: string; kind: 'image' | 'video' }) => {
    store().setWallpaper(item.path, item.kind);
    store().setBackground('custom');
  };

  // The pill and HUD equalizer buttons ask for that group specifically.
  useEffect(() => {
    if (section !== 'eq') return;
    panelRef.current
      ?.querySelector('#settings-eq')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [section]);

  const applyEqGains = (gains: number[]) => {
    store().setEq({ gains });
    getEngine().setEqGains(eq.enabled ? gains : gains.map(() => 0));
  };

  const pickWallpaper = async () => {
    setPicking(true);
    try {
      const file = await window.electronAPI?.openFile({
        title: 'Choose a wallpaper',
        filters: [
          { name: 'Images and videos', extensions: MEDIA_EXT },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (!file) return;
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      store().setWallpaper(file, VIDEO_EXT.includes(ext) ? 'video' : 'image');
    } finally {
      setPicking(false);
    }
  };

  /*
   * The two backdrops are one choice, not two switches.
   *
   * They used to be a `background` enum and a separate `artBackdrop` boolean,
   * which let a user land on "no custom wallpaper and no album art" — a window
   * with nothing behind its glass, reading as a bug rather than as a setting. One
   * field with two values cannot be in none of them. The third value this offered
   * for a while — the cover blurred past recognition — is gone: it was a second
   * way to wear the record, and the person using it wanted the record.
   */
  const pickCustomBackground = () => {
    store().setBackground('custom');
    if (!wallpaperPath) void pickWallpaper();
  };

  const pickArtBackdrop = () => store().setBackground('art');

  return (
    <div className="app-page settings-page" ref={panelRef}>
      <div className="settings-panel">
        {/*
         * Two cards per row, then one card split in two.
         *
         * Every card used to be `min(100%, 620px)` and centred, which on a
         * maximised window left roughly a third of the page empty on each side and
         * turned a five-card screen into a scroll. Pairing them fills the column,
         * and the grid's default `stretch` is what makes Theme and Widgets — and
         * System and Shortcuts — come out the same height without a magic number
         * anywhere.
         */}
        <div className="settings-row">
        {/* ── Theme ────────────────────────────────────────── */}
        <section
          className="liquid-glass-card settings-card"
          data-glass
          data-config={cardGlass(18)}
          data-no-capture
        >
          <h3 className="settings-card-title">Customization</h3>

          <div className="settings-field">
            <div className="settings-field-head">
              <h4>Background</h4>
            </div>
            <div className="settings-pill-row background-pills">
              <button
                onClick={pickCustomBackground}
                className={`liquid-glass-btn small-text squish pill-choice ${background === 'custom' ? 'active' : ''}`}
              >
                Custom background
              </button>
              <button
                onClick={pickArtBackdrop}
                className={`liquid-glass-btn small-text squish pill-choice ${background === 'art' ? 'active' : ''}`}
              >
                Album art
              </button>
            </div>
            {/*
             * A custom wallpaper is the only place a video can be painted behind
             * the whole window, so this is the only place that warning is true. It
             * used to sit under both buttons and tell an album-art user about a
             * file they had not chosen.
             */}
            {background === 'custom' ? (
              <p className="settings-hint">
                For custom wallpaper, static/video wallpapers are supported, but video
                wallpapers are not recommended for low end PCs.
              </p>
            ) : null}
            {background === 'custom' && wallpaperPath ? (
              <div className="wallpaper-row">
                <div className="wallpaper-thumb">
                  {wallpaperKind === 'video' ? (
                    <video src={toMediaUrl(wallpaperPath)} muted loop autoPlay playsInline />
                  ) : (
                    <img src={toMediaUrl(wallpaperPath)} alt="" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">
                    {wallpaperPath.split(/[\\/]/).pop()}
                  </p>
                  <div className="flex gap-2 mt-2">
                    <button
                      onClick={() => void pickWallpaper()}
                      disabled={picking}
                      className="liquid-glass-btn small-text squish"
                    >
                      {picking ? 'Opening…' : 'Replace'}
                    </button>
                  </div>
                  {/*
                   * The folder, spelled out, because it is the answer to the next
                   * question anyone who reads this will ask — where are they, and can
                   * I have another one. Pressing it opens the same folder in Explorer,
                   * and anything dropped into it turns up in the strip below the next
                   * time this card is opened.
                   */}
                  {stock.dir ? (
                    <p className="settings-hint stock-note">
                      Check out the stock wallpapers from{' '}
                      <button
                        type="button"
                        className="stock-note-path"
                        onClick={() => void window.electronAPI?.openStockWallpapers?.()}
                        data-tip="Open the folder"
                      >
                        {stock.dir}
                      </button>
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}
            {background === 'custom' && stock.items.length ? (
              <div className="stock-wallpapers" role="listbox" aria-label="Stock wallpapers">
                {stock.items.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    role="option"
                    aria-selected={wallpaperPath === item.path}
                    className={`stock-tile ${wallpaperPath === item.path ? 'is-active' : ''}`}
                    onClick={() => chooseStock(item)}
                    data-tip={item.name}
                  >
                    {item.kind === 'video' ? (
                      /*
                       * No `autoPlay`, and this is not a taste call.
                       *
                       * Six clips playing at once was what the grid used to be, and
                       * it cost the page twice over. Every live `<video>` inside the
                       * glass root sets the engine's `hasDynamic` flag, which makes
                       * it re-composite the whole scene on every frame rather than
                       * only the panels that moved — measured at a median frame of
                       * 110 ms while scrolling Settings, against 36 ms with the
                       * canvases taken away. On a two-core laptop that is the
                       * reported lag, and the six decoders are a slice of the
                       * reported memory as well.
                       *
                       * Hover is the one place a clip earns its keep, so it plays
                       * there and is parked to a still frame everywhere else.
                       */
                      <video
                        src={toMediaUrl(item.path)}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onLoadedData={(e) => {
                          // A frame to look at, taken once and then frozen — the
                          // tile has to read as a picture until it is asked for.
                          const v = e.currentTarget;
                          if (v.paused) v.currentTime = Math.min(0.6, (v.duration || 1) / 3);
                        }}
                        onMouseEnter={(e) => void e.currentTarget.play().catch(() => undefined)}
                        onMouseLeave={(e) => {
                          const v = e.currentTarget;
                          v.pause();
                          v.currentTime = Math.min(0.6, (v.duration || 1) / 3);
                        }}
                      />
                    ) : (
                      <img src={toMediaUrl(item.path)} alt="" loading="lazy" />
                    )}
                    <span className="stock-tile-name truncate">{item.name}</span>
                    {item.kind === 'video' ? (
                      <span className="stock-tile-flag" aria-hidden>
                        <Icon name="theatre" size={10} />
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/*
           * The room's softness, offered in both modes now that the mode which
           * carried its own fixed radius is gone.
           */}
          <div className="settings-slider">
            <div className="settings-slider-head">
              <h4>Backdrop blur</h4>
              <span>{wallpaperBlur}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={64}
              step={1}
              value={wallpaperBlur}
              onChange={(e) => store().setWallpaperBlur(parseInt(e.target.value, 10))}
              className="glass-slider"
              style={{ '--progress': `${(wallpaperBlur / 64) * 100}%` } as React.CSSProperties}
            />
          </div>

          <div className="settings-slider">
            <div className="settings-slider-head">
              <h4>Backdrop darkness</h4>
              <span>{backdropDim}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={backdropDim}
              onChange={(e) => store().setBackdropDim(parseInt(e.target.value, 10))}
              className="glass-slider"
              style={{ '--progress': `${backdropDim}%` } as React.CSSProperties}
            />
          </div>

          {/*
           * No conditional on this one or the slider above it.
           *
           * The lift is baked into the backdrop's own draw, which is the single
           * surface the shader refracts, so both backgrounds answer to it. Hiding
           * it anywhere would be a control that works but is not offered.
           *
           * It says what zero is, because the honest reading of a slider beside
           * "Backdrop darkness" is that it is a second dimmer, and it is the opposite
           * of one — the picture gets richer at the same brightness, always.
           */}
          <div className="settings-slider">
            <div className="settings-slider-head">
              <h4>Colour depth</h4>
              <span>{backdropSat === 0 ? 'Default' : `${backdropSat}%`}</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={backdropSat}
              onChange={(e) => store().setBackdropSat(parseInt(e.target.value, 10))}
              className="glass-slider"
              style={{ '--progress': `${backdropSat}%` } as React.CSSProperties}
            />
          </div>
        </section>

        {/* ── Widgets ──────────────────────────────────────── */}
        <section
          className="liquid-glass-card settings-card"
          data-glass
          data-config={cardGlass(18)}
          data-no-capture
        >
          <h3 className="settings-card-title">Widgets</h3>
          <div className="settings-switch-row">
            <span>Clock</span>
            <button
              onClick={() => store().setClockEnabled(!clockEnabled)}
              className={`liquid-glass-btn small-text squish pill-choice ${clockEnabled ? 'active' : ''}`}
            >
              {clockEnabled ? 'On' : 'Off'}
            </button>
          </div>
          {/*
           * Deliberately not nested inside the switch above it. These two rows answer
           * two different questions — is the widget on the sidebar, is it over the
           * artwork — and hiding one behind the other made the pair behave as though
           * the first still owned the second.
           */}
          <div className="settings-switch-row is-sub">
            <span>In fullscreen music</span>
            <button
              onClick={() => store().setClockInFullscreen(!clockInFullscreen)}
              className={`liquid-glass-btn small-text squish pill-choice ${clockInFullscreen ? 'active' : ''}`}
            >
              {clockInFullscreen ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-switch-row">
            <span>Motivational quotes</span>
            <button
              onClick={() => store().setQuotesEnabled(!quotesEnabled)}
              className={`liquid-glass-btn small-text squish pill-choice ${quotesEnabled ? 'active' : ''}`}
            >
              {quotesEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-switch-row is-sub">
            <span>In fullscreen music</span>
            <button
              onClick={() => store().setQuotesInFullscreen(!quotesInFullscreen)}
              className={`liquid-glass-btn small-text squish pill-choice ${quotesInFullscreen ? 'active' : ''}`}
            >
              {quotesInFullscreen ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-switch-row">
            <span>Pomodoro</span>
            <button
              onClick={() => store().setPomodoroEnabled(!pomodoroEnabled)}
              className={`liquid-glass-btn small-text squish pill-choice ${pomodoroEnabled ? 'active' : ''}`}
            >
              {pomodoroEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <div className="settings-switch-row">
            <span>Lyrics</span>
            <button
              onClick={() => store().setLyricsEnabled(!lyricsEnabled)}
              className={`liquid-glass-btn small-text squish pill-choice ${lyricsEnabled ? 'active' : ''}`}
            >
              {lyricsEnabled ? 'On' : 'Off'}
            </button>
          </div>

          {/*
           * The quote pool, extendable. A card that only ever says what someone
           * else decided to put in the build is a screensaver; two lines and a
           * name is enough to make it yours.
           */}
          <div className="quote-manager">
            <h4 className="settings-sub-title">Your quotes</h4>
            <div className="quote-add">
              <input
                className="glass-input"
                placeholder="The line"
                value={quoteText}
                onChange={(e) => setQuoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    store().addQuote(quoteText, quoteAuthor);
                    setQuoteText('');
                    setQuoteAuthor('');
                  }
                }}
                aria-label="Quote text"
              />
              <input
                className="glass-input"
                placeholder="Who said it"
                value={quoteAuthor}
                onChange={(e) => setQuoteAuthor(e.target.value)}
                aria-label="Quote author"
              />
              <button
                type="button"
                className="liquid-glass-btn small-text squish"
                onClick={() => {
                  store().addQuote(quoteText, quoteAuthor);
                  setQuoteText('');
                  setQuoteAuthor('');
                }}
              >
                Add
              </button>
            </div>
            {customQuotes.length ? (
              <ul className="quote-list">
                {customQuotes.map((q, i) => (
                  <li key={`${q.t}-${i}`}>
                    <span className="quote-list-text">{q.t}</span>
                    <span className="quote-list-by">{q.a}</span>
                    <button
                      type="button"
                      className="quote-list-del"
                      onClick={() => store().removeQuote(i)}
                      data-tip="Remove this quote"
                      aria-label="Remove quote"
                    >
                      <Icon name="delete" size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settings-hint">
                Nothing added yet — the card rotates through the built-in pool of{' '}
                {QUOTES.length}.
              </p>
            )}
          </div>
        </section>
        </div>

        {/*
         * Two switches against fourteen binding rows.
         *
         * The row is cut in the shortcuts' favour because the binds are the only
         * thing here that is wide *and* long: they run two columns, and the columns
         * need the room the labels do not. The System card was the short half of
         * this pair for as long as it carried only switches — the grid stretches
         * both cards to the taller one, so the slack showed up as a band of empty
         * glass at the foot of the narrow side. Each switch now sits on a plate of
         * its own with its sentence underneath it, which is where the height comes
         * from: the two cards meet at the same line because they hold about the
         * same amount, not because one of them was padded out.
         */}

        <div className="settings-row settings-row-system">
          {/* ── System ───────────────────────────────────────── */}
          <section
          className="liquid-glass-card settings-card"
          data-glass
          data-config={cardGlass(18)}
          data-no-capture
        >
            <h3 className="settings-card-title">System</h3>
            <div className="settings-plate">
              <div className="settings-switch-row">
                <span>Start with Windows</span>
                <button
                  onClick={() => store().setAutoStartup(!autoStartup)}
                  className={`liquid-glass-btn small-text squish pill-choice ${autoStartup ? 'active' : ''}`}
                >
                  {autoStartup ? 'On' : 'Off'}
                </button>
              </div>
              <p className="settings-hint">
                Registers ChaosX as a login item, so it shows up in Task Manager&apos;s
                Startup tab where you can see it and turn it off.
              </p>
            </div>
            <div className="settings-plate">
              <div className="settings-switch-row">
                <span>Close to tray</span>
                <button
                  onClick={() => store().setCloseToTray(!closeToTray)}
                  className={`liquid-glass-btn small-text squish pill-choice ${closeToTray ? 'active' : ''}`}
                >
                  {closeToTray ? 'On' : 'Off'}
                </button>
              </div>
              <p className="settings-hint">
                The close button hides ChaosX into the notification-area overflow instead
                of quitting. Off, closing the window ends the app.
              </p>
            </div>
            <div className="settings-plate">
              <div className="settings-switch-row">
                <span>Pin to taskbar</span>
                <button
                  onClick={togglePin}
                  disabled={pinPending}
                  className={`liquid-glass-btn small-text squish pill-choice ${pinned ? 'active' : ''}`}
                >
                  {pinPending ? 'Waiting on Windows…' : pinned ? 'On' : 'Off'}
                </button>
              </div>
              <p className="settings-hint">
                ChaosX asks Windows to pin it, and Windows shows its own confirmation.
                Accept that and the icon is on the bar straight away. Taking it back off
                is done on the bar itself — Windows will not hand a pin back to the app
                that asked for it.
              </p>
              {pinError ? (
                <p className="settings-hint settings-hint-warn">
                  Not pinned: {pinError}.
                </p>
              ) : null}
            </div>
          </section>

          {/* ── Shortcuts ─────────────────────────────────────── */}
          <section
            className="liquid-glass-card settings-card settings-card-keys"
            data-glass
            data-config={cardGlass(18)}
            data-no-capture
          >
            <h3 className="settings-card-title">Keyboard shortcuts</h3>
            <p className="settings-hint">
              Click a key, press the combination you want, then Enter to confirm it.
              A combination that already belongs to another row is refused rather
              than quietly stolen, and Esc while recording puts the old one back.
            </p>
            <div className="shortcut-list">
              {BIND_ORDER.map((id) => (
                <BindRow key={id} id={id} />
              ))}
            </div>
            <button
              type="button"
              className="liquid-glass-btn small-text squish"
              onClick={() => usePlayerStore.getState().resetBinds()}
            >
              Restore the default keys
            </button>
          </section>
        </div>

        <div className="settings-row settings-row-centred">
          <section
          className="liquid-glass-card settings-card"
          data-glass
          data-config={cardGlass(18)}
          data-no-capture
        >
            <Credits />
          </section>
        </div>

      </div>
    </div>
  );
};

export default SettingsPanel;
