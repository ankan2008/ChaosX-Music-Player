import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import Icon from '../ui/Icon';

/**
 * `minimal` drops the two ±5s seeks, leaving what still fits a control narrow
 * enough to float over the desktop as the pill.
 *
 * `leading` is for a control that belongs to the row but not to the transport —
 * the statistics button, which every surface except the mini card carries. It is
 * a prop rather than four call sites because the mini card is the odd one out,
 * and repeating the group everywhere but there is how a button quietly reappears
 * on a 250px card that has no room for it.
 */
const TransportControls: React.FC<{
  compact?: boolean;
  minimal?: boolean;
  className?: string;
  leading?: React.ReactNode;
}> = ({ compact = false, minimal = false, className = '', leading }) => {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const hasTracks = usePlayerStore((s) => s.queue.length > 0);
  const store = usePlayerStore.getState;

  return (
    <div className={`transport ${compact ? 'compact' : ''} ${minimal ? 'minimal' : ''} ${className}`}>
      {leading}

      {/*
       * The same hairline that separates the transport from shuffle, on the other
       * side of it. What sits left of here is not about the record — statistics and
       * a process restart — and without the rule the row read as eleven transport
       * buttons rather than two groups that happen to share a pill.
       */}
      {leading ? <span className="transport-divider" /> : null}

      <button
        onClick={() => store().playPrevious()}
        disabled={!hasTracks}
        className="liquid-glass-btn icon small"
        data-tip="Previous"
        aria-label="Previous"
      >
        <Icon name="previous" size={compact ? 17 : 19} />
      </button>

      {!minimal && (
        <button
          onClick={() => getEngine().seekBy(-5)}
          disabled={!hasTracks}
          className="liquid-glass-btn icon small"
          data-tip="Back 5 seconds (←)"
          aria-label="Back 5 seconds"
        >
          <Icon name="back-5s" size={compact ? 17 : 19} />
        </button>
      )}

      <button
        onClick={() => void store().togglePlay()}
        disabled={!hasTracks}
        className={`liquid-glass-btn primary icon ${compact ? '' : 'large'}`}
        data-tip={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
        aria-label={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
      >
        <Icon name={isPlaying ? 'pause' : 'play'} size={compact ? 16 : 20} />
        {/* Names the action the button performs, and the bars confirm audio is
            actually running right now rather than trusting the icon alone. */}
        {isPlaying && (
          <span className="transport-playing" aria-hidden>
            <span />
            <span />
            <span />
          </span>
        )}
      </button>

      {!minimal && (
        <button
          onClick={() => getEngine().seekBy(5)}
          disabled={!hasTracks}
          className="liquid-glass-btn icon small"
          data-tip="Forward 5 seconds (→)"
          aria-label="Forward 5 seconds"
        >
          <Icon name="forward-5s" size={compact ? 17 : 19} />
        </button>
      )}

      <button
        onClick={() => store().playNext()}
        disabled={!hasTracks}
        className="liquid-glass-btn icon small"
        data-tip="Next"
        aria-label="Next"
      >
        <Icon name="next" size={compact ? 17 : 19} />
      </button>

      {!compact && (
        <>
          <span className="transport-divider" />
          <button
            onClick={() => store().toggleShuffle()}
            className={`liquid-glass-btn icon small mode-btn ${shuffle ? 'active' : ''}`}
            data-tip="Shuffle"
            aria-label="Shuffle"
          >
            <Icon name="shuffle" size={19} />
          </button>
          <button
            onClick={() => store().toggleRepeat()}
            className={`liquid-glass-btn icon small mode-btn ${repeatMode !== 'off' ? 'active' : ''}`}
            data-tip={`Repeat: ${repeatMode}`}
            aria-label={`Repeat: ${repeatMode}`}
          >
            <Icon name="repeat" size={19} />
            {repeatMode === 'one' && <span className="repeat-one-dot">1</span>}
          </button>
        </>
      )}
    </div>
  );
};

export default TransportControls;
