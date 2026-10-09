import React, { useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import MorphOptionList from '../ui/MorphOptionList';
import { useStepWheel } from '../../hooks/useStepWheel';
import { panelDirection } from '../../utils/surface';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
/** Kept in step with `.speed-trigger` in globals.css: the morph starts from
    wherever the button actually is, so the two widths must agree. */
const SPEED_IDLE = { width: 50, height: 28, radius: 14 };
/*
 * Wide and short, so the eight rates read as one row of choices rather than a
 * column as tall as the widget that opened it — and so it agrees with the pitch
 * and volume panels, which were already horizontal.
 */
const SPEED_OPEN = { width: 348, height: 62, radius: 24 };

/** The playback-rate control, shared by the docked pill and the fullscreen one. */
const SpeedControl: React.FC = () => {
  const speed = usePlayerStore((s) => s.speed);
  const speedRef = useRef<HTMLButtonElement | null>(null);
  const store = usePlayerStore.getState;

  /* Hovering the button and turning the wheel walks the same discrete list the
     dropdown offers, so the wheel can never land on a rate the menu doesn't. */
  useStepWheel(speedRef, (direction) => {
    const { speed: live } = store();
    const at = SPEEDS.indexOf(live);
    const from = at === -1 ? SPEEDS.findIndex((v) => v >= live) : at;
    if (from === -1) return;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, from + direction))];
    if (next !== live) store().setSpeed(next);
  });

  return (
    <>
      <button
        ref={speedRef}
        type="button"
        className="glass-select-trigger morph-trigger speed-trigger"
        data-tip="Playback speed"
        aria-label="Playback speed"
      >
        {speed}x
      </button>
      <MorphingGlassPanel
        triggerRef={speedRef}
        idle={SPEED_IDLE}
        open={SPEED_OPEN}
        direction={panelDirection}
        align="center"
      >
        <MorphOptionList
          layout="row"
          options={SPEEDS.map((v) => ({ value: String(v), label: `${v}x` }))}
          value={String(speed)}
          onSelect={(v) => store().setSpeed(parseFloat(v))}
        />
      </MorphingGlassPanel>
    </>
  );
};

export default SpeedControl;
