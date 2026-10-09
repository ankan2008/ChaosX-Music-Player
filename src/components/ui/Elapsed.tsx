import React from 'react';
import { usePlaybackPosition } from '../../hooks/usePlaybackPosition';
import { formatTime } from '../../utils/formatTime';

/**
 * The elapsed-time read-out, standing alone.
 *
 * It is a component rather than an expression because it is the only thing on
 * these panels that changes while a song runs, and a parent that reads the
 * playhead itself takes the artwork, the disc and the whole control row into
 * React's way with every tick.
 */
const Elapsed: React.FC<{ className?: string }> = ({ className = 'pill-time' }) => (
  <span className={className}>{formatTime(usePlaybackPosition())}</span>
);

export default Elapsed;
