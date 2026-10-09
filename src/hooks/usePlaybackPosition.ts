import { useEffect, useState } from 'react';
import { getEngine } from '../audio/engine';

/**
 * The playhead, for the few surfaces that actually show it.
 *
 * Not `usePlayerStore((s) => s.playbackPosition)`. A store write notifies every
 * subscriber in the window, and reaching the three or four that care costs React
 * a reconciliation pass over the whole library tree — measured at ~700 ms before
 * the next frame paints, in slices too small to ever register as a long task.
 * The engine hands the same value to its listeners directly, so a tick updates a
 * time label and nothing else.
 */
export function usePlaybackPosition(): number {
  const [position, setPosition] = useState(() => getEngine().getPosition());
  useEffect(() => getEngine().onPosition(setPosition), []);
  return position;
}
