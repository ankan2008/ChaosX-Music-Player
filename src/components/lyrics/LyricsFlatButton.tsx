import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import Icon from '../ui/Icon';

/**
 * Read-all mode, as a bare icon.
 *
 * The library's lyrics card has room for the words "Stop highlighting" under an
 * underline when it is on. The mini card and the pill have one ring's width of
 * room and nothing more, so here the state is the icon's own colour and the name
 * arrives only as the hover pill — which is the same gesture every other control
 * in these two windows already uses.
 */
const LyricsFlatButton: React.FC<{ size?: number }> = ({ size = 12 }) => {
  const flat = usePlayerStore((s) => s.lyricsFlat);
  const setFlat = usePlayerStore((s) => s.setLyricsFlat);
  return (
    <button
      type="button"
      className={`lyrics-refresh-btn lyrics-flat-btn${flat ? ' is-on' : ''}`}
      onClick={(event) => {
        // The mini lyrics sheet closes on any click inside it, and this button
        // lives inside that sheet.
        event.stopPropagation();
        setFlat(!flat);
      }}
      aria-pressed={flat}
      data-tip={flat ? 'Line By Line' : 'All At Once'}
      aria-label={flat ? 'Line By Line' : 'All At Once'}
    >
      <Icon name="lyrics" size={size} />
    </button>
  );
};

export default LyricsFlatButton;
