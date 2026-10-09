import React, { useRef } from 'react';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import Icon from '../ui/Icon';
import SystemMeters from '../widgets/SystemMeters';
import { panelDirection } from '../../utils/surface';
import { IS_PILL_WINDOW } from '../../utils/windowRole';

const IDLE = { width: 32, height: 32, radius: 11 };

/*
 * Measured off the panel's own content, not guessed.
 *
 * The library and the takeover get 620 × 300: three 168px cards, the strip's
 * gaps, the title line and both sets of padding, with real air left over at both
 * ends rather than a card welded to the rounded corner.
 *
 * The pill asks for 440 × 288 instead of the same box, because the room it has is
 * the 400px transparent gutter beside the strip and `MorphingGlassPanel` pays for
 * a wide request by scaling the whole surface down. At 566 the fit came out at
 * 0.68, which is a 0.64rem label rendered at 7px — the meters were legible on the
 * Statistics page and unreadable here, and the battery card hung past the panel's
 * own right edge. 440 fits the gutter at 0.87, and the pill's cards are cut to
 * match (see `.stats-pop.is-pill`), so the panel lands at nearly full size.
 */
const OPEN = IS_PILL_WINDOW
  ? { width: 440, height: 288, radius: 24 }
  : { width: 620, height: 300, radius: 26 };

/**
 * What the machine is doing, one click from wherever the transport is.
 *
 * The same three live meters the Statistics page draws — `SystemMeters` owns the
 * polling, the ring animation and the battery's bubble — mounted here rather than
 * redrawn, so the two surfaces cannot drift and a spike shows up in both at the
 * same instant. It lives on the pill because the question "why is playback
 * stuttering" is asked while playing, not while browsing a page.
 *
 * The body carries no glass of its own. `MorphingGlassPanel` already decides the
 * surface — shader refractive in the library, mica in the widget, acrylic frost
 * under the takeover — and a second `[data-glass]` inside it drew a liquid-glass
 * card on top of that, which is why this one dropdown looked machined while the
 * queue, volume and equalizer beside it all looked like glass.
 */
const StatsControl: React.FC = () => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="liquid-glass-btn icon small squish"
        data-tip="System statistics"
        aria-label="System statistics"
      >
        <Icon name="laptop" size={15} />
      </button>

      <MorphingGlassPanel
        triggerRef={triggerRef}
        idle={IDLE}
        open={OPEN}
        direction={panelDirection}
        align="center"
        project
      >
        <div className={`stats-pop ${IS_PILL_WINDOW ? 'is-pill' : ''}`}>
          <span className="stats-pop-title">This machine, right now</span>
          <SystemMeters />
        </div>
      </MorphingGlassPanel>
    </>
  );
};

export default StatsControl;
