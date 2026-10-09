import React, { useState } from 'react';
import Icon from '../ui/Icon';

/**
 * Restart the app from the inside.
 *
 * Next to Statistics because it is the other thing on this row you press when
 * something is wrong — and unlike the rest of the pill it is not a view of the
 * playback, it is a repair on the process.
 *
 * One press, no confirmation. The whole point is a clean process, and a dialog in
 * the way of a clean process is a dialog in the way of a clean process; the cost of
 * getting it wrong is the few seconds the app takes to come back.
 *
 * The button is one icon and no animation, and the state it clears — the
 * AudioContext that will not give its memory back, the render targets that only
 * shrink when the context is lost, decks parked on a file nobody is playing — is
 * exactly what a two-core machine cannot afford to accumulate.
 */
const RestartControl: React.FC = () => {
  const [busy, setBusy] = useState(false);

  const go = () => {
    if (busy) return;
    setBusy(true);
    // The main process exits before any reply can come back, so the pressed state
    // is not a spinner waiting on a result — it is the button stopping itself from
    // being pressed twice into two relaunches.
    void window.electronAPI?.restartApp?.();
  };

  return (
    <button
      type="button"
      className={`liquid-glass-btn icon small squish${busy ? ' is-busy' : ''}`}
      data-tip={busy ? 'Restarting…' : 'Restart ChaosX'}
      aria-label="Restart ChaosX"
      aria-busy={busy}
      onClick={go}
    >
      <Icon name="restart-app" size={15} />
    </button>
  );
};

export default RestartControl;
