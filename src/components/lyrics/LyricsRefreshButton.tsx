import React from 'react';
import { useRemoteLyrics } from '../../hooks/useRemoteLyrics';
import Icon from '../ui/Icon';

/**
 * The LRCLIB re-search control, on its own.
 *
 * Wrapping the hook in a component is what lets a surface that has no lyrics
 * card of its own — the mini overlay, which draws two lines rather than the
 * scrolling panel — still carry the button. It also means the hook is mounted
 * exactly once per renderer: `useRemoteLyrics` is what asks LRCLIB in the first
 * place, so a mode without it was showing only whatever the library window had
 * already fetched.
 */
const LyricsRefreshButton: React.FC<{ size?: number }> = ({ size = 12 }) => {
  const { state, refresh } = useRemoteLyrics();
  return (
    <button
      type="button"
      className="lyrics-refresh-btn"
      onClick={(event) => {
        // The mini lyrics sheet closes on any click inside it, and this button
        // lives inside that sheet.
        event.stopPropagation();
        refresh();
      }}
      disabled={state === 'searching'}
      data-tip="Search LRCLIB again"
      aria-label="Search LRCLIB again"
    >
      <Icon name="refresh" size={size} />
    </button>
  );
};

export default LyricsRefreshButton;
