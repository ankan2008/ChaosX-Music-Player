import React, { useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { EQ_BANDS_HZ } from '../../../shared/audio';
import Icon from '../ui/Icon';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import { panelDirection } from '../../utils/surface';
import { useStepWheel } from '../../hooks/useStepWheel';

const PRESETS: Record<string, number[]> = {
  Flat: EQ_BANDS_HZ.map(() => 0),
  'Bass Boost': [6, 5, 4, 2, 0, 0, 0, 0, 1, 2],
  Vocal: [-3, -2, 0, 2, 4, 4, 3, 1, -1, -2],
  Treble: [-4, -3, -2, -1, 0, 0, 1, 3, 5, 6],
  Electronic: [5, 4, 1, -2, -1, 2, 4, 5, 4, 3],
  Acoustic: [3, 2, 1, 2, 3, 3, 2, 2, 1, 1],
};

const sameGains = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The EQ trigger is a squircle icon, so the panel starts from that shape. */
const EQ_IDLE = { width: 32, height: 32, radius: 11 };
const EQ_OPEN = { width: 424, height: 296, radius: 20 };

const PITCH_IDLE = { width: 44, height: 32, radius: 16 };
/*
 * Widened from 276 when the steppers arrived. Two 24px buttons and their gaps
 * come straight out of the row the slider had to itself, so at the old width the
 * "longer track" the panel was meant to show would have been shorter than the
 * one it replaced. The pill already opens a 424px equalizer from the same
 * trigger column, and its window carries 400px of transparent gutter on each
 * side, so a 330px flyout is nowhere near the edge of what fits.
 */
const PITCH_OPEN = { width: 330, height: 132, radius: 24 };

/** The engine's clamp, mirrored here so the steppers can tell when they are done. */
const PITCH_LIMIT = 12;

/** Labels drawn under the pitch slider. Every fourth semitone keeps them legible. */
const PITCH_TICKS = [-12, -8, -4, 0, 4, 8, 12];

/**
 * One of the two steppers that flank the pitch slider.
 *
 * A press is a semitone and a hold keeps going, which is the lyrics timing
 * stepper's arrangement copied rather than a new one: the delay chain starts at
 * 340ms so a deliberate click is never mistaken for the start of a run, then
 * accelerates by 0.82 down to 24ms. Twenty-four clicks to walk from 0 to −12 is
 * the reason a hold has to exist at all — the alternative was a coarser step,
 * and a coarse step is useless for the ±1 st nudges the control is actually
 * asked for.
 *
 * The chain lives in a timer, not in `setInterval`, because each step re-renders
 * this component and an interval would be rebuilt from scratch on every one of
 * them, resetting the acceleration.
 */
const PitchStep: React.FC<{
  sign: -1 | 1;
  atLimit: boolean;
  onStep: () => void;
}> = ({ sign, atLimit, onStep }) => {
  const timer = useRef(0);
  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = 0;
  };
  React.useEffect(() => stop, []);

  /*
   * Reaching the limit disables the button, and a disabled button never sees the
   * pointerup that would otherwise end the run — so the climb has to be cut off
   * here instead of hoping the release arrives.
   */
  React.useEffect(() => {
    if (atLimit) stop();
  }, [atLimit]);

  const start = () => {
    if (atLimit) return;
    onStep();
    stop();
    let delay = 340;
    const arm = () => {
      timer.current = window.setTimeout(() => {
        onStep();
        delay = Math.max(24, delay * 0.82);
        arm();
      }, delay) as unknown as number;
    };
    arm();
  };

  const tip = sign < 0 ? 'Down a semitone — hold to keep going' : 'Up a semitone — hold to keep going';

  return (
    <button
      type="button"
      className="pitch-step"
      disabled={atLimit}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStep();
        }
      }}
      data-tip={tip}
      aria-label={tip}
    >
      {sign < 0 ? '−' : '+'}
    </button>
  );
};

/**
 * Pitch offset: one button that opens a slider rather than a minus, a readout
 * and a plus taking up three slots in the strip. The panel it opens does carry
 * its own minus and plus — see `PitchStep`.
 */
export const PitchControl: React.FC = () => {
  const pitch = usePlayerStore((s) => s.pitch);
  const pitchRef = useRef<HTMLButtonElement | null>(null);
  const store = usePlayerStore.getState;
  const label = `${pitch > 0 ? '+' : ''}${pitch} st`;

  /* The store clamps too, but the steppers need to know they got there. */
  const nudge = (delta: number) => {
    const live = store().pitch;
    store().setPitch(Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, live + delta)));
  };

  /* One semitone a notch, bounded by the same −12…+12 the slider offers. */
  useStepWheel(pitchRef, (direction) => nudge(direction));

  return (
    <>
      <button
        ref={pitchRef}
        className={`liquid-glass-btn small-text squish morph-trigger ${
          pitch !== 0 ? 'active' : ''
        }`}
        data-tip="Pitch offset"
        aria-label="Pitch offset"
      >
        {label}
      </button>
      <MorphingGlassPanel
        triggerRef={pitchRef}
        idle={PITCH_IDLE}
        open={PITCH_OPEN}
        direction={panelDirection}
        align="center"
      >
        <div className="pitch-panel">
          <div className="pitch-head">
            <span className="font-heading text-xs">Pitch</span>
            <span className={`pitch-value ${pitch !== 0 ? 'shifted' : ''}`}>{label}</span>
          </div>
          <div className="pitch-row">
            <PitchStep sign={-1} atLimit={pitch <= -PITCH_LIMIT} onStep={() => nudge(-1)} />
            <input
              type="range"
              min={-PITCH_LIMIT}
              max={PITCH_LIMIT}
              step={1}
              value={pitch}
              onChange={(e) => store().setPitch(parseInt(e.target.value, 10))}
              className="glass-slider pitch-range"
              style={{ '--progress': `${((pitch + PITCH_LIMIT) / (PITCH_LIMIT * 2)) * 100}%` } as React.CSSProperties}
              aria-label="Pitch offset in semitones"
            />
            <PitchStep sign={1} atLimit={pitch >= PITCH_LIMIT} onStep={() => nudge(1)} />
          </div>
          <div className="pitch-scale" aria-hidden>
            {PITCH_TICKS.map((tick, i) => (
              /*
               * Each label carries the fraction of the range it names, because
               * the row cannot derive it: `space-between` aligns edges, and these
               * are labels of three different widths whose centres therefore land
               * nowhere near the values they stand for.
               */
              <span
                key={tick}
                style={{ left: `${(i / (PITCH_TICKS.length - 1)) * 100}%` }}
              >
                {tick > 0 ? `+${tick}` : tick}
              </span>
            ))}
          </div>
        </div>
      </MorphingGlassPanel>
    </>
  );
};

/** Ten-band equalizer with presets, behind a squircle icon. */
export const EqControl: React.FC = () => {
  const eq = usePlayerStore((s) => s.eq);
  const customEq = usePlayerStore((s) => s.customEq);
  const eqRef = useRef<HTMLButtonElement | null>(null);
  const store = usePlayerStore.getState;

  /*
   * `setEq` applies to the deck as well as the store now, so these call sites do
   * not have to remember a second line that actually makes the sound change.
   */
  const applyGains = (gains: number[]) => {
    store().setEq({ gains });
  };

  /** Dragging a band *is* authoring the custom profile, so both get written. */
  const editBand = (i: number, value: number) => {
    const gains = [...eq.gains];
    gains[i] = value;
    store().setEq({ gains });
    store().setCustomEq(gains);
  };

  const presetActive = (gains: number[]) => sameGains(gains, eq.gains);
  const anyPresetActive = Object.values(PRESETS).some(presetActive);
  const customActive = !anyPresetActive && sameGains(customEq, eq.gains);

  return (
    <>
      <button
        ref={eqRef}
        className={`liquid-glass-btn icon small squish squircle-icon mode-btn ${
          eq.enabled ? 'active' : ''
        }`}
        data-tip="Equalizer"
        aria-label="Equalizer"
      >
        <Icon name="equalizer" size={15} />
      </button>

      <MorphingGlassPanel
        triggerRef={eqRef}
        idle={EQ_IDLE}
        open={EQ_OPEN}
        direction={panelDirection}
        align="center"
      >
        <div className="eq-panel" role="group" aria-label="Equalizer">
          <div className="eq-pop-head">
            <span className="font-heading text-xs">Equalizer</span>
            <button
              onClick={() => store().setEq({ enabled: !eq.enabled })}
              className={`liquid-glass-btn small-text squish mode-btn ${eq.enabled ? 'active' : ''}`}
            >
              {eq.enabled ? 'On' : 'Off'}
            </button>
          </div>

          <div className="eq-presets">
            {Object.entries(PRESETS).map(([name, gains]) => (
              <button
                key={name}
                onClick={() => applyGains(gains)}
                className={`liquid-glass-btn small-text squish mode-btn ${
                  presetActive(gains) ? 'active' : ''
                }`}
              >
                {name}
              </button>
            ))}
            <button
              onClick={() => applyGains(customEq)}
              className={`liquid-glass-btn small-text squish mode-btn ${
                customActive ? 'active' : ''
              }`}
              data-tip="Your saved curve"
            >
              Custom
            </button>
          </div>

          <div className={`eq-bands ${eq.enabled ? '' : 'dimmed'}`}>
            {EQ_BANDS_HZ.map((hz, i) => (
              <div key={hz} className="eq-band">
                <span className="eq-db">{eq.gains[i] ?? 0}</span>
                <span className="eq-slider-wrap">
                  <input
                    type="range"
                    min={-12}
                    max={12}
                    step={1}
                    value={eq.gains[i] ?? 0}
                    onChange={(e) => editBand(i, parseInt(e.target.value, 10))}
                    className="glass-slider eq-slider"
                    style={
                      {
                        '--progress': `${(((eq.gains[i] ?? 0) + 12) / 24) * 100}%`,
                      } as React.CSSProperties
                    }
                    aria-label={`${hz} hertz gain`}
                  />
                </span>
                <span className="eq-hz">{hz >= 1000 ? `${hz / 1000}k` : hz}</span>
              </div>
            ))}
          </div>
        </div>
      </MorphingGlassPanel>
    </>
  );
};

/**
 * Pitch and equalizer together. Both live in the pill, the takeover and the
 * mini card, and the mini card is only 250px square — so each is one button
 * that opens a panel rather than a row of three.
 *
 * The pill grid needs them in separate cells, so it imports the two halves
 * directly instead of this wrapper.
 */
const PitchEqControls: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`pitch-eq ${className}`}>
    <PitchControl />
    <EqControl />
  </div>
);

export default PitchEqControls;
