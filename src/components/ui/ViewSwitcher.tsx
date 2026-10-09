import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import Icon, { type IconName } from '../ui/Icon';
import TravelSheet from './TravelSheet';
import type { ViewMode } from '../../types';
import { OVERLAY_ROLE } from '../../utils/windowRole';

/**
 * The four shapes the app can take. One control shared by every surface, so
 * leaving a mode never means learning where that mode's exit button is.
 *
 * The mini card's lyrics overlay is deliberately not a fifth entry — it is a
 * state of the mini card, opened by tapping the cover.
 */
const MODES: Array<{ mode: ViewMode; icon: IconName; label: string }> = [
  { mode: 'normal', icon: 'music', label: 'Home' },
  { mode: 'full', icon: 'theatre', label: 'Full-screen Music Mode' },
  { mode: 'mini', icon: 'mini', label: 'Mini Mode' },
  { mode: 'pill', icon: 'pill', label: 'Pill Mode' },
];

/**
 * `modes` re-orders the four rather than filtering them. The pill grid reads
 * bottom-to-top and wants the two widget switches stacked above the two window
 * switches, which is the reverse of the order every other surface uses.
 *
 * `forVideo` is the library window while a film is on screen. Fullscreen means
 * something different there — the music takeover would put a record over the
 * picture — so the card narrows to the two choices that are still true, and the
 * one that keeps the name "full" is relabelled to say what it now fills.
 */
const ViewSwitcher: React.FC<{
  className?: string;
  modes?: ViewMode[];
  forVideo?: boolean;
  /**
   * Slide a liquid-glass sheet under the lit mode instead of filling its button.
   *
   * Opt-in because this control lives in three places with three different
   * budgets: the sidebar card can afford a shader surface, the strip cannot (it
   * is a 146px window whose glass already depends on a wallpaper it has to read
   * from the registry), and the takeover deliberately runs on compositor blur so
   * the turning record stays in time.
   */
  highlight?: boolean;
  /**
   * One more button at the end of the group, for the gesture that belongs to
   * this surface rather than to a mode: leaving a takeover.
   *
   * It goes *inside* the capsule rather than beside it because the exit is a view
   * control by anything but name — sitting on its own at the end of a 24-button
   * row it reads as one more transport key, and the one control people look for
   * first is the one they could not find.
   */
  tail?: React.ReactNode;
}> = ({ className = '', modes, forVideo = false, highlight = false, tail }) => {
  const store = usePlayerStore.getState;
  const nowPlayingFull = usePlayerStore((s) => s.nowPlayingFull);
  const overlayRole = usePlayerStore((s) => s.overlayRole);
  const switcherRef = React.useRef<HTMLDivElement | null>(null);

  /*
   * Inside a widget the answer is the window's role, always: the card cannot
   * become a library. In the library window, normal/fullscreen is its own state
   * and the widget that may be floating beside it is a second, independent
   * answer — so exactly one of the four buttons is lit at a time.
   */
  const active: ViewMode = OVERLAY_ROLE ?? overlayRole ?? (nowPlayingFull ? 'full' : 'normal');

  const shown = modes
    ? MODES.filter((m) => modes.includes(m.mode)).sort((a, b) => modes.indexOf(a.mode) - modes.indexOf(b.mode))
    : MODES;

  const visible = forVideo ? shown.filter((m) => m.mode === 'full' || m.mode === 'mini') : shown;
  const index = visible.findIndex((m) => m.mode === active);

  const buttons = (
    <div className={`view-switcher ${className}`} ref={switcherRef} role="group" aria-label="Switch view">
      {visible.map(({ mode, icon, label }) => {
        const text = forVideo && mode === 'full' ? 'Fullscreen Video Mode' : label;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => store().setView(mode)}
            className={`liquid-glass-btn icon small squish mode-btn ${active === mode ? 'active' : ''}`}
            data-tip={text}
            aria-label={text}
            aria-pressed={active === mode}
          >
            <Icon name={icon} size={13} />
          </button>
        );
      })}
      {tail}
    </div>
  );

  if (!highlight) return buttons;

  return (
    <div className="travel-frame view-switcher-frame">
      <TravelSheet itemsRef={switcherRef} activeIndex={index} radius={12} ms={520} />
      {buttons}
    </div>
  );
};

export default ViewSwitcher;
