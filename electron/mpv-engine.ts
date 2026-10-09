/**
 * The main-process mpv host.
 *
 * Two `mpv.exe` child processes, each spoken to over a Windows named pipe with
 * newline-delimited JSON. One is audible; the other always holds the track being
 * loaded next, so a hand-off never pays for a probe and a first decode while the
 * listener is waiting.
 *
 * Everything audio-correct lives here rather than in the renderer for three
 * reasons, and each one changed a design decision the brief assumed:
 *
 *  - The envelope ramp wants a 40ms timer. From the renderer that is an IPC round
 *    trip every tick; here it is a local call into a deck in the same process.
 *    Measured, `volume` costs 0.8ms p50 and provokes no mpv events at all, unlike
 *    an `af` rewrite at 102.5ms p50 and twelve `audio-reconfig`s.
 *  - Several windows (library, pill, mini) each used to own an AudioContext, and
 *    the whole hand-off dance exists to stop them playing over each other. With
 *    one engine in main there is nothing to hand off; every window is a view onto
 *    the same deck.
 *  - mpv decodes formats Chromium has no decoder for, which retires the ffmpeg →
 *    24-bit WAV conversion cache entirely. That cache is where 4.1GB of disk and
 *    one eviction bug came from.
 *
 * Position is the one thing that cannot come from here per frame — an IPC message
 * is not a vsync. Main reports the deck's real time at 8Hz and the renderer
 * interpolates between reports.
 */
import { ipcMain, BrowserWindow } from 'electron';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  buildMpvAfChain,
  trimGain,
  clamp,
  CURVES,
  FADE_IN_S,
  FADE_OUT_S,
  DUCK_LEAD_S,
  DUCK_FLOOR,
  EQ_BANDS_HZ,
  envelopeCurve,
  type MpvState,
  type LoadOptions,
  type MpvSnapshot,
  type RampSnapshot,
  type PlaySession,
} from '../shared/audio';
import { mpvWindow, type VideoSlot } from './mpv-window';
import { setThumbPlaying } from './taskbar-buttons';

/** Mirrors `electron/ffmpeg.ts`: dev reads the project tree, packaged reads Resources. */
function mpvBinary(): string {
  const dir = process.defaultApp
    ? path.join(process.cwd(), 'resources', 'mpv')
    : path.join(process.resourcesPath, 'mpv');
  return path.join(dir, process.platform === 'win32' ? 'mpv.exe' : 'mpv');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let seq = 0;
const nextId = () => ++seq;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * How long a deck that has already answered once gets to open a file.
 *
 * A warm load is a demux, and this machine does that in a few hundred milliseconds
 * even with the whole interface animating behind it. Eight seconds is already five
 * times the honest figure, and past it a silence really does mean a demuxer that
 * gave up without saying so.
 */
const LOAD_PATIENCE_WARM_MS = 8000;
/**
 * How long the first file through a brand-new deck gets.
 *
 * This is the number that generated the toast. A cold load is a process spawn, a
 * pipe connect, a config read and a first demux, and on two cores with the library
 * scan, the cover reader and the glass engine all queued behind it, the first
 * `file-loaded` has been measured arriving past the eight-second wall — with the
 * song playing happily afterwards. Every one of those was reported to the user as
 * their file being corrupt.
 */
const LOAD_PATIENCE_COLD_MS = 40000;

/**
 * A load that did not land, and whether the deck actually passed judgement.
 *
 * The distinction is the reason this class exists. "mpv said moov atom not found"
 * is a fact about the user's file and belongs in a toast. "we waited and nothing
 * came back" is a fact about this machine's queue, and putting the first message on
 * the back of the second is what made the same wrong notification appear since the
 * first day of the project.
 */
class LoadRefused extends Error {
  constructor(message: string, readonly mpvSaid: boolean) {
    super(message);
  }
}

/**
 * One mpv process plus the pipe it is spoken to.
 *
 * Replies cannot be read in order: the same stream carries unsolicited `event`
 * and `async_reply` lines, so every request is matched by `request_id`.
 */
class MpvDeck extends EventEmitter {
  proc: ChildProcessByStdio<null, null, Readable> | null = null;
  private sock: net.Socket | null = null;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  private disconnected = false;
  /**
   * Ring of every event mpv pushed, with its payload.
   *
   * Added because `eof-reached` turned out to be unreadable at the moment it
   * matters (see the engine's end-of-track handling): the only way to find out
   * what mpv actually signals at the end of a file is to look at what it sends.
   */
  readonly eventLog: string[] = [];

  constructor(private binPath: string, private pipe: string, private extraArgs: string[]) {
    super();
  }

  /**
   * mpv prepends `\\.\pipe\` to `--input-ipc-server` itself on Windows. Passing a
   * full pipe path as the argument creates a doubly-prefixed pipe that no client
   * can then open — worth knowing before the first hour of debugging is spent.
   */
  static pipeName(tag: string): string {
    return `sc-mpv-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get socketPath(): string {
    return '\\\\.\\pipe\\' + this.pipe;
  }

  get connected(): boolean {
    return !!this.sock && !this.disconnected;
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  get stderrLog(): string {
    return this.stderrTail;
  }

  async start(timeoutMs = 8000): Promise<this> {
    const proc = spawn(this.binPath, [
      '--no-terminal',
      '--idle=yes',
      ...this.extraArgs,
      '--input-ipc-server=' + this.pipe,
    ], { stdio: ['ignore', 'ignore', 'pipe'] }) as ChildProcessByStdio<null, null, Readable>;
    this.proc = proc;

    proc.on('error', (e) => this.emit('error', e));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-4000);
    });
    proc.on('exit', (code) => {
      this.disconnected = true;
      this.emit('exit', code);
    });

    /*
     * The pipe exists only once mpv has created it, so connect-with-retry *is*
     * the wait. A fixed sleep is either too short on a cold disk or wasteful.
     * `--really-quiet` is deliberately not passed: an invalid startup option
     * makes mpv exit 1 with no message under it, which reads as a hung engine.
     */
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.connect();
        return this;
      } catch {
        if (Date.now() > deadline) {
          const died = this.proc && this.proc.exitCode !== null
            ? `mpv exited with code ${this.proc.exitCode}`
            : 'mpv is running but never opened the pipe';
          throw new Error(
            `mpv IPC pipe never came up: ${this.socketPath}\n${died}\nstderr: ${this.stderrTail || '(none)'}`,
          );
        }
        await sleep(120);
      }
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      const fail = (err: Error) => { sock.destroy(); reject(err); };
      sock.once('connect', () => {
        sock.off('error', fail);
        this.sock = sock;
        this.disconnected = false;
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('close', () => { this.disconnected = true; this.emit('close'); });
        resolve();
      });
      sock.once('error', fail);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.error === 'idle') continue;
      if (msg.request_id !== undefined && this.pending.has(msg.request_id)) {
        const wait = this.pending.get(msg.request_id)!;
        this.pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') wait.reject(new Error(`${msg.error} (async: ${msg.async})`));
        else wait.resolve(msg.data);
        continue;
      }
      if (msg.event) {
        this.eventLog.push(msg.event + (msg.error ? ':' + msg.error : '') + (msg.reason ? '(' + msg.reason + ')' : ''));
        if (this.eventLog.length > 60) this.eventLog.shift();
        this.emit('event', msg);
      }
    }
  }

  private ask(payload: { command: unknown[] }, timeoutMs = 4000): Promise<unknown> {
    if (!this.sock || this.disconnected) return Promise.reject(new Error('mpv deck not connected'));
    const id = nextId();
    const p = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mpv IPC timed out after ${timeoutMs}ms: ${JSON.stringify(payload.command)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock!.write(JSON.stringify({ ...payload, request_id: id }) + '\n');
    });
    /*
     * mpv answers `property unavailable` for a property that vanished while the
     * request was in flight — a poll that moved on, a deck that finished loading,
     * a file that ended. If nobody awaits that reply any more the rejection is
     * unobserved, and Node's default for an unobserved rejection is to end the
     * process, which in Electron's main process takes the app with it. Marking
     * every request observed costs nothing and callers that do await still get
     * the error normally.
     */
    p.catch(() => {});
    return p;
  }

  command(name: string, ...args: unknown[]): Promise<unknown> {
    return this.ask({ command: [name, ...args] });
  }

  /** Fire and forget, swallowing the transient rejections a busy deck produces. */
  fire(name: string, ...args: unknown[]): void {
    this.ask({ command: [name, ...args] }, 1500).catch(() => {});
  }

  getProperty<T = unknown>(name: string): Promise<T> {
    return this.ask({ command: ['get_property', name] }) as Promise<T>;
  }

  setProperty(name: string, value: unknown): Promise<unknown> {
    return this.ask({ command: ['set_property', name, value] });
  }

  /**
   * Bumped on every load so a waiter can tell whether a newer one has taken the
   * deck over while it was still queueing.
   */
  private loadSeq = 0;
  /**
   * True once this deck has opened a file, which is what separates a slow first
   * load from a deck that has gone quiet on a file it can read.
   */
  private warm = false;

  /**
   * Whether mpv reports this exact file as the one it has open right now.
   *
   * Asked rather than assumed because the alternative is a user-facing "could not
   * open this file" over a song that is audibly playing — which is what happened
   * whenever two loads overlapped. A load that loses the deck to a newer one has
   * no event left to receive, so it is checked against the deck before it is
   * allowed to call anything a failure. The deck was fine; the bookkeeping was not.
   */
  /**
   * Does this deck hold `file`, and how long is it allowed to take to say so.
   *
   * The patience is the whole point of the second argument. This call is the
   * *appeal* after the watchdog has already fired, so a budget shorter than the
   * watchdog's is a formality — it re-asks the same question the same slow pipe
   * just failed to answer and then convicts the file. Measured on this machine,
   * mpv's first `file-loaded` after a cold spawn can land past eight seconds while
   * the library scan, the cover reader and the glass engine are all competing for
   * two cores, and in every one of those cases the song went on to play. The deck
   * was not refusing the file; it was getting to it.
   */
  async isOpen(file: string, patienceMs = 960): Promise<boolean> {
    const want = file.replace(/\\/g, '/').toLowerCase();
    const until = Date.now() + Math.max(0, patienceMs);
    for (;;) {
      const p = await this.getProperty<string>('path').catch(() => null);
      if (typeof p === 'string' && p.replace(/\\/g, '/').toLowerCase() === want) return true;
      if (Date.now() >= until) return false;
      await sleep(120);
    }
  }

  async loadfile(file: string, timeoutMs?: number): Promise<void> {
    const patience = timeoutMs ?? this.budget();
    /*
     * `loadfile` resolves as soon as the command is queued, not when the demuxer
     * has swapped files — so reading `duration` straight after it returns the
     * *previous* track's value. Measured: loading Shape of You (233.7s) over Dark
     * Horse reported 197.9s, which is exactly the outgoing track. The UI shows the
     * duration and drives the waveform from it, so a stale read is a visible bug,
     * not a rounding issue. `file-loaded` is mpv's own "this file is open" signal.
     *
     * It is still only a signal, so neither wait is allowed to fail the load on its
     * own. Both fall back to asking the deck what it has open, and only a deck that
     * genuinely does not hold the file reports an error. On a 4-thread laptop
     * pinned at 100% CPU a 4s IPC answer is not rare, and the file is usually
     * loaded anyway a moment later.
     */
    const seq = ++this.loadSeq;
    const raced = this.raceLoad(file, patience);
    await this.command('loadfile', file, 'replace').catch(async () => {
      if (this.loadSeq !== seq || await this.isOpen(file, patience)) return;
      throw new LoadRefused(`mpv could not queue the load for ${file}`, false);
    });
    const out = await raced;
    if (out.ok) {
      this.warm = true;
      await this.awaitLoaded(patience);
      return;
    }
    /*
     * The watchdog expired without mpv ever saying the file was bad, so the only
     * honest question left is whether the deck is holding it now. It gets the whole
     * budget again to answer — this is the appeal, and an appeal that runs out at
     * the same clock as the conviction is not an appeal.
     *
     * Every toast of this kind the app has ever produced was wrong in the same way:
     * the song in the picture kept playing. The deck was slow, the file was fine,
     * and the message blamed the user's library for the machine's queue.
     */
    if (this.loadSeq !== seq) return;
    if (await this.isOpen(file, patience)) {
      this.warm = true;
      return;
    }
    throw new LoadRefused(out.why, out.mpvSaid);
  }

  /**
   * How long this deck will be given to produce a file.
   *
   * A deck that has answered once is warm and a load through it is a demux, which
   * this machine does in well under a second. A deck that has never answered is a
   * process spawn, a pipe connect, a config read and a first demux, and on two
   * cores with the library scan running behind it that is the case that used to
   * blow the eight-second wall. The cold deck gets five times the room; the warm
   * one keeps the short leash, because a warm deck that goes quiet really is
   * looking at a file it cannot open.
   */
  private budget(): number {
    return this.warm ? LOAD_PATIENCE_WARM_MS : LOAD_PATIENCE_COLD_MS;
  }

  /**
   * Settle on whichever of mpv's two verdicts arrives first: the file opened, or
   * the file was refused and mpv said why.
   *
   * This used to wait for `file-loaded` alone, and a file mpv cannot open never
   * sends it. `257 - N - Soldier.mp3` is an MP4/AAC stream with a 161 KB ID3v2 tag
   * glued on the front and a `.mp3` name on the end; the demuxer reads the tag's
   * own header as an atom size of 1.2 GB, walks off the file, and reports
   * "moov atom not found" — an answer mpv delivers inside about 200 ms. Listening
   * only for the success event meant the load sat on its watchdog for the full
   * 8000 ms and then reported *that* as the reason, so the user was shown a timing
   * detail instead of the truth. Racing the two makes a dead file fail at the
   * speed mpv noticed, carrying mpv's own words.
   *
   * The `mpvSaid` flag is the other half of that honesty. An expiry is a fact about
   * this app's patience; an `end-file` with reason `error` is a fact about the
   * file. Only the second one is allowed to call somebody's library corrupt.
   */
  private raceLoad(
    file: string,
    timeoutMs: number,
  ): Promise<{ ok: true } | { ok: false; why: string; mpvSaid: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: true } | { ok: false; why: string; mpvSaid: boolean }) => {
        if (settled) return;
        settled = true;
        this.off('event', onEvent);
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ ok: false, why: `the deck did not answer within ${timeoutMs}ms`, mpvSaid: false }),
        timeoutMs,
      );
      const onEvent = (msg: {
        event?: string;
        reason?: string;
        error?: string;
        file_error?: string;
      }) => {
        if (msg.event === 'file-loaded') {
          finish({ ok: true });
        } else if (msg.event === 'end-file' && msg.reason === 'error') {
          // `file_error` is ffmpeg's own verdict; `error` is mpv's generic string.
          finish({
            ok: false,
            why: msg.file_error || msg.error || 'mpv refused this file',
            mpvSaid: true,
          });
        }
        // `end-file` with reason `stop` is the outgoing file of this very replace,
        // and `eof` is a finished track. Neither says anything about this load.
      };
      this.on('event', onEvent);
    });
  }

  /**
   * `time-pos` and `duration` do not exist until the demuxer has finished probing,
   * and a `volume` write or a seek issued before then is thrown away.
   */
  async awaitLoaded(timeoutMs = 6000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const d = await this.getProperty<number | null>('duration').catch(() => null);
      if (typeof d === 'number' && Number.isFinite(d) && d > 0) return;
      await sleep(60);
    }
  }

  async quit(): Promise<void> {
    try { await this.ask({ command: ['quit'] }, 1200); } catch { /* already gone */ }
    this.teardown();
    try { this.proc?.kill(); } catch { /* ignore */ }
  }

  kill(): void {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.teardown();
  }

  private teardown(): void {
    try { this.sock?.destroy(); } catch { /* ignore */ }
    this.sock = null;
    this.disconnected = true;
    for (const { reject } of this.pending.values()) reject(new Error('deck closed'));
    this.pending.clear();
  }
}

interface Ramp {
  from: number;
  to: number;
  startedAt: number;
  durationMs: number;
  fn: (t: number) => number;
  onDone?: (() => void) | undefined;
  /** Set while a ramp is parked; its start time is re-based on release. */
  heldSince?: number | null;
}

/**
 * Factorised volume ramps for one deck.
 *
 * Three independent things want a say in how loud a deck is: the user's volume
 * slider, the play/pause envelope, and the per-track clipping trim. Writing
 * `volume` directly from any of them stomps on the others — pausing halfway
 * through a trim change would flatten the fade curve, and finishing a fade would
 * overwrite the pause ramp's target with the pre-pause level.
 *
 * So each writer owns a named factor in 0..1 and the value pushed to mpv is
 * `userVolume × envelope × trim`. Starting a ramp replaces only that factor's own
 * in-flight ramp.
 */
class RampScheduler {
  userVolume = 60;
  private factors = new Map<string, number>();
  private ramps = new Map<string, Ramp>();
  private timer: NodeJS.Timeout | null = null;
  private lastPushed: number | null = null;
  pushes = 0;
  errors: string[] = [];
  /**
   * The last values actually written to the deck, with timestamps.
   *
   * A fade has to be verified from the side that performs it. Measuring one from a
   * renderer is unreliable — an unfocused Electron window throttles rAF and timers
   * to roughly 1Hz, so a 900ms sampling loop returned a single reading and the
   * trace looked like an instant stop. This ring is written by the same code that
   * drives mpv, so it is the real curve regardless of who is asking.
   */
  readonly history: Array<{ t: number; v: number }> = [];

  constructor(private write: (v: number) => Promise<unknown>, private intervalMs = 40) {}

  /** Jump a factor to a value and drop any ramp that was heading elsewhere. */
  setFactor(name: string, value: number): number {
    const v = clamp(value, 0, 1);
    this.factors.set(name, v);
    this.ramps.delete(name);
    this.push();
    return v;
  }

  /**
   * Change the user's volume and make sure the deck hears about it.
   *
   * Assigning `userVolume` and then calling `tick()` was the old route, and it
   * silently did nothing whenever no ramp happened to be running — `tick` returns
   * at its first line when `ramps` is empty, before any push. So a mute pressed on
   * a steady-playing track stored the 0, updated the UI to show it, and left mpv
   * at full level: the icon read muted and the sound kept going, "randomly",
   * depending on whether a fade or a trim change happened to be in flight.
   */
  setUserVolume(v: number): void {
    this.userVolume = v;
    this.push();
  }

  factor(name: string): number {
    return this.factors.get(name) ?? 1;
  }

  rampFactor(name: string, to: number, durationMs: number, curve: string): void {
    const target = clamp(to, 0, 1);
    const from = this.factors.get(name) ?? 1;
    this.factors.set(name, from);
    if (durationMs <= 0 || from === target) { this.setFactor(name, target); return; }
    this.ramps.set(name, {
      from,
      to: target,
      startedAt: Date.now(),
      durationMs: Math.max(1, durationMs),
      fn: CURVES[curve] ?? CURVES.linear,
    });
    this.ensureTimer();
    this.push();
  }

  combined(): number {
    let product = this.userVolume;
    for (const v of this.factors.values()) product *= v;
    return product;
  }

  /**
   * Push the current combined value to the deck if it moved.
   *
   * Called both by the timer and directly after any instantaneous change, so a
   * factor set from outside a ramp still lands without waiting up to 40ms.
   */
  private push(): void {
    const v = this.combined();
    if (this.lastPushed !== null && Math.abs(v - this.lastPushed) <= 0.001) return;
    this.lastPushed = v;
    this.pushes++;
    const t = Date.now();
    if (!this.history.length || t - this.history[this.history.length - 1].t >= 8) {
      this.history.push({ t, v: +v.toFixed(3) });
      if (this.history.length > 80) this.history.shift();
    }
    this.write(v).catch((e) => this.errors.push('write: ' + (e as Error).message));
  }

  tick(): void {
    if (this.ramps.size === 0) return;
    const now = Date.now();
    const finished: Array<Ramp & { name: string }> = [];
    for (const [name, r] of [...this.ramps]) {
      if (r.heldSince != null) continue;
      const t = clamp((now - r.startedAt) / r.durationMs, 0, 1);
      this.factors.set(name, r.from + (r.to - r.from) * r.fn(t));
      if (t >= 1) {
        this.factors.set(name, r.to);
        this.ramps.delete(name);
        finished.push({ ...r, name });
      }
    }

    this.push();

    /*
     * Completion callbacks run AFTER the final value has been pushed. "Pause once
     * the deck is silent" is the entire point of the envelope ramp, and firing
     * inside the loop above paused the deck while the last write was still queued
     * — measured as pausing at 9.1 of 60 with the remaining 9.1 arriving after.
     */
    for (const r of finished) {
      try { r.onDone?.(); } catch (e) { this.errors.push('onDone: ' + (e as Error).message); }
    }
  }

  /**
   * Run `cb` when `name`'s ramp finishes — or immediately if it already has.
   *
   * `rampFactor` short-circuits to `setFactor` when the factor is already at its
   * target, which deletes the ramp, so a callback registered afterwards found
   * nothing to attach to and was silently dropped. The engine uses this to clear
   * its `fadingOut` flag, so a pause issued while the deck was already silent left
   * that flag stuck true: the poll stopped recomputing `playing`, and the transport
   * kept reporting "playing" against a paused, frozen deck.
   */
  onRampDone(name: string, cb: () => void): void {
    const r = this.ramps.get(name);
    if (r) {
      r.onDone = cb;
      return;
    }
    cb();
  }

  /**
   * Park a ramp and resume it from exactly where it stopped.
   *
   * Ramps advance on wall-clock time, so a second gesture landing mid-fade lets
   * the first sail on to completion inaudibly and the listener is dropped into its
   * tail. Holding re-bases the start time on release.
   */
  hold(name: string): void {
    const r = this.ramps.get(name);
    if (r && r.heldSince == null) r.heldSince = Date.now();
  }

  release(name: string): void {
    const r = this.ramps.get(name);
    if (r && r.heldSince != null) {
      r.startedAt += Date.now() - r.heldSince;
      r.heldSince = null;
    }
  }

  isRamping(name: string): boolean {
    return this.ramps.has(name);
  }

  /** Resolve when `name`'s ramp reaches its target, for a caller that must be silent first. */
  async settled(name: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.ramps.has(name) && Date.now() < deadline) await sleep(20);
    this.tick();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  snapshot(): RampSnapshot {
    const factors: Record<string, number> = {};
    for (const [k, v] of this.factors) factors[k] = +v.toFixed(4);
    return {
      userVolume: this.userVolume,
      factors,
      combined: +this.combined().toFixed(3),
      live: [...this.ramps.keys()],
      pushes: this.pushes,
      history: this.history.slice(-40),
      errors: this.errors,
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/*
 * The wire types live in `shared/audio.ts` so the renderer can type-check against
 * the same declaration without importing Electron. Re-exported here because
 * `electron/` consumers reach the engine through this module.
 */
export type { MpvState, LoadOptions, MpvSnapshot } from '../shared/audio';

const POLL_MS = 125;

/**
 * How long the engine waits before putting its mpv processes down.
 *
 * A deck is 51–55 MB of working set that only exists to hold a file open, so once
 * the engine holds nothing it is paying rent on an empty house. `halt()` is the
 * renderer handing a film to its own decoder, and from that moment the decks have no
 * job at all — the short grace is there because a user who stops a track and presses
 * play again two seconds later should not pay a cold boot for it.
 *
 * The long one covers a track that is merely *paused*: the file stays open so a
 * resume is instant, and that is worth keeping for a few minutes but not for the rest
 * of the afternoon. What survives the teardown is `state.path` and `state.pos`, which
 * is everything `play()` needs to open the same file where it left off. A track that
 * ran to its own end is not on this list at all — see `releaseDecks`.
 */
const EMPTY_RELEASE_MS = 2500;
/*
 * Two minutes, not five.
 *
 * The argument for the long grace was that a paused track is a track the user is
 * about to resume, and resuming a deck that still has the file open is instant. That
 * is true and it is also the whole cost: two decks is a hundred and ten megabytes of
 * working set held for a resume that may not come, on a machine where the user has
 * set a ceiling by the megabyte and measures the app against Task Manager. Two
 * minutes covers "hold on a second" and every touchpad media-key pause that gets
 * answered from the keyboard, and gives the memory back for a pause that was actually
 * the user walking away. What survives either way is `state.path` and `state.pos`, so
 * the resume after the deadline is a reload of the same file at the same second — a
 * third of a second of silence, not a lost place.
 */
const PAUSED_RELEASE_MS = 2 * 60 * 1000;

/**
 * The engine. One instance in the main process, shared by every window.
 */
class MpvEngine {
  private decks: MpvDeck[] = [];
  private ramps: RampScheduler[] = [];
  /** The audible deck. */
  private active = 0;
  private ready = false;
  private broken: string | null = null;
  private booting: Promise<void> | null = null;
  /** One in-flight standby-deck spawn, so two preloads cannot make two processes. */
  private standbyBoot: Promise<void> | null = null;
  /** One in-flight teardown, so a `load()` cannot boot a deck on top of a dying one. */
  private retiring: Promise<void> | null = null;
  /** The wait before an engine that holds nothing puts its mpv processes down. */
  private idleRelease: NodeJS.Timeout | null = null;

  private eqGains: number[] = new Array(EQ_BANDS_HZ.length).fill(0);
  /**
   * Whether the equaliser is engaged, as opposed to what its curve is.
   *
   * It lives here rather than only in each renderer's store because the deck is the
   * thing that applies it, and three windows used to disagree about a flag none of
   * them shared.
   */
  private eqEnabled = true;
  private pitch = 0;
  /*
   * Off by default. This is the per-track true-peak trim — the app measuring a file
   * and attenuating it so it lands under a ceiling — which is loudness
   * normalisation by another name, and the user asked for it off. The mpv limiter
   * rides the same flag by design, so a track that would clip now clips rather
   * than being quietly turned down; the Settings toggle still turns both back on.
   */
  private limiterOn = false;
  private lastWatchdog = 0;
  /** Consecutive watchdog beats that found the deck playing into silence. */
  private silentBeats = 0;
  /** The path currently under its end-of-track duck, so it only starts once. */
  private duckedFor: string | null = null;
  /** Set by main so the transport media keys can follow the deck's play state. */
  onPlayingChange: ((playing: boolean) => void) | null = null;
  /**
   * Set by main so the *window* the picture is drawn into can follow the deck.
   *
   * A callback rather than a poll because the two facts it is made from — mpv has
   * decoded a frame, and a card is on screen — arrive in either order, and the one
   * that arrives second is the one that has to notice. Main moves mpv's window
   * between the library and the widget here, before the first placement.
   */
  onHasVideoChange: ((has: boolean) => void) | null = null;
  private lastPlayingForKeys = false;
  private trimDb = 0;
  private guardOn = false;
  private speed = 1;
  private userVolume = 0.6;

  /** Debounce for `af` writes: a chain rewrite costs ~102ms and reconfigures audio. */
  private afTimer: NodeJS.Timeout | null = null;
  private afDirty = false;
  private lastAf: string | null = null;

  /** What the standby deck currently holds, or null if it is empty. */
  private standbyFile: string | null = null;

  private state: MpvState = {
    pos: 0, duration: 0, playing: false, paused: true, path: null, error: null, hasVideo: false, at: Date.now(),
  };
  private pollTimer: NodeJS.Timeout | null = null;
  private lastBroadcast = 0;
  /** Which decks currently have their video output turned on. */
  /*
   * `null` means 'this deck has never been asked', which is different from
   * 'asked for no video'. The decks now start with mpv's default `vid=auto`, so
   * the first decision has to be written even when it is 'no' — otherwise an
   * mp3 with cover art keeps an image track selected and paints it.
   */
  private videoOn: Array<boolean | null> = [null, null];
  /** The cutout the page last asked for, in CSS pixels. */
  private slot: VideoSlot | null = null;

  /**
   * True between "the fade to silence started" and "the deck actually stopped".
   *
   * The poll reads the deck's own `pause` property, which is still false for the
   * whole 600ms of the fade. Without this flag every poll would flip the transport
   * back to playing — and the ramp's own completion guard ("did something start
   * again during the fade?") would then answer yes and never pause at all.
   *
   * A deadline rather than a boolean, because every release of this flag used to
   * live inside a ramp completion callback, and a callback is dropped the moment
   * anything else touches that factor. `preload()` calls `setFactor('env', 0)` on
   * the deck it is re-purposing — and during a hand-off that is the deck still
   * fading out — which deletes the ramp and its callback with it. The flag then
   * stayed true for the rest of the session, and it is the gate on three things at
   * once: the poll's play-state recompute, the lead-in duck, and the watchdog that
   * re-asserts audibility. So the transport kept showing "playing" over a silent,
   * frozen deck with the waveform rippling across it, and no fade was left to hear
   * because the deck had already been stopped. A deadline expires by itself,
   * whatever happens to the callback that was supposed to clear it.
   */
  private fadingOutUntil = 0;
  private get fadingOut(): boolean {
    return Date.now() < this.fadingOutUntil;
  }
  /** Hold the flag for at least this long. The 120ms covers the ramp's own tick. */
  private holdFadingOut(durMs: number): void {
    const until = Date.now() + durMs + 120;
    if (until > this.fadingOutUntil) this.fadingOutUntil = until;
  }
  private releaseFadingOut(): void {
    this.fadingOutUntil = 0;
  }
  /** Set while the user drags the playhead: the deck is held still on purpose. */
  private scrubbing = false;
  private scrubWasPlaying = false;
  /** What each deck was last told about file looping, so a hand-off is not rewritten per load. */
  private loopFile: string[] = [];

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  get unavailable(): boolean {
    return this.broken !== null;
  }

  get lastError(): string | null {
    return this.broken;
  }

  /**
   * Bring the decks up lazily rather than at `whenReady`.
   *
   * An mpv process costs 51–55 MB of working set and the user may open the app and
   * never press play; spawning at startup also races the window's own load. The first
   * transport call pays the ~400ms and every later one is free.
   *
   * What changed on 2026-10-05 is that this no longer buys *two* of them. Boot used
   * to create both decks in one loop, so a session that only ever played one film —
   * which is what was measured: two `mpv.exe`, both children of the live main process,
   * both created in the same second, one loaded track — paid 52 MB for a standby that
   * was never asked for. The renderer's `upcomingPathForPreload()` returns null for a
   * video next, a queue of one, and the end of a non-repeating queue, so in exactly
   * those cases deck B has no job at all. It is now built by `ensureStandbyDeck()`,
   * which only `preload()` can reach, so the warm advance keeps its seam and the
   * nothing-to-warm session gets one process instead of two. What that change did not
   * cover was the *call* the renderer makes when there is nothing to warm: it sends an
   * empty path, and an empty path reached `init()` and `ensureStandbyDeck()` like any
   * other, so the nothing-to-warm session still paid for both. See `preload()`.
   *
   * A failed boot is put down before it is reported. The decks were pushed into
   * `this.decks` as they were created, so a boot that threw on the second one left the
   * first alive, `ready` false and `broken` set — and the next transport call would
   * boot again *on top of it*, because nothing had retired the half of it that worked.
   * One orphan per retry was the result.
   */
  async init(): Promise<void> {
    this.cancelIdleRelease();
    if (this.retiring) await this.retiring.catch(() => {});
    if (this.ready) return;
    if (this.booting) return this.booting;
    this.booting = this.boot();
    try {
      await this.booting;
      this.ready = true;
    } catch (e) {
      this.broken = (e as Error).message;
      console.error('[mpv] engine failed to start:', this.broken);
      // Do not leave a partially-booted engine for the next attempt to stack on.
      void this.putDecksDown(false);
      throw e;
    } finally {
      this.booting = null;
    }
  }

  private async boot(): Promise<void> {
    const bin = mpvBinary();
    if (!fs.existsSync(bin)) {
      throw new Error(`mpv.exe is not at ${bin}. Copy it to resources/mpv/ or restore the 2026-09-25 backup.`);
    }
    await this.buildDecks(bin, [['a', 0]] as const);
    await this.writeAf();
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
  }

  /**
   * The standby deck, made the first time something genuinely wants one.
   *
   * Answered from `this.next` rather than `this.decks[1]`, because the two only agree
   * while deck A is audible: after a hand-off the standby is deck A, and a preload that
   * took `decks[1]` would then load the next track into the deck that is still playing.
   *
   * The spawn is folded into a promise rather than simply awaited, because `preload()`
   * is called with `void` from `load()` and twice in a row would otherwise start two
   * processes and push both, leaving a third `mpv.exe` that nothing can address by
   * index — which is the shape of the orphan this whole path is here to remove.
   */
  private async ensureStandbyDeck(): Promise<MpvDeck | null> {
    const standing = this.next;
    if (standing?.running) return standing;
    /*
     * A standby whose process has gone is not a standby, and answering with it anyway
     * would hand the next track to a dead pipe — the user would read that as "could not
     * open this file" about a song that is fine. Null is the honest answer: `preload()`
     * gives up on the warm-up and the next `load()` advances in place on the deck that
     * is still playing, which is the same thing that happens when there is no standby.
     */
    if (standing) return null;
    if (this.standbyBoot) {
      await this.standbyBoot.catch(() => {});
      return this.next ?? null;
    }
    this.standbyBoot = this.buildDecks(mpvBinary(), [['b', 1]] as const)
      .finally(() => { this.standbyBoot = null; });
    try {
      await this.standbyBoot;
    } catch (e) {
      // A standby that will not come up costs the seamless advance and nothing else:
      // the audible deck is already running, so the next track simply loads cold in
      // place instead of the whole transport being called broken.
      console.warn('[mpv] standby deck unavailable:', (e as Error).message);
      return null;
    }
    return this.next ?? null;
  }

  /**
   * Spawn the listed mpv processes and wire each to its deck index.
   *
   * Split out of `boot()` so the standby can arrive later without duplicating the
   * command line — that list of switches is the accumulated reasoning of several
   * bug reports, and a second copy of it would drift the first time one was edited.
   */
  private async buildDecks(
    bin: string,
    list: ReadonlyArray<readonly ['a' | 'b', number]>,
  ): Promise<void> {
    for (const [tag, index] of list) {
      /*
       * `live` and `next` address the decks by position, so a process that lands
       * anywhere other than its index cannot be reached by anything afterwards — not
       * loaded into, not muted, not killed. The one way that was is an idle release
       * emptying `this.decks` under a standby still being spawned, which would put the
       * new deck at 0 and leave the real orphan this file keeps being asked to remove.
       */
      if (this.decks.length !== index) {
        throw new Error(`deck ${tag} would land at ${this.decks.length}, not ${index}`);
      }
      const deck = new MpvDeck(bin, MpvDeck.pipeName(tag), [
        /*
         * Draw into the app window rather than one of mpv's own. With no video to
         * show this creates nothing at all — measured, an audio-only deck started
         * with `--wid` and `--force-window=no` adds no child window — so the only
         * cost is paying it when a video track actually turns the output on.
         *
         * There is deliberately no `--no-video` and no `--vid=no` here, and both
         * used to be. `--no-video` never gives mpv a video output to draw with, so
         * a later `vid=auto` reports `video-reconfig`, selects the track, decodes
         * it and paints *nothing* — which is the whole "I can hear it but there is
         * no picture" bug. `--vid=no` is worse still on a clip with no audio
         * track: measured against a screen recording with no sound, the load dies
         * as `start-file → end-file` with "No video or audio streams selected",
         * so `file-loaded` never arrives and the deck reports a timeout after
         * 8000ms. Which track is wanted is a per-file decision, and `applyVideo`
         * already makes it on every `file-loaded`.
         */
        ...(mpvWindow.wid ? ['--wid=' + mpvWindow.wid, '--force-window=no'] : []),
        // 0..100 maps to a linear 0..1 gain with no soft-clip region above it.
        '--volume-max=100',
        /*
         * Keep the audio output open when a deck replaces its own source, so the
         * next file starts on the stream that is already running instead of
         * tearing down and re-opening a WASAPI client. Without it every
         * same-deck advance pays the device latency twice over, which is the
         * silence between tracks.
         */
        '--gapless-audio=yes',
        /*
         * Video decoding. Left unset, mpv's default is `--hwdec=no`, which puts
         * every frame of a 1080p lecture through a software decoder on a machine
         * this app already shares with a WebGL glass renderer and a 4-thread CPU.
         * Audio files never touch that path, which is exactly why the user's
         * music plays fine and their videos do not.
         *
         * `auto-safe` rather than `auto`: it picks a hardware decoder only where
         * the copy back to system memory is known to be correct, so a driver that
         * mangles colour gets skipped instead of trusted. The software path stays
         * as the fallback when there is no GPU at all.
         *
         * `framedrop=vo` is the other half. A decoder that cannot keep up should
         * drop pictures, not stall the audio clock — waiting is what "stutter" is.
         *
         * Deliberately absent: `--vo` and `--gpu-api`. `gpu` is already the
         * default on Windows, so naming them buys nothing, and naming them makes
         * mpv build a d3d11 context for an audio-only `loadfile` too — measured as
         * three `file-loaded did not arrive within 8000ms` rejections on a laptop
         * that was already at 100% CPU.
         */
        '--hwdec=auto-safe',
        '--framedrop=vo',
        /*
         * How much audio is queued toward the output device.
         *
         * mpv's default is 0.2s, and on a 4-logical-CPU machine that is the whole
         * margin: a scheduling hitch of a fifth of a second — a library rescan, a
         * window being dragged, another application waking up — and the WASAPI
         * client runs dry and the speaker crackles. The buffer is the only defence
         * against that, because nothing upstream can promise the thread will be
         * scheduled. It costs latency the listener never notices and memory the
         * size of a few frames; it does not delay the start of playback, which is
         * bounded by the decoder, not by the buffer.
         *
         * Measured: under four spinning CPU cores *and* a renderer burning six
         * milliseconds of every frame, the demuxer cache never left 8s ahead and
         * mpv reported no underrun, so whatever still crackles is not the decode
         * or the disk — it is the hop into the device, which is exactly the span
         * this number buys. 0.6s absorbed most of it; 1.5s is the same margin with
         * room for a full GC pause plus a compositor reallocation on top.
         */
        '--audio-buffer=1.5',
        /*
         * An ordered fallback list rather than a single output.
         *
         * Left unset, mpv picks WASAPI and stays there. On a laptop that is the
         * one path that goes quietly deaf: switch to Bluetooth, let another app
         * grab the device exclusively, or sleep the machine, and the WASAPI
         * client dies while the decoder carries on — so the deck keeps reporting
         * `time-pos`, the waveform sweeps, the lyric line advances, the transport
         * says playing, and nothing comes out of the speakers. That is the
         * "suddenly the audio itself stops working" report, and it is the worst
         * failure mode a player can have because every other part of the UI is
         * telling the truth about a deck that is making no sound.
         *
         * Naming DirectSound second gives mpv a different transport to fall back
         * to at re-open rather than a dead one.
         */
        '--ao=wasapi,directsound',
        /*
         * Read ahead further into the file so the decoder is never waiting on the
         * disk. Paired with the larger output buffer this is what has to absorb the
         * load spike, and the standby deck already pays this cost for the *next*
         * track, so the two together are why the advance does not have to borrow
         * time from either.
         */
        '--demuxer-readahead-secs=8',
        '--demuxer-max-bytes=48MiB',
      ]);
      /*
       * A deck whose pipe never came up is a running process with no handle on it.
       * `start()` throws after spawning, and this method has not pushed anything yet,
       * so nothing else in this class could ever find it again — the boot failure then
       * left an mpv.exe behind, and every retry left another. It is put down here before
       * the error is passed on.
       */
      try {
        await deck.start();
      } catch (e) {
        deck.kill();
        throw e;
      }
      deck.on('exit', (code: number | null) => {
        console.warn(`[mpv] deck ${tag} exited with ${code}`);
        this.send('mpv:deck-exit', { tag, code });
      });
      deck.on('event', (msg: { event?: string; reason?: string }) => this.onDeckEvent(index, msg));
      /*
       * Checked again now that the pipe is up, because that wait is where the race
       * lives: an idle release can empty `this.decks` while this process is booting,
       * and a deck pushed after that belongs to no engine — it could never be loaded
       * into, muted or killed, which is precisely the orphan this whole path exists to
       * prevent. It puts itself down instead.
       */
      if (this.decks.length !== index) {
        console.warn(`[mpv] deck ${tag} booted into an engine that had moved on; killing it`);
        deck.kill();
        continue;
      }
      this.decks.push(deck);
      const ramp = new RampScheduler((v) => deck.setProperty('volume', v));
      ramp.userVolume = this.userVolume * 100;
      this.ramps.push(ramp);
      /*
       * The standby deck must never be audible, so it is muted rather than trusted.
       * Set here rather than once for both decks after the loop, which is what made
       * the second process look like it had to be created with the first.
       */
      if (index !== 0) await deck.setProperty('mute', true).catch(() => {});
      // A deck that joins after the chain was written has never been told what it is.
      if (this.lastAf) await deck.setProperty('af', this.lastAf).catch(() => {});
    }
  }

  /**
   * The audible deck plus the standby deck, in that order.
   *
   * The indices ping-pong on every hand-off, which is what keeps the fading-out
   * deck untouched while the next one loads into the other.
   *
   * Either getter can be `undefined`: a session that never needed a warm advance has
   * one deck, and an engine that has been put down for idleness has none. Every reader
   * already treats that as "nothing to do", because `halt()` used to be able to leave
   * the engine holding no file at all and `play()` had to answer that.
   */
  private get live(): MpvDeck | undefined { return this.decks[this.active]; }
  private get next(): MpvDeck | undefined { return this.decks[1 - this.active]; }
  private get liveRamp(): RampScheduler | undefined { return this.ramps[this.active]; }
  private get nextRamp(): RampScheduler | undefined { return this.ramps[1 - this.active]; }

  // ------------------------------------------------------------------
  // Filter chain
  // ------------------------------------------------------------------

  /**
   * Rebuild the whole `af` chain, debounced.
   *
   * In this mpv build there is no in-place parameter edit — `af-command` is
   * rejected by librubberband (a real command name and a made-up one produce the
   * identical error, so it never reaches the filter). The only runtime route is
   * rewriting the complete chain, which costs ~102ms p50 and provokes a full
   * `audio-reconfig`. Writing per pointer-move during an EQ drag would stutter the
   * audio it is meant to shape, so a drag costs one rewrite on settle.
   */
  private scheduleAf(): void {
    this.afDirty = true;
    if (this.afTimer) clearTimeout(this.afTimer);
    this.afTimer = setTimeout(() => {
      this.afTimer = null;
      if (this.afDirty) void this.writeAf();
    }, 180);
  }

  /** Force the chain write now, for callers that need it applied before measuring. */
  async forceAf(): Promise<string> {
    if (this.afTimer) clearTimeout(this.afTimer);
    this.afTimer = null;
    await this.writeAf();
    return this.lastAf ?? '';
  }

  private async writeAf(): Promise<void> {
    this.afDirty = false;
    if (!this.decks.length) return;
    const chain = buildMpvAfChain({
      eqGains: this.eqGains,
      pitchSemitones: this.pitch,
      limiter: this.limiterOn,
    });
    if (chain === this.lastAf) return;
    this.lastAf = chain;
    for (const d of this.decks) {
      try { await d.setProperty('af', chain); } catch { /* a deck that is not up yet */ }
    }
  }

  currentAf(): string | null { return this.lastAf; }

  /**
   * Write a complete `af` chain exactly as it is given, and read it back.
   *
   * Dev bridge only. Every parameter the UI owns is encoded into one string by
   * `buildMpvAfChain`, so the only way to find out whether `window=short` is really
   * what is chewing the sound is to put a chain on the deck that the builder cannot
   * produce, and to hear the answer from the filter rather than from the code.
   *
   * `lastAf` goes with it, because it is the key that decides whether a rebuild is
   * worth sending: leave it stale and the next UI change would be judged unchanged.
   */
  async setRawAf(chain: string): Promise<{ written: string; readBack: string | null; decks: number }> {
    this.lastAf = chain;
    let readBack: string | null = null;
    for (const d of this.decks) {
      try {
        await d.setProperty('af', chain);
        readBack = JSON.stringify(await d.getProperty<unknown>('af'));
      } catch { /* a deck that is not up yet */ }
    }
    return { written: chain, readBack, decks: this.decks.length };
  }

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------

  /**
   * Hand off to `file`.
   *
   * The load always goes to the *standby* deck while the current one fades out.
   * That is what makes the sequential ramp §1 asks for possible at all: loading
   * into the audible deck would replace its source and cut it dead mid-fade, which
   * is the hard click the ramp exists to remove. Probing and decoding also happen
   * under the fade instead of after it.
   */
  /**
   * End of track comes from mpv's `end-file` event, not the `eof-reached`
   * property.
   *
   * Measured across a real file boundary: `eof-reached` reads false in the last
   * poll before the end and is `property unavailable` from then on, because mpv
   * unloads the file the moment it finishes — so the property is never observable
   * as true by anything polling it. The first build polled it and auto-next hung
   * with the transport showing "playing" at a frozen position forever.
   *
   * `reason` has to be checked, not just the event name: replacing a file also
   * raises `end-file`, with reason `stop`, and treating that as "the song ended"
   * would advance the queue on every manual skip.
   */
  private onDeckEvent(index: number, msg: { event?: string; reason?: string }): void {
    if (msg.event === 'file-loaded') {
      void this.applyVideo(index);
      return;
    }
    if (msg.event !== 'end-file') return;
    if (index !== this.active || msg.reason !== 'eof') return;
    if (!this.state.path) return;
    this.state.playing = false;
    this.state.paused = true;
    this.send('mpv:ended', { path: this.state.path, reason: msg.reason ?? 'eof' });
    this.broadcast(true);
  }

  /**
   * Decide, from the deck itself, whether what it just opened has a picture.
   *
   * `vid=auto` alone would not be enough: mpv counts an embedded cover image as a
   * video track, so every tagged FLAC in the library would open a window showing
   * the album art. `image` and `albumart` are what separate the two, and both
   * come from the same read that answers "is there any video track at all".
   *
   * The deck that is fading out is left alone on purpose — turning its video off
   * mid-fade would blank the picture the user can still hear. It is stopped when
   * the hand-off retires it.
   */
  private async applyVideo(index: number): Promise<void> {
    const deck = this.decks[index];
    if (!deck || !mpvWindow.available) return;
    if (index !== this.active) {
      /*
       * The standby deck pre-buffers audio only. Leaving its picture on would put
       * a second mpv window in the same parent as the audible one, and there is
       * no way to tell them apart from the outside — so the standby is forced off
       * and asked again the moment it becomes the live deck.
       */
      if (this.videoOn[index] !== false) {
        this.videoOn[index] = false;
        await deck.setProperty('vid', 'no').catch(() => {});
      }
      return;
    }
    let hasVideo = false;
    try {
      const list = await deck.getProperty<Array<Record<string, unknown>>>('track-list');
      hasVideo = !!list && list.some((t) => t.type === 'video' && t.image !== true && t.albumart !== true);
    } catch {
      return;
    }
    const was = this.videoOn[index];
    this.videoOn[index] = hasVideo;
    if (was !== hasVideo) await deck.setProperty('vid', hasVideo ? 'auto' : 'no').catch(() => {});
    /*
     * Which window owns the picture is main's call, and it has to be made before
     * this placement rather than after it. mpv creates its window under the `--wid`
     * it was spawned with — the library's, always — so the instant a card takes the
     * film over there is a real native window sitting in a surface nobody is looking
     * at, and placing it first would put the film's first frame at whatever
     * rectangle the library's page last asked for. `onHasVideoChange` moves the
     * window and writes the slot that belongs to its new host; this line then
     * applies it.
     */
    const changed = this.state.hasVideo !== hasVideo;
    this.state.hasVideo = hasVideo;
    if (changed) this.onHasVideoChange?.(hasVideo);
    mpvWindow.place(hasVideo ? this.slot : null);
    if (changed) this.broadcast(true);
  }

  /** Re-decide video for both decks; call whenever the live deck changes. */
  private syncVideo(): void {
    void this.applyVideo(this.active);
    void this.applyVideo(1 - this.active);
  }

  /**
   * The page's video rectangle, in CSS pixels relative to the client area, or
   * null when nothing is reserved. mpv's window is positioned by the main
   * process because only it can talk to Win32; the renderer only says where the
   * hole should be.
   */
  setVideoSlot(slot: VideoSlot | null): void {
    this.slot = slot;
    /*
     * Hiding is unconditional; showing is not. A child window mpv left behind
     * from an earlier file is still on screen and still where the last slot put
     * it, and gating the null on `videoOn` meant a stale black rectangle stayed
     * parked over the interface.
     */
    if (slot === null || this.videoOn[this.active]) mpvWindow.place(slot);
  }

  /**
   * Whether mpv's native window is the film's picture right now.
   *
   * Asked by main, which owns the question "which window should that picture be
   * in" and cannot answer it from the deck's broadcast — the broadcast is
   * change-gated and throttled, and a card opened a frame too late would have to
   * wait for the next one to change.
   */
  hasFilmPicture(): boolean {
    return this.state.hasVideo;
  }

  async load(file: string, opts: LoadOptions = {}): Promise<void> {
    await this.init();
    const autoplay = opts.autoplay !== false;
    const outDeck = this.live;
    const outRamp = this.liveRamp;
    const inDeck = this.standbyFile === file ? this.next : outDeck;
    const inRamp = this.standbyFile === file ? this.nextRamp : outRamp;
    if (!inDeck || !inRamp) return;

    const reuse = this.standbyFile === file && inDeck !== outDeck;

    /*
     * Fade the audible deck down while the other one comes up — at the same time.
     *
     * These two ramps used to run back to back: the outgoing deck faded for
     * 600ms, `settled('env')` blocked the incoming deck until that had finished,
     * and then the new deck spent another 400ms climbing from silence. Exactly one
     * second of nothing on every playlist change, which is the seam this whole
     * path exists to close. Overlapping them turns the same two envelopes into a
     * crossfade: the old song is still audible, quietly, while the new one is
     * already starting.
     *
     * Only when there are genuinely two decks. A cold load reuses the live deck,
     * and a deck cannot crossfade with itself — that case keeps the fade-in alone.
     */
    const overlap = reuse && outDeck && outRamp && outDeck !== inDeck;
    if (overlap && this.state.path) {
      this.holdFadingOut(FADE_OUT_S * 1000);
      outRamp.rampFactor('env', 0, FADE_OUT_S * 1000, envelopeCurve(1, 0));
      outRamp.onRampDone('env', () => {
        this.releaseFadingOut();
        // Park the retired deck once its ramp has landed, whatever the incoming
        // deck has decided about playing in the meantime.
        outDeck.setProperty('pause', true).catch(() => {});
        outDeck.setProperty('mute', true).catch(() => {});
      });
    }

    let duration = 0;
    try {
      if (reuse) {
        this.active = this.decks.indexOf(inDeck);
        this.standbyFile = null;
        const d = await inDeck.getProperty<number | null>('duration').catch(() => null);
        duration = typeof d === 'number' && d > 0 ? d : 0;
      } else {
        if (this.standbyFile !== null && inDeck !== this.next) this.standbyFile = null;
        await inDeck.loadfile(file);
        const d = await inDeck.getProperty<number | null>('duration').catch(() => null);
        duration = typeof d === 'number' && d > 0 ? d : 0;
        this.active = this.decks.indexOf(inDeck);
      }
    } catch (e) {
      this.state.path = file;
      /*
       * Two different failures wear one sentence here for long enough to produce a
       * toast that has been wrong every time it appeared. mpv's own verdict — "moov
       * atom not found", "unknown format" — is a fact about the file, and the plain
       * sentence below is the right thing to say about it. An expiry is a fact about
       * this machine's queue, and calling somebody's library corrupt because a
       * two-core laptop took forty seconds to spawn a decoder told them the opposite
       * of what was known.
       *
       * So the accusation only goes out when mpv actually made it. Anything else
       * says what happened and leaves the file alone.
       */
      const why = (e as Error).message.slice(0, 140);
      const judged = e instanceof LoadRefused && e.mpvSaid;
      this.state.error = judged
        ? `Could not open this file — it is corrupt, or not really the format its name claims. (${why})`
        : `The player did not answer in time, so this one was not started. It is almost certainly your machine being busy rather than the file — try it again. (${why})`;
      this.state.playing = false;
      this.releaseFadingOut();
      this.broadcast(true);
      return;
    }

    this.applyLoop();
    this.state.path = file;
    this.state.error = null;
    this.state.duration = duration;
    this.state.pos = opts.startAt ?? 0;
    /*
     * The promoted deck's `file-loaded` fired while it was still the standby, so
     * it declined to open a picture. Asking again here is what actually shows the
     * video — and on the reuse path there is no load event at all, because the
     * deck already had the file.
     */
    this.syncVideo();

    inDeck.fire('set_property', 'speed', this.speed);
    inRamp.userVolume = this.userVolume * 100;
    inRamp.setFactor('trim', trimGain(this.guardOn, this.trimDb));
    if (opts.startAt && opts.startAt > 0) {
      await inDeck.setProperty('time-pos', opts.startAt).catch(() => {});
    }

    /*
     * The retired deck is parked by its own ramp completion above, not here.
     *
     * Parking it synchronously is what forced the wait: silence the outgoing deck
     * before the incoming one speaks and the two ramps can only ever be
     * sequential. Muting on `onRampDone` still guarantees the end state — the
     * retired deck never survives its fade with sound on — and the next `load`
     * into that deck unmutes it before it is ever audible again.
     */
    inRamp.setFactor('env', 0);
    await inDeck.setProperty('mute', false).catch(() => {});

    if (autoplay) {
      await inDeck.setProperty('pause', false).catch(() => {});
      this.state.playing = true;
      this.state.paused = false;
      // Always climb in, never appear at full level: a deck that starts at 1.0
      // clicks, and on an advance it also stamps on the tail of the song still
      // fading out underneath it.
      inRamp.rampFactor('env', 1, FADE_IN_S * 1000, envelopeCurve(0, 1));
    } else {
      await inDeck.setProperty('pause', true).catch(() => {});
      inRamp.setFactor('env', 1);
      this.state.playing = false;
      this.state.paused = true;
    }

    if (opts.preloadNext) void this.preload(opts.preloadNext);
    this.broadcast(true);
  }

  /**
   * Warm a deck with the file that is coming next, then park it silent at 0.
   *
   * This is the part of the old crossfade worth keeping: not an overlapping
   * blend, just never making the listener wait for a decoder to start up.
   *
   * This is also the only thing that asks for the second mpv process at all. It is
   * the right place: "there is a next track to warm" is exactly the condition the
   * standby exists to answer, and the renderer already declines to name one for a
   * film, a single-item queue or the end of a non-repeating list.
   */
  async preload(file: string): Promise<void> {
    /*
     * An empty path is the renderer's way of saying "there is nothing to warm".
     * `upcomingPathForPreload()` returns null at the end of a non-repeating queue,
     * for a queue of one, and whenever a film is what comes next, and `commitOrder()`
     * passes the result through `?? ''`. It used to fall straight into the body
     * below, whose first act is `init()` and whose second is `ensureStandbyDeck()` —
     * so a shuffle toggle on a one-song queue spawned *both* mpv processes, waited
     * for both pipes to answer, loaded nothing and failed. Measured on the dev
     * bridge: `preload('')` from a clean slate produced two `mpv.exe` at 72 MB on
     * arrival and 111-133 MB once their decoders had settled, for a session with
     * nothing to pre-buffer. That is the whole of "two decks exist even in a
     * music-only session" for any queue that is not actually asking for a warm
     * advance, and it is why the guard sits above `init()` rather than beside the
     * load: clearing a warm-up must never be able to buy a process.
     *
     * Nothing is lost by returning early. The old path never unloaded the standby
     * either — `loadfile('')` is refused by mpv, so a deck that was holding a track
     * kept holding it — so forgetting which file was promised is the entire effect.
     */
    if (!file) {
      this.standbyFile = null;
      return;
    }
    await this.init();
    if (this.standbyFile === file) return;
    const deck = await this.ensureStandbyDeck();
    const ramp = this.nextRamp;
    if (!deck || !ramp) return;
    /*
     * Never re-purpose a deck that is still sounding.
     *
     * During a hand-off the standby deck *is* the retiring one, so loading the
     * following track into it here replaced its source a few milliseconds into a
     * one-second crossfade. The ear heard a cut followed by a swell, which is the
     * "the fade between songs is not working" report — and the fade was real, it
     * was just being truncated before it became audible. Bounded wait, so a ramp
     * that somehow never lands costs a lost warm deck rather than a lost track.
     */
    if (ramp.isRamping('env')) await ramp.settled('env', 1400);
    if (this.nextRamp !== ramp) return;
    this.standbyFile = file;
    try {
      await deck.setProperty('mute', true);
      await deck.loadfile(file);
      await deck.setProperty('pause', true);
      await deck.setProperty('time-pos', 0).catch(() => {});
      ramp.setFactor('env', 0);
      deck.fire('set_property', 'speed', this.speed);
    } catch {
      if (this.standbyFile === file) this.standbyFile = null;
    }
  }

  async play(): Promise<void> {
    /*
     * Cold, because the idle release put the decks down under a track the user had
     * paused. There is no deck to un-pause here, so the file is opened again where it
     * was left — and `load()` boots the engine on the way through, which is why this
     * is a resume rather than an `init()` followed by a shrug. A resume that quietly
     * did nothing is the worst failure this class can have: the renderer writes
     * "playing" optimistically, the poll has no deck to read the truth from, and the
     * transport shows a song running into silence forever.
     */
    if (!this.decks.length) {
      const file = this.state.path;
      if (!file) return;
      await this.load(file, { autoplay: true, startAt: this.state.pos });
      return;
    }
    const deck = this.live;
    const ramp = this.liveRamp;
    if (!deck || !ramp || !this.state.path) return;
    this.cancelIdleRelease();
    this.releaseFadingOut();
    deck.fire('set_property', 'mute', false);
    deck.fire('set_property', 'pause', false);
    ramp.rampFactor('env', 1, FADE_IN_S * 1000, envelopeCurve(0, 1));
    this.state.playing = true;
    this.state.paused = false;
    this.broadcast(true);
  }

  /**
   * Ramp to silence, then stop the deck at the end of the ramp.
   *
   * A deck stopped at an arbitrary sample value clicks the speaker; one stopped
   * on a zero-crossing does not, and the ramp is what guarantees the latter.
   */
  pause(): void {
    const deck = this.live;
    const ramp = this.liveRamp;
    if (!deck || !ramp) return;
    /*
     * Already silent means stop right now, not "pause" into nothing.
     *
     * This used to `return` whenever the envelope had already reached zero, on the
     * reasoning that there was no fade left to run. But the deck can sit unpaused
     * at `env: 0` — any hand-off that promotes a preloaded deck and never finishes
     * its fade-in leaves it there — and then a pause was a no-op while the
     * renderer still wrote its optimistic "paused". The next poll read the truth
     * back off the running deck and flipped the transport to play again. That is
     * the loop the user described as "clicking play/pause doesnt respond, it
     * pauses for a second then plays again, still without audio", and it is also
     * why the pause fade seemed to have been removed: there was nothing to fade.
     */
    if (!ramp.isRamping('env') && ramp.factor('env') === 0) {
      this.releaseFadingOut();
      this.state.playing = false;
      this.state.paused = true;
      deck.setProperty('pause', true).catch(() => {});
      this.armIdleRelease(PAUSED_RELEASE_MS);
      this.broadcast(true);
      return;
    }
    ramp.rampFactor('env', 0, FADE_OUT_S * 1000, envelopeCurve(1, 0));
    ramp.onRampDone('env', () => {
      this.releaseFadingOut();
      // A resume during the fade owns the deck now; do not stomp on it.
      if (this.state.playing) return;
      deck.setProperty('pause', true).catch(() => {});
      this.state.paused = true;
      this.armIdleRelease(PAUSED_RELEASE_MS);
      this.broadcast(true);
    });
    this.holdFadingOut(FADE_OUT_S * 1000);
    this.state.playing = false;
    this.broadcast(true);
  }

  stop(): void {
    const deck = this.live;
    const ramp = this.liveRamp;
    if (!deck || !ramp) return;
    ramp.rampFactor('env', 0, FADE_OUT_S * 1000, envelopeCurve(1, 0));
    ramp.onRampDone('env', () => {
      if (this.state.playing) return;
      deck.setProperty('pause', true).catch(() => {});
      deck.setProperty('time-pos', 0).catch(() => {});
      this.state.pos = 0;
      this.armIdleRelease(PAUSED_RELEASE_MS);
      this.broadcast(true);
    });
    this.holdFadingOut(FADE_OUT_S * 1000);
    this.state.playing = false;
    this.state.pos = 0;
    this.broadcast(true);
  }

  /**
   * Take the file off both decks entirely, and put the processes down after.
   *
   * `stop()` fades to silence and rewinds, but the deck keeps the file open and
   * keeps answering `hasVideo: true` about it. That is exactly right for a song the
   * user paused, and exactly wrong when the renderer has just handed a film to its
   * own `<video>` element: the deck carried on behind the page's decoder and the
   * two came out of one speaker at once, which is the user's "the current video is
   * running and the .ts audio plays parallel to it". mpv's own `stop` command
   * empties the playlist, so nothing is left to make noise or hold a picture.
   *
   * Emptying the playlist is not the same as releasing the process, though, and for
   * a long time it was the end of the story: an mpv with no file open sat holding
   * 52 MB until the app quit, which is what the task bar looked like after a film was
   * handed over. `drop()` therefore arms the idle release, and the next `load()`
   * cancels it through `init()`.
   */
  halt(): void {
    const deck = this.live;
    const ramp = this.liveRamp;
    const drop = (): void => {
      for (const d of this.decks) {
        if (!d) continue;
        void d.command('stop').catch(() => undefined);
      }
      this.standbyFile = null;
      this.releaseFadingOut();
      this.state.playing = false;
      this.state.paused = true;
      this.state.pos = 0;
      this.state.path = null;
      this.state.hasVideo = false;
      this.state.at = Date.now();
      // Never 'false': a deck that has not been asked yet has to re-decide on its
      // next file, and `applyVideo` reads null as "ask me".
      this.videoOn = [null, null];
      /*
       * Same reason as in `applyVideo`: main has to take the picture out of the
       * widget before the placement below hides it, because a native window left
       * parented to a frame that is about to be destroyed goes with it, and mpv's
       * video output does not recover from having its window destroyed under it.
       */
      this.onHasVideoChange?.(false);
      this.setVideoSlot(null);
      this.armIdleRelease(EMPTY_RELEASE_MS);
      this.broadcast(true);
    };
    if (!deck || !ramp) {
      drop();
      return;
    }
    ramp.rampFactor('env', 0, FADE_OUT_S * 1000, envelopeCurve(1, 0));
    ramp.onRampDone('env', drop);
    this.holdFadingOut(FADE_OUT_S * 1000);
    this.state.playing = false;
    this.state.pos = 0;
    this.broadcast(true);
  }

  /**
   * Repeat one, answered by the deck rather than by a chase after `end-file`.
   *
   * The renderer used to catch the end-of-track event and reply with `seek(0)` and
   * `play()`. mpv unloads the file the moment it finishes, so that restart lands on
   * an idle deck — and the latch that stops one ending from skipping twice meant it
   * only ever got the one shot. Hence "repeat one repeats once". `loop-file` keeps
   * the file loaded and replays it internally, forever and gaplessly, which is what
   * the mode has always been supposed to mean.
   */
  applyLoop(): void {
    const value = session?.repeat === 'one' ? 'inf' : 'no';
    for (let i = 0; i < this.decks.length; i++) {
      const deck = this.decks[i];
      if (!deck || this.loopFile[i] === value) continue;
      this.loopFile[i] = value;
      deck.fire('set_property', 'loop-file', value);
    }
  }

  async seek(seconds: number): Promise<void> {
    if (!this.state.path) return;
    const target = clamp(seconds, 0, this.state.duration > 0 ? this.state.duration : seconds);
    const deck = this.live;
    if (!deck) {
      /*
       * Released while paused, so there is no deck to write to. The position is still
       * worth keeping, because `play()` reopens the remembered file at the remembered
       * spot — a seek that was thrown away would have the film start from the top
       * after the user had plainly dragged it elsewhere.
       */
      this.state.pos = target;
      this.broadcast(true);
      return;
    }
    /*
     * Only adopt the requested position if the deck accepted the write. The first
     * version swallowed the rejection and set `state.pos` anyway, which is how a
     * seek issued after the file had already ended reported a position that would
     * never move — the UI sat showing 232.5s of a frozen, still-"playing" track.
     */
    try {
      await deck.setProperty('time-pos', target);
      this.state.pos = target;
    } catch {
      const actual = await deck.getProperty<number | null>('time-pos').catch(() => null);
      if (typeof actual === 'number' && Number.isFinite(actual)) this.state.pos = actual;
    }
    this.broadcast(true);
  }

  /**
   * Scrubbing holds the audio still and lets only the playhead move. Every write
   * to `time-pos` discards the decoder's buffer and refills it, and a drag
   * produces dozens of those a second — the crackle this removes.
   */
  beginScrub(): void {
    if (this.scrubbing) return;
    this.scrubbing = true;
    this.scrubWasPlaying = this.state.playing;
    if (this.scrubWasPlaying) this.live?.fire('set_property', 'pause', true);
  }

  async endScrub(seconds: number): Promise<void> {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    await this.seek(seconds);
    if (this.scrubWasPlaying) {
      this.live?.fire('set_property', 'pause', false);
      this.liveRamp?.setFactor('env', 1);
      this.state.playing = true;
      this.state.paused = false;
    }
    this.broadcast(true);
  }

  // ------------------------------------------------------------------
  // Mixing
  // ------------------------------------------------------------------

  setVolume(v: number): void {
    this.userVolume = clamp(v, 0, 1);
    for (const r of this.ramps) r.setUserVolume(this.userVolume * 100);
    this.broadcastMix();
  }

  setSpeed(s: number): void {
    this.speed = clamp(s, 0.25, 2);
    for (const d of this.decks) d.fire('set_property', 'speed', this.speed);
    this.broadcastMix();
  }

  setPitch(semitones: number): void {
    this.pitch = clamp(semitones, -12, 12);
    this.scheduleAf();
    this.broadcastMix();
  }

  setEqGains(gains: number[], enabled?: boolean): void {
    this.eqGains = new Array(EQ_BANDS_HZ.length)
      .fill(0)
      .map((_, i) => clamp(Number(gains[i]) || 0, -12, 12));
    if (enabled !== undefined) this.eqEnabled = enabled;
    this.scheduleAf();
    this.broadcastMix();
  }

  /**
   * Tell every window what the deck's mixer now is.
   *
   * Sent on the same one-way channel as the session hub rather than as a reply,
   * because the writer is whichever of the three windows happened to move a
   * control and the other two have to find out unprompted. The renderer guards
   * against echoing its own copy back, so this cannot oscillate.
   */
  private broadcastMix(): void {
    this.send('mpv:mix', {
      volume: this.userVolume,
      speed: this.speed,
      pitch: this.pitch,
      eq: [...this.eqGains],
      eqEnabled: this.eqEnabled,
      guard: this.limiterOn,
    });
  }

  /**
   * The per-track clipping trim in dB, from the file's measured true peak.
   *
   * It rides the ramp scheduler as a factor rather than a filter parameter
   * because the trim changes once per track while `af` changes are expensive — and
   * because the mpv limiter's own ceiling parameter is inert (see shared/audio).
   */
  setTrackTrimDb(db: number): void {
    this.trimDb = Number.isFinite(db) ? db : 0;
    const v = trimGain(this.guardOn, this.trimDb);
    for (const r of this.ramps) r.setFactor('trim', v);
  }

  setClippingGuard(on: boolean): void {
    this.limiterOn = on;
    this.guardOn = on;
    const v = trimGain(on, this.trimDb);
    for (const r of this.ramps) r.setFactor('trim', v);
    this.scheduleAf();
    this.broadcastMix();
  }

  // ------------------------------------------------------------------
  // State reporting
  // ------------------------------------------------------------------

  private async poll(): Promise<void> {
    const deck = this.live;
    if (!deck || !this.ready || !this.state.path) return;
    const [pos, paused, idle, duration] = await Promise.all([
      deck.getProperty<number | null>('time-pos').catch(() => null),
      deck.getProperty<boolean>('pause').catch(() => true),
      deck.getProperty<boolean>('idle-active').catch(() => true),
      deck.getProperty<number | null>('duration').catch(() => null),
    ]);
    /*
     * Stamped the instant the reading lands, before anything else is awaited.
     * The renderer extrapolates between reports and needs to know when each one
     * was taken, not when it was delivered — and `broadcast()` can be reached
     * through several branches, some of which are behind further awaits.
     */
    this.state.at = Date.now();

    let changed = false;
    if (typeof pos === 'number' && Number.isFinite(pos) && !this.scrubbing) {
      this.state.pos = pos;
      changed = true;
    }
    if (typeof duration === 'number' && duration > 0 && Math.abs(duration - this.state.duration) > 0.5) {
      this.state.duration = duration;
      changed = true;
    }

    /*
     * The lead-in duck. A hand-off used to be one second of silence at the
     * boundary: the outgoing track ran full tilt to its last frame, the deck
     * stopped, and the incoming one faded up from zero — so what the ear heard
     * was a cut followed by a swell, not a transition. Starting the descent
     * DUCK_LEAD_S before the end makes the two overlap into one gesture, and
     * leaving the floor above silence keeps the last line intelligible.
     *
     * Keyed on the path so it fires once per track, and reversed if the user
     * seeks back off the tail — a duck that could not be undone would leave the
     * rest of a long song quiet.
     *
     * The duck goes to `liveRamp` alone, never to every deck. Writing it to the
     * standby as well was measured leaving the incoming track playing eleven
     * seconds at `combined: 0` — the hand-off zeroes the new deck's envelope and
     * fades it back up, and a duck still in flight on that same factor ate the
     * fade-in, so the song ran silently. Only the deck that is actually sounding
     * has anything to duck.
     */
    if (
      !this.fadingOut &&
      !this.scrubbing &&
      !paused &&
      !idle &&
      typeof pos === 'number' &&
      Number.isFinite(pos) &&
      Number.isFinite(duration) &&
      (duration as number) > DUCK_LEAD_S * 2
    ) {
      const left = (duration as number) - pos;
      const key = this.state.path;
      const live = this.liveRamp;
      if (live) {
        if (left <= DUCK_LEAD_S && this.duckedFor !== key) {
          this.duckedFor = key;
          live.rampFactor('env', DUCK_FLOOR, Math.max(150, left * 1000), 'linear');
        } else if (left > DUCK_LEAD_S * 1.4 && this.duckedFor === key) {
          this.duckedFor = null;
          live.rampFactor('env', 1, FADE_IN_S * 1000, envelopeCurve(0, 1));
        }
      }
    }

    /*
     * While a fade to silence is running the deck is still genuinely unpaused —
     * that is the point of the ramp. Reading `pause` during that window would
     * report "playing" for 600ms after the user pressed pause, and would re-arm
     * the ramp's own completion guard so the deck never stopped at all.
     */
    /*
     * No `eof-reached` check here, deliberately. Measured across a file boundary
     * it reads false in the last poll before the end and `property unavailable`
     * from then on, because mpv unloads the file the instant it finishes — so a
     * poll can never observe it as true. The end-of-track signal is the
     * `end-file` event, handled in `onDeckEvent`.
     *
     * This block is still what keeps the transport honest: at EOF the deck reports
     * `idle-active`, so a missed event degrades to "shows stopped but does not
     * advance" rather than the first build's failure mode of showing "playing"
     * against a frozen position forever.
     */
    if (!this.fadingOut && !this.scrubbing) {
      const playing = !paused && !idle;
      if (playing !== this.state.playing) {
        this.state.playing = playing;
        this.state.paused = paused;
        changed = true;
      }
    }

    /*
     * Broadcast on a real change only. A periodic "is anything new?" push once
     * looked harmless, but measured it is a 4Hz wake-up for every open window
     * while the transport is sitting still — three windows × 4/s of nothing, and
     * renderer main-thread time is the scarce resource in this app.
     */
    if (changed) this.broadcast();
    this.audioWatchdog();
  }

  /**
   * Re-read the deck and push the answer, whatever changed while nobody was
   * looking.
   *
   * A touchpad media gesture reaches the deck through SMTC even when this app
   * has lost focus. The deck obeys it, and the renderer's copy of `isPlaying`
   * only ever moves on a report it did not receive — so the audio stopped while
   * the transport kept showing pause and the waveform kept sweeping. The poll is
   * already running, but `broadcast()` is change-gated, and a state that changed
   * while the renderer was not listening never looks like a change again.
   */
  resync(): void {
    void this.poll();
    this.broadcast(true);
  }

  /**
   * Re-assert the live deck's audibility, on a slow beat.
   *
   * The deck can end up playing-in-silence from a write that never landed:
   * `mute=false` is fired without a reply at the top of `play()`, a volume push
   * is skipped when the combined value has not moved, and a device change can
   * leave the output open at zero. None of those show up anywhere else, because
   * position keeps advancing.
   *
   * So while the deck says it is playing, every couple of seconds the envelope is
   * pushed again and mute is asserted false. It is idempotent when nothing is
   * wrong — the same numbers, the same state — and it turns a permanent outage
   * into two seconds of quiet.
   */
  private audioWatchdog(): void {
    if (!this.state.playing || this.fadingOut || this.scrubbing) return;
    const deck = this.live;
    const ramp = this.liveRamp;
    if (!deck || !ramp) return;
    const now = Date.now();
    if (now - this.lastWatchdog < 2000) return;
    this.lastWatchdog = now;
    /*
     * Repair a stranded envelope before re-asserting it.
     *
     * Re-pushing `combined()` unconditionally made this the thing that *held* the
     * outage shut: with `env` stuck at 0 the honest product is silence, so every
     * beat wrote zero again and the deck played into a muted speaker forever. Two
     * beats rather than one, because a fade-in is 600ms and a duck floor is well
     * above this threshold — a single reading could interrupt either.
     */
    if (ramp.combined() <= 0.5 && ramp.userVolume > 0.5) {
      this.silentBeats += 1;
      if (this.silentBeats >= 2) {
        this.silentBeats = 0;
        ramp.setFactor('env', 1);
        deck.setProperty('mute', false).catch(() => {});
      }
    } else {
      this.silentBeats = 0;
    }
    const v = ramp.combined();
    // Force the write even when the value has not moved, because the whole point
    // is that a previous one may never have arrived.
    deck.setProperty('volume', v).catch(() => {});
    deck.setProperty('mute', false).catch(() => {});
  }

  private broadcast(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastBroadcast < 100) return;
    this.state.at = now;
    this.lastBroadcast = now;
    this.send('mpv:state', this.state);
    // The thumbnail's middle button is a play/pause glyph, so it follows state.
    setThumbPlaying(this.state.playing);
    /*
     * Main decides here whether the next/previous hardware keys are ours. They
     * are, for as long as this deck is the thing making noise, and not one frame
     * longer — holding them while idle would swallow the key from whatever else
     * is playing, which is the exact complaint that kept the shortcuts scoped to
     * window focus in the first place.
     */
    if (this.state.playing !== this.lastPlayingForKeys) {
      this.lastPlayingForKeys = this.state.playing;
      this.onPlayingChange?.(this.state.playing);
    }
  }

  private send(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  snapshot(): MpvSnapshot {
    return {
      ready: this.ready,
      broken: this.broken,
      activeDeck: this.active,
      standbyFile: this.standbyFile,
      af: this.lastAf,
      state: { ...this.state },
      video: { ...mpvWindow.debug(), videoOn: [...this.videoOn], slot: this.slot },
      volume: this.userVolume,
      speed: this.speed,
      pitch: this.pitch,
      eq: [...this.eqGains],
      eqEnabled: this.eqEnabled,
      guard: this.limiterOn,
      trimDb: this.trimDb,
      fadingOut: this.fadingOut,
      scrubbing: this.scrubbing,
      ramps: this.ramps.map((r) => r.snapshot()),
      decks: this.decks.map((d) => ({ connected: d.connected, running: d.running })),
      /** Last events mpv pushed per deck, so the end-of-track path is checkable live. */
      events: this.decks.map((d) => d.eventLog.slice(-14)),
    };
  }

  /**
   * Read raw mpv properties off a deck, bypassing everything this class caches.
   *
   * A debugging affordance, but a load-bearing one: when the playhead froze after
   * an auto-advance there was no way to tell "mpv is paused" from "mpv is playing
   * and the engine is not reading it", because every number the renderer could see
   * had already been through the engine's own state.
   */
  async rawProps(names: string[], deckIndex = -1): Promise<Record<string, unknown>> {
    const idx = deckIndex >= 0 ? deckIndex : this.active;
    const deck = this.decks[idx];
    if (!deck) return { error: 'no such deck' };
    const out: Record<string, unknown> = {};
    await Promise.all(
      names.slice(0, 24).map(async (n) => {
        try { out[n] = await deck.getProperty(n); } catch (e) { out[n] = 'ERR ' + (e as Error).message.slice(0, 40); }
      }),
    );
    return out;
  }

  /**
   * Hard, synchronous teardown for `will-quit`.
   *
   * An async `quit()` sends the IPC goodbye and waits, which a quitting Electron
   * process does not honour — the result is mpv.exe left behind playing into a dead
   * app and holding the named pipe so the next launch cannot bind it.
   */
  shutdown(): void {
    void this.putDecksDown(false);
  }

  /**
   * Start the countdown on the mpv processes, with the wait the caller's reason asks
   * for — this does not decide whether the engine is idle, only how long to give it.
   *
   * `halt()` arms the short one: its `stop` command emptied both decks, so from that
   * instant the processes exist only in case the user asks again — 52 MB of maybe, for
   * a player that is showing nothing. `pause()` and `stop()` arm the long one, because a
   * track the user paused is a track they are very likely to resume in a second, and
   * resuming a deck that still has the file open is instant in a way that reloading it
   * is not.
   *
   * An arm already running is never pushed forward. Anything that wants the decks back
   * cancels it outright — `load()` and `preload()` through `init()`, and `play()`
   * itself, which is the one resume that reaches a warm deck without booting anything.
   * An arm that re-delayed itself on every poll would simply never fire on a queue that
   * keeps pausing.
   */
  private armIdleRelease(ms: number): void {
    if (this.idleRelease || !this.decks.length) return;
    this.idleRelease = setTimeout(() => {
      this.idleRelease = null;
      void this.releaseDecks();
    }, ms);
  }

  private cancelIdleRelease(): void {
    if (!this.idleRelease) return;
    clearTimeout(this.idleRelease);
    this.idleRelease = null;
  }

  /**
   * Put the mpv processes down because nothing is loaded and nothing is playing.
   *
   * Re-checked at fire time, not only at arm time, because what happens in between is
   * the user pressing play — and a touchpad media key reaches the deck through SMTC
   * without the renderer calling anything that could have cancelled the timer.
   *
   * `state.path` and `state.pos` survive on purpose: they are what `play()` reopens the
   * paused file with. Where they have already been cleared — by `halt()` — the engine
   * is honestly empty and the renderer knows it, so a resume there is a `load()`.
   *
   * A track that finished by itself is not armed for release, because that is the one
   * silence that is usually about to be filled: the queue is still loaded and its next
   * row is pre-buffered in the standby. Putting the processes down there would spend
   * the seam this class works hardest to keep, on a gap the user did not ask for.
   */
  private async releaseDecks(): Promise<void> {
    if (this.retiring) return this.retiring;
    if (!this.decks.length || this.state.playing || this.scrubbing || this.fadingOut) return;
    console.log(
      `[mpv] idle: releasing ${this.decks.length} mpv process(es), `
      + (this.state.path ? `paused on ${this.state.path}` : 'nothing loaded'),
    );
    const run = this.putDecksDown(true).finally(() => { this.retiring = null; });
    this.retiring = run;
    return run;
  }

  /**
   * Stop the timers, the ramps and every mpv process, and reset what was per-deck.
   *
   * The per-deck caches are the part that silently rots if forgotten. `lastAf` is
   * compared before a chain is written, so a remembered chain would never reach a
   * re-booted deck and the user's EQ would go quiet on resume; `loopFile` is compared
   * per index the same way, so repeat-one would not be re-asserted and the track would
   * play once instead of forever; and `videoOn` remembers a decision taken about a
   * process that no longer exists, which `applyVideo` would then trust.
   */
  private async putDecksDown(graceful: boolean): Promise<void> {
    this.cancelIdleRelease();
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.afTimer) { clearTimeout(this.afTimer); this.afTimer = null; }
    this.afDirty = false;
    for (const r of this.ramps) r.stop();
    const decks = this.decks;
    this.decks = [];
    this.ramps = [];
    this.standbyBoot = null;
    this.standbyFile = null;
    this.active = 0;
    this.videoOn = [null, null];
    this.loopFile = [];
    this.lastAf = null;
    this.duckedFor = null;
    this.silentBeats = 0;
    this.lastWatchdog = 0;
    this.ready = false;
    this.releaseFadingOut();
    if (graceful) for (const d of decks) await d.quit().catch(() => {});
    else for (const d of decks) d.kill();
  }
}

export const mpvEngine = new MpvEngine();

type Handlers = {
  'mpv:load': [string, LoadOptions?];
  'mpv:preload': [string];
  'mpv:play': [];
  'mpv:pause': [];
  'mpv:stop': [];
  'mpv:halt': [];
  'mpv:seek': [number];
  'mpv:begin-scrub': [];
  'mpv:end-scrub': [number];
  'mpv:volume': [number];
  'mpv:speed': [number];
  'mpv:pitch': [number];
  'mpv:eq': [number[], boolean?];
  'mpv:trim': [number];
  'mpv:guard': [boolean];
  'mpv:snapshot': [];
  'mpv:force-af': [];
  'mpv:raw-props': [string[], number?];
};

/**
 * Wire the engine to the renderers.
 *
 * The command surface is deliberately narrow: discrete transport and mixing
 * actions, never a per-frame one. Anything the UI needs every frame comes back on
 * the `mpv:state` broadcast and is interpolated locally.
 */
/*
 * The play session hub.
 *
 * One deck, four windows. Each window used to keep its own queue and index, so a
 * widget opened cold adopted whatever the last hand-off happened to carry and then
 * pressed Next from *that* list — which is how a pill ended up replaying the song
 * already playing, or skipping to something the library was never showing. These
 * windows are control surfaces on one player, so the session is published here
 * once and mirrored by everyone: ids and a position, each window resolving them
 * against its own scan of the library rather than being sent whole tracks.
 */
let session: PlaySession | null = null;

export function registerMpvIpc(): void {
  ipcMain.on('mpv:set-session', (e, next: PlaySession) => {
    if (!next || !Array.isArray(next.ids)) return;
    session = next;
    // Repeat one is a deck property now, so the deck has to hear about the change.
    mpvEngine.applyLoop();
    for (const win of BrowserWindow.getAllWindows()) {
      // The publisher already has it. Echoing it back would make it bounce.
      if (win.isDestroyed() || win.webContents === e.sender) continue;
      win.webContents.send('mpv:session', next);
    }
  });
  // A window that arrives late asks, instead of guessing from a hand-off payload.
  ipcMain.handle('mpv:get-session', () => session);
  const handle = <K extends keyof Handlers>(
    channel: K,
    fn: (...args: Handlers[K]) => unknown,
  ): void => {
    ipcMain.handle(`mpv:${channel.slice(4)}`, async (_e, ...args: unknown[]) => {
      try {
        const result = await fn(...(args as Handlers[K]));
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    });
  };

  handle('mpv:load', (file, opts) => mpvEngine.load(file, opts ?? {}));
  handle('mpv:preload', (file) => mpvEngine.preload(file));
  handle('mpv:play', () => mpvEngine.play());
  handle('mpv:pause', () => mpvEngine.pause());
  handle('mpv:stop', () => mpvEngine.stop());
  handle('mpv:halt', () => mpvEngine.halt());
  handle('mpv:seek', (sec) => mpvEngine.seek(sec));
  handle('mpv:begin-scrub', () => mpvEngine.beginScrub());
  handle('mpv:end-scrub', (sec) => mpvEngine.endScrub(sec));
  handle('mpv:volume', (v) => mpvEngine.setVolume(v));
  handle('mpv:speed', (s) => mpvEngine.setSpeed(s));
  handle('mpv:pitch', (st) => mpvEngine.setPitch(st));
  handle('mpv:eq', (gains, enabled) => mpvEngine.setEqGains(gains, enabled));
  handle('mpv:trim', (db) => mpvEngine.setTrackTrimDb(db));
  handle('mpv:guard', (on) => mpvEngine.setClippingGuard(on));
  handle('mpv:snapshot', () => mpvEngine.snapshot());
  handle('mpv:force-af', () => mpvEngine.forceAf());
  handle('mpv:raw-props', (names, deckIndex) => mpvEngine.rawProps(names, deckIndex));
}
