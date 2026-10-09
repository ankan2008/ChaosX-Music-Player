import React from 'react';
import { cardGlass } from '../../utils/glass';

/**
 * The heading every page opens with.
 *
 * It used to be bare text sitting on the page card, which made it read as a
 * caption of whatever was underneath rather than as the page's own title. The
 * plate gives it the same material as the surfaces below it, and gives Home —
 * which had no heading at all — somewhere to put one that cannot collide with
 * the continue-listening hero, because the plate is a flex row of its own.
 */
const PageHead: React.FC<{
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ title, sub, actions }) => (
  <header
    className={`page-head liquid-glass-card small${actions ? ' has-actions' : ''}`}
    data-glass
    data-config={cardGlass(18)}
    data-no-capture
  >
    <div className="page-head-copy">
      <h2 className="app-page-title">{title}</h2>
      {sub ? <p className="app-page-sub">{sub}</p> : null}
    </div>
    {actions ? <div className="app-page-actions">{actions}</div> : null}
  </header>
);

export default PageHead;
