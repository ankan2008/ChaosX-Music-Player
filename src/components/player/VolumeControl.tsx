import React, { useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import Icon from '../ui/Icon';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import { useStepWheel } from '../../hooks/useStepWheel';
import { panelDirection } from '../../utils/surface';

/**
 * Volume as a single control: a squircle speaker button that morphs sideways
 * into a wide glass capsule holding the slider, with the mute toggle at its head.
 *
 * Horizontal, like the pitch and rate panels. It used to be a 58x252 capsule with
 * the range turned through -90°, which is the arrangement that makes a slider feel
 * wrong on a strip that runs down the edge of the screen: every other control on
 * it opens sideways, and a thumb you drag upwards out of a row of things you drag
 * left-to-right reads as a mistake the first time every single session.
 */
const IDLE = { width: 32, height: 32, radius: 11 };
/** Fully rounded on the short axis: the one open shape that is a capsule. */
const OPEN = { width: 252, height: 58, radius: 29 };

const VolumeControl: React.FC<{ className?: string }> = ({ className = '' }) => {
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.mutedVolume !== null);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const store = usePlayerStore.getState;

  const silent = muted || volume === 0;
  const pct = Math.round(volume * 100);

  /* Two percent a notch: slow enough to land on an exact number, fast enough
     that a long flick still crosses the range in one gesture. */
  useStepWheel(triggerRef, (direction) => {
    if (store().mutedVolume !== null) store().toggleMute();
    const live = store().volume;
    const next = Math.round((live + direction * 0.02) * 100) / 100;
    store().setVolume(Math.min(1, Math.max(0, next)));
  });

  return (
    <div className={`volume-wrap ${className}`}>
      <button
        ref={triggerRef}
        className={`liquid-glass-btn icon small squish squircle-icon tip-high ${
          silent ? 'active' : ''
        }`}
        data-tip={silent ? 'Unmute' : `Volume ${pct}%`}
        aria-label={silent ? 'Unmute' : 'Mute'}
      >
        <Icon name={silent ? 'mute' : 'volume'} size={15} />
      </button>

      <MorphingGlassPanel
        triggerRef={triggerRef}
        idle={IDLE}
        open={OPEN}
        direction={panelDirection}
        align="center"
        /* One tap opens the slider, two taps on the button mute and unmute it. */
        doubleClickAction={toggleMute}
      >
        <div className="volume-capsule">
          <span className="volume-pct">{pct}</span>
          <span className="volume-track">
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={pct}
              onChange={(e) => store().setVolume(parseInt(e.target.value, 10) / 100)}
              className="glass-slider volume-range"
              style={{ '--progress': `${pct}%` } as React.CSSProperties}
              aria-label="Volume percentage"
            />
          </span>
          <button
            type="button"
            className="volume-mute"
            onClick={() => store().toggleMute()}
            aria-label={silent ? 'Unmute' : 'Mute'}
          >
            <Icon name={silent ? 'mute' : 'volume'} size={13} />
          </button>
        </div>
      </MorphingGlassPanel>
    </div>
  );
};

export default VolumeControl;
