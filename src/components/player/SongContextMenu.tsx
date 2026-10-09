import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEngine } from '../../audio/engine';
import Icon from '../ui/Icon';
import { dropdownGlass } from '../../utils/glass';
import type { MenuAction } from '../../utils/songActions';
import type { Track } from '../../types';

/**
 * The floating menu over a song row — and over a handful of them.
 *
 * It takes its rows from `utils/songActions` rather than deciding them here, because
 * the same six choices have to answer a right-click on one row and the multi-select
 * toolbar on six, and a menu that maintains its own list of actions is a menu that
 * quietly disagrees with its sibling.
 *
 * Only actions this build can perform are offered. The reference this was drawn
 * against also carries favourites, "never play again", artist and album pages and
 * playlist membership — none of which exist here, and a menu item that silently does
 * nothing is worse than one that is not there, because the user has to discover which
 * of the six lied to them.
 *
 * It is a plain fixed panel rather than a `MorphingGlassPanel`: a morph needs a
 * trigger element to grow out of, and a context menu grows out of a point on the
 * screen that changes per row.
 *
 * It is portalled to `.app-root` for the same reason the flyouts are. The row that
 * opens it sits inside `.app-main`, which is a `data-glass` card inside `.page-stage`,
 * which is animated with a `transform` — and either one of those makes an element of
 * `position: fixed` resolve against *it* rather than the viewport. Left in place the
 * menu landed hundreds of pixels from the cursor, which is what read as "right
 * clicking pulls the dropdown way far".
 */
interface Props {
  /** The rows this menu acts on. One for a right-click, several for the toolbar. */
  tracks: Track[];
  /** The list the tracks came from, so "play now" queues the right running order. */
  list: Track[];
  x: number;
  y: number;
  onClose: () => void;
  /** Overrides "play the list this row came from". */
  onPlayNow?: () => void;
  /**
   * Replace the whole menu with these.
   *
   * A row that is not part of any list the menu knows about cannot be offered
   * "play now" — that is a promise about a running order that does not exist. A
   * panel that knows what its rows really are passes its own list of actions.
   */
  actions?: MenuAction[];
  /** A dim line above the rows — the multi-select uses it for "4 selected". */
  header?: string;
}

const MENU_W = 232;

const SongContextMenu: React.FC<Props> = ({
  tracks,
  list,
  x,
  y,
  onClose,
  onPlayNow,
  actions,
  header,
}) => {
  const box = useRef<HTMLDivElement | null>(null);
  const [shifted, setShifted] = useState({ x, y });
  /**
   * The submenu currently standing in for its parent.
   *
   * Held as the array itself, not as an index, because the parent is rebuilt with
   * the store every time the menu opens and an index into something that has since
   * changed points at the wrong row.
   */
  const [sub, setSub] = useState<MenuAction[] | null>(null);

  /*
   * Flip rather than clip. The menu is opened by a pointer, so it can land with
   * its bottom or right edge past the window; measuring after the first paint and
   * pulling it back is the only way to know its real size. Portalled to the body,
   * the rect it reports is in the same space as `clientX`/`clientY`, so the clamp
   * is honest — which it was not while an ancestor transform moved the box.
   */
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setShifted({
      x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, sub]);

  /*
   * A new target is a new menu.
   *
   * The panel is one node in the caller's tree, so pointing it at different rows
   * re-renders it rather than remounting it — and a `sub` left over from the last
   * time it was open would stand in for the new target's own top level. That showed
   * up as the multi-select menu arriving already inside "Add to list" because a
   * single-track menu had been navigated there moments before.
   */
  useEffect(() => {
    setSub(null);
  }, [tracks]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      // Backstep out of a submenu before closing the menu itself.
      if (e.key === 'Escape') {
        if (sub) setSub(null);
        else onClose();
      }
    };
    // Captured, and on the next tick: the pointer-down that opened this must not
    // also be the outside-click that closes it.
    const t = window.setTimeout(() => {
      window.addEventListener('mousedown', away, true);
      window.addEventListener('blur', onClose);
    }, 0);
    window.addEventListener('keydown', key);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose, sub]);

  const defaultItems: MenuAction[] = [
    {
      label: 'Play now',
      icon: 'play',
      run: () => (onPlayNow ? onPlayNow() : void getEngine().playList(list, tracks[0])),
    },
    /*
     * "Play next" is the one queue-shaped action that survives, because it is a
     * statement about the *next* track rather than about a list you maintain: it
     * puts this song immediately after the current one and asks nothing of the
     * list afterwards.
     */
    { label: 'Play next', icon: 'next', run: () => tracks.forEach((t) => getEngine().insertNext(t)) },
    {
      label: 'Show in File Explorer',
      icon: 'download',
      run: () => void window.electronAPI?.openPath?.(tracks[0]?.path),
    },
  ];

  const items = sub ?? actions ?? defaultItems;

  /**
   * The root the menu is portalled into.
   *
   * `.app-root` rather than `document.body`: the glass engine walks that element
   * for `[data-glass]` surfaces, so a menu hung off the body would silently lose
   * its refraction, and in the overlay windows the root is where the widget's own
   * stacking rules live.
   */
  const host = useRef<HTMLElement | null>(
    (typeof document !== 'undefined' && document.querySelector('.app-root')) ||
      (typeof document !== 'undefined' ? document.body : null),
  );

  return createPortal(
    <div
      className="song-context-menu"
      ref={box}
      style={{ left: shifted.x, top: shifted.y }}
      role="menu"
      data-glass
      data-config={dropdownGlass(16)}
      data-no-capture
      onContextMenu={(e) => e.preventDefault()}
    >
      <i className="menu-tint" aria-hidden />
      {header ? <p className="song-context-head">{header}</p> : null}
      {items.map((item) => (
        <React.Fragment key={item.label}>
          {item.sep ? <span className="song-context-sep" aria-hidden /> : null}
          <button
            type="button"
            role="menuitem"
            aria-disabled={item.dimmed || undefined}
            className={`song-context-item ${item.danger ? 'danger' : ''} ${item.dimmed ? 'dimmed' : ''}`}
            onClick={() => {
              if (item.dimmed) return;
              if (item.sub) {
                setSub(item.sub);
                return;
              }
              item.run?.();
              onClose();
            }}
          >
            <Icon name={item.icon} size={13} />
            <span className="song-context-label">{item.label}</span>
            {item.sub ? <Icon name="collapse" size={11} rotate={-90} className="song-context-arrow" /> : null}
            {item.hint ? <span className="song-context-hint">{item.hint}</span> : null}
          </button>
        </React.Fragment>
      ))}
      {sub ? (
        <button
          type="button"
          className="song-context-item song-context-back"
          onClick={() => setSub(null)}
        >
          <Icon name="collapse" size={11} rotate={90} />
          <span className="song-context-label">Back</span>
        </button>
      ) : null}
    </div>,
    host.current ?? document.body,
  );
};

export default SongContextMenu;
