import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import type { AppSection } from '../../stores/playerStore';

/**
 * How long the leaving page stays in the tree, and the number `--fly-out-ms` in
 * `globals.css` has to agree with.
 *
 * It used to be `FLY_MS`. With the cards' tint down to a hint of an edge, the two
 * pages are no longer opaque sheets stacked on each other — the old one showed
 * *through* the new one for the whole gesture, so leaving Statistics left its
 * meters and its ranked lists plainly visible underneath the Library for most of a
 * second, which is the transition being destroyed by the thing that was meant to
 * be the transition. It now finishes going out at 300ms, well inside the arriving
 * page's own fade-in, and leaves nothing behind to read through.
 */
const LEAVE_MS = 300;

/**
 * The move between the four pages.
 *
 * The page being left stays where it is and dims a little while the arriving one
 * comes down from above and settles on top of it — the gesture the user asked
 * for, in place of the earlier fly-out.
 *
 * Both layers have to exist for that, so the outgoing element tree is held here
 * for the length of the gesture rather than unmounted immediately. Holding a
 * rendered element is safe: it is an immutable description, and the page inside
 * it keeps its own scroll position because it is never torn down and rebuilt.
 *
 * The direction is the nav order, not the DOM order: Home → Library slides the
 * new page in from the right because that is the way the list in the sidebar
 * runs, and coming back slides it in from the left.
 *
 * The animation sits on these wrappers rather than on a page itself. The pages
 * are `data-glass` surfaces, and an opacity or transform tween on one of those
 * stalls at its from-state in Chromium. These boxes are plain, so they can move —
 * and they animate with transform and opacity only, never `filter`, because an
 * animated blur is not composited and would freeze for as long as React is
 * mounting the page underneath.
 */
const PageStage: React.FC<{ section: AppSection; children: React.ReactNode }> = ({
  section,
  children,
}) => {
  const dir = usePlayerStore((s) => s.sectionDir);

  /*
   * The leaving page is set from an effect, not from a comparison during render.
   *
   * This used to call `setState` in the render body when `section` changed, which
   * is a legitimate React pattern but the one thing that can trip "Maximum update
   * depth exceeded" if anything else in the tree is also re-rendering — and under
   * a fast run of navigations it intermittently did. An effect costs one extra
   * frame on the very first commit of a new page and cannot loop, because it
   * writes only when the section it is holding is genuinely stale.
   */
  const [held, setHeld] = useState<{
    section: AppSection;
    node: React.ReactNode;
    leaving: React.ReactNode;
    leaveKey: number;
  }>({ section, node: children, leaving: null, leaveKey: 0 });

  /** What the previous page rendered, captured before the new one replaces it. */
  const previous = useRef<{ section: AppSection; node: React.ReactNode }>({ section, node: children });

  useEffect(() => {
    const was = previous.current;
    previous.current = { section, node: children };
    if (was.section === section) return;
    setHeld((h) => ({ section, node: children, leaving: was.node, leaveKey: h.leaveKey + 1 }));
  }, [section, children]);

  useEffect(() => {
    if (!held.leaving) return undefined;
    const key = held.leaveKey;
    const t = window.setTimeout(
      () => setHeld((h) => (h.leaveKey === key ? { ...h, leaving: null } : h)),
      LEAVE_MS,
    );
    return () => window.clearTimeout(t);
  }, [held.leaveKey, held.leaving]);

  /*
   * Both layers take the same direction class; the arriving one is rendered last
   * so it lands on top of the page it is replacing rather than fading up through
   * it.
   *
   * The entering layer is the one in flow, so the column is always as tall as the
   * page the user is going to, not the one they are leaving.
   */
  const side = dir === 'fwd' ? 'east' : 'west';
  return (
    <div className="page-stack">
      <div key={section} className={`page-layer page-enter ${side}`}>
        {children}
      </div>
      {held.leaving ? (
        <div key={held.leaveKey} className={`page-layer page-leave ${side}`} aria-hidden>
          {held.leaving}
        </div>
      ) : null}
    </div>
  );
};

export default PageStage;
