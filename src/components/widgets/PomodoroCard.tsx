import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { cardGlass } from '../../utils/glass';
import { playChime } from '../../utils/chime';
import Hourglass from './Hourglass';
import Icon from '../ui/Icon';

/**
 * The pomodoro clock: work, break, repeat, in a card on the sidebar.
 *
 * Two rules shape it.
 *
 * The handoff is scheduled, not detected. The break does not start when a tick
 * notices the work has run out — it starts at `workEndsAt`, which is a number
 * computed the second the work block began. A 250 ms poll can be late by up to
 * that much, and on a throttled background tab by minutes; keying the next
 * phase off the previous phase's timestamp means the cycle keeps its own time
 * however badly the renderer is being starved.
 *
 * The countdown reads an absolute end time rather than decrementing a counter.
 * A decrementing timer drifts against the wall clock every time the machine
 * sleeps, and a five-minute break that turns into seven is not a five-minute
 * break.
 */

type Phase = 'idle' | 'work' | 'break' | 'done';

function formatLeft(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `hh:mm:ss`, always three pairs, so the field never changes width as it is typed. */
const clock = (sec: number) =>
  [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');

/**
 * `hh:mm:ss` as seconds, from whatever the field holds right now.
 *
 * Parts are clamped individually and missing parts read as zero, so a half-typed
 * "1:2" is one hour two minutes rather than a rejected keystroke — the field is
 * written as it goes, and a value that refuses to hold a partial edit cannot be
 * typed into.
 */
function parseClock(raw: string): number | null {
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  const [h = 0, m = 0, s = 0] = nums.length === 3 ? nums : [0, ...nums];
  if (h < 0 || h > 99 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * A dropdown whose contents are a form rather than a list.
 *
 * `GlassSelect` is an option picker; the durations and the round count are typed,
 * so they need the same shell with different contents. The trigger, the upward
 * menu and the dismiss rules are shared with it deliberately — two dropdowns
 * that open differently is the kind of inconsistency that makes an interface feel
 * assembled rather than designed.
 */
const Dropdown: React.FC<{
  label: string;
  tip: string;
  className?: string;
  /**
   * When set, the menu grows an OK row and nothing is written until it is
   * pressed.
   *
   * The duration fields used to commit on every keystroke, so typing a break of
   * `00:05:00` fired `0`, `00`, `00:0`, … and the running timer re-derived its
   * length from each of them — a half-typed value briefly reset the clock you
   * were watching. Drafting inside the menu and applying once is what makes the
   * field safe to type into.
   */
  apply?: () => boolean;
  children: React.ReactNode;
}> = ({ label, tip, className = '', apply, children }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`glass-select pomo-drop ${className}`} ref={rootRef}>
      <button
        type="button"
        className={`glass-select-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        data-tip={tip}
        aria-label={tip}
        aria-expanded={open}
      >
        <span className="truncate">{label}</span>
        <Icon name="collapse" size={11} rotate={open ? 180 : 0} className="glass-select-caret-icon" />
      </button>
      {open ? (
        <div
          className="glass-select-menu up pomo-drop-menu"
          data-glass
          data-config={cardGlass(16)}
          data-no-capture
        >
          {children}
          {apply ? (
            <button
              type="button"
              className="liquid-glass-btn small-text squish pomo-apply"
              onClick={() => {
                if (apply()) setOpen(false);
              }}
            >
              OK
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The two lengths in the space of a sidebar button.
 *
 * `00:25:00 · 00:05:00` is the honest form and it is 21 characters, which the
 * 118px column cannot hold; the leading zeros carry no information when the unit
 * is already written. The editor inside the dropdown still shows full clocks.
 */
function durationText(work: number, brk: number): string {
  const one = (s: number) =>
    s >= 3600
      ? `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`
      : s >= 60
        ? `${(s / 60).toFixed(s % 60 ? 1 : 0)}m`
        : `${s}s`;
  return `${one(work)} · ${one(brk)}`;
}

/**
 * The sand is no longer the app's to colour. The glass is a rendered liquid with
 * its own gold-to-rose palette and its own iridescence, and mixing the accent
 * into it washed the whole thing out.
 */

const PomodoroCard: React.FC = () => {
  const workSec = usePlayerStore((s) => s.pomodoroWorkSec);
  const breakSec = usePlayerStore((s) => s.pomodoroBreakSec);
  const rounds = usePlayerStore((s) => s.pomodoroRounds);
  const volume = usePlayerStore((s) => s.volume);

  const [phase, setPhase] = useState<Phase>('idle');
  const [endsAt, setEndsAt] = useState(0);
  const [pausedMs, setPausedMs] = useState<number | null>(null);
  const [round, setRound] = useState(1);
  const [now, setNow] = useState(() => Date.now());
  const [flip, setFlip] = useState(0);
  /* The typed fields keep their own text while it is being edited, so a
     half-written "00:0" is not rewritten under the cursor. */
  const [draft, setDraft] = useState<{ work: string; break: string } | null>(null);
  const [roundDraft, setRoundDraft] = useState<string | null>(null);

  const running = (phase === 'work' || phase === 'break') && pausedMs === null;
  const duration = (phase === 'break' ? breakSec : workSec) * 1000;
  const left = pausedMs ?? (phase === 'idle' || phase === 'done' ? duration : endsAt - now);
  const progress = duration > 0 ? 1 - Math.max(0, Math.min(1, left / duration)) : 1;

  /*
   * One 250 ms tick drives both the displayed number and the handoff. Nothing
   * here is a `setTimeout`: a scheduled callback that fires late changes what
   * the user sees, whereas a late tick only changes how often the same
   * calculation is repeated.
   */
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running || now < endsAt) return;
    playChime(5, 0.06 + volume * 0.16);
    /*
     * The exact second the last phase ended, clamped forward by a second's
     * grace so a machine that woke from sleep mid-break does not immediately
     * ring for a break that finished an hour ago.
     */
    const handoff = Math.max(endsAt, now - 1000);
    /*
     * The phase is over, so the half that has just filled turns back up to the
     * top. One half-turn, in the direction it is already going: the sand never
     * runs upward, the glass does.
     */
    setFlip((f) => f + 1);
    if (phase === 'work') {
      setPhase('break');
      setEndsAt(handoff + breakSec * 1000);
    } else if (round >= rounds) {
      setPhase('done');
    } else {
      setRound((r) => r + 1);
      setPhase('work');
      setEndsAt(handoff + workSec * 1000);
    }
  }, [breakSec, endsAt, now, phase, round, rounds, running, volume, workSec]);

  const start = useCallback(() => {
    setRound(1);
    setPhase('work');
    setPausedMs(null);
    setEndsAt(Date.now() + workSec * 1000);
    /*
     * No turn here. After a reset the full half is already at the top, and
     * starting is not the event that turns the glass — finishing is.
     */
  }, [workSec]);

  const togglePause = useCallback(() => {
    if (phase !== 'work' && phase !== 'break') {
      start();
      return;
    }
    if (pausedMs === null) setPausedMs(Math.max(0, endsAt - Date.now()));
    else {
      setEndsAt(Date.now() + pausedMs);
      setPausedMs(null);
    }
    setNow(Date.now());
  }, [endsAt, pausedMs, phase, start]);

  const reset = useCallback(() => {
    setPhase('idle');
    setPausedMs(null);
    setEndsAt(0);
    setRound(1);
    /*
     * Turn until the glass is upright again — one half-turn if it is lying
     * inverted, two if it is not. The sand is then always at the top when a
     * cycle starts over, and the turn never winds backwards through half-turns
     * it has already made.
     */
    setFlip((f) => f + (f % 2 === 0 ? 2 : 1));
  }, []);

  const commitClock = (field: 'work' | 'break', raw: string): number | null => {
    const seconds = parseClock(raw);
    return seconds === null || seconds === 0 ? null : seconds;
  };

  /** Typing only edits the draft; the running clock never sees a partial value. */
  const setDuration = (field: 'work' | 'break', raw: string) => {
    setDraft((d) => {
      const base = {
        work: d?.work ?? clock(workSec),
        break: d?.break ?? clock(breakSec),
      };
      base[field] = raw;
      return base;
    });
  };

  /**
   * Write both lengths, or neither.
   *
   * Returning false keeps the menu open, because a field that refuses to close on
   * an invalid value is telling the truth: the edit is not done.
   */
  const applyDurations = (): boolean => {
    const w = commitClock('work', draft?.work ?? clock(workSec));
    const b = commitClock('break', draft?.break ?? clock(breakSec));
    if (w === null || b === null) return false;
    const s = usePlayerStore.getState();
    if (w !== workSec) s.setPomodoroWorkSec(w);
    if (b !== breakSec) s.setPomodoroBreakSec(b);
    setDraft(null);
    /*
     * Re-cut the clock to the new lengths.
     *
     * `endsAt` was computed from the duration that was in force when the phase
     * started, so editing a running timer leaves a boundary that belongs to the
     * old numbers: the handoff then fires the moment the tick catches it, and a
     * second later the next one is already overdue, so the card walks itself
     * through Focus/Break/Focus at the 250 ms polling rate. Measured before this
     * existed — starting a 6-second block and reading "Break 0:02" 0.8s later.
     *
     * Restarting from the top of round one is the honest answer, and it is what
     * pressing OK says: these are the lengths, begin.
     */
    if (w !== workSec || b !== breakSec) {
      setRound(1);
      setPausedMs(null);
      setPhase('work');
      setEndsAt(Date.now() + w * 1000);
      setNow(Date.now());
    }
    return true;
  };

  const setRoundCount = (raw: string) => {
    setRoundDraft(raw);
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 24) {
      usePlayerStore.getState().setPomodoroRounds(n);
      setRoundDraft(null);
    }
  };

  const durationLabel = durationText(workSec, breakSec);

  return (
    <section
      className="liquid-glass-card small pomodoro-card"
      data-glass
      data-config={cardGlass(18)}
      data-no-capture
    >
      <header className="pomo-head">
        <span className="pomo-title">{phase === 'break' ? 'Break' : phase === 'work' ? 'Focus' : 'Pomodoro'}</span>
        <span className="pomo-round-label">
          {Math.min(round, rounds)}/{rounds}
        </span>
        <span className={`pomo-time ${running ? 'live' : ''}`}>{formatLeft(left)}</span>
      </header>

      <div className="pomo-body">
        <div className="pomo-glasses">
          <Hourglass
            progress={progress}
            active={running}
            paused={pausedMs !== null}
            flip={flip}
            label={phase === 'break' ? 'Break time' : 'Focus time'}
          />
        </div>

        <div className="pomo-side">
          <div className="pomo-controls">
            <button
              type="button"
              className="liquid-glass-btn icon small squish"
              onClick={togglePause}
              data-tip={pausedMs !== null ? 'Resume' : running ? 'Pause' : 'Start'}
              aria-label={pausedMs !== null ? 'Resume' : running ? 'Pause' : 'Start'}
            >
              <Icon name={running ? 'pause' : 'play'} size={13} />
            </button>
            <button
              type="button"
              className="liquid-glass-btn icon small squish"
              onClick={reset}
              data-tip="Reset the cycle"
              aria-label="Reset"
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>

          <Dropdown
            label={durationLabel}
            tip="Focus and break lengths"
            apply={applyDurations}
          >
            {(['work', 'break'] as const).map((field) => (
              <label key={field} className="pomo-edit-row">
                <span className="pomo-edit-name">{field === 'work' ? 'Focus' : 'Break'}</span>
                <input
                  className="pomo-hms"
                  type="text"
                  inputMode="numeric"
                  placeholder="hh:mm:ss"
                  value={draft?.[field] ?? clock(field === 'work' ? workSec : breakSec)}
                  aria-label={`${field === 'work' ? 'focus' : 'break'} length, hours minutes seconds`}
                  onChange={(e) => setDuration(field, e.target.value)}
                />
              </label>
            ))}
          </Dropdown>

          <Dropdown
            className="pomo-rounds-drop"
            label={`${rounds} rounds`}
            tip="Rounds before the cycle ends"
          >
            <label className="pomo-edit-row">
              <span className="pomo-edit-name">Rounds</span>
              <input
                className="pomo-hms pomo-round-input"
                type="text"
                inputMode="numeric"
                value={roundDraft ?? String(rounds)}
                aria-label="Number of rounds"
                onChange={(e) => setRoundCount(e.target.value)}
              />
            </label>
          </Dropdown>
        </div>
      </div>

      {phase === 'done' ? (
        <div className="pomo-popup" role="dialog" aria-label="Cycle finished">
          <p className="pomo-popup-text">{rounds} rounds done.</p>
          <div className="pomo-popup-actions">
            <button type="button" className="liquid-glass-btn small-text squish" onClick={start}>
              Restart
            </button>
            <button type="button" className="liquid-glass-btn small-text squish" onClick={reset}>
              Stop
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};

export default PomodoroCard;
