/**
 * Single source of truth for the audio DSP chain, shared by the renderer and the
 * main-process mpv host.
 *
 * These used to live in `src/audio/engine.ts` next to the Web Audio graph that
 * consumed them. mpv runs in its own process and cannot reach into that module,
 * and two copies of a band list or a filter string is how a UI slider ends up
 * driving a filter nobody labelled. So both sides import here instead.
 */

/** Centre frequencies of the 10-band graphic EQ, in Hz. */
export const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

/** Gain range the UI exposes per band, in dB. */
export const EQ_MAX_DB = 12;

/** Clip guard trims a hot track by at most this much. */
export const TRIM_MAX_DB = 24;

/**
 * Envelope lengths for every manual start, stop and skip, in seconds.
 *
 * A deck that stops at an arbitrary sample value clicks the speaker. This started
 * at 120/60ms, which was sized only to hide that click — technically smooth, far
 * too fast to hear as a fade. The pause is the longer of the two because it ends
 * in silence and so has nowhere to hide an abrupt edge.
 */
export const FADE_IN_S = 0.6;
export const FADE_OUT_S = 1.0;
/**
 * How long before the end of a track the outgoing audio starts easing down, and
 * how far it goes. A song that stops dead and then fades the next one in from
 * zero still reads as a cut, because the cut happens at the boundary; starting
 * the descent while the record is still playing is what makes a hand-off feel
 * like one gesture. The floor is above zero so the last line is never inaudible.
 */
export const DUCK_LEAD_S = 2.5;
export const DUCK_FLOOR = 0.3;

export const WAVEFORM_PEAK_COUNT = 800;

export interface AfChainInput {
  /** Ten band gains in dB, index-aligned with EQ_BANDS_HZ. */
  eqGains: number[];
  /** Semitones, −12..12. Zero leaves the pitch filter out entirely. */
  pitchSemitones: number;
  /** Clip guard on: the safety limiter sits at the end of the chain. */
  limiter: boolean;
}

/**
 * The whole DSP chain as one mpv filter string.
 *
 * mpv has no in-place parameter edit for these filters in this build — the only
 * runtime route is `set_property('af', <complete chain>)`, which replaces the
 * chain rather than adjusting one value in it. So every parameter the UI owns has
 * to be encoded into a single string, built fresh each time, and the caller
 * debounces so a drag costs one rewrite rather than sixty.
 *
 * Order matches the graph this replaces: EQ first, pitch second, limiter last.
 *
 * Filter choices are measured, not assumed:
 *  - `equalizer` with `t=q` is mpv's peaking filter, matching the biquads it
 *    replaces. `t=h` is a shelf and would change the response, not just the code.
 *  - `rubberband` is compiled into this build (verified via `--af=rubberband=help`)
 *    and its `pitch-scale` takes a linear ratio; it survives an `af` rewrite
 *    without a reload gap.
 *  - the limiter has to be `lavfi=[...]`, and the bracket form is the only
 *    spelling `set_property` accepts — `lavfi=alimiter=...` fails with
 *    "unsupported format for accessing property".
 */
export function buildMpvAfChain({ eqGains, pitchSemitones, limiter }: AfChainInput): string {
  const parts: string[] = [];

  for (let i = 0; i < EQ_BANDS_HZ.length; i++) {
    const g = clamp(eqGains[i] ?? 0, -EQ_MAX_DB, EQ_MAX_DB);
    if (g === 0) continue;
    parts.push(`equalizer=f=${EQ_BANDS_HZ[i]}:t=q:w=1:g=${round(g, 3)}`);
  }

  const semis = clamp(pitchSemitones, -12, 12);
  if (semis !== 0) {
    /*
     * `window=long` and `pitch=quality`, measured against the alternatives.
     *
     * This used to say `window=short`, on the theory that Rubber Band's standard window
     * was the largest buffer sitting on the hop between the filter and the device, and
     * that a smaller buffer therefore stopped the playhead freezing. The theory is wrong
     * in both halves. Offline, a +2 semitone shift and back is the closest thing to a
     * measurement of "sounds went missing": `short` loses 1.17 dB of band energy on the
     * round trip against 0.78 for these settings, and keeps 0.479 of each transient's
     * correlation against 0.500 — it is the worst of the options that are not obviously
     * cheap. Live, on the running deck at +2 with the playhead sampled every 50 ms,
     * `short` and `long:pitch=quality` both produced zero stalls in 12 seconds (239
     * samples, cache pinned at 8.02 s), and it was the *standard* window that dropped one
     * sample to 0.46 of real time. So the short window was buying nothing.
     *
     * `engine=faster` is the one to stay off: 3.69 dB lost on the round trip, and half
     * the transient correlation of `pitch=quality`.
     */
    parts.push(
      `@pitch:rubberband:pitch-scale=${round(Math.pow(2, semis / 12), 6)}:window=long:pitch=quality`,
    );
  }

  if (limiter) parts.push(LIMITER_FILTER);

  return parts.join(',');
}

/**
 * The safety limiter.
 *
 * `limit` is accepted, read back correctly through `get_property('af')`, and then
 * ignored: measured against a +12 dBFS sine, ceilings of 1.0, 0.5 and 0.125 all
 * produced peak 0.00 dB / rms -3.01 dB. `level_out` does work (0.125 measured
 * exactly -18.06 dB), but using it for the ceiling would attenuate everything
 * below the threshold too, which is the opposite of what a safety net is for.
 *
 * So the ceiling is 0 dBFS and the -1.5 dBFS target is carried by the per-track
 * trim instead. Measured effect on a +12 dBFS sine: no filter gives rms -0.49 dB
 * (hard clipped), this gives -3.02 dB (a clean unity sine) — the net works, it
 * just only catches true overshoot.
 */
export const LIMITER_FILTER = 'lavfi=[alimiter]';

/** Linear amplitude for the per-track clipping trim, from its dB value. */
export function trimGain(guardEnabled: boolean, gainDb: number): number {
  if (!guardEnabled) return 1;
  return Math.pow(10, clamp(gainDb, -TRIM_MAX_DB, 0) / 20);
}

/** Semitones from a rubberband pitch-scale ratio, for readback assertions. */
export function ratioToSemitones(ratio: number): number {
  return 12 * Math.log2(ratio);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, places: number): number {
  const p = Math.pow(10, places);
  return Math.round(v * p) / p;
}

/**
 * Gain ramp shapes. The scheduler drives mpv's `volume` property, which was
 * measured to be cheap and inert (0.8ms p50, zero mpv events) unlike an `af`
 * rewrite (102.5ms p50, twelve `audio-reconfig`s), so this runs on a 40ms timer.
 */
export const CURVES: Record<string, (t: number) => number> = {
  linear: (t) => t,
  /**
   * Complement per direction, because the scheduler's lerp already carries the
   * direction: `in` 0→1 through sin lands on sin, `out` 1→0 through 1-cos lands
   * on cos, and cos²+sin²=1 keeps perceived loudness flat across the hand-off.
   *
   * Two earlier attempts both looked right and measured wrong. Complementary
   * cos/sin *curves* invert the outgoing side (cos(0)=1 lands straight on the
   * target, so the fade ran backwards); one shared sin curve gives 1-sin and sin,
   * whose squares sum to 0.586 at the midpoint — the ~29% dip equal power exists
   * to prevent.
   */
  equalPowerIn: (t) => Math.sin((t * Math.PI) / 2),
  equalPowerOut: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeIn: (t) => t * t * t,
};

/** The curve the envelope uses in each direction: leave gently, arrive gently. */
export function envelopeCurve(from: number, to: number): 'easeOut' | 'easeIn' {
  return to > from ? 'easeIn' : 'easeOut';
}

/**
 * What the main-process deck reports, and what every window receives.
 *
 * Typed here rather than in `electron/mpv-engine.ts` because the renderer cannot
 * import a module that pulls in Electron, and a structurally-duplicated interface
 * is how a renamed field silently becomes `undefined` at one end of the wire.
 */
export interface MpvState {
  pos: number;
  duration: number;
  playing: boolean;
  paused: boolean;
  /** Absolute path, so a renderer can match it back to its own track record. */
  path: string | null;
  error: string | null;
  /**
   * The audible deck has a real video track. Decided in the main process from
   * mpv's own track list, which is the only place that can tell a video stream
   * from an embedded cover art — and cover art is the common case, because most
   * files in this library carry one.
   */
  hasVideo: boolean;
  /** Wall-clock stamp of the reading, so the renderer can interpolate from it. */
  at: number;
}

/**
 * A film, as every window except the one decoding it needs to see it.
 *
 * The library window owns the film's audio: it is the only window wired to the
 * mixer, and the one whose `<video>` or mpv deck actually produces sound. A widget
 * mirrors this reading onto its own transport, and — when `inPage` says the file is
 * one Chromium can decode — runs a second, muted decoder purely to put the picture
 * on screen. Two decoders of one file is the price of a card that shows moving
 * images instead of a still; the relay is what keeps them on the same second.
 */
export interface FilmState {
  path: string | null;
  pos: number;
  duration: number;
  playing: boolean;
  hasVideo: boolean;
  /**
   * The owner is decoding this in a `<video>` element rather than in mpv.
   *
   * It decides whether a widget can show the film at all. mpv's picture is a
   * native child of the *library* window's handle, so any container Chromium
   * refuses has no pixels a widget could ever copy, and the card falls back to
   * its poster. `.ts` used to be that case; it is no longer scanned at all.
   */
  inPage: boolean;
  /** Playback rate, so a mirror interpolates at the same speed it is asked for. */
  rate: number;
  vw: number;
  vh: number;
  /** Wall-clock stamp of the reading, so a renderer can interpolate from it. */
  at: number;
}

/**
 * One widget's request that the film move.
 *
 * Commands, not state: a widget never edits the other window's media element
 * directly, it asks, and the owner answers with the next `FilmState`. That is what
 * keeps the two honest when a command arrives while the owner is mid-seek.
 */
export type FilmCommand =
  | { type: 'load'; path: string; autoplay: boolean }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; to: number }
  | { type: 'mix'; volume: number; speed: number; pitch: number; guard: boolean };

/**
 * The mixer as the shared deck currently holds it.
 *
 * Broadcast for the same reason the play session is: the deck outlives any one
 * window, but speed, pitch and volume used to live only in whichever window the
 * user last touched. A widget opened afterwards pushed its own persisted copy
 * over the live values, and neither direction could see the other change.
 */
export interface MixState {
  volume: number;
  speed: number;
  pitch: number;
  eq: number[];
  /**
   * Whether the equaliser is engaged, as distinct from what its curve is.
   *
   * The gains always travelled; this flag did not, so it lived only in whichever
   * window's persisted store happened to be read last. That is the whole of
   * "fullscreen shows equalizer is on, but miniplayer says the opposite" — the deck
   * was applying one curve while two panels disagreed about whether to show it.
   */
  eqEnabled: boolean;
  guard: boolean;
}

export interface LoadOptions {
  autoplay?: boolean;
  startAt?: number;
  /** Queue this file on the standby deck as soon as the hand-off is done. */
  preloadNext?: string | null;
}

/** The renderer-facing command surface, unwrapped from the {ok,result} envelope. */
export interface MpvApi {
  load(file: string, opts?: LoadOptions): Promise<unknown>;
  preload(file: string): Promise<unknown>;
  play(): Promise<unknown>;
  pause(): Promise<unknown>;
  stop(): Promise<unknown>;
  /**
   * Empty both decks' playlists. Used when the page's own element takes a film.
   *
   * An engine left holding nothing retires its mpv processes shortly after, so this
   * is also how the ~52 MB a deck costs gets handed back; the next `load()` starts a
   * fresh one.
   */
  halt(): Promise<unknown>;
  seek(sec: number): Promise<unknown>;
  beginScrub(): Promise<unknown>;
  endScrub(sec: number): Promise<unknown>;
  volume(v: number): Promise<unknown>;
  speed(s: number): Promise<unknown>;
  pitch(semitones: number): Promise<unknown>;
  eq(gains: number[], enabled?: boolean): Promise<unknown>;
  trim(db: number): Promise<unknown>;
  guard(on: boolean): Promise<unknown>;
  snapshot(): Promise<MpvSnapshot>;
  forceAf(): Promise<string>;
  /** Raw mpv properties, bypassing every cached value in the engine. */
  rawProps(names: string[], deckIndex?: number): Promise<Record<string, unknown>>;
  /** Publish this window's play order for the others to mirror. */
  setSession?(session: PlaySession): void;
  /** The order the deck is currently following, as published by whoever changed it. */
  getSession?(): Promise<PlaySession | null>;
  onSession?(callback: (session: PlaySession) => void): () => void;
  /** The deck's mixer, mirrored into every window the moment anyone changes it. */
  onMix?(callback: (mix: MixState) => void): () => void;
}

/** What one deck's ramp scheduler reports about itself. */
export interface RampSnapshot {
  userVolume: number;
  factors: Record<string, number>;
  combined: number;
  live: string[];
  pushes: number;
  /** Values actually written to the deck, newest last, with timestamps. */
  history: Array<{ t: number; v: number }>;
  errors: string[];
}

/**
 * The play session, as every window must agree on it.
 *
 * Only the ids travel, never the tracks. Four windows share one deck in the main
 * process but each holds its own scanned library, so a queue is a list of ids
 * plus a position in it and every window resolves those against what it already
 * has. Sending whole tracks would put a few hundred cover images on every
 * hand-off to move information the receiver already owned.
 */
export interface PlaySession {
  ids: string[];
  index: number;
  shuffle: boolean;
  seed: number;
  /**
   * Repeat mode travels with the queue.
   *
   * It used to live only in whichever window last touched it, persisted to that
   * window's own copy of the store, so a widget opened afterwards could show "off"
   * while the deck was looping one track — the same class of disagreement as the
   * equaliser flag, and fixed the same way: main owns it and announces it.
   */
  repeat: 'off' | 'one' | 'all';
}

export interface MpvSnapshot {
  ready: boolean;
  broken: string | null;
  activeDeck: number;
  standbyFile: string | null;
  af: string | null;
  state: MpvState;
  volume: number;
  speed: number;
  pitch: number;
  eq: number[];
  eqEnabled: boolean;
  guard: boolean;
  trimDb: number;
  fadingOut: boolean;
  scrubbing: boolean;
  ramps: RampSnapshot[];
  decks: Array<{ connected: boolean; running: boolean }>;
  /** Recent mpv events per deck, newest last — how the end-of-track path is verified. */
  events: string[][];
  /**
   * The embedded video window: whether Win32 bindings loaded, what children the
   * app window has beyond Chromium's own, and where the last placement landed.
   */
  video?: Record<string, unknown>;
}

