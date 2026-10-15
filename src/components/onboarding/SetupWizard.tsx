import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { toMediaUrl } from '../../audio/engine';
import BrandMark from '../ui/BrandMark';
import VinylBackground from '../backdrop/VinylBackground';
import Icon from '../ui/Icon';

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

const STEPS = [
  { key: 'profile', label: 'You', icon: 'pencil' },
  { key: 'library', label: 'Library', icon: 'playlist' },
  { key: 'backdrop', label: 'Backdrop', icon: 'image' },
  { key: 'system', label: 'Windows', icon: 'settings' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

interface Props {
  /** Opens the folder dialog and scans what was picked. From `useLibrary`. */
  onPinFolder: () => Promise<void> | void;
  onDone: () => void;
}

/**
 * The three questions the app cannot answer for itself.
 *
 * A fresh install used to open onto an empty library with a default wallpaper and
 * the Windows account picture, and every one of those had to be hunted for
 * separately across the Library page and two halves of Settings. This asks them in
 * the order they actually matter.
 *
 * It is deliberately not a wall. Three steps, each finishable in one press, and
 * every answer is a store write the Settings page can reach again — so skipping
 * the whole thing costs nothing except the walk back through Library and Settings
 * by hand.
 *
 * The room it sits in is the fullscreen record, borrowed rather than imitated:
 * the same `VinylBackground`, the same 18 px bake, the same bottom-left pivot,
 * turned under a frosted card. Setup is the one moment the app has to introduce
 * itself, and a flat black dialog would introduce a feature list rather than the
 * thing the user is about to spend their time looking at.
 */
export const SetupWizard: React.FC<Props> = ({ onPinFolder, onDone }) => {
  const folders = usePlayerStore((s) => s.folders);
  const library = usePlayerStore((s) => s.library);
  const isScanning = usePlayerStore((s) => s.isScanning);
  const avatarPath = usePlayerStore((s) => s.avatarPath);
  const background = usePlayerStore((s) => s.background);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);

  const [step, setStep] = useState<StepKey>('profile');
  const [user, setUser] = useState<{ displayName?: string; username?: string; avatar?: string | null } | null>(null);
  /*
   * The two things the app does to the machine rather than to itself, asked here
   * instead of being done on first launch: an install that edits the login items
   * and the taskbar before it has said hello is the one thing people uninstall.
   *
   * Both start on, which is what the user asked for and also what almost everyone
   * here wants — a player that is waiting when the laptop opens, and one that goes
   * to the tray rather than stopping dead when the cross is pressed. Unticking is
   * the whole opt-out, and both stay changeable in Settings.
   */
  const [pin, setPin] = useState(true);
  const [startup, setStartup] = useState(true);
  /*
   * The shipped wallpapers, in the same miniature grid Settings uses. Setup is
   * where most people choose their backdrop, and until now the only way to see what
   * ChaosX ships was to leave setup, open Settings, and read a list of file names.
   */
  const [stock, setStock] = useState<{
    dir: string;
    items: { name: string; path: string; kind: 'image' | 'video' }[];
  }>({ dir: '', items: [] });

  useEffect(() => {
    void window.electronAPI?.getUser().then((info) => {
      if (info) setUser(info as never);
    });
    void window.electronAPI?.getStockWallpapers?.().then((got) => {
      if (got) setStock(got);
    });
    /* A shortcut the user pinned by hand before installing this build is still
       theirs; the step should show the truth rather than re-asking. */
    void window.electronAPI?.isTaskbarPinned?.().then((on) => {
      if (on === undefined) return;
      setPin(on);
    });
    void window.electronAPI?.getAutoLaunch?.().then((on) => {
      if (typeof on === 'boolean') setStartup(on);
    });
  }, []);

  /*
   * Three seconds of "Scanning…", the same as the Library page's button. The card is
   * the way in to pinning a second folder, and holding it shut for the whole of a
   * first walk over the library turns the one control setup exists for into a
   * spinner.
   */
  const [scanAnnounced, setScanAnnounced] = useState(false);
  useEffect(() => {
    if (!isScanning) {
      setScanAnnounced(false);
      return;
    }
    setScanAnnounced(true);
    const timer = window.setTimeout(() => setScanAnnounced(false), 3000);
    return () => window.clearTimeout(timer);
  }, [isScanning]);

  /** Hand the two answers to main, then let the page close the wizard. */
  const finish = () => {
    const store = usePlayerStore.getState();
    // Unconditional, because the default is the answer: writing the same value the
    // field already carries is what registers the login item on a first run, and
    // skipping it on the grounds that nothing changed is how the switch ends up
    // reading "On" against a machine that was never told.
    store.setAutoStartup(startup);
    /*
     * Only ever a request to *add* the pin. Windows answers it with its own dialog,
     * and there is no matching call to take the pin back — asking to switch it off
     * would spend the whole first run on a prompt that can only say no.
     */
    if (pin) void window.electronAPI?.setTaskbarPinned?.(true);
    onDone();
  };

  const rawName = user?.displayName || user?.username || 'there';
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
  const windowsPicture = user?.avatar ?? null;

  /*
   * The disc shows the wallpaper the user is standing on, which is the katana for
   * anyone coming through here for the first time. `wallpaperPath` is already a
   * `toMediaUrl`-able value — an absolute Windows path, or the shipped
   * `/brand/wallpapers/train_upscaled.jpg` for a fresh install — so it goes through the same resolver the rest of the
   * app uses rather than a second rule for what counts as a URL.
   */
  const discArt = toMediaUrl(wallpaperPath || '/brand/wallpapers/train_upscaled.jpg');

  const pickAvatar = async () => {
    const file = await window.electronAPI?.openFile({
      title: 'Choose a profile picture',
      filters: [{ name: 'Images', extensions: IMAGE_EXT }],
    });
    if (file) usePlayerStore.getState().setAvatar(file);
  };

  const pickWallpaper = async () => {
    const file = await window.electronAPI?.openFile({
      title: 'Choose a wallpaper',
      filters: [
        { name: 'Images and videos', extensions: [...IMAGE_EXT, ...VIDEO_EXT] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (!file) return;
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    usePlayerStore.getState().setWallpaper(file, VIDEO_EXT.includes(ext) ? 'video' : 'image');
  };

  /*
   * The two sources, one selected at a time.
   *
   * Windows' own desktop used to be a third option here and is gone from the app
   * everywhere, and so is the blurred-past-recognition version of the record: it
   * was a refinement of the album art rather than a different answer to "what is
   * behind the glass", and the one question this screen asks is that question.
   */
  const chooseCustom = () => {
    usePlayerStore.getState().setBackground('custom');
    if (!wallpaperPath) void pickWallpaper();
  };
  const chooseArt = () => {
    usePlayerStore.getState().setBackground('art');
  };
  const chooseStock = (item: { path: string; kind: 'image' | 'video' }) => {
    const store = usePlayerStore.getState();
    store.setWallpaper(item.path, item.kind);
    store.setBackground('custom');
  };

  const songCount = library.filter((t) => t.kind !== 'video').length;
  const index = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="setup-scrim" data-no-capture role="dialog" aria-modal="true" aria-label="Set up ChaosX">
      <VinylBackground art={discArt} playing blurPx={18} />
      <div className="setup-shade" data-no-capture />

      {/*
       * Not `liquid-glass-card`. That class is the one lever Small Potato Mode
       * pulls to strip every card's background and backdrop-filter at once, and
       * the library window runs with it on — so borrowing it here would have
       * removed the very frost that keeps the card readable over the record,
       * which is what made this screen a black box.
       */}
      <div className="setup-card" data-no-capture>
        <div className="setup-brand">
          <BrandMark />
        </div>

        <header className="setup-head">
          <div>
            <h1 className="setup-title">Welcome, {name}</h1>
            <p className="setup-sub">Three quick things, and ChaosX is yours.</p>
          </div>
          <button
            type="button"
            className="liquid-glass-btn small-text squish"
            onClick={finish}
            data-tip="Skip setup — everything stays changeable in Settings"
          >
            Skip for now
          </button>
        </header>

        <nav className="setup-rail" aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className={`setup-rail-step ${s.key === step ? 'active' : ''} ${i < index ? 'done' : ''}`}
              onClick={() => setStep(s.key)}
            >
              <span className="setup-rail-num">
                {i < index ? <Icon name="check" size={11} /> : i + 1}
              </span>
              <Icon name={s.icon} size={13} />
              {s.label}
            </button>
          ))}
        </nav>

        {step === 'profile' && (
          <section className="setup-body">
            <p className="setup-lead">
              This is the face in the sidebar. Leave it alone to keep your Windows
              picture.
            </p>
            <div className="setup-profile-row">
              <button
                type="button"
                className="avatar-plate setup-avatar"
                onClick={() => void pickAvatar()}
                data-tip="Choose a profile picture"
                aria-label="Profile picture"
              >
                {avatarPath ? (
                  <img src={toMediaUrl(avatarPath)} alt="" />
                ) : windowsPicture ? (
                  /* The pale frame is baked into the Windows file, so only this
                     branch is cropped. See `.avatar-plate img.is-windows`. */
                  <img className="is-windows" src={windowsPicture} alt="" />
                ) : (
                  <span>{name.charAt(0)}</span>
                )}
                <span className="avatar-edit" aria-hidden>
                  <Icon name="pencil" size={11} />
                </span>
              </button>
              <div className="setup-profile-text">
                <strong>{name}</strong>
                {/*
                 * Names what is actually on screen. The caption used to read
                 * "Using your Windows account picture" beside a letter, because
                 * Windows 11 stopped writing the registry key the lookup read — so
                 * the label described a picture the app had never found.
                 */}
                <span>
                  {avatarPath
                    ? `Using ${avatarPath.split(/[\\/]/).pop()}`
                    : windowsPicture
                      ? 'Using your Windows account picture'
                      : 'Windows has no picture set for this account, so your initial is used'}
                </span>
                {avatarPath ? (
                  <button
                    type="button"
                    className="setup-link"
                    onClick={() => usePlayerStore.getState().setAvatar(null)}
                  >
                    {windowsPicture ? 'Use the Windows picture instead' : 'Go back to the initial'}
                  </button>
                ) : null}
              </div>
            </div>
          </section>
        )}

        {step === 'library' && (
          <section className="setup-body">
            <p className="setup-lead">
              Point ChaosX at the folders your music and videos live in. It reads
              them once here, and you can pin more from the Library page later.
            </p>

            {/*
             * A door, not a manifest. The folder list already lives on the Library
             * page, where each one can also be unpin­ned and rescanned; repeating it
             * here gave setup a second, weaker copy of a control that already exists
             * — and setup's job is only to open the picker once.
             */}
            <button
              type="button"
              className="setup-pin-card"
              onClick={() => void onPinFolder()}
            >
              <span className="setup-pin-icon">
                <Icon name={scanAnnounced ? 'refresh' : 'plus'} size={20} />
              </span>
              <span className="setup-pin-title">
                {scanAnnounced ? 'Scanning…' : 'Choose folders to pin'}
              </span>
              <span className="setup-pin-sub">
                A folder picker opens. Everything inside it — audio and video — is
                read for tags, duration and cover art.
              </span>
            </button>

            <p className="setup-note setup-pin-tally">
              {isScanning
                ? 'Reading the folders you picked…'
                : folders.length === 0
                  ? 'Nothing pinned yet — the library stays empty until you add a folder.'
                  : `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} pinned · ${songCount} ${songCount === 1 ? 'song' : 'songs'} in the library`}
            </p>
          </section>
        )}

        {step === 'backdrop' && (
          <section className="setup-body">
            <p className="setup-lead">
              Everything in ChaosX is glass, and glass needs something behind it.
              Pick which.
            </p>
            <div className="setup-tiles setup-tiles-two">
              <button
                type="button"
                className={`setup-tile ${background === 'custom' ? 'is-active' : ''}`}
                onClick={chooseCustom}
                aria-pressed={background === 'custom'}
              >
                <span className="setup-tile-face">
                  {wallpaperPath ? (
                    VIDEO_EXT.includes((wallpaperPath.split('.').pop() ?? '').toLowerCase()) ? (
                      <video src={toMediaUrl(wallpaperPath)} muted loop autoPlay playsInline />
                    ) : (
                      <img src={toMediaUrl(wallpaperPath)} alt="" />
                    )
                  ) : (
                    <Icon name="image" size={26} />
                  )}
                </span>
                <span className="setup-tile-title">Custom wallpaper</span>
                <span className="setup-tile-sub">
                  Any image or video you choose, used everywhere. Static images are
                  recommended for low-end PCs.
                </span>
              </button>
              <button
                type="button"
                className={`setup-tile ${background === 'art' ? 'is-active' : ''}`}
                onClick={chooseArt}
                aria-pressed={background === 'art'}
              >
                <span className="setup-tile-face setup-face-art">
                  <Icon name="theatre" size={26} />
                </span>
                <span className="setup-tile-title">Album art</span>
                <span className="setup-tile-sub">
                  The backdrop follows whatever is playing, and tints the whole
                  interface with it.
                </span>
              </button>
            </div>
            {background === 'custom' ? (
              <div className="setup-actions">
                <button
                  type="button"
                  className="liquid-glass-btn small-text squish"
                  onClick={() => void pickWallpaper()}
                >
                  <Icon name="image" size={13} />
                  {wallpaperPath ? 'Choose a different wallpaper' : 'Choose a wallpaper'}
                </button>
                {wallpaperPath ? <span className="setup-note truncate">{wallpaperPath}</span> : null}
              </div>
            ) : null}
            {/*
             * The same miniature grid Settings has, because a name is not a
             * wallpaper. Videos are parked to one frame and only play under the
             * pointer, exactly as in Settings — six live decoders behind the glass
             * on a two-core laptop is the lag the app has already been charged with
             * once.
             */}
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
                      <video
                        src={toMediaUrl(item.path)}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onLoadedData={(e) => {
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
          </section>
        )}

        {step === 'system' && (
          <section className="setup-body">
            <p className="setup-lead">
              Two questions about the machine, and ChaosX stops asking.
            </p>
            <div className="setup-check-list">
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={pin}
                  onChange={(e) => setPin(e.target.checked)}
                />
                <span className="setup-check-text">
                  <strong>Pin to the taskbar</strong>
                  <span>
                    Keeps ChaosX one click away when it is not open. Windows asks you
                    once, as soon as setup finishes, and the icon appears the moment
                    you accept.
                  </span>
                </span>
              </label>
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={startup}
                  onChange={(e) => setStartup(e.target.checked)}
                />
                <span className="setup-check-text">
                  <strong>Start when Windows signs in</strong>
                  <span>
                    Appears in Task Manager&apos;s Startup apps, where it can be
                    turned off again by hand.
                  </span>
                </span>
              </label>
            </div>
            <p className="setup-note">
              Closing the window will keep playing in the system tray rather than
              stop the record. That is a setting too, under Settings &gt; System.
            </p>
          </section>
        )}

        <footer className="setup-foot">
          <button
            type="button"
            className="liquid-glass-btn small-text squish"
            onClick={() => setStep(STEPS[Math.max(0, index - 1)].key)}
            disabled={index === 0}
          >
            <Icon name="previous" size={12} />
            Back
          </button>
          {index < STEPS.length - 1 ? (
            <button
              type="button"
              className="liquid-glass-btn small-text squish setup-next"
              onClick={() => setStep(STEPS[index + 1].key)}
            >
              Next
              <Icon name="next" size={12} />
            </button>
          ) : (
            <button type="button" className="liquid-glass-btn small-text squish setup-next" onClick={finish}>
              Start listening
              <Icon name="check" size={12} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
};

export default SetupWizard;
