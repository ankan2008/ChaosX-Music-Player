import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { toMediaUrl } from '../../audio/engine';
import Icon from '../ui/Icon';
import BrandMark from '../ui/BrandMark';
import GlassClock from '../ui/GlassClock';
import TravelSheet from '../ui/TravelSheet';
import QuoteCard from '../widgets/QuoteCard';
import PomodoroCard from '../widgets/PomodoroCard';
import { cardGlass } from '../../utils/glass';
import type { UserInfo } from '../../types';

/** The four places, in the order the sheet walks them. */
const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'library', label: 'Library', icon: 'playlist' },
  { id: 'statistics', label: 'Statistics', icon: 'sort' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const;

/**
 * The clock's numeral height for a window this tall.
 *
 * The digits are masks cut from the font at one fixed height and laid out at it in
 * pixels, so CSS cannot shrink them the way it shrinks everything else — a `font-size`
 * change would not touch a mask. On a 1366x768 panel at 125% scaling the content
 * column is about 580 CSS pixels tall, and the four cards in the sidebar's stack
 * (greeting, navigation, quote, clock) plus the pomodoro below them need roughly 640
 * at the sizes this app was designed against. The clock is the one surface in that
 * stack whose whole job is four numerals, so it is the one that gives.
 */
function clockDigitHeight(innerHeight: number): number {
  if (innerHeight <= 600) return 17;
  if (innerHeight <= 680) return 20;
  if (innerHeight <= 780) return 23;
  return 27;
}

const Sidebar: React.FC<{
  className?: string;
}> = ({ className = '' }) => {
  const section = usePlayerStore((s) => s.section);
  const avatarPath = usePlayerStore((s) => s.avatarPath);
  const clockEnabled = usePlayerStore((s) => s.clockEnabled);
  const quotesEnabled = usePlayerStore((s) => s.quotesEnabled);
  const pomodoroEnabled = usePlayerStore((s) => s.pomodoroEnabled);
  const [user, setUser] = useState<UserInfo | null>(null);
  /*
   * The loaded picture's own width ÷ height, or 0 until it reports. The plate's
   * shape is decided from this rather than fixed: a square portrait cropped into a
   * landscape badge loses the top and bottom of a face, and a wide banner forced
   * into a squircle loses both edges. So the plate asks the image what it is
   * before it decides how to draw it.
   */
  const [avatarAspect, setAvatarAspect] = useState(0);
  const [digitHeight, setDigitHeight] = useState(() => clockDigitHeight(window.innerHeight));
  const navRef = useRef<HTMLDivElement | null>(null);
  /* Counted from the same array the markup maps over, never stored. */
  const navIndex = Math.max(0, NAV.findIndex((item) => item.id === section));
  /*
   * The three cards are the app's only continuous animations outside the
   * transport: the clock re-renders once a second, the quote card re-fits its type
   * on every resize, and the pomodoro drives the hourglass at frame rate while a
   * round is running.
   *
   * They used to be taken out wholesale by a low-resource mode. That was the wrong
   * cut. Measured, all three together cost less than a single glass surface: the
   * clock is one text node a second, the quote is static once fitted, and the
   * hourglass is a ported SVG whose turn is the one animation the user has said
   * must not be touched. What actually costs memory is the WebGL scene pass. So the
   * cards answer to their own settings here and to nothing else.
   */
  const showQuotes = quotesEnabled;
  const showClock = clockEnabled;
  const showPomodoro = pomodoroEnabled;

  const pickAvatar = async () => {
    const file = await window.electronAPI?.openFile({
      title: 'Choose a profile picture',
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] },
      ],
    });
    if (file) usePlayerStore.getState().setAvatar(file);
  };

  useEffect(() => {
    void window.electronAPI?.getUser().then((info) => {
      if (info) setUser(info);
    });
  }, []);

  /*
   * Re-read the height rather than asking the user to close and reopen the window.
   * Snapping ChaosX to half a screen is the common way this column gets short, and
   * the clock should be smaller the moment it does rather than at the next launch.
   */
  useEffect(() => {
    const onResize = () => setDigitHeight(clockDigitHeight(window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const customName = usePlayerStore((s) => s.userName);
  const [nameEdit, setNameEdit] = useState(false);
  const rawName = customName || user?.displayName || user?.username || 'there';
  const username = rawName.charAt(0).toUpperCase() + rawName.slice(1);

  return (
    <aside
      className={`liquid-glass-panel sidebar ${className}`}
      data-glass
      data-config={cardGlass(26)}
      data-no-capture
    >
      <header className="user-block">
        {/*
         * The mark, not the word. "ChaosX" as a heading duplicated what the
         * artwork already says, and the drawn wordmark carries the script face,
         * the gold and the X that no font in the build can produce.
         */}
        <BrandMark />
        {/* Its own card, in the same style as the clock and view cards below
            it: the greeting is a surface, not a caption glued to the title. */}
        <div
          className="liquid-glass-card small user-identity"
          data-glass
          data-config={cardGlass(18)}
          data-no-capture
        >
          {/*
           * A wrapper rather than putting the reset button inside the plate,
           * because the plate clips (`overflow: hidden` is what makes the rounded
           * corners cut the picture) and a child control would be cut with it. It
           * also keeps the reset out of the plate's own click, so pressing one
           * cannot accidentally be the other.
           */}
          <div
            className={`avatar-slot ${avatarAspect >= 0.9 && avatarAspect <= 1.1 ? 'is-square' : avatarAspect ? 'is-wide' : ''}`}
          >
            <button
              className="avatar-plate"
              onClick={() => void pickAvatar()}
              data-tip="Change profile picture"
              aria-label="Change profile picture"
            >
              {avatarPath ? (
                <img
                  src={toMediaUrl(avatarPath)}
                  alt=""
                  onLoad={(e) => {
                    const n = e.currentTarget;
                    setAvatarAspect(n.naturalHeight ? n.naturalWidth / n.naturalHeight : 0);
                  }}
                />
              ) : user?.avatar ? (
                <img
                  className="is-windows"
                  src={user.avatar}
                  alt=""
                  onLoad={(e) => {
                    const n = e.currentTarget;
                    setAvatarAspect(n.naturalHeight ? n.naturalWidth / n.naturalHeight : 0);
                  }}
                />
              ) : (
                <span>{username.charAt(0).toUpperCase()}</span>
              )}
              <span className="avatar-edit" aria-hidden>
                <Icon name="pencil" size={11} />
              </span>
            </button>
            {/*
             * Only shown once there is something to undo. The Windows picture is
             * read from the registry at startup, so "reset" always has a defined
             * target — and with no custom file chosen there is nothing to go back
             * from, so the badge stays out of the way.
             */}
            {avatarPath ? (
              <button
                type="button"
                className="avatar-reset"
                onClick={() => usePlayerStore.getState().setAvatar(null)}
                data-tip="Use the Windows account picture"
                aria-label="Reset to the Windows account picture"
              >
                <Icon name="refresh" size={11} />
              </button>
            ) : null}
          </div>
          <div className="user-greeting">
            <span className="greeting-word">Welcome,</span>
            {nameEdit ? (
              <input
                className="greeting-input"
                autoFocus
                defaultValue={username}
                maxLength={24}
                aria-label="Your name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    // Closing the field unmounts it, and an unmounted input never
                    // fires `blur`, so Enter has to write the value itself.
                    usePlayerStore.getState().setUserName(e.currentTarget.value);
                    setNameEdit(false);
                  } else if (e.key === 'Escape') {
                    usePlayerStore.getState().setUserName(null);
                    setNameEdit(false);
                  }
                }}
                onBlur={(e) => {
                  usePlayerStore.getState().setUserName(e.currentTarget.value);
                  setNameEdit(false);
                }}
              />
            ) : (
              <>
                <span className="greeting-name">{username}</span>
                {/*
                 * The name is the Windows account's until the user says otherwise,
                 * and the reset only has something to undo once they have. Same
                 * shape as the avatar's pair of badges, so the two read as one
                 * lockup rather than two unrelated hover affordances.
                 */}
                <button
                  type="button"
                  className="greeting-edit"
                  onClick={() => setNameEdit(true)}
                  data-tip="Change your name"
                  aria-label="Change your name"
                >
                  <Icon name="pencil" size={10} />
                </button>
                {customName ? (
                  <button
                    type="button"
                    className="greeting-edit"
                    onClick={() => usePlayerStore.getState().setUserName(null)}
                    data-tip="Use the Windows account name"
                    aria-label="Use the Windows account name"
                  >
                    <Icon name="refresh" size={10} />
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </header>

      {/*
       * Navigation, not a folder dump.
       *
       * Every pinned folder used to be a row here, which meant the sidebar grew
       * with the library and never fitted. The folders belong to the Library page
       * now; this list is the
       * four places you can actually go — on a card of its own, with the same
       * travelling glass sheet the folder strip and the ranked lists carry, so the
       * page you are on is marked by the one object that moves rather than by four
       * rows that each repaint themselves.
       */}
      <div className="sidebar-scroll">
        <div className="liquid-glass-card small nav-card" data-glass data-config={cardGlass(18)} data-no-capture>
          <div className="travel-frame nav-travel">
            <TravelSheet itemsRef={navRef} activeIndex={navIndex} radius={13} ms={780} tint="var(--art-tint)" />
            <div className="sidebar-folders" ref={navRef}>
              {NAV.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    const s = usePlayerStore.getState();
                    s.setSection(item.id);
                    // Home is the whole library; the folder filter only means anything
                    // on the track list, so leaving the page resets it.
                    if (item.id === 'home') s.setSelectedFolder('all');
                  }}
                  className={`sidebar-row ${section === item.id ? 'active' : ''}`}
                >
                  <Icon name={item.icon} size={15} className="row-icon" />
                  <span className="row-label">{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/*
         * The quote is above the clock in the scroll order, deliberately.
         *
         * The clock is the one you can read anywhere on the taskbar; the quote is
         * the one that only exists here. It still gets the gap under the navigation
         * the clock used to leave empty — the two simply trade places when space
         * runs out.
         */}
        {showQuotes ? <QuoteCard /> : null}

        {showClock ? (
          <div
            className="liquid-glass-card small clock-card"
            data-glass
            data-config={cardGlass(18)}
            data-no-capture
          >
            {/*
             * `plainDate`, because this clock already sits on a card. The date's
             * own pill was a second piece of glass inside the first, and the one
             * thing it was there to do — separate the day from the numerals — the
             * gap between them does for free.
             */}
            <GlassClock digitHeight={digitHeight} className="sidebar-clock" plainDate />
          </div>
        ) : null}
      </div>

      {/* The view picker moved onto the player pill, next to the controls it
          belongs with. As a card here it was the eighth surface in a column that
          had to be scrolled to read, and the mode you are in is something you
          change while looking at the transport, not while reading the clock. */}
      {showPomodoro ? <PomodoroCard /> : null}
    </aside>
  );
};

export default Sidebar;
