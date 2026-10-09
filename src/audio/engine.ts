import { usePlayerStore } from '../stores/playerStore';
import type { Track } from '../types';
import type { PlaySession } from '../../shared/audio';
import { seededPermutation } from '../utils/sorting';
import { IS_OVERLAY_WINDOW } from '../utils/windowRole';
import { getCachedPoster } from '../utils/videoPoster';
import type { FilmCommand, FilmState, MixState, MpvApi, MpvSnapshot, MpvState } from '../../shared/audio';
import {
  EQ_BANDS_HZ,
  FADE_IN_S,
  FADE_OUT_S,
  WAVEFORM_PEAK_COUNT,
  trimGain,
} from '../../shared/audio';

/**
 * `EQ_BANDS_HZ` and `WAVEFORM_PEAK_COUNT` are deliberately NOT re-exported from
 * here. `playerStore` needs them at module-initialisation time and `engine.ts`
 * imports `playerStore`, so a re-export closes the cycle and the constant reads as
 * an uninitialised binding — which took down every UI module at once. Consumers
 * import them from `shared/audio` directly.
 */


/**
 * What crosses the wire between windows when playback moves from one to the
 * other.
 *
 * mpv runs in the main process now, so there is one engine for every window and
 * almost none of what this used to carry is needed — it survives because
 * `App.tsx` still exchanges it with the pill overlay, and a window coming to the
 * foreground still has to adopt the position the shared deck is at.
 */
export interface HandoffState {
  trackId?: string;
  position: number;
  playing: boolean;
  mode?: 'normal' | 'full' | 'mini' | 'pill';
  /*
   * The track and queue themselves, not just an id to look up. A freshly created
   * overlay window has an empty store — only settings are persisted — so an id it
   * cannot resolve is worse than useless: the card renders "Nothing playing" over a
   * blank record while audio carries on in the main process behind it. Sending the
   * records means the widget can show what is actually playing on first paint.
   */
  track?: Track;
  queue?: Track[];
  index?: number;
}

/**
 * mpv decodes everything, so the ffmpeg → 24-bit WAV conversion cache that used
 * to sit behind the video path is gone: it was the source of 4.1GB of disk, of
 * the eviction bug that made a referenced WAV vanish, and of seconds of waiting
 * on a track change.
 */
export function toMediaUrl(filePath: string): string {
  /*
   * An app-served asset is already a URL, but only *relative to the document*.
   * `/brand/wallpaper.jpg` is the background every fresh install ships with, and
   * under `file://` a leading slash is the root of the drive — so the packaged app
   * asked for `C:\brand\wallpaper.jpg` and painted nothing. Dropping the slash to
   * a `.` is the one spelling that resolves in dev, where the document is the dev
   * server's root, and packaged, where it is `dist/index.html`. Routing it through
   * the media scheme would ask the handler for a file at a drive root instead. A
   * real Windows path starts with a drive letter, or `\\` for a share, so neither
   * reading can swallow the other.
   */
  if (filePath.startsWith('/')) return `.${filePath}`;
  return `media://track/${encodeURIComponent(filePath)}`;
}

/** The mpv bridge, or null when running somewhere without the Electron preload. */
function mpv(): MpvApi | null {
  return window.electronAPI?.mpv ?? null;
}

/**
 * The video track's picture and sound.
 *
 * Video is the one thing still on the old path, and it is the reason this class
 * exists separately rather than being folded away: mpv can only show a picture by
 * rendering into a window handle (`--wid`), which is its own task. Until that
 * lands a `.mp4` keeps playing through a `<video>` element with the same Web
 * Audio chain it always had, so nothing about video regresses while music moves
 * to mpv.
 *
 * Everything here is created on the first video load and never before, so an
 * audio-only session allocates no AudioContext at all.
 */
class VideoPath {
  private el: HTMLVideoElement | null = null;
  private ctx: AudioContext | null = null;
  private eqFilters: BiquadFilterNode[] = [];
  private eqOut!: GainNode;
  private trackGain!: GainNode;
  private envelope!: GainNode;
  private volumeGain!: GainNode;
  private limiter!: WaveShaperNode;
  private routedThroughPitch = false;
  private pitchNode: { pitchSemitones: { value: number }; playbackRate: { value: number }; connect(n: AudioNode): void } | null = null;
  private pitchLoading: Promise<unknown> | null = null;
  private targetPitch = 0;
  private eqGains = new Array(EQ_BANDS_HZ.length).fill(0);
  private volume = 0.8;
  private guardEnabled = true;
  private trackGainDb = 0;
  private pauseTimer = 0;

  /**
   * True for a second, purely decorative copy of a film another window is decoding.
   *
   * A mirror never builds the DSP graph. It has no business owning an
   * `AudioContext`, an equaliser or a limiter — it is `muted`, and if it were
   * wired up the listener would hear the same lecture from two decoders at once.
   * Skipping `ensureGraph()` is also what keeps a floating card from allocating a
   * second audio pipeline just to show a picture.
   */
  private mirrored = false;

  /**
   * Set by the engine so a rebuilt element keeps its event wiring.
   *
   * `close()` releases the graph's audio device and render thread, and it is the
   * only thing that does. But a closed `AudioContext` cannot hand its element to a
   * fresh one: the next `createMediaElementSource` on the same node throws
   * `InvalidStateError` ("HTMLMediaElement already connected previously to a
   * different MediaElementSourceNode"). So tearing the graph down also drops the
   * element, and the element is where the engine's `play`/`pause`/`ended`/`error`/
   * `loadedmetadata`/`loadeddata` listeners live. This hook re-attaches them the
   * moment a new film builds a new element, which is what lets the next film
   * rebuild the graph cleanly instead of throwing on a dead node.
   */
  private binder: ((el: HTMLVideoElement) => void) | null = null;

  setElementBinder(fn: (el: HTMLVideoElement) => void): void {
    this.binder = fn;
  }

  /**
   * Arming the graph's release. Zero means nothing is pending.
   *
   * Kept here rather than in the engine because the graph is this class's resource;
   * the engine only decides *when* the deck stops using it.
   */
  private closeTimer = 0;

  setMirror(on: boolean): void {
    this.mirrored = on;
    this.element.muted = on;
  }

  get element(): HTMLVideoElement {
    if (!this.el) {
      const el = document.createElement('video');
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.controls = false;
      el.setAttribute('playsinline', '');
      el.style.width = '100%';
      el.style.height = '100%';
      el.style.objectFit = 'contain';
      el.style.display = 'block';
      el.style.background = '#000';
      this.el = el;
      // A rebuilt element carries no listeners; the engine re-hangs them here.
      this.binder?.(el);
    }
    return this.el;
  }

  /**
   * Transfer curve for the safety limiter: identity below the threshold, then a
   * tanh knee that eases the overshoot. Slope-matched at the joint so content
   * under the ceiling passes through untouched.
   */
  private buildLimiterCurve(): Float32Array<ArrayBuffer> {
    const t = Math.pow(10, -1.5 / 20);
    const ceiling = 0.95;
    const points = 8192;
    const curve = new Float32Array(new ArrayBuffer(points * 4));
    for (let i = 0; i < points; i++) {
      const x = (i / (points - 1)) * 2 - 1;
      const a = Math.abs(x);
      const over = a - t;
      const y = over <= 0 ? a : t + (ceiling - t) * Math.tanh(over / (ceiling - t));
      curve[i] = Math.sign(x) * y;
    }
    return curve;
  }

  private ensureGraph(): AudioContext {
    // Building or reusing the graph means the deck is using it again — stand down
    // any close the last hand-off to mpv scheduled.
    this.cancelClose();
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(this.element);
    let node: AudioNode = source;
    for (const freq of EQ_BANDS_HZ) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.1;
      filter.gain.value = this.eqGains[this.eqFilters.length] ?? 0;
      node.connect(filter);
      node = filter;
      this.eqFilters.push(filter);
    }
    this.eqOut = ctx.createGain();
    node.connect(this.eqOut);
    this.trackGain = ctx.createGain();
    /*
     * Separate from `trackGain` on purpose. That node carries the per-track
     * clipping guard computed from the file's measured loudness; writing an
     * envelope there would overwrite the guard, and the next analysis result
     * would overwrite the envelope mid-fade.
     */
    this.envelope = ctx.createGain();
    this.volumeGain = ctx.createGain();
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = this.buildLimiterCurve();
    this.limiter.oversample = 'none';
    this.eqOut.connect(this.trackGain);
    this.trackGain.connect(this.envelope);
    this.envelope.connect(this.volumeGain);
    this.volumeGain.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.volumeGain.gain.value = this.volume;
    this.ctx = ctx;
    return ctx;
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  /**
   * Tear the graph down: close the context and drop the element bound to it.
   *
   * An `AudioContext` is not a lazy idle thing — it holds an audio device and a
   * 48 kHz render thread that keeps waking the process whether or not anything is
   * playing through it. Music runs through mpv, so once the deck leaves the video
   * path that context is pure overhead for the rest of the session, and Chromium
   * spawns the shared `audio.mojom.AudioService` child to serve it. `close()` is
   * the only call that gives the device and the thread back.
   *
   * The element goes with it because a bound element cannot be re-sourced after its
   * context dies (see `binder`). Both are re-made on the next in-page film. The
   * node references (`eqOut` … `limiter`) are left dangling on purpose: with
   * `ctx = null` every method that touches them short-circuits on `if (!this.ctx)`,
   * and `ensureGraph` reassigns all of them when it rebuilds.
   */
  teardownGraph(): void {
    this.cancelClose();
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        /* already closing */
      }
    }
    this.ctx = null;
    this.eqFilters = [];
    this.pitchNode = null;
    this.pitchLoading = null;
    this.routedThroughPitch = false;
    if (this.el) {
      // Detach first so the outgoing film's last frame stops painting, then drop it
      // so a fresh element (and its re-hung listeners) is built on the next film.
      this.el.removeAttribute('src');
      this.el.load();
      this.el.remove();
      this.el = null;
    }
  }

  /**
   * Give the graph back a beat after the deck stops using it.
   *
   * Deferred, not immediate, because leaving video almost always runs through a
   * fade: `load()` fading the film out to hand over to a song, and `releaseFilm()`
   * doing the same on a deck hand-off, both ride the envelope on *this* context.
   * Closing the instant the skip happens would cut that fade short into a click —
   * the exact regression #72/#55 guard against. The engine passes the fade's own
   * length; the graph goes once the last ramped value has been reached.
   */
  scheduleClose(afterMs: number): void {
    if (!this.ctx) return;
    window.clearTimeout(this.closeTimer);
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = 0;
      this.teardownGraph();
    }, afterMs);
  }

  /** Cancel a pending close; called by every path that is about to keep using it. */
  cancelClose(): void {
    if (!this.closeTimer) return;
    window.clearTimeout(this.closeTimer);
    this.closeTimer = 0;
  }

  get currentTime(): number {
    return this.element.currentTime || 0;
  }

  get duration(): number {
    const d = this.element.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  get paused(): boolean {
    return this.element.paused;
  }

  async load(url: string, speed: number, poster?: string | null): Promise<void> {
    if (!this.mirrored) {
      const ctx = this.ensureGraph();
      // The graph cannot start a suspended context's clock; playing before the
      // resume settles is how a film begins silent and drifts.
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => undefined);
      }
    }
    /*
     * A poster is the difference between "the video is loading" and "the app has
     * gone black". The element is `background: #000` and `object-fit: contain`,
     * so every frame before the decoder produces one is a black rectangle in a
     * letterbox — which is what the user reported as "at the starting it just
     * shows a black window". ffmpeg has already written a 640px JPEG of this
     * exact file into the poster cache at thumbnail time, and the element will
     * paint it natively, so it costs one attribute.
     */
    this.element.poster = poster ?? '';
    /*
     * Swapping the source ends the old media, so the fade-out's trailing pause has
     * nothing left to stop and would land on the *new* film instead. It used to:
     * `loadVideo()` fades out, then awaits `play()`, and the pause the fade armed
     * fired ~400ms into the track that had just started — a video that looked like
     * it never began.
     */
    this.cancelPendingPause();
    // The media load algorithm copies defaultPlaybackRate over playbackRate, so
    // speed has to live in both or every new track silently drops back to 1x.
    this.element.defaultPlaybackRate = speed;
    this.element.playbackRate = speed;
    this.element.src = url;
    // The load algorithm is still in flight, so the element reports the previous
    // film's rate here; hand the mirror the number that is about to stick.
    this.syncPitchMirror(speed);
    this.setTrackGainDb(this.trackGainDb);
  }

  play(): Promise<void> {
    this.resume();
    return this.element.play();
  }

  pause(): void {
    this.element.pause();
  }

  seek(to: number): void {
    try {
      this.element.currentTime = to;
    } catch {
      /* not ready to seek yet */
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.volumeGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
  }

  setSpeed(s: number): void {
    this.element.defaultPlaybackRate = s;
    this.element.playbackRate = s;
    this.syncPitchMirror();
  }

  /**
   * Re-assert the worklet's idea of the element's rate.
   *
   * `playbackRate` on the SoundTouch node is not a second tempo control. The pipe
   * behind it is built so that its `_rate` and `_tempo` always cancel
   * (`_rate = virtualPitch`, `_tempo = 1 / virtualPitch`), which makes it a pure
   * pitch shifter at constant duration, and the processor feeds it
   * `pitch * 2^(semitones/12) / playbackRate`. So the node's `playbackRate` is the
   * *pitch bias the element already applied* — the tempo belongs to the element,
   * the pitch belongs to the worklet, exactly one place each. Measured with a
   * constant-rate oscillator on the other end, underruns do not track the rate at
   * all (53 blocks short at 1x/0st, 53 at 2x/+12st, and not one fully-silent
   * render block in either) — which is the evidence that killed the theory that
   * the element and the worklet are resampling in series and draining each other.
   *
   * What that leaves is a coherence problem rather than a throughput one: the
   * mirror has to equal the element's rate *after the element settles*. It used to
   * be taken whenever `setPitch` happened to resolve, and the media load algorithm
   * runs `defaultPlaybackRate` over `playbackRate` while a source is being
   * attached, so a pitch change issued during a track change could read a rate of 1
   * from an element that was about to become 1.25. Nothing corrected it afterwards —
   * `setSpeed` is not called again on that track — and the bias the worklet was
   * supposed to undo went un-undone, leaving the film about four semitones sharp
   * (1.25x of pitch, the element's own resample with no compensation) for its whole
   * duration.
   *
   * `settlingTo` is why this takes the rate instead of always reading it: just
   * after `src` is assigned the element still reports the *previous* media's rate,
   * and the only honest number for that window is the one about to be applied.
   * The `ratechange` hook installed with the node covers every case this one
   * cannot see, so the two sides cannot be left disagreeing.
   *
   * The AudioParam clamps at 0.1..8, outside which the write is ignored rather
   * than throwing, so a stale in-range value would survive a wild rate.
   */
  private syncPitchMirror(settlingTo?: number): void {
    if (!this.pitchNode) return;
    const rate = settlingTo ?? this.element.playbackRate ?? 1;
    this.pitchNode.playbackRate.value = Math.max(0.1, Math.min(8, rate));
  }

  setEqGains(gains: number[]): void {
    this.eqGains = [...gains];
    if (!this.ctx) return;
    this.eqFilters.forEach((f, i) => {
      f.gain.setTargetAtTime(gains[i] ?? 0, this.ctx!.currentTime, 0.02);
    });
  }

  setPitch(semitones: number): void {
    this.targetPitch = semitones;
    if (!this.ctx) return;
    if (semitones === 0) {
      this.routeDirect();
      this.element.preservesPitch = true;
      return;
    }
    void this.ensurePitchNode().then((node) => {
      if (!node || this.targetPitch === 0) return;
      node.pitchSemitones.value = this.targetPitch;
      this.syncPitchMirror();
      this.element.preservesPitch = false;
      this.routeThroughPitch(node);
    });
  }

  private async ensurePitchNode(): Promise<VideoPath['pitchNode']> {
    if (this.pitchNode) return this.pitchNode;
    if (this.pitchLoading) return this.pitchLoading as Promise<VideoPath['pitchNode']>;
    this.pitchLoading = (async () => {
      try {
        const [{ SoundTouchNode }, processorSource] = await Promise.all([
          import('@soundtouchjs/audio-worklet'),
          import('@soundtouchjs/audio-worklet/processor?raw').then((m) => (m as { default: string }).default),
        ]);
        const url = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
        try {
          await SoundTouchNode.register(this.ctx!, url);
        } catch {
          /* already registered on this context */
        } finally {
          URL.revokeObjectURL(url);
        }
        const node = new SoundTouchNode({ context: this.ctx!, outputChannelCount: 2 });
        node.pitchSemitones.value = this.targetPitch;
        node.connect(this.trackGain);
        this.pitchNode = node as unknown as VideoPath['pitchNode'];
        this.syncPitchMirror();
        /*
         * The one hook that makes the pair self-healing. Anything can move the
         * element's rate behind this class's back — the load algorithm on a new
         * source, a `defaultPlaybackRate` adopted from the attribute, a film handed
         * over from another window — and each of those used to leave the worklet
         * correcting a bias the element no longer had. `ratechange` is the element
         * saying it settled, so mirroring there means the two can disagree only
         * inside one synchronous block, never for a whole track.
         */
        this.element.addEventListener('ratechange', () => this.syncPitchMirror());
        return this.pitchNode;
      } catch {
        return null;
      } finally {
        this.pitchLoading = null;
      }
    })();
    return this.pitchLoading as Promise<VideoPath['pitchNode']>;
  }

  private routeDirect(): void {
    if (!this.routedThroughPitch || !this.ctx) return;
    this.eqOut.disconnect();
    this.eqOut.connect(this.trackGain);
    this.routedThroughPitch = false;
  }

  private routeThroughPitch(node: NonNullable<VideoPath['pitchNode']>): void {
    if (this.routedThroughPitch || !this.ctx) return;
    this.eqOut.disconnect();
    this.eqOut.connect(node as unknown as AudioNode);
    this.routedThroughPitch = true;
  }

  setGuard(on: boolean, gainDb: number): void {
    this.guardEnabled = on;
    this.trackGainDb = gainDb;
    if (!this.ctx) return;
    this.volumeGain.disconnect();
    this.limiter.disconnect();
    if (on) {
      this.volumeGain.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
    } else {
      this.volumeGain.connect(this.ctx.destination);
    }
    this.setTrackGainDb(on ? gainDb : 0);
  }

  private setTrackGainDb(db: number): void {
    if (!this.ctx) return;
    const gain = trimGain(this.guardEnabled, db);
    this.trackGain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.02);
    void db;
  }

  /**
   * Ramps the envelope to `target` from wherever it currently is.
   *
   * `cancelScheduledValues` alone is not enough: it drops the pending ramp but
   * leaves the *value* wherever the last ramp was heading, so an interrupted
   * fade-out jumps to full before starting the fade-in. `setValueAtTime` pins the
   * true current value first, which is what makes an interrupted fade continue
   * smoothly instead of stepping.
   */
  fadeEnvelope(target: number, seconds: number): void {
    if (!this.ctx) {
      return;
    }
    const gain = this.envelope.gain;
    const now = this.ctx.currentTime;
    const from = gain.value;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(from, now);
    if (seconds <= 0 || from === target) {
      gain.setValueAtTime(target, now + Math.max(0, seconds));
      return;
    }
    const easeIn = target > from;
    const steps = Math.max(12, Math.round(seconds * 120));
    const data = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const eased = easeIn ? t * t * t : 1 - Math.pow(1 - t, 3);
      data[i] = from + (target - from) * eased;
    }
    data[steps - 1] = target;
    gain.setValueCurveAtTime(data, now, seconds);
  }

  /** Fades to silence, then actually stops the element at the end of the ramp. */
  fadeOutPause(): void {
    this.fadeEnvelope(0, FADE_OUT_S);
    this.cancelPendingPause();
    this.pauseTimer = window.setTimeout(() => {
      this.pauseTimer = 0;
      this.element.pause();
    }, FADE_OUT_S * 1000 + 8);
  }

  cancelPendingPause(): void {
    if (!this.pauseTimer) return;
    window.clearTimeout(this.pauseTimer);
    this.pauseTimer = 0;
  }

  get hasPausePending(): boolean {
    return this.pauseTimer !== 0;
  }

  /** Video always lives on the element; the shader needs it mounted. */
  mount(container: HTMLElement | null): void {
    if (!container || this.element.parentElement === container) return;
    container.appendChild(this.element);
  }

  unmount(): void {
    this.element.remove();
  }

  get videoSize(): { w: number; h: number } {
    return { w: this.element.videoWidth, h: this.element.videoHeight };
  }
}

/**
 * The single source of truth for playback.
 *
 * Music is played by mpv in the main process (see `electron/mpv-engine.ts`); this
 * class is the renderer's view of it — command calls out, an interpolated position
 * clock in, and the queue/shuffle ordering that only the renderer owns. Video
 * still runs through `VideoPath` above because mpv cannot put a picture on screen
 * until it is embedded via `--wid`.
 *
 * The public surface is deliberately unchanged from the Web Audio engine this
 * replaced, which is what let the swap happen without touching a single UI file.
 */
class AudioEngine {
  private video = new VideoPath();
  /** True while the shared deck is the video element rather than mpv. */
  private onVideo = false;
  /**
   * True while anything with a picture is on screen, whichever engine draws it.
   *
   * `onVideo` only covers the in-page element, and the containers Chromium refuses
   * go to mpv with a film still playing — so the rate reset below cannot key off it
   * without .ts files keeping a song's +6 semitones and 1.5x.
   */
  private onFilm = false;
  /** The speed and pitch the songs were running at, saved when a film took over. */
  private rateBeforeFilm: { speed: number; pitch: number } | null = null;
  /**
   * Files the `<video>` element refused, so they go straight to mpv from then on.
   *
   * Keyed by path rather than by extension, because Chromium's answer is about
   * the stream inside the container: an `.mkv` carrying h264+aac decodes fine and
   * keeps its refractable picture, while one carrying HEVC does not.
   */
  private inPageFailed = new Set<string>();
  /*
   * True in a floating widget while the track on screen is a film.
   *
   * The widget does not decode it — the library window does, and has since before
   * the widget existed. Everything this window would otherwise do to its own media
   * element becomes a message, and everything it would read out of one becomes a
   * mirrored `FilmState`. That is the same arrangement the widgets already have
   * with the mpv deck for music, which is why a widget can pause a song it never
   * loaded; a film simply needed the same treatment.
   */
  private filmRemote = false;
  /**
   * The file this window's element is decoding, or null.
   *
   * Kept separately from `currentTrack` because the two come apart when a widget
   * moves on: the session broadcast updates this window's idea of what is playing
   * a beat before its element has been told to stop, and the only way to know the
   * film is over is that the deck has started answering about something else.
   */
  private filmPath: string | null = null;
  /** Re-reads the element's real duration and picture size; set with the element. */
  private readVideoShape: () => void = () => {};

  private queue: Track[] = [];
  private index = -1;
  /** Stable permutation for shuffle mode, shared by next(), previous() and the pre-buffer. */
  private shuffleOrder: number[] = [];
  /**
   * The rows the user put in order by hand, by track id.
   *
   * The walk is otherwise a pure function of the seed, so anything that hands the
   * deck a different list re-derives it — which would quietly unpick an arrangement
   * nobody derived, a search hit being the usual culprit. Agreed rule: a hand-made
   * window outranks a re-pick until the deck has played past it. It is keyed by id
   * rather than by position because the list it is measured against is the one thing
   * that does change underneath it, and rows that leave the queue go with the list
   * that owned them — playing a different folder takes the walk back.
   */
  private pinnedUpcoming: string[] = [];
  /** Set while mirroring another window, so the mirror is not echoed back. */
  private applyingRemote = false;
  private sessionArmed = false;
  /** The last session seen, kept so a late library scan can still be fed it. */
  private heldSession: PlaySession | null = null;
  private loadToken = 0;

  private gainCache = new Map<string, number>();
  private waveformCache = new Map<string, number[]>();
  private waveformPending = new Map<string, Promise<number[] | null>>();
  private analysisTimer: number | null = null;
  /** A film's ffmpeg job, parked until the picture stops moving. See `parkAnalysis`. */
  private analysisPending: Track | null = null;
  private analysisWait = 0;

  /** The last thing the shared deck told us, and when. */
  private remote: MpvState | null = null;
  /** Position clock: `remote.pos` sampled at `anchorWall`, advanced by `speed`. */
  private anchorPos = 0;
  private anchorWall = 0;
  private posRaf: number | null = null;
  private posTimer: number | null = null;
  /** Whether the playhead loop is meant to be running, across a reschedule. */
  private posLoop = false;
  private lastPublished = 0;
  private lastPublishedPos = -1;
  /** Surfaces that want the playhead: the only thing the position loop feeds. */
  private posListeners = new Set<(seconds: number) => void>();
  private listenersBound = false;
  /**
   * Which window owns auto-advance. Main sends `mpv:ended` to the visible window
   * only, but a window can become visible between the event and its handler, so
   * the track identity is the thing that actually stops a double advance.
   */
  private endedFor: string | null = null;
  private scrubbing = false;
  private scrubWasPlaying = false;

  constructor() {
    this.bindListeners();

    // Mirror the session the other windows are already following, so a widget
    // opened after playback started shows the same queue rather than its own.
    this.startSessionSync();

    const s = usePlayerStore.getState();
    this.video.setVolume(s.volume);
    if (s.pitch !== 0) this.video.setPitch(s.pitch);
    this.video.setGuard(s.clipGuard !== false, 0);

    /*
     * Ask the deck what its mixer is rather than handing it this window's
     * persisted copy. The push was the bug: every window restores from the same
     * persisted store, so opening a mini or pill card overwrote a speed the user
     * had just set elsewhere with whatever that window last remembered — which is
     * why a change "didn't always reflect". The deck is the only thing that can
     * answer, so it is the only thing asked.
     */
    void mpv()
      ?.snapshot()
      .then((deck) => {
        /*
         * Whether a native window can be moved at all, which decides whether a film
         * can be handed to the card. `video.available` is the Win32 bindings —
         * `koffi` is optional, and without it there is no picture to parent, so a
         * film sent to mpv would be one with sound and no image in either window.
         * `broken` is the deck's own answer: an mpv that will not start has the same
         * consequence for a different reason.
         */
        this.nativePicture = !deck.broken && deck.video?.available === true;
        this.applyMix({
          volume: deck.volume,
          speed: deck.speed,
          pitch: deck.pitch,
          eq: deck.eq,
          eqEnabled: deck.eqEnabled,
          guard: deck.guard,
        });
      })
      .catch(() => {});
    this.armMixSync();
    this.armFilmRelay();
    this.armRouteWatch();

    if (import.meta.env.DEV) {
      const scope = window as unknown as Record<string, unknown>;
      scope.__engine = this;
      scope.__engineDebug = () => ({
        onVideo: this.onVideo,
        track: usePlayerStore.getState().currentTrack?.name ?? null,
        remote: this.remote,
        renderPos: +this.getRenderPosition().toFixed(3),
        videoPos: +this.video.currentTime.toFixed(3),
        queueLen: this.queue.length,
        index: this.index,
        shuffleOrder: this.shuffleOrder.length,
      });
    }
  }

  // ------------------------------------------------------------------
  // The shared deck's state, mirrored into this window's store
  // ------------------------------------------------------------------

  private bindListeners(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;
    const api = window.electronAPI;

    api?.onMpvState?.((st) => this.applyState(st));
    api?.onMpvEnded?.((info) => this.handleEnded(String(info?.path ?? '')));

    /*
     * The video element's events move with the element. The graph's teardown drops
     * the element it was bound to — a closed `AudioContext` cannot re-source the same
     * node without throwing `InvalidStateError` — so the element is rebuilt for the
     * next in-page film, and this hook re-hangs the listeners on whatever is built.
     * Registering it before the element is first touched is what binds the element
     * that construction creates; every later film re-enters through it.
     */
    this.video.setElementBinder((el) => this.bindElementEvents(el));
    void this.video.element;
  }

  /** Hang the deck's listeners for one video element. Re-run on every rebuild. */
  private bindElementEvents(el: HTMLVideoElement): void {
    /*
     * The video element's own events. It is the only source still in this
     * process, and its `pause` must not flip the transport while mpv is the one
     * actually playing — hence the `onVideo` guards throughout.
     */
    el.addEventListener('ended', () => {
      if (!this.onVideo) return;
      this.handleEnded(el.currentSrc);
    });
    el.addEventListener('play', () => {
      if (!this.onVideo) return;
      usePlayerStore.setState({ isPlaying: true });
      this.startPositionLoop();
      this.video.resume();
    });
    el.addEventListener('pause', () => {
      if (!this.onVideo || this.scrubbing || this.video.hasPausePending) return;
      usePlayerStore.setState({ isPlaying: false });
      this.stopPositionLoop();
    });
    el.addEventListener('error', () => {
      if (!this.onVideo) return;
      const code = el.error?.code ?? 0;
      /*
       * 3 (decode) and 4 (source not supported) mean Chromium cannot open this
       * stream, which is exactly the case the embedded deck exists for — so hand
       * the file to mpv instead of showing an error card. 1 (aborted) and 2
       * (network) are a load we started and lost, and retrying through a
       * different engine would only repeat it.
       */
      if (code === 3 || code === 4) {
        const path = usePlayerStore.getState().currentTrack?.path;
        if (path && !this.inPageFailed.has(path)) {
          this.onVideoDecodeError(path);
          return;
        }
      }
      usePlayerStore.setState({
        isPlaying: false,
        playbackError: MEDIA_ERROR_TEXT[code] ?? 'This file could not be played',
      });
    });
    const readShape = () => {
      if (!this.onVideo) return;
      const duration = el.duration;
      if (Number.isFinite(duration) && duration > 0) {
        const { currentTrack, updateTrack } = usePlayerStore.getState();
        if (currentTrack && Math.abs(currentTrack.duration - duration) > 1) {
          updateTrack({ ...currentTrack, duration: Math.round(duration) });
        }
      }
      /*
       * Only answer once the element actually knows its geometry. Before
       * HAVE_METADATA, `videoWidth` is 0 for every file including the ones with a
       * picture, and writing that as `mediaHasVideo: false` hid the stage
       * (`visibility: hidden`) that `load()` had just correctly opened — a black
       * box for however long the header took to parse, which read as the video
       * failing to start.
       */
      if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
        const has = el.videoWidth > 0 && el.videoHeight > 0;
        usePlayerStore.setState({
          mediaHasVideo: has,
          videoNatural: has ? { w: el.videoWidth, h: el.videoHeight } : null,
        });
      }
    };
    /*
     * Kept on the instance because the two load events are not enough on their
     * own. Replaying the same source, or a source the element already has cached,
     * fires neither of them, and `mediaHasVideo` then holds whatever the previous
     * track left there — which is why the top-right picture "randomly" appeared or
     * did not for a file that was plainly playing. `loadVideo` calls this directly
     * once playback starts, so the flag is re-read against the real element every
     * time rather than only on the two events that may or may not arrive.
     */
    this.readVideoShape = readShape;
    el.addEventListener('loadedmetadata', readShape);
    el.addEventListener('loadeddata', readShape);
  }

  /**
   * Adopt a report from the shared deck.
   *
   * The anchor has to be placed at the moment the reading was *taken*, not the
   * moment it landed here. A report is read in main, sent over IPC, and handled by
   * a renderer whose timers can be throttled by 6× when it is in the background —
   * anchoring on arrival therefore treats a stale position as current, and the
   * extrapolation loses that interval every single report. Measured: the playhead
   * advanced 10.5s across 19s of wall clock, i.e. a song finishing at half
   * past its own end. `st.at` is main's own timestamp, so using it absorbs any
   * delivery delay no matter how jittery.
   */
  private applyState(st: MpvState, from: 'deck' | 'film' = 'deck'): void {
    /*
     * While a widget mirrors someone else's film, the deck has nothing to say
     * about this window: it is parked on the track that played before the film,
     * reporting it paused. Believing it froze the widget's transport and dropped it
     * back to the music card mid-lecture, which is the same class of bug as
     * believing it about `isPlaying` when the element owns playback.
     */
    if (this.filmRemote && from !== 'film') return;
    this.remote = st;
    /*
     * The deck has moved on to a different file, which means a widget started
     * something else on it — and this window is still decoding the film that used
     * to be the track. Left alone it keeps the picture, keeps `onVideo` (so every
     * further deck report is ignored, which is how a widget's play button stops
     * working), and keeps a media element that nothing is asking for.
     */
    /*
     * The deck has moved on to a different file *and this window agrees that file
     * is now the track* — which means a widget started something else on the deck
     * while this window was still decoding the film. Both halves are needed: the
     * deck keeps answering about whatever it played before an in-page element took
     * over, so testing the path alone releases the film the instant it starts.
     */
    if (from === 'deck' && this.onVideo && this.filmPath && st.path) {
      const cur = usePlayerStore.getState().currentTrack;
      if (
        !sameFile(st.path, this.filmPath)
        && cur
        && cur.kind !== 'video'
        && sameFile(st.path, cur.path)
      ) {
        this.releaseFilm();
      }
    }
    /*
     * While the media element owns playback the deck is idle by definition, and
     * believing its report was a loop with teeth: this used to write
     * `isPlaying: false`, `useMediaSession` handed 'paused' to the OS, and Windows
     * SMTC answered its own question with a pause action that reached the app back
     * as `store().pause()` — pausing the film a few seconds after every start. The
     * deck's last word is still kept in `this.remote`, because the picture and the
     * path are read there; only the store and the position clock stay with the
     * element, which is the only thing actually playing.
     */
    if (this.onVideo) return;
    const speed = Math.max(0.25, usePlayerStore.getState().speed || 1);
    // Renderer-clock equivalent of main's reading time.
    const takenAt = performance.now() - Math.max(0, Date.now() - st.at);

    if (st.path) this.endedFor = null;

    const cur = this.extrapolate(speed);
    const drift = st.pos - cur;
    if (!st.playing || !Number.isFinite(this.anchorPos) || Math.abs(drift) > 1.5) {
      this.anchorPos = st.pos;
      this.anchorWall = takenAt;
    } else {
      /*
       * Close most of the gap rather than all of it. mpv's reading carries a
       * little jitter and the deck's own clock is not perfectly aligned with
       * ours, so snapping to each report makes the playhead step; converging on
       * it keeps the sweep continuous while still correcting real drift.
       */
      this.anchorPos = cur + drift * 0.6;
      this.anchorWall = takenAt;
    }

    /*
     * `playbackPosition` has exactly one writer, the rAF loop, as it did before
     * the swap. Writing it here too looked harmless and was not: the old engine
     * published position at 10Hz from one place, and adding an 8Hz second writer
     * on top re-rendered every subscriber — including the 349-row library list —
     * roughly twice as often as the app had ever been designed for, and the
     * renderer degraded until it stopped answering entirely.
     */
    if (usePlayerStore.getState().isPlaying !== st.playing) {
      usePlayerStore.setState({ isPlaying: st.playing });
    }
    if (!st.playing) {
      this.publishPosition(st.pos);
    }

    if (st.playing) this.startPositionLoop();
    else this.stopPositionLoop();

    if (st.error) {
      usePlayerStore.setState({ playbackError: st.error, isPlaying: false });
    }

    /*
     * While mpv owns the playback it is the only thing that knows whether what it
     * opened has a picture — the media element is not even loaded, so its
     * `videoWidth` says nothing. This is the one field the deck is allowed to
     * write, and it is change-gated for the same reason position is: a store field
     * that flips on every report re-renders the whole library.
     *
     * Gated on the path as well, because the deck keeps answering about the file it
     * last held. After a widget took an in-page film over, this used to write
     * `mediaHasVideo: true` back into a library that had just released it, and the
     * view reserved a rectangle for a picture that was not coming.
     */
    const onScreen = usePlayerStore.getState().currentTrack;
    const deckFilm =
      st.hasVideo && !!onScreen && onScreen.kind === 'video' && sameFile(st.path ?? '', onScreen.path);
    if (!this.onVideo && usePlayerStore.getState().mediaHasVideo !== deckFilm) {
      usePlayerStore.setState({ mediaHasVideo: deckFilm });
      this.watchSlot();
      if (deckFilm) this.publishMpvSize();
    }
    /*
     * And the picture's ratio, re-asked every time the deck starts answering about
     * a *different* film rather than only when it starts or stops having one.
     *
     * The card used to copy this off the relay — the library reported its element's
     * `videoWidth` four times a second and the mini sized its window from it — and
     * with the deck drawing the film there is nobody left reporting at all. The
     * `mediaHasVideo` gate above cannot cover it either: a queue that runs one
     * lecture into another leaves that flag true across the change, so the second
     * card would be cut to the first one's shape and mpv would spend the difference
     * painting bars nobody asked for.
     */
    if (deckFilm && this.sizedFor !== st.path) {
      this.sizedFor = st.path;
      this.publishMpvSize();
    } else if (!deckFilm) {
      this.sizedFor = null;
    }

    const { currentTrack, updateTrack } = usePlayerStore.getState();
    if (currentTrack && st.duration > 0 && Math.abs(currentTrack.duration - st.duration) > 1) {
      updateTrack({ ...currentTrack, duration: Math.round(st.duration) });
    }
  }

  private extrapolate(speed: number): number {
    if (!this.remote?.playing) return this.anchorPos;
    const elapsed = (performance.now() - this.anchorWall) / 1000;
    const dur = this.remote?.duration ?? 0;
    const p = this.anchorPos + elapsed * speed;
    return dur > 0 ? Math.min(p, dur) : p;
  }

  /**
   * The playhead's clock, on whichever scheduler this window can afford.
   *
   * A frame-rate loop is for surfaces that repaint at frame rate: the waveform, the
   * scrub bar, the record. While mpv owns the picture none of those are on screen —
   * the film is a native child window the compositor moves, and this renderer is
   * asked to paint nothing. Running a 60 Hz loop anyway was therefore pure cost, on
   * the two cores that the film's own compositing also wants, and "the video still
   * lags a bit" survived every change made to the decoder (measured: `hwdec-current`
   * is `d3d11va`, so it was never the decode). A quarter-second tick is more than
   * the mm:ss readout needs and leaves the frames to the picture.
   */
  private startPositionLoop(): void {
    if (this.posLoop) return;
    this.posLoop = true;
    const tick = (now: number) => {
      if (!this.posLoop) return;
      const time = this.getRenderPosition();
      /*
       * The store only needs to be smooth enough for text and lyrics. It
       * re-rendered the whole tree every frame, which starved the main thread
       * exactly when scrubbing needed it most; per-frame surfaces read the engine
       * directly instead (see WaveformProgress).
       */
      if (now - this.lastPublished > 100 && Math.abs(time - this.lastPublishedPos) > 0.01) {
        this.lastPublished = now;
        this.lastPublishedPos = time;
        this.publishPosition(time);
      }
      this.schedulePosTick(tick);
    };
    this.schedulePosTick(tick);
  }

  private schedulePosTick(tick: (now: number) => void): void {
    if (this.onVideo) {
      this.posTimer = window.setTimeout(() => {
        this.posTimer = null;
        tick(performance.now());
      }, 240);
    } else {
      this.posRaf = requestAnimationFrame((now) => {
        this.posRaf = null;
        tick(now);
      });
    }
  }

  /**
   * Watch the playhead without going through the store.
   *
   * A second or two of playback moves a number in the global state a few times a
   * second, and every one of those writes cost the app ~700 ms before the next
   * frame was painted: React had to reconcile the whole library tree to reach the
   * few subscribers whose value had actually changed, and it did that work in
   * slices small enough never to register as a long task. Measured, live: 5.2 fps
   * with the writes and 60.0 fps with only those writes suppressed. So the
   * playhead now goes to the handful of surfaces that display it, and nothing
   * else is disturbed.
   */
  onPosition(fn: (seconds: number) => void): () => void {
    this.posListeners.add(fn);
    fn(this.getPosition());
    return () => {
      this.posListeners.delete(fn);
    };
  }

  private publishPosition(seconds: number): void {
    for (const fn of this.posListeners) fn(seconds);
  }

  private stopPositionLoop(): void {
    this.posLoop = false;
    if (this.posRaf !== null) {
      cancelAnimationFrame(this.posRaf);
      this.posRaf = null;
    }
    if (this.posTimer !== null) {
      window.clearTimeout(this.posTimer);
      this.posTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // Which engine owns this track
  // ------------------------------------------------------------------

  /**
   * Whether this window's own `<video>` should be the thing that draws a film.
   *
   * Two answers used to be one question. Chromium decodes an mp4 happily, and the
   * liquid-glass shader can only bend a picture that is an element in its scene —
   * so while the shader is up, the page's element is not a fallback, it *is* the
   * feature: a glass panel over a film refracts the film.
   *
   * When the shader is not up there is no scene to sample and the element becomes
   * pure cost. The renderer then composites the picture itself, on the two cores
   * that are also painting the interface, and that is the lag which survived every
   * change made to the decoder: measured against the user's own lecture file,
   * `hwdec-current` is `d3d11va` and the container is 1918x1078 H.264 at 30 fps, so
   * mpv was never the bottleneck. Out of the shader's way the film goes to mpv's
   * native picture, which the compositor moves without asking this renderer for a
   * single frame.
   *
   * Containers Chromium refuses never take the element path at all, and a file it
   * has already failed on is not asked twice.
   */
  private get filmWantsElement(): boolean {
    return !IS_OVERLAY_WINDOW;
  }

  private isVideoTrack(track: Track): boolean {
    return track.kind === 'video'
      && !this.inPageFailed.has(track.path)
      && !this.filmOnOverlay
      && this.filmWantsElement;
  }

  /**
   * Whether a film belongs to the card's native picture rather than to this page.
   *
   * Asked by three places that must never disagree — which engine `load` picks,
   * whether the library reserves a rectangle for a window it is not drawing, and
   * whether the placement loop is allowed to speak at all — so it is one answer
   * read three times rather than three questions.
   *
   * Gated on the deck being *able* to draw it, not just on the card being up:
   * without the Win32 bindings (`koffi` is an optional dependency) there is no
   * native window to move, and a film handed to mpv then is a film with sound and
   * no picture anywhere. Falling back to the page's element costs the second
   * decoder this exists to remove, which is still cheaper than losing the film.
   *
   * The library's own fullscreen takeover opts out, and it is the one case where
   * the card is up and the user is nonetheless looking at this window: they asked
   * the film to fill it, and taking the picture away to hand it to a card they did
   * not ask about is the bug, not the fix. That is the same condition
   * `VideoStage` already uses to decide which of the two surfaces shows the still.
   */
  private get filmOnOverlay(): boolean {
    if (IS_OVERLAY_WINDOW || !this.nativePicture) return false;
    const st = usePlayerStore.getState();
    return st.overlayRole === 'mini' && !st.videoFullscreen;
  }

  /**
   * Whether main can put mpv's native window on screen at all.
   *
   * Read off the deck's own report rather than assumed, and false until that
   * report arrives: the safe default is the page's element, which has never needed
   * anything installed.
   */
  private nativePicture = false;

  /**
   * Re-decide the route when a card arrives over — or leaves — a film already playing.
   *
   * `isVideoTrack` reads `filmOnOverlay`, and putting a card on screen does not call
   * `load`: the film is mid-scene, the track has not changed, and nothing else in the
   * app ever asks the question again. Without this the whole of the second-decoder
   * fix would apply only to films started *after* the card was already up, which is
   * the rarer half and the one the user was complaining about.
   *
   * Re-entering `load` is the same move `onVideoDecodeError` already makes for the
   * other direction, for the same reason: the branch is chosen at the top of that
   * function and there is no narrower door into it.
   */
  private armRouteWatch(): void {
    if (IS_OVERLAY_WINDOW) return;
    let last = this.filmOnOverlay;
    usePlayerStore.subscribe((s) => {
      /*
       * Derived from the one getter that decides it, not recomputed here, so the
       * store's copy of the rule and the engine's can never drift apart — the two
       * asking different questions is how a film ends up decoded by both windows.
       */
      const next = this.filmOnOverlay;
      if (next === last) return;
      last = next;
      const track = s.currentTrack;
      if (!track || track.kind !== 'video') return;
      /*
       * A file the element already refused is on the deck whatever the card is doing,
       * so the answer did not actually move and a reload would only restart it.
       */
      if (this.inPageFailed.has(track.path)) return;
      void this.load({ ...track }, s.isPlaying);
    });
  }

  /**
   * Fall back to the embedded deck after the element refused a file.
   *
   * Re-entering `load` is enough to move it: `isVideoTrack` now answers false for
   * this path, so the same call takes the mpv branch. The guard against a loop is
   * that `inPageFailed` is written before the retry, so a second error from the
   * mpv side cannot bounce back here.
   */
  private onVideoDecodeError(path: string): void {
    if (this.inPageFailed.has(path)) return;
    this.inPageFailed.add(path);
    const current = usePlayerStore.getState().currentTrack;
    if (current?.path !== path) return;
    usePlayerStore.setState({ playbackError: null });
    void this.load({ ...current }, !this.video.paused);
  }

  private handleEnded(sourcePath: string): void {
    if (this.endedFor === sourcePath) return;
    this.endedFor = sourcePath;
    const { repeatMode } = usePlayerStore.getState();
    if (repeatMode === 'one') {
      /*
       * Rewind the latch with the file.
       *
       * `endedFor` exists so one ending cannot advance the queue twice, and it is
       * cleared by the deck's next state report — which never arrives on this
       * branch, because a track that has run out has nothing left to report. So the
       * restart was answered once and every ending after it was discarded as a
       * duplicate. That is "repeat one repeats once". mpv now loops the file
       * itself via `loop-file` and never reports an ending at all; this is the
       * page's own element, which has no such switch and is the reason the branch
       * exists.
       */
      this.endedFor = null;
      if (this.onVideo) {
        this.video.seek(0);
        this.video.fadeEnvelope(1, FADE_IN_S);
        void this.video.play().catch(() => {});
      } else {
        void mpv()?.seek(0).then(() => mpv()?.play());
      }
      return;
    }
    const [first] = this.upcomingIndices(1);
    if (first === undefined) {
      usePlayerStore.setState({ isPlaying: false });
      this.publishPosition(0);
      if (this.onVideo) this.video.seek(0);
      return;
    }
    void this.playTrackAt(first);
  }

  // ------------------------------------------------------------------
  // Clipping guard and waveform
  // ------------------------------------------------------------------

  /**
   * Skimming through a list can load a dozen tracks in a few seconds; starting an
   * ffmpeg job for each would pile up work nobody sees. Jobs only start once a
   * track has stayed loaded for a moment.
   */
  private scheduleBackgroundAnalysis(track: Track): void {
    if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
    if (this.analysisPending !== null) {
      this.analysisPending = null;
      if (this.analysisWait !== 0) {
        window.clearInterval(this.analysisWait);
        this.analysisWait = 0;
      }
    }
    /*
     * Much longer for a film. The job is two ffmpeg decodes — `analyzeLoudness`
     * runs a parallel filter graph and `extractPeaks` decodes the entire audio
     * track to stdout — and ffmpeg.ts's own comment says the two-slot cap exists
     * because "a handful of parallel decoders is enough to starve playback of
     * CPU". Starting them 1.2s in lands them exactly on the window the user
     * reported: audio crackling and drifting out of sync with its own picture for
     * the first few seconds of every video. A film is also long, so a later start
     * costs nothing the viewer will notice.
     */
    const delay = track.kind === 'video' ? 12000 : 1200;
    this.analysisTimer = window.setTimeout(() => {
      this.analysisTimer = null;
      if (usePlayerStore.getState().currentTrack?.id !== track.id) return;
      this.runBackgroundAnalysis(track);
    }, delay);
  }

  /**
   * The two ffmpeg jobs, unless a film is still moving on screen.
   *
   * `extractPeaks` reads the file from end to end. Over a two-hour lecture that is
   * two hours' worth of audio decode competing with the page's own decoder for the
   * same two cores, which is the stutter the user sees as "the video plays at half
   * speed for a moment and then catches up". The picture is the thing the user is
   * watching, so the job waits for it to stop and runs the moment it does.
   */
  private runBackgroundAnalysis(track: Track): void {
    if (this.onVideo && !this.video.paused) {
      this.parkAnalysis(track);
      return;
    }
    void this.applyClippingGuard(track);
    void this.warmWaveform(track);
  }

  private parkAnalysis(track: Track): void {
    this.analysisPending = track;
    if (this.analysisWait !== 0) return;
    this.analysisWait = window.setInterval(() => {
      if (this.onVideo && !this.video.paused) return;
      const parked = this.analysisPending;
      this.analysisPending = null;
      window.clearInterval(this.analysisWait);
      this.analysisWait = 0;
      if (!parked || usePlayerStore.getState().currentTrack?.id !== parked.id) return;
      void this.applyClippingGuard(parked);
      void this.warmWaveform(parked);
    }, 2000);
  }

  private async applyClippingGuard(track: Track): Promise<void> {
    const guardOn = usePlayerStore.getState().clipGuard !== false;
    if (!guardOn) {
      this.setTrim(0);
      return;
    }
    const cached = this.gainCache.get(track.id);
    if (cached !== undefined) {
      this.setTrim(cached);
      return;
    }
    this.setTrim(0);
    const api = window.electronAPI;
    if (!api?.analyzeMedia) return;
    try {
      const analysis = await api.analyzeMedia(track.path, track.duration || 0);
      if (!analysis) return;
      this.gainCache.set(track.id, analysis.gainDb);
      if (usePlayerStore.getState().currentTrack?.id !== track.id) return;
      this.setTrim(analysis.gainDb);
    } catch {
      /* the guard falls back to the limiter alone */
    }
  }

  private setTrim(db: number): void {
    if (this.onVideo) {
      this.video.setGuard(usePlayerStore.getState().clipGuard !== false, db);
      return;
    }
    // A widget mirroring someone else's film has no stream to trim, and the deck
    // it would otherwise write to is playing a different track entirely.
    if (this.filmRemote) return;
    void mpv()?.trim(db);
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * The UI calls this with whatever element should show the picture. Two very
   * different things can live there: the `<video>` we own for containers
   * Chromium decodes, or *nothing* — mpv's embedded window sits behind the page,
   * so for those the host's only job is to say where the hole should be.
   */
  mount(container: HTMLElement | null): void {
    this.slotHost = container;
    /*
     * A different element knows nothing about the last one, so the edge this is
     * gated on has to be forgotten with it. `VideoStage` remounts its host whenever
     * a film comes and goes, and a latch held across that left the next card with
     * its poster painted straight over the film.
     */
    this.nativeStageApplied = false;
    if (this.onVideo || this.mirrorPath) this.video.mount(container);
    this.watchSlot();
  }

  private slotHost: HTMLElement | null = null;
  private slotFrame = 0;
  private slotLast = '';
  /**
   * Whether main has moved mpv's native film picture into *this* window.
   *
   * Told rather than worked out. Every signal the card could read for itself — the
   * film relay, `videoInPage`, whether a mirror is running — goes absent at exactly
   * the moment the picture arrives, and "the film is mpv-routed" was already the
   * description of a card showing a poster instead. Only main knows which of the two
   * it is, and it is the only one that can say so without a round trip.
   */
  private filmNativeHere = false;
  /** The last value `applyNativeStage` wrote, so the loop does not repaint per frame. */
  private nativeStageApplied = false;

  /**
   * Take the card's own stage off the picture while mpv draws behind the page.
   *
   * Written inline and with `!important` on purpose. The stylesheet's
   * `.mini-overlay.video-mini .video-stage` outranks `.is-embedded` — the class this
   * loop already toggles for the library window — and it is the rule that paints the
   * still there, so the class alone cannot undo it. Restating the rule is not an
   * option either: that declaration is what a card with *no* picture shows through,
   * and the takeover depends on the same file.
   *
   * Only the stage goes. The card's scrub bar and transport row are siblings in a
   * layer *above* this box and have to stay, or the widget cannot be driven at all;
   * and the mini window renders no tint layer and no backdrop canvas — `App.tsx`
   * refuses both to an overlay — which is the whole reason the picture can sit at the
   * bottom of the z-order here when it cannot in the library.
   */
  private applyNativeStage(): void {
    const host = this.slotHost;
    if (!host) return;
    const on = this.filmNativeHere;
    if (on === this.nativeStageApplied) return;
    this.nativeStageApplied = on;
    if (on) host.style.setProperty('background', 'transparent', 'important');
    else host.style.removeProperty('background');
  }
  /**
   * The film's own width/height ratio, read once per file from the deck.
   *
   * mpv fits the picture into whatever window it is handed and paints the rest
   * black, so a 16:9 lecture in a 2.3:1 slot arrives with bars down the sides
   * that belong to mpv, not to the app. Reporting a slot that already has the
   * video's ratio removes them, and lets the picture take every pixel of height
   * the strip leaves it.
   */
  private slotAspect = 0;
  private slotAspectFor: string | null = null;

  /** True while mpv's own window is the picture rather than the media element. */
  private get embeddedVideo(): boolean {
    /*
     * Two ways this window is not the surface holding the picture.
     *
     * A widget never is: mpv's native window is parented to whichever window main
     * put it in, and a rectangle reported by a window that is not that one is not a
     * placement — it is the picture moving to the wrong coordinates inside the
     * library, which is the black slab over the sidebar. The card's own rectangle is
     * computed in main from its bounds, because the card *is* the picture and needs
     * no measurement to say so.
     *
     * And neither is the library while the card is showing a film: the picture has
     * gone over there, and this window's job is the still it already paints.
     */
    if (this.onVideo || this.filmOnOverlay || IS_OVERLAY_WINDOW) return false;
    const st = this.remote;
    if (!st?.hasVideo) return false;
    /*
     * And only while that report is about the track on screen. mpv keeps the file
     * it last held even after an in-page element takes a film over, so a stale
     * `hasVideo` reserved a slot for a picture that no longer exists: a black card
     * in the corner of the library while the real film plays in the widget.
     */
    const cur = usePlayerStore.getState().currentTrack;
    return !!cur && cur.kind === 'video' && sameFile(st.path ?? '', cur.path);
  }

  /**
   * How much of the slot's foot belongs to the control strip rather than to the
   * picture, given the strip that is actually on screen right now.
   *
   * Measured from the pill rather than read from a constant: the band is exactly
   * the distance from the top of the strip to the bottom of the slot, so the
   * picture can never be drawn behind the glass, and the strip can never be given
   * more room than it uses. Zero when there is no strip in the document at all.
   *
   * That last clause is the fix. The band used to be a flat 132 CSS px subtracted
   * from every slot, including the *docked* one, where no pill exists because it
   * only renders in the takeover. A 16:9 lecture then got a 524x162 window — a
   * 3.2:1 box — and mpv letterboxed it, which is the black bars down the sides and
   * the picture nowhere near the bottom of the card it sits in.
   */
  private hudBand(slot: DOMRect): number {
    const el = document.querySelector<HTMLElement>('.video-pill');
    if (!el) return 0;
    /*
     * Liveness, not just geometry.
     *
     * The strip leaves the takeover on a 0.32s fade, and a `getBoundingClientRect`
     * taken during it still returns the box it is vacating. Subtracting that band
     * from the freshly-docked slot gave mpv a window `band` pixels shorter than
     * the card it sits in — the picture cropped along the foot and offset, which
     * is what "going back from fullscreen leaves the video disoriented" was.
     */
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return 0;
    const pill = el.getBoundingClientRect();
    if (pill.height <= 0 || pill.width <= 0) return 0;
    // A strip that is not over the picture takes no room out of it.
    if (pill.top >= slot.bottom || pill.bottom <= slot.top) return 0;
    return Math.max(0, Math.ceil(slot.bottom - pill.top) + 8);
  }

  /**
   * Keep the main process told where the embedded picture goes.
   *
   * A ResizeObserver is not enough on its own: the docked stage *glides* into
   * the takeover by animating left and top, and an element that moves without
   * resizing never fires one. Reading a single bounding box per frame and sending
   * only when it changed costs nothing while the layout is still, which is most
   * of a song. If this loop ever stalls — the window is hidden, so rAF is frozen —
   * the last placement simply holds, and turning video off destroys the child
   * window from the main process regardless.
   */
  /**
   * mpv's own picture dimensions, for the surfaces that have to take the film's
   * shape before they see a frame of it — the mini player's rectangle is sized
   * from this ratio.
   *
   * Asked for rather than carried per track because mpv only knows once its
   * demuxer has the file open, which can be a beat after `load` returned; the
   * retries cover that beat. `hasVideo` flipping is the other moment it becomes
   * knowable, and it re-asks there too.
   */
  private publishMpvSize(): void {
    const token = this.loadToken;
    const ask = (tries: number): void => {
      void window.electronAPI?.mpv
        ?.rawProps(['dwidth', 'dheight'])
        .then((p) => {
          if (this.loadToken !== token || this.onVideo) return;
          const w = Number(p.dwidth);
          const h = Number(p.dheight);
          if (w > 0 && h > 0) {
            usePlayerStore.setState({ videoNatural: { w, h } });
            return;
          }
          if (tries > 0) window.setTimeout(() => ask(tries - 1), 400);
        })
        .catch(() => {});
    };
    ask(4);
  }

  private watchSlot(): void {
    const api = window.electronAPI?.video;
    if (this.slotFrame) {
      cancelAnimationFrame(this.slotFrame);
      this.slotFrame = 0;
    }
    const step = () => {
      this.slotFrame = 0;
      /*
       * The stage is normally a black card. Over an embedded picture it has to be
       * nothing at all — the page is the only thing between the viewer and mpv's
       * window, so any pixel this box paints hides the video. Its rounded corners
       * go for the same reason: a CSS radius cannot clip a child window, and a
       * square of video with rounded corners drawn around it is worse than a
       * square of video.
       *
       * Applied per frame rather than once at mount, because "who is drawing the
       * picture" is not settled when the host mounts: `remote.hasVideo` arrives
       * with the deck's own `file-loaded`, which is after the effect that called
       * `mount()` has already run. Toggling it only there left the flag stuck at
       * its mount-time value for the whole song.
       */
      this.slotHost?.classList.toggle('is-embedded', this.embeddedVideo);
      /*
       * The card's half of the same arrangement, and it cannot use the class.
       *
       * With mpv drawing behind the page there, this window's stage is the only
       * opaque thing sitting exactly over the film — it carries `#000` plus the
       * still, which is what a card with no picture of its own needs — so it has to
       * stop painting, or the film is a poster with sound.
       */
      if (IS_OVERLAY_WINDOW) this.applyNativeStage();
      /*
       * And the loop goes quiet while the card holds the picture.
       *
       * Not because there is nothing to say but because anything it said would be
       * wrong: the rectangle is measured against this window's client area and main
       * would apply it to a native window living in a different one. Silence is also
       * the right message — `setSlot(null)` *hides* the picture, which is what
       * dropping the placement would do to the film the card is showing.
       */
      if (this.filmOnOverlay) {
        this.slotFrame = requestAnimationFrame(step);
        return;
      }
      /*
       * And the loop never ends.
       *
       * It used to `return` without asking for another frame the first time it saw
       * no embedded picture — which happens on every Chromium-decodable video,
       * because the media element draws those until the takeover forces the native
       * path. Nothing restarted it, so mpv's child window kept whatever placement
       * it last had: a full-window native surface sitting *above* the page,
       * swallowing every pointer event, which made the video controls unreachable.
       */
      if (!api || !this.embeddedVideo || !this.slotHost) {
        if (this.slotLast) {
          this.slotLast = '';
          api?.setSlot(null);
        }
        this.slotFrame = requestAnimationFrame(step);
        return;
      }
      const r = this.slotHost.getBoundingClientRect();
      /*
       * A stage with no box has nothing to draw. `VideoStage` clears its rect
       * when the page in front has no `.video-slot` — Home does not reserve one
       * any more — and the host collapses with it. Placing a 0×0 window would
       * leave whatever mpv had last on screen, so this is the point where the
       * picture is actually given back.
       */
      if (r.width < 2 || r.height < 2) {
        if (this.slotLast) {
          this.slotLast = '';
          api.setSlot(null);
        }
        this.slotFrame = requestAnimationFrame(step);
        return;
      }
      /*
       * Two placements, chosen by the view.
       *
       * While the fullscreen video takeover is up the page has nothing it wants
       * to keep over the film, so `VideoStage` marks the root `video-under` and
       * hides the layers that would otherwise cover the picture — and mpv can then
       * sit *below* the page, which is the only way a control in the page can be
       * drawn on top of it. In that state the strip needs no band cut out of the
       * picture, so the film gets every pixel of height the window has.
       *
       * Docked, the card is inside the library the user is browsing, those layers
       * cannot come off, and mpv stays above the page — which is why the strip
       * still gets a band there. `hudBand` measures the pill, and there is none
       * docked, so the band is zero either way.
       */
      const under = !!this.slotHost.classList.contains('is-full')
        && !!document.querySelector('.app-root.video-under');
      const band = under || !this.slotHost.classList.contains('is-embedded') ? 0 : this.hudBand(r);
      const path = this.remote?.path ?? null;
      if (this.slotAspectFor !== path) {
        this.slotAspectFor = path;
        this.slotAspect = 0;
        void window.electronAPI?.mpv
          ?.rawProps(['dwidth', 'dheight'])
          .then((p) => {
            const w = Number(p.dwidth);
            const h = Number(p.dheight);
            if (w > 0 && h > 0) this.slotAspect = w / h;
            this.slotLast = '';
          })
          .catch(() => {});
      }
      const avail = { x: r.left, y: r.top, w: r.width, h: Math.max(48, r.height - band) };
      /*
       * The largest box of the film's own ratio that fits what is left. Handed to
       * mpv instead of the raw slot, the native window *is* the picture: nothing
       * of it is letterboxed, and the space around it is the app's, not a black
       * band mpv painted.
       */
      let box = avail;
      if (this.slotAspect > 0) {
        const w = Math.min(avail.w, avail.h * this.slotAspect);
        box = { x: avail.x + (avail.w - w) / 2, y: avail.y + (avail.h - w / this.slotAspect) / 2, w, h: w / this.slotAspect };
      }
      const key = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)},${under ? 'u' : 't'}`;
      if (key !== this.slotLast) {
        this.slotLast = key;
        api.setSlot({ ...box, under });
      }
      this.slotFrame = requestAnimationFrame(step);
    };
    this.slotFrame = requestAnimationFrame(step);
  }

  getQueue(): Track[] {
    return this.queue;
  }

  /* ── One session, four windows ────────────────────────────────────────── */

  /**
   * Say out loud what this window believes the play order is.
   *
   * The pill and the mini card are control surfaces on the single deck in the
   * main process, not players of their own. They used to keep a private queue
   * seeded from whatever a hand-off happened to carry, so pressing Next in a
   * widget advanced *that* list — often straight back onto the song already
   * playing. Ids travel, never tracks: every window has its own scan of the same
   * library, and a few hundred cover images have no business on an IPC channel.
   */
  publishSession(): void {
    if (this.applyingRemote || this.queue.length === 0) return;
    const s = usePlayerStore.getState();
    void window.electronAPI?.mpv?.setSession?.({
      ids: this.queue.map((t) => t.id),
      index: this.index,
      shuffle: s.shuffle,
      seed: s.shuffleSeed,
      repeat: s.repeatMode,
    });
  }

  /**
   * Adopt another window's session. Deliberately does not touch the deck: the
   * publisher already moved it, and loading again here is what made a widget
   * restart the track. The shuffle order is not sent — it is a pure function of
   * the queue length and the seed, so both windows derive the same one.
   */
  applySession(next: PlaySession): void {
    const s = usePlayerStore.getState();
    const byId = new Map(s.library.map((t) => [t.id, t] as const));
    const mapped = next.ids.map((id) => byId.get(id));
    // A window still scanning its library cannot resolve the ids yet; its own
    // scan finishing, or the next publish, brings it in line.
    const tracks = mapped.filter((t): t is Track => !!t);
    if (tracks.length !== mapped.length) return;
    const same =
      tracks.length === this.queue.length
      && next.index === this.index
      && tracks.every((t, i) => t.id === this.queue[i]?.id)
      && s.shuffle === next.shuffle
      && s.shuffleSeed === next.seed
      && s.repeatMode === next.repeat;
    if (same) return;
    this.applyingRemote = true;
    try {
      /*
       * The session travels as ids, so every track here is this window's own scan
       * copy — including the one now playing, which may already carry a lyric set
       * this window fetched or received. Replacing it with the bare scan entry is
       * what wiped the words out from under the renderer that was showing them.
       */
      const keepLyrics = (t: Track): Track => carryLyrics(t, s.currentTrack);
      const withLyrics = tracks.map(keepLyrics);
      this.queue = withLyrics;
      this.shuffleOrder = [];
      // The other window is describing its own walk; a window that had arranged
      // rows by hand is being told to follow someone else's order instead.
      this.pinnedUpcoming = [];
      this.index = Math.max(0, Math.min(next.index, withLyrics.length - 1));
      usePlayerStore.setState({
        queue: this.queue,
        currentIndex: this.index,
        shuffle: next.shuffle,
        shuffleSeed: next.seed,
        repeatMode: next.repeat,
        currentTrack: withLyrics[this.index] ?? s.currentTrack,
      });
      this.syncFilmSurface(withLyrics[this.index] ?? s.currentTrack ?? null);
      this.fillCurrentCover(withLyrics[this.index]);
    } finally {
      this.applyingRemote = false;
    }
  }

  /**
   * Give this window the cover of the row it is showing.
   *
   * No store row is handed the library's artwork any more — 56 KB of base64 per
   * track is a memory bill for the handful of tiles that are on screen — which
   * leaves the record that is *sounding* as the one cover the store has to carry. It
   * is not only the disc's picture: the mini card and the pill take their art from
   * here, so does the fullscreen takeover and the vinyl behind it, the pill's tint
   * samples it, the waveform's accent reads it off the row it found by id, and the
   * shell's media-session artwork is built from it. The interface's own colour is not
   * one of them — `--art-rgb` in the library window samples the backdrop, not the
   * cover — so this is the whole list of what would otherwise go blank.
   *
   * So the playing file's cover is fetched here, from the same bounded cache the
   * list tiles use (one read per file, whichever surface needed it first), and it
   * lands on `currentTrack` *and* on the row it came from. The row matters twice
   * over: `WaveformProgress` resolves a track by id out of the library rather than
   * taking the playing record, and the next scan publishes rows built from the
   * parsed cache, which strips it — `publish` in `useLibrary` is what carries this
   * one cover across a re-scan.
   *
   * The import is dynamic on purpose. `utils/metadata` reaches into this module for
   * `toMediaUrl`, and a static import here would close the loop.
   */
  private fillCurrentCover(track: Track | null | undefined): void {
    if (!track || track.albumArt) return;
    const path = track.path;
    void import('../utils/metadata')
      .then(({ coverFor }) => coverFor(path, 512))
      .then((url) => {
        if (!url) return;
        const s = usePlayerStore.getState();
        /** The row, filled; every other row keeps its identity so the list does not rebuild. */
        const withCover = (rows: Track[]): Track[] =>
          rows.some((t) => !t.albumArt && sameFile(t.path, path))
            ? rows.map((t) => (!t.albumArt && sameFile(t.path, path) ? { ...t, albumArt: url } : t))
            : rows;
        /*
         * A read that lands after the deck moved on is still the right answer for
         * the row it was asked about, so the rows are filled either way and only
         * `currentTrack` is guarded. It used to be the only thing written, which
         * made a cover that arrived during a fast two-track skip simply vanish.
         */
        const playing = s.currentTrack;
        usePlayerStore.setState({
          ...(playing && sameFile(playing.path, path) && !playing.albumArt
            ? { currentTrack: { ...playing, albumArt: url } }
            : null),
          library: withCover(s.library),
          queue: withCover(s.queue),
        });
      })
      .catch(() => {
        // No cover is the default tile, which is what the row already shows.
      });
  }

  /** Subscribe, and pull whatever the deck is already doing. */
  /**
   * Follow the deck's mixer for the rest of this window's life.
   *
   * The mirror of `startSessionSync` for the settings that are not the queue. A
   * session broadcast already kept all three windows on one play order, but speed,
   * pitch, volume and the guard were written straight to mpv and never announced,
   * so each window's zustand copy drifted from the deck and from its siblings.
   */
  private armMixSync(): void {
    window.electronAPI?.mpv?.onMix?.((mix) => this.applyMix(mix));
  }

  /* ── The film, across windows ─────────────────────────────────────────────── */

  /** Ask the window that owns the film to move it. */
  private sendFilm(cmd: FilmCommand): void {
    window.electronAPI?.film?.command(cmd);
  }

  /**
   * Wire up whichever half of the relay this window is.
   *
   * The library answers commands and announces readings; a widget does the
   * opposite. Both halves sit behind the same window-role test so neither can
   * answer the other's broadcast to itself, which is how a mirror loop and a
   * self-inflicted `pause` were produced the last time this was event-driven.
   */
  private armFilmRelay(): void {
    if (IS_OVERLAY_WINDOW) {
      window.electronAPI?.film?.onState?.((state) => this.applyFilmState(state as FilmState));
      /*
       * The card's other owner: main, saying that the film's picture is now being
       * drawn by mpv *into this window*. Everything the relay is for stops existing
       * at that moment, and nothing here can see it happen any other way.
       */
      window.electronAPI?.overlay?.onPicture?.((native) => this.applyNativePicture(native));
      /*
       * Silence is an answer too. The library stops publishing the instant a film
       * goes to mpv, and a mirror left running would play the widget's own copy of
       * the file on its own clock — soundless, but a picture drifting away from the
       * audio underneath it. Two intervals' worth of nothing means the owner is no
       * longer decoding this in a page element.
       */
      window.setInterval(() => {
        if (!this.mirrorPath || !this.filmSeen) return;
        if (Date.now() - this.filmSeen > 1200) this.dropFilmMirror();
      }, 500);
      return;
    }
    window.electronAPI?.film?.onCommand?.((cmd) => void this.applyFilmCommand(cmd as FilmCommand));
  }

  /**
   * Adopt or release the native picture main has just moved into this window.
   *
   * Two things follow, and both are the reason the signal is pushed instead of
   * inferred.
   *
   * The mirror goes: it exists to keep up with readings this window can no longer
   * receive, and mounting it against the same file mpv is already decoding one
   * window over is the second decoder all of this was written to remove.
   *
   * And the deck starts being believed. While the library owns the film in a page
   * element the deck is parked on whatever song played before it, so
   * `filmRemote` exists to stop a widget reading `playing: false` off it and
   * freezing its own transport. Once the picture is here, the deck *is* the film —
   * its position, its duration, and the `dwidth`/`dheight` the card needs in order
   * to ask for a window shaped like the picture rather than like a square.
   */
  private applyNativePicture(native: boolean): void {
    if (this.filmNativeHere === native) return;
    this.filmNativeHere = native;
    if (native) {
      this.filmRemote = false;
      this.dropFilmMirror();
    } else {
      const cur = usePlayerStore.getState().currentTrack;
      this.filmRemote = cur?.kind === 'video';
    }
    this.applyNativeStage();
    /*
     * Re-armed rather than left to whatever was running: the loop is what applies
     * the stage, and a card that came up on a song has not started one yet.
     */
    this.watchSlot();
  }

  /**
   * The library's side of the relay: one reading of the element, four a second.
   *
   * A timer rather than the element's own events, because the only event that
   * matters — `timeupdate` — fires four times a second already and says nothing
   * about a seek, a pause, or the picture's size arriving late. The interval is
   * started and stopped with the element, so a window playing music never pays for
   * it and a widget with no film open hears nothing.
   */
  private filmPublisher = 0;
  private startFilmPublisher(): void {
    if (this.filmPublisher) return;
    this.filmPublisher = window.setInterval(() => this.publishFilmState(), 250);
  }

  private stopFilmPublisher(): void {
    if (!this.filmPublisher) return;
    window.clearInterval(this.filmPublisher);
    this.filmPublisher = 0;
    /*
     * The publisher is the only thing that ever said "the element is running", so
     * leaving it must say the opposite. Without this a film that ends hands the
     * transport keys back to the deck and then stops reporting, and the app is left
     * holding the keys against a page that went silent minutes ago.
     */
    window.electronAPI?.film?.reportPlaying(false);
  }

  /**
   * Put the film down.
   *
   * The fade is not decoration: pausing a media element at full envelope is an
   * audible click, and this path runs while the user is somewhere else entirely —
   * they pressed play on a song in the mini player and this window is tidying up
   * behind them.
   */
  private releaseFilm(): void {
    this.onVideo = false;
    this.filmPath = null;
    this.stopFilmPublisher();
    this.video.fadeOutPause();
    this.video.unmount();
    // Same deferred teardown as the skip-to-song path: a widget took the deck over,
    // so this window's graph is idle and goes once the fade it just armed has run.
    this.video.scheduleClose(FADE_OUT_S * 1000 + 60);
    usePlayerStore.setState({ mediaHasVideo: false, videoInPage: false, videoNatural: null });
  }

  private publishFilmState(): void {
    if (IS_OVERLAY_WINDOW || !this.onVideo) return;
    const s = usePlayerStore.getState();
    const size = this.video.videoSize;
    window.electronAPI?.film?.report({
      path: s.currentTrack?.path ?? null,
      pos: this.video.currentTime,
      duration: this.video.duration || s.currentTrack?.duration || 0,
      playing: !this.video.element.paused,
      hasVideo: true,
      inPage: true,
      rate: this.video.element.playbackRate || 1,
      vw: size.w,
      vh: size.h,
      at: Date.now(),
    } satisfies FilmState);
    window.electronAPI?.film?.reportPlaying(!this.video.element.paused);
  }

  /** Adopt the owner's reading as this window's deck state, and copy its picture. */
  private applyFilmState(f: FilmState): void {
    if (!IS_OVERLAY_WINDOW) return;
    /*
     * Nobody is decoding this in a page element any more, so nobody has readings
     * worth adopting — a message that arrives while the native picture is in this
     * window is one that was in flight when the library handed the film over.
     * Believing it would re-mount the mirror and put a second decoder back exactly
     * where this file just spent its time removing one.
     */
    if (this.filmNativeHere) return;
    const cur = usePlayerStore.getState().currentTrack;
    /*
     * A reading about a film this window has already moved on from is not a
     * reading about anything. The library keeps publishing for a beat after a
     * skip, and taking it at face value slid the widget's playhead back onto the
     * previous track.
     */
    if (!cur || !f.path || !sameFile(cur.path, f.path)) return;
    this.filmSeen = Date.now();
    this.applyState({
      pos: f.pos,
      duration: f.duration,
      playing: f.playing,
      paused: !f.playing,
      path: f.path,
      error: null,
      hasVideo: f.hasVideo,
      at: f.at,
    }, 'film');
    if (f.vw > 0 && f.vh > 0) {
      const v = usePlayerStore.getState().videoNatural;
      if (!v || v.w !== f.vw || v.h !== f.vh) {
        usePlayerStore.setState({ videoNatural: { w: f.vw, h: f.vh } });
      }
    }
    if (f.inPage) this.followFilm(f);
    else this.dropFilmMirror();
  }

  /**
   * The wall-clock stamp of the last reading that matched what is on screen.
   *
   * Zero means "never". A mirror has to be re-fed constantly or it drifts away from
   * the audio it is standing under, so two intervals' worth of nothing drops it —
   * which is the card back on its poster, unless main has meanwhile said the picture
   * is drawn here by mpv, in which case there was never a mirror to lose.
   */
  private filmSeen = 0;
  private mirrorPath: string | null = null;
  /**
   * The film the last `publishMpvSize()` was for, so one file ending and another
   * beginning asks again instead of reusing the previous card's shape.
   */
  private sizedFor: string | null = null;

  /**
   * Point this window's own muted element at the same film and keep it honest.
   *
   * The correction is a seek, not a rate nudge. A mirror that is a third of a
   * second out on a lecture is the user's "as if the miniplayer is just mirroring
   * the fullscreen mode" broken in the one way that shows — lips out of step with
   * the card beside them — and a seek is invisible against a picture that is
   * already moving. Under the threshold nothing is touched, so a steady stream of
   * readings cannot stutter the playback.
   */
  private followFilm(f: FilmState): void {
    const cur = usePlayerStore.getState().currentTrack;
    if (!cur) return;
    const url = cur.mediaUrl || toMediaUrl(cur.path);
    if (this.mirrorPath !== url) {
      this.mirrorPath = url;
      this.video.setMirror(true);
      this.video.mount(this.slotHost);
      void this.video.load(url, f.rate || 1, getCachedPoster(cur.path)).catch(() => undefined);
      usePlayerStore.setState({ videoInPage: true });
    }
    const lead = Math.max(0, (Date.now() - f.at) / 1000);
    const want = f.pos + (f.playing ? lead * (f.rate || 1) : 0);
    const el = this.video.element;
    if (Number.isFinite(want) && Math.abs(el.currentTime - want) > 0.34) this.video.seek(want);
    if (Math.abs((el.playbackRate || 1) - (f.rate || 1)) > 0.01) {
      el.defaultPlaybackRate = f.rate || 1;
      el.playbackRate = f.rate || 1;
    }
    if (f.playing && el.paused) void el.play().catch(() => undefined);
    if (!f.playing && !el.paused) el.pause();
  }

  /** Put the copied picture down; the poster takes over from here. */
  private dropFilmMirror(): void {
    if (!this.mirrorPath) return;
    this.mirrorPath = null;
    this.video.pause();
    this.video.unmount();
    this.video.setMirror(false);
    usePlayerStore.setState({ videoInPage: false });
  }

  /**
   * Which surface a widget should be showing for the track it just learned about.
   *
   * The queue can move between a film and a song without this window being asked
   * to load anything — the library advances on its own and broadcasts the new
   * order — so the form is derived from the track rather than from the call that
   * would have set it. Without this the mini keeps its video rectangle around a
   * ballad, and keeps it silent around a film.
   */
  private syncFilmSurface(track: Track | null): void {
    if (!IS_OVERLAY_WINDOW) return;
    const isFilm = track?.kind === 'video';
    /*
     * Whether the deck is worth believing about this film. True when somebody else
     * is decoding it in a page element and this window's readings come from the
     * relay instead; false the moment main says the picture is being drawn here by
     * mpv, because then the deck is the film and there is nobody left to report.
     */
    this.filmRemote = isFilm && !this.filmNativeHere;
    // A new track invalidates whatever reading was keeping the mirror alive, so
    // the card starts on its poster and only shows a picture once either the
    // library says it is decoding this one in a `<video>`, or main says it has put
    // the native window inside this one.
    this.filmSeen = 0;
    this.dropFilmMirror();
    usePlayerStore.setState({
      mediaHasVideo: isFilm,
      videoInPage: false,
      ...(isFilm ? {} : { videoNatural: null }),
    });
  }

  /** Do what a widget asked, to the film this window is decoding. */
  private async applyFilmCommand(cmd: FilmCommand): Promise<void> {
    if (IS_OVERLAY_WINDOW) return;
    const s = usePlayerStore.getState();
    if (cmd.type === 'load') {
      const track =
        s.queue.find((t) => sameFile(t.path, cmd.path))
        ?? s.library.find((t) => sameFile(t.path, cmd.path));
      /*
       * `onFilm`, not `onVideo`: the question is whether this window is already
       * playing that file, not whether its own element is the thing drawing it.
       * Asked against the element, every widget adopting a film the deck had been
       * showing for a minute — which is the normal case now that a card takes them —
       * got its `load` obeyed, and mpv opened the same file again from the first
       * second. The one symptom this whole relay was written to avoid.
       */
      if (!track || s.currentTrack && sameFile(s.currentTrack.path, cmd.path) && this.onFilm) return;
      await this.load(track, cmd.autoplay);
      return;
    }
    if (!this.onVideo) return;
    if (cmd.type === 'play') {
      if (this.video.element.paused) void this.togglePlay();
    } else if (cmd.type === 'pause') {
      if (!this.video.element.paused) this.pause();
    } else if (cmd.type === 'seek') {
      this.seek(cmd.to);
    }
  }

  /**
   * Adopt a mixer reading without sending it back to the deck.
   *
   * Deliberately written through `setState` rather than the store's own
   * `setVolume` / `setSpeed` actions: those call the engine, the engine calls mpv,
   * and mpv broadcasts the change straight back here — a loop that terminates only
   * because the values happen to agree, and which costs a round trip per window
   * per control on every drag. The element path is per-window, so the deck's
   * numbers still have to be re-applied to it locally.
   */
  private applyMix(mix: MixState): void {
    const s = usePlayerStore.getState();
    const patch: Record<string, unknown> = {};
    if (Math.abs(s.volume - mix.volume) > 0.0005) patch.volume = mix.volume;
    if (Math.abs(s.speed - mix.speed) > 0.0005) patch.speed = mix.speed;
    if (Math.abs(s.pitch - mix.pitch) > 0.0005) patch.pitch = mix.pitch;
    if (s.clipGuard !== mix.guard) patch.clipGuard = mix.guard;
    /*
     * The equaliser used to arrive here and be dropped on the floor. The gains were
     * in the payload and were never read into the store, and the on/off flag was
     * not in it at all — so the deck applied one curve while two panels disagreed
     * about whether to show it, which is what the user saw as "fullscreen says the
     * equalizer is on and the miniplayer says the opposite".
     *
     * Compared by content, not by reference: the store's array is replaced on every
     * write, so an identity check would never fire and every window would keep
     * whatever it booted with.
     */
    const eqChanged =
      mix.eqEnabled !== s.eq.enabled
      || mix.eq.length !== s.eq.gains.length
      || mix.eq.some((g, i) => Math.abs(g - (s.eq.gains[i] ?? 0)) > 0.001);
    if (eqChanged) patch.eq = { enabled: mix.eqEnabled, gains: [...mix.eq] };
    if (Object.keys(patch).length) usePlayerStore.setState(patch);

    this.video.setVolume(mix.volume);
    this.video.setSpeed(mix.speed);
    this.video.setPitch(mix.pitch);
    this.video.setEqGains(mix.eqEnabled ? mix.eq : mix.eq.map(() => 0));
    this.video.setGuard(mix.guard, this.gainCache.get(s.currentTrack?.id ?? '') ?? 0);
  }

  private startSessionSync(): void {
    if (this.sessionArmed) return;
    this.sessionArmed = true;
    window.electronAPI?.mpv?.onSession?.((next) => {
      this.heldSession = next;
      this.applySession(next);
    });
    void window.electronAPI?.mpv?.getSession?.().then((next) => {
      if (!next) return;
      this.heldSession = next;
      this.applySession(next);
    });
    /*
     * A cold overlay asks before it has finished scanning its own library, and an
     * unresolved id list is deliberately refused — so the first attempt usually
     * lands on nothing. Retrying when the scan grows is what makes the widget show
     * the real queue rather than an empty one; without it the pill sits on "0
     * tracks" until the next track change.
     */
    let scanned = usePlayerStore.getState().library.length;
    usePlayerStore.subscribe((s) => {
      if (s.library.length === scanned || !this.heldSession) return;
      scanned = s.library.length;
      this.applySession(this.heldSession);
    });
  }

  getIndex(): number {
    return this.index;
  }

  /**
   * Take a list as the play order, optionally stopping at a row without opening it.
   *
   * `arm` is false only for the queue the app seeds on a cold start. Loading that row
   * meant spawning mpv — 52 MB of process, plus a second one for the standby deck the
   * preload asks for — to hold a file nobody had asked to hear yet, which is how a
   * player on a two-core laptop spent 110 MB before the user pressed anything. The
   * row is *selected* instead: the shell has a current track, the list has a
   * highlighter, the Up Next panel has a walk, and the deck stays shut until the
   * first real play, which `play()` reaches through `playTrackAt`.
   */
  setQueue(tracks: Track[], index = 0, arm = true): void {
    this.queue = [...tracks];
    this.shuffleOrder = [];
    this.pinnedUpcoming = [];
    if (this.queue.length > 0) {
      this.index = Math.max(0, Math.min(index, this.queue.length - 1));
      if (arm) this.load(this.queue[this.index], false);
      else this.select(this.queue[this.index]);
    } else {
      this.index = -1;
      usePlayerStore.setState({ currentTrack: null });
      this.publishPosition(0);
    }
    usePlayerStore.setState({ queue: this.queue, currentIndex: this.index });
    this.publishSession();
  }

  /**
   * Make a row the current one without touching a deck.
   *
   * Deliberately not `syncTrackToStore`, which is where a listen is counted: seeding
   * a selection would put one play on the tally of a random song every time the app
   * opens, and the tally is the Statistics page's whole subject.
   */
  private select(track: Track): void {
    usePlayerStore.setState({ currentTrack: track, isPlaying: false });
    this.fillCurrentCover(track);
    this.publishPosition(0);
  }

  /**
   * Play a track as part of the list it came from. Clicking a song should leave
   * "up next" pointing at the rest of *that* list.
   *
   * The lists are compared row by row rather than by length. Two folders can hold
   * the same number of songs while sharing none of them, and a length check let
   * the second one keep playing the first — with shuffle on, the permutation was
   * carried over too, so the symptom was the same record coming back a song later
   * than it should have.
   */
  async playList(tracks: Track[], track: Track): Promise<void> {
    const idx = tracks.findIndex((t) => t.id === track.id);
    if (idx < 0) return this.playTrack(track);
    const same =
      this.queue.length === tracks.length && this.queue.every((t, i) => t.id === tracks[i].id);
    if (!same) {
      this.queue = [...tracks];
      this.shuffleOrder = [];
      usePlayerStore.setState({ queue: this.queue });
    }
    await this.playTrackAt(idx);
  }

  /**
   * Put a track immediately after the one that is sounding.
   *
   * The only order edit the app makes now, and it is written against whichever
   * order is actually in play — the permutation when shuffle is on, the list when
   * it is not — because "play next" means next in the sequence you are hearing, not
   * next in the sorted library. With shuffle on, the permutation is edited in place
   * so the rest of the run is untouched; with it off, the row is moved in the list
   * itself, which is the only list there is.
   */
  insertNext(track: Track): void {
    if (this.queue.length === 0) {
      this.queue = [track];
      this.shuffleOrder = [];
      this.index = 0;
      this.commitOrder();
      return;
    }

    if (this.shuffleApplies() && this.queue.length > 1) {
      this.ensureShuffleOrder();
      let qi = this.queue.findIndex((t) => t.id === track.id);
      if (qi < 0) {
        this.queue = [...this.queue, track];
        qi = this.queue.length - 1;
        this.shuffleOrder = [...this.shuffleOrder, qi];
      }
      const order = [...this.shuffleOrder];
      const at = order.indexOf(qi);
      if (at >= 0) order.splice(at, 1);
      const cur = order.indexOf(this.index);
      order.splice(cur + 1, 0, qi);
      this.shuffleOrder = order;
      this.commitOrder();
      return;
    }

    const currentId = this.queue[this.index]?.id ?? null;
    const from = this.queue.findIndex((t) => t.id === track.id);
    const next = [...this.queue];
    if (from >= 0) {
      next.splice(from, 1);
      if (from < this.index) this.index -= 1;
    }
    next.splice(this.index + 1, 0, track);
    this.queue = next;
    this.shuffleOrder = [];
    if (currentId) {
      const re = next.findIndex((t) => t.id === currentId);
      if (re >= 0) this.index = re;
    }
    this.commitOrder();
  }

  /**
   * Forget the cached permutation so the next skip draws a new one.
   *
   * `ensureShuffleOrder` only recomputes when the row count changes, which is
   * right for a rescan and exactly wrong for a shuffle toggle: the store had just
   * been given a fresh seed, but an equally long cached order meant the engine
   * never looked at it. Turning shuffle off and back on replayed the same run.
   */
  invalidateShuffle(): void {
    this.shuffleOrder = [];
    /* Turning shuffle over is the user asking for a different order, so the rows
       they arranged by hand for the old one go with it. */
    this.pinnedUpcoming = [];
  }

  private syncTrackToStore(track: Track): void {
    usePlayerStore.setState({ currentTrack: track });
    /*
     * A hand-made window is spent one row at a time: the row that has just started
     * is no longer ahead of anything. When the last of them goes, the next list swap
     * re-picks the walk as it always used to.
     */
    if (this.pinnedUpcoming.includes(track.id)) {
      this.pinnedUpcoming = this.pinnedUpcoming.filter((id) => id !== track.id);
    }
    /*
     * A listen is counted where a deck actually starts a file.
     *
     * Watching `currentTrack` from the store instead looks equivalent and is
     * badly wrong: a folder rescan republishes the library, the session writer
     * re-resolves `currentTrack` by index into that new array, and while the scan
     * is in flight the track sitting at that index changes several times a
     * second. Measured: one tune, one scan, 8342 plays.
     */
    usePlayerStore.getState().recordPlay(track.id);
    this.publishPosition(0);
    this.anchorPos = 0;
    this.anchorWall = performance.now();
    this.endedFor = null;
  }

  /**
   * A film never inherits a song's rate.
   *
   * Speed and pitch are mixer settings, not per-track ones, so they used to carry
   * straight over: a lecture left at 1.5x after a fast song arrived still at 1.5x
   * with the dialogue bent, and a film handed to mpv kept the rubberband filter
   * engaged, which is the one thing in the chain that cannot keep up.
   *
   * The song's own values are held rather than discarded, because the reset is a
   * statement about films and not about the queue. They come back on the next song
   * unless the user moved the slider during the film, in which case their choice wins.
   */
  private resetRateForFilm(wasFilm: boolean): void {
    const store = usePlayerStore.getState();
    if (this.onFilm && !wasFilm) {
      if (store.speed === 1 && store.pitch === 0) {
        this.rateBeforeFilm = null;
        return;
      }
      this.rateBeforeFilm = { speed: store.speed, pitch: store.pitch };
      store.setSpeed(1);
      store.setPitch(0);
      return;
    }
    if (!this.onFilm && wasFilm && this.rateBeforeFilm) {
      const saved = this.rateBeforeFilm;
      this.rateBeforeFilm = null;
      if (store.speed === 1) store.setSpeed(saved.speed);
      if (store.pitch === 0) store.setPitch(saved.pitch);
    }
  }

  /**
   * @param announce false when this window is only *adopting* a track another
   *   window already started — a hand-off — rather than the user asking for it.
   *   Without that distinction a widget opening would tell the library to reload
   *   the film from zero, and every lecture would restart when you minimized it.
   */
  async load(track: Track, autoplay = true, announce = true): Promise<void> {
    const token = ++this.loadToken;
    /*
     * A widget never decodes a film. It records what is on screen, asks the window
     * that owns the film to put it there, and then mirrors the readings that come
     * back. Nothing below this branch touches `this.video`, so there is exactly one
     * decoder per file and the two surfaces cannot drift into playing different
     * songs — which is precisely what "I hear one video and see another" was.
     */
    if (IS_OVERLAY_WINDOW && track.kind === 'video') {
      this.syncFilmSurface(track);
      usePlayerStore.setState({ playbackError: null });
      this.syncTrackToStore(track);
      this.publishSession();
      if (announce) this.sendFilm({ type: 'load', path: track.path, autoplay });
      return;
    }
    this.filmRemote = false;
    const wasVideo = this.onVideo;
    /*
     * Where this window's film is, read here and nowhere later.
     *
     * `getPosition()` is the one getter that already knows which engine is answering:
     * it returns the element's clock while `onVideo` is true and the deck's
     * extrapolated report while it is false. Reading it above the assignment two lines
     * down is what makes it the *outgoing* engine's answer, which is the only answer
     * worth having — and it removes the need to guess which field of the deck's state
     * still describes this file, which is exactly the guess the previous version of
     * this block got wrong when a film came back from the deck to the page.
     */
    const posBefore = this.getPosition();
    const previous = usePlayerStore.getState().currentTrack;
    const video = this.isVideoTrack(track);
    this.onVideo = video;
    const wasFilm = this.onFilm;
    this.onFilm = track.kind === 'video';
    this.filmPath = video ? track.path : null;
    if (video) this.startFilmPublisher();
    else this.stopFilmPublisher();
    this.resetRateForFilm(wasFilm);

    /*
     * A route change in the middle of a film carries the playhead with it.
     *
     * This is not a skip. Nothing about the track moved; the only thing that changed
     * is which window is the surface the user is looking at. Both halves are obvious
     * if dropped — open the card eleven minutes into a lecture and find it back at
     * the beginning, or close it and find the page's element restarted from zero under
     * a picture that had been running for a minute.
     *
     * Gated on the store still naming this same file, because the same condition is
     * true when a song hands over to a film, and there the outgoing position belongs
     * to the song and carrying it would start the lecture eleven minutes in.
     */
    let handoverFrom = 0;
    if (
      track.kind === 'video'
      && wasVideo !== video
      && !!previous
      && sameFile(previous.path, track.path)
      && Number.isFinite(posBefore)
      // Under half a second the offset is smaller than the two engines' own start-up
      // slop, and asking a file that has barely opened to seek is how the first frame
      // gets dropped rather than the first second.
      && posBefore > 0.5
    ) {
      handoverFrom = posBefore;
    }

    // A skip is a stop and a start in one gesture, so it gets the same envelope.
    if (wasVideo && !video) this.video.fadeOutPause();
    /*
     * Which engine draws the picture is published alongside whether there is one,
     * because the two answer different questions. `mediaHasVideo` says a film is
     * on screen; this says the film is *in the page*, which is the only form of it
     * the liquid-glass scene pass can sample. Every surface that floats over a
     * video reads this to choose between real glass and a translucent fill.
     */
    /*
     * `mediaHasVideo` is a property of the track — there is a film on screen —
     * while `videoInPage` is a property of the route drawing it. They used to be
     * set from the DOM branch only, so a file the element refused and mpv took
     * instead reported no video at all: the docked slot never reserved its
     * rectangle and the picture had nowhere to be placed. That is the whole of
     * "the .ts is playing but nothing shows top-right, and other files are fine".
     */
    const hasFilm = track.kind === 'video';
    usePlayerStore.setState({ mediaHasVideo: hasFilm, videoInPage: video, videoNatural: null });
    if (hasFilm && !video) this.publishMpvSize();
    if (video) {
      /*
       * The mirror of the fade above, and the reason a film used to play *over*
       * the song that was already running. A DOM `<video>` is decoded in this
       * process, so nothing on the mpv side is about to stop it: the deck keeps
       * its file and keeps reporting `playing`, and `applyState` now ignores it
       * because `onVideo` flipped — so neither the UI nor the code could see the
       * second stream still making noise. Containers that go to mpv instead never
       * reach here; `api.load` hands the old deck over to the new file itself.
       */
      if (!wasVideo) void mpv()?.halt();
      /*
       * Re-attach the element, every time this route wins.
       *
       * The mpv branch unmounts it, and the only other caller is `VideoStage`'s
       * effect keyed on `mediaHasVideo` — which is a property of the *track*, so
       * playing a .ts and then an mp4 leaves it `true` across the change, the
       * effect never re-runs, and nothing puts the element back. A detached media
       * element still feeds its `MediaElementSource`, so the film played perfectly
       * into a black rectangle: the whole of "after a .ts no other video shows a
       * picture, but I can hear it".
       */
      this.video.mount(this.slotHost);
    } else {
      this.video.unmount();
      /*
       * The film is gone and the deck is mpv's from here. Hand back the
       * AudioContext the in-page element was built on once the fade-out above has
       * run, so its audio device and 48 kHz render thread are not held for the rest
       * of a session that plays through mpv and never touches the graph. Deferred by
       * the fade's own length — closing at the instant of the skip would cut
       * #72/#55's fade into a click. The next in-page film rebuilds the graph on a
       * fresh element (`ensureGraph` cancels this if a film comes back first).
       */
      this.video.scheduleClose(FADE_OUT_S * 1000 + 60);
    }

    usePlayerStore.setState({ playbackError: null });
    this.syncTrackToStore(track);
    if (this.onVideo) {
      await this.loadVideo(track, autoplay, token, handoverFrom);
      return;
    }

    const api = mpv();
    if (!api) {
      usePlayerStore.setState({ playbackError: 'The mpv engine is not available in this window' });
      return;
    }
    try {
      await api.load(track.path, {
        autoplay,
        startAt: handoverFrom || undefined,
        preloadNext: this.upcomingPathForPreload(),
      });
    } catch (e) {
      if (token === this.loadToken) {
        usePlayerStore.setState({ isPlaying: false, playbackError: (e as Error).message });
      }
      return;
    }
    if (token !== this.loadToken) return;
    this.setTrim(this.gainCache.get(track.id) ?? 0);
    this.scheduleBackgroundAnalysis(track);
    this.fillCurrentCover(track);
  }

  /** The video element's path, which still needs the load envelope in this process. */
  private async loadVideo(track: Track, autoplay: boolean, token: number, startAt = 0): Promise<void> {
    const speed = usePlayerStore.getState().speed;
    this.video.fadeOutPause();
    const url = track.mediaUrl || toMediaUrl(track.path);
    try {
      await this.video.load(url, speed, getCachedPoster(track.path));
    } catch {
      /* surfaced by the element's error event */
    }
    if (token !== this.loadToken) return;
    /*
     * Jump to where the deck had the film before this window took it back.
     *
     * After `load()` rather than before it: an element with no metadata has nowhere
     * to seek to, and the offset is silently thrown away instead of queued — which
     * is a film that starts at the beginning and says nothing about why. Also
     * before the `play()` below, so the jump happens on a paused frame and the fade
     * in is the first thing the user hears, rather than a seek in mid-sentence.
     */
    if (startAt > 0) {
      this.video.seek(startAt);
      this.anchorPos = startAt;
      this.anchorWall = performance.now();
      this.publishPosition(startAt);
    }
    this.setTrim(this.gainCache.get(track.id) ?? 0);
    this.scheduleBackgroundAnalysis(track);
    /*
     * A film's row is stripped like any other, and the poster the element paints
     * from is not what the pill, the mini card or the record behind them are drawn
     * from: those read the row's cover, which for a container carrying a `covr`
     * atom is a real picture and used to arrive with the scan.
     */
    this.fillCurrentCover(track);
    if (autoplay) {
      try {
        await this.video.play();
        this.video.fadeEnvelope(1, FADE_IN_S);
        this.readVideoShape();
        usePlayerStore.setState({ isPlaying: !this.video.paused });
      } catch {
        this.video.fadeEnvelope(1, 0);
        if (token === this.loadToken) usePlayerStore.setState({ isPlaying: false });
      }
    } else {
      this.video.fadeEnvelope(1, 0);
    }
  }

  /**
   * The track after this one, handed to mpv's standby deck on every load.
   * Returns null at the end of a non-repeating queue, where there is nothing to
   * pre-buffer.
   *
   * Null for the whole time a film is on screen, whichever engine is drawing it.
   * Gapless is a music feature: the seam it buys is ten milliseconds between two
   * songs, and what it costs is a second decoder holding a second file open. On a
   * film that decoder competes with the one already painting frames, which is the
   * machine the stutter shows up on, and nothing wants a ten-millisecond seam
   * between two videos.
   */
  private upcomingPathForPreload(): string | null {
    if (this.onFilm) return null;
    if (this.queue.length < 2) return null;
    const { repeatMode, shuffle } = usePlayerStore.getState();
    if (!repeatMode && this.index === this.queue.length - 1 && !shuffle) return null;
    const [nextIdx] = this.upcomingIndices(1);
    if (nextIdx === undefined) return null;
    const next = this.queue[nextIdx];
    if (!next || this.isVideoTrack(next)) return null;
    return next.path;
  }

  async playTrackAt(index: number): Promise<void> {
    if (index < 0 || index >= this.queue.length) return;
    /*
     * Spend the row before it becomes the current one.
     *
     * A hand-made window is a promise about what plays *next*; the moment a row in
     * it starts sounding it has been kept. This is the one choke point every
     * advance goes through — the transport, an ending, a click on a row — so
     * spending it here is what stops a six-row arrangement from being replayed as a
     * six-song loop forever once the walk has passed it. `pinnedAhead` prunes the
     * same thing from the other direction, because the window that plays a row is
     * not always the window that arranged it.
     */
    const played = this.queue[index]?.id;
    if (played && this.pinnedUpcoming.includes(played)) {
      this.pinnedUpcoming = this.pinnedUpcoming.filter((id) => id !== played);
    }
    this.index = index;
    usePlayerStore.setState({ currentIndex: index });
    this.publishSession();
    await this.load(this.queue[index], true);
  }

  async playTrack(track: Track): Promise<void> {
    const idx = this.queue.findIndex((t) => t.id === track.id);
    if (idx >= 0) {
      await this.playTrackAt(idx);
      return;
    }
    /*
     * Not in the loaded queue: adopt the library it came from rather than
     * prepending a stranger onto whatever was already there, which left
     * auto-advance walking over an order nobody chose.
     */
    const library = usePlayerStore.getState().library;
    const byId = library.findIndex((t) => t.id === track.id);
    const byPath = byId >= 0 ? byId : library.findIndex((t) => t.path === track.path);
    if (byPath >= 0) {
      this.queue = [...library];
      this.shuffleOrder = [];
      usePlayerStore.setState({ queue: this.queue });
      await this.playTrackAt(byPath);
      return;
    }
    if (this.queue.length > 1) {
      await this.load(track, true);
      return;
    }
    this.queue = [track];
    this.shuffleOrder = [];
    this.index = 0;
    usePlayerStore.setState({ queue: this.queue, currentIndex: 0 });
    await this.load(track, true);
  }

  async togglePlay(): Promise<void> {
    /*
     * The optimistic flip is not decoration: the reading that would confirm it is
     * up to 250 ms away, and a transport icon that waits that long to change reads
     * as a dead button. The next `FilmState` overrules it if the owner disagreed.
     */
    if (this.filmRemote) {
      const playing = usePlayerStore.getState().isPlaying;
      this.sendFilm({ type: playing ? 'pause' : 'play' });
      usePlayerStore.setState({ isPlaying: !playing });
      return;
    }
    if (this.onVideo) {
      const el = this.video.element;
      if (!el.src && this.queue.length > 0) {
        await this.playTrackAt(Math.max(0, this.index));
        return;
      }
      if (!el.src) return;
      if (el.paused || this.video.hasPausePending) {
        this.video.cancelPendingPause();
        this.video.fadeEnvelope(1, FADE_IN_S);
        try {
          await this.video.play();
        } catch {
          /* autoplay blocked: the transport stays paused and the user can press play */
        }
      } else {
        this.video.fadeOutPause();
      }
      return;
    }

    const api = mpv();
    if (!api) return;
    /*
     * Decide from the state already in hand, not from a round trip.
     *
     * This used to `await this.current()` first, which is an IPC read of the
     * deck — so the pause command was not even *sent* until the answer came
     * back, measured at ~450 ms on a four-thread machine with a video decoded.
     * A play button that takes half a second to answer is the "not responsive"
     * complaint regardless of what the icon eventually does.
     *
     * `this.remote` is the same state, delivered by the broadcast the deck
     * already pushes on every change, so it is at most one poll stale — and the
     * store's `isPlaying` is written from that same source.
     */
    const st = this.remote;
    if (!st?.path) {
      if (this.queue.length > 0) await this.playTrackAt(Math.max(0, this.index));
      return;
    }
    const want = !st.playing;
    if (want) api.play();
    else api.pause();
    /*
     * Optimistic, and safe to be: `play()` and `pause()` both answer with a forced
     * broadcast carrying exactly this value, so the deck's report agrees and
     * `applyState` is a no-op. If the deck *cannot* do it — no file, a failed
     * resume — its broadcast is the one that wins and the icon corrects itself.
     *
     * What must not happen is writing a value derived from an awaited read, which
     * is how the mini card ended up flickering pause → play → pause → play: two
     * authors, one field, and the stale one finished last.
     */
    usePlayerStore.setState({ isPlaying: want });
  }

  /**
   * Resume — as distinct from `togglePlay`, which is an answer to "which one is it
   * now?" rather than to "start".
   *
   * This used to delegate to `togglePlay()`, and `togglePlay()` decides by negating
   * the deck's last reported state. Windows sends `play` and `pause` to an SMTC
   * participant as two separate actions, and so does the taskbar thumbnail, so a
   * "play" that landed while that report was one poll stale answered by *pausing* —
   * and the transport then showed the opposite of the deck for as long as it took
   * the next broadcast to arrive. Every imperative caller in the app goes through
   * here.
   */
  async play(): Promise<void> {
    if (this.filmRemote) {
      if (usePlayerStore.getState().isPlaying) return;
      this.sendFilm({ type: 'play' });
      usePlayerStore.setState({ isPlaying: true });
      return;
    }
    if (this.onVideo) {
      const el = this.video.element;
      if (!el.src && this.queue.length > 0) {
        await this.playTrackAt(Math.max(0, this.index));
        return;
      }
      // A fade-out still in flight counts as not-yet-paused, and is cancelled.
      if (!el.src || (!el.paused && !this.video.hasPausePending)) return;
      this.video.cancelPendingPause();
      this.video.fadeEnvelope(1, FADE_IN_S);
      try {
        await this.video.play();
      } catch {
        /* autoplay blocked: the transport stays paused and the user can press play */
      }
      return;
    }
    const api = mpv();
    if (!api) return;
    if (!this.remote?.path) {
      if (this.queue.length > 0) await this.playTrackAt(Math.max(0, this.index));
      return;
    }
    if (this.remote.playing) return;
    api.play();
    usePlayerStore.setState({ isPlaying: true });
  }

  pause(): void {
    if (this.filmRemote) {
      this.sendFilm({ type: 'pause' });
      usePlayerStore.setState({ isPlaying: false });
      return;
    }
    if (this.onVideo) {
      this.video.fadeOutPause();
      return;
    }
    mpv()?.pause();
  }

  stop(): void {
    if (this.filmRemote) {
      this.sendFilm({ type: 'pause' });
      this.sendFilm({ type: 'seek', to: 0 });
      usePlayerStore.setState({ isPlaying: false });
      this.publishPosition(0);
      return;
    }
    if (this.onVideo) {
      this.video.fadeEnvelope(0, FADE_OUT_S);
      this.video.cancelPendingPause();
      window.setTimeout(() => {
        this.video.pause();
        this.video.seek(0);
      }, FADE_OUT_S * 1000 + 8);
      usePlayerStore.setState({ isPlaying: false });
      this.publishPosition(0);
      return;
    }
    mpv()?.stop();
    usePlayerStore.setState({ isPlaying: false });
      this.publishPosition(0);
  }

  /**
   * Shuffle picks each track exactly once per pass. Keeping the permutation here
   * rather than calling Math.random() per skip is what lets the pre-buffer know
   * what is actually coming.
   */
  private ensureShuffleOrder(): void {
    if (this.shuffleOrder.length === this.queue.length) return;
    /*
     * Derived from the store seed rather than drawn here, so every window reaches
     * the same order independently. Math.random made the pre-buffer a guess: it
     * loaded a successor that the next skip would never play.
     */
    this.shuffleOrder = seededPermutation(this.queue.length, usePlayerStore.getState().shuffleSeed);
  }

  /** Queue indices in the exact order they will play, current track excluded. */
  upcomingIndices(count: number, direction: 1 | -1 = 1): number[] {
    const n = this.queue.length;
    if (n === 0) return [];
    const { repeatMode } = usePlayerStore.getState();

    let order: number[];
    let pos: number;
    if (this.shuffleApplies() && n > 1) {
      this.ensureShuffleOrder();
      order = this.shuffleOrder;
      pos = this.shuffleOrder.indexOf(this.index);
      if (pos < 0) pos = 0;
    } else {
      order = this.queue.map((_, i) => i);
      pos = this.index;
    }

    const out: number[] = [];
    /*
     * The hand-made rows lead, then the walk with them taken out, so a drag moves
     * what plays next without replacing the rest of the permutation behind it.
     */
    const taken = new Set<number>();
    for (const pinned of this.pinnedAhead()) {
      if (out.length >= count) break;
      out.push(pinned);
      taken.add(pinned);
    }
    for (let step = 1; out.length < count && step <= n; step++) {
      const p = pos + direction * step;
      if (p < 0 || p >= n) {
        /*
         * Running off the end of the list turns over rather than stopping.
         *
         * It used to be gated on `repeatMode === 'all'`, which left a queue that
         * had simply finished going silent with the transport showing a paused
         * last track — a state nobody chooses and everybody reads as a crash.
         * Stepping backwards off the top still stops, because there the user is
         * looking for the first thing they played, not another lap.
         */
        if (direction < 0 && repeatMode !== 'all') break;
        const wrapped = order[((p % n) + n) % n];
        if (taken.has(wrapped)) continue;
        out.push(wrapped);
        taken.add(wrapped);
      } else {
        if (taken.has(order[p])) continue;
        out.push(order[p]);
        taken.add(order[p]);
      }
    }
    return out;
  }

  /** The rows after the one that is sounding, in the order they will actually play. */
  upcomingTracks(count: number): Track[] {
    return this.upcomingIndices(count)
      .map((i) => this.queue[i])
      .filter((t): t is Track => !!t);
  }

  /**
   * Commit the window the user just dragged into order.
   *
   * Only the shape of the rows ahead of this one changes; the songs behind the
   * window still come from the permutation, so a drag is not a new list.
   */
  setUpcomingOrder(tracks: Track[]): void {
    if (tracks.length === 0) return;
    this.pinnedUpcoming = tracks.map((t) => t.id);
    this.commitOrder();
  }

  /** Queue positions for the hand-made rows that are still ahead of the current one. */
  private pinnedAhead(): number[] {
    if (this.pinnedUpcoming.length === 0) return [];
    const out: number[] = [];
    const stillAhead: string[] = [];
    for (const id of this.pinnedUpcoming) {
      const at = this.queue.findIndex((t) => t.id === id);
      // Gone from the list: the row it was pinned for no longer exists to play.
      // Sounding right now: a hand-made window is spent one row at a time, and
      // the row that has started is not ahead of anything.
      if (at < 0 || at === this.index) continue;
      out.push(at);
      stillAhead.push(id);
    }
    this.pinnedUpcoming = stillAhead;
    return out;
  }

  /**
   * Whether the engine's own permutation is in play right now.
   *
   * It used to step aside for two other conditions as well — which list the deck
   * was following, and whether a hand-made running order existed. Both meant the
   * same thing to the user: shuffle was lit, and the songs still came in order.
   * There is one list and one order now, so the switch is the whole test, which is
   * what makes it behave the same from the transport, the pre-buffer and the
   * session mirror instead of three quarters of the same rule in each.
   */
  private shuffleApplies(): boolean {
    return usePlayerStore.getState().shuffle;
  }

  /**
   * Publish an order edit to every window, and re-buffer what comes next.
   */
  private commitOrder(): void {
    usePlayerStore.setState({
      queue: this.queue,
      currentIndex: this.index,
    });
    if (!this.onVideo) void mpv()?.preload(this.upcomingPathForPreload() ?? '');
    this.publishSession();
  }

  next(): void {
    const [first] = this.upcomingIndices(1);
    if (first === undefined) return;
    void this.playTrackAt(first);
  }

  previous(): void {
    if (this.getPosition() > 5) {
      this.seek(0);
      return;
    }
    const [prev] = this.upcomingIndices(1, -1);
    if (prev === undefined) return;
    void this.playTrackAt(prev);
  }

  getDuration(): number {
    if (this.onVideo) return this.video.duration;
    return this.remote?.duration ?? 0;
  }

  getPosition(): number {
    if (this.onVideo) return this.video.currentTime;
    return this.getRenderPosition();
  }

  /**
   * Position for per-frame surfaces, interpolated between deck reports.
   *
   * mpv speaks at ~8Hz because that is what an IPC round trip is worth; a canvas
   * playhead needs 60. So the last real reading is extrapolated from its own
   * timestamp, and every new reading nudges the time origin rather than the
   * position — which is what keeps the sweep smooth instead of stepping.
   */
  getRenderPosition(): number {
    if (this.onVideo) return this.video.currentTime;
    const speed = Math.max(0.25, usePlayerStore.getState().speed || 1);
    return this.extrapolate(speed);
  }

  /**
   * What a second window needs to pick this track up: which song, where in it,
   * and whether it was playing. With one shared deck this is a read, not a
   * transfer — the reason the pill no longer has to pause anything first.
   */
  handoffState(): HandoffState {
    const s = usePlayerStore.getState();
    return {
      trackId: s.currentTrack?.id,
      position: this.getPosition(),
      playing: s.isPlaying,
      track: s.currentTrack ?? undefined,
      /*
       * The rows, without their covers. A hand-off used to carry the whole queue
       * byte for byte, which meant opening a pill over a 425-row session put a
       * second copy of every embedded JPEG into the widget's process — the exact
       * 23 MB the widget's own library stopped carrying. The record it draws is
       * `track` above; the rest ask for their art when they are painted.
       */
      queue: this.queue.length ? this.queue.map(noCover) : undefined,
      index: this.index,
    };
  }

  /** Nothing to mute any more: the pill and this window already share one deck. */
  pauseForHandoff(): void {
    /* intentionally empty — kept because App.tsx still calls it */
  }

  /** Adopt the position the shared deck is at, rather than loading anything. */
  async applyHandoff(state: HandoffState): Promise<void> {
    if (!state.trackId) return;
    const s = usePlayerStore.getState();
    const found =
      s.library.find((t) => t.id === state.trackId) ??
      s.queue.find((t) => t.id === state.trackId) ??
      state.track ??
      s.currentTrack;
    if (!found) return;
    const carried = carryLyrics(found, state.track);
    /*
     * Rows arrive without covers in either window, so the hand-off's copy is often
     * the only one that has the record this window is about to draw — a library that
     * stripped its rows, or a strip that filled `currentTrack` and nothing else.
     * Only fills a gap: when this window's own row already carries a cover it is the
     * same bytes, and re-setting it would repaint a disc that is on screen.
     */
    const track = carried.albumArt || !state.track?.albumArt
      ? carried
      : { ...carried, albumArt: state.track.albumArt };
    // A cold overlay window has no queue at all; adopt the sender's so
    // auto-advance works from the widget rather than only from the library.
    if (state.queue && s.queue.length === 0) {
      this.queue = [...state.queue];
      usePlayerStore.setState({
        queue: this.queue,
        currentIndex: state.index ?? this.queue.findIndex((t) => t.id === track.id),
      });
      this.index = usePlayerStore.getState().currentIndex;
    }
    const idx = this.queue.findIndex((t) => t.id === track.id);
    if (idx >= 0) {
      this.index = idx;
      usePlayerStore.setState({ currentIndex: idx });
    }
    this.fillCurrentCover(track);
    /*
     * A widget adopting a film records it and waits to be told. It must not seek
     * or play: the library has been decoding this file since before the widget
     * existed, and a hand-off that restarted it is how opening the mini player
     * threw the film back to 0:00.
     */
    if (IS_OVERLAY_WINDOW && track.kind === 'video') {
      await this.load(track, false, false);
      this.publishPosition(state.position);
      usePlayerStore.setState({ isPlaying: state.playing });
      return;
    }
    const remote = await this.current();
    /*
     * The same-file shortcut adopts the running deck instead of reloading it. What
     * it can no longer strand is the picture: the film's element now lives in this
     * window for the whole session, so a window that has the file also has the
     * frame.
     */
    if (remote?.path && sameFile(remote.path, track.path)) {
      usePlayerStore.setState({ currentTrack: track, isPlaying: remote.playing });
      this.publishPosition(remote.pos);
      return;
    }
    if (this.isVideoTrack(track)) {
      await this.load(track, false);
      this.seek(Math.max(0, state.position));
      if (state.playing) await this.play();
      return;
    }
    await mpv()?.load(track.path, { autoplay: state.playing, startAt: Math.max(0, state.position) });
    usePlayerStore.setState({ currentTrack: track });
  }

  private async current(): Promise<MpvState | null> {
    const api = mpv();
    if (!api) return this.remote;
    try {
      const snap: MpvSnapshot = await api.snapshot();
      return snap.state;
    } catch {
      return this.remote;
    }
  }

  seek(seconds: number): void {
    if (this.filmRemote) {
      const duration = this.getDuration();
      const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      this.sendFilm({ type: 'seek', to: target });
      this.anchorPos = target;
      this.anchorWall = performance.now();
      this.publishPosition(target);
      return;
    }
    if (this.onVideo) {
      const duration = this.getDuration();
      const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
      this.video.seek(target);
      this.publishPosition(target);
      this.anchorPos = target;
      this.anchorWall = performance.now();
      return;
    }
    const duration = this.getDuration();
    const target = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
    this.anchorPos = target;
    this.anchorWall = performance.now();
    this.publishPosition(target);
    void mpv()?.seek(target);
  }

  seekBy(delta: number): void {
    this.seek(this.getPosition() + delta);
  }

  /**
   * Scrubbing holds the audio still and lets only the playhead move. Every write
   * to the deck's position discards the decoder's buffer and refills it, and a
   * drag produces dozens of those a second — the crackle this removes.
   */
  beginScrub(): void {
    if (this.scrubbing) return;
    this.scrubbing = true;
    this.scrubWasPlaying = usePlayerStore.getState().isPlaying;
    if (this.onVideo) {
      if (!this.video.paused) this.video.pause();
      return;
    }
    void mpv()?.beginScrub();
  }

  /** Only the UI moves while the drag is in flight; the deck stays put. */
  previewScrub(seconds: number): void {
    if (!this.scrubbing) return;
    this.anchorPos = seconds;
    this.anchorWall = performance.now();
    this.publishPosition(seconds);
  }

  endScrub(seconds: number): void {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    if (this.onVideo) {
      this.seek(seconds);
      if (this.scrubWasPlaying) void this.video.play().catch(() => {});
      return;
    }
    /*
     * Only hand the deck back to play if it was playing when the drag began.
     *
     * This used to call `play()` unconditionally, so dragging the slider on a
     * paused song started it playing — the one thing a scrub on a paused track
     * must never do. The video path above already asked `scrubWasPlaying`; the mpv
     * path simply had not been told to.
     */
    void mpv()?.endScrub(seconds);
    this.seek(seconds);
    if (this.scrubWasPlaying) void mpv()?.play();
  }

  setClippingGuard(enabled: boolean): void {
    this.video.setGuard(enabled, this.gainCache.get(usePlayerStore.getState().currentTrack?.id ?? '') ?? 0);
    void mpv()?.guard(enabled);
    const current = usePlayerStore.getState().currentTrack;
    if (enabled && current) void this.applyClippingGuard(current);
  }

  setVolume(vol: number): void {
    const clamped = Math.max(0, Math.min(1, vol));
    this.video.setVolume(clamped);
    void mpv()?.volume(clamped);
  }

  setSpeed(speed: number): void {
    const clamped = Math.max(0.25, Math.min(2.0, speed));
    this.video.setSpeed(clamped);
    void mpv()?.speed(clamped);
  }

  setPitch(semitones: number): void {
    const clamped = Math.max(-12, Math.min(12, semitones));
    this.video.setPitch(clamped);
    void mpv()?.pitch(clamped);
  }

  setEqBand(bandIndex: number, gainDb: number): void {
    const eq = usePlayerStore.getState().eq;
    const gains = eq.gains.map((g, i) =>
      i === bandIndex ? Math.max(-12, Math.min(12, gainDb)) : g,
    );
    this.video.setEqGains(gains);
    void mpv()?.eq(gains, eq.enabled);
  }

  setEqGains(gainsDb: number[]): void {
    const gains = gainsDb.map((g) => Math.max(-12, Math.min(12, g)));
    this.video.setEqGains(gains);
    void mpv()?.eq(gains, usePlayerStore.getState().eq.enabled);
  }

  /**
   * Warm the shared deck's standby with the track that is coming up.
   *
   * Called when the queue settles rather than on every skip, so the deck is
   * already decoded by the time the fade needs it.
   */
  primeNext(): void {
    if (this.onVideo) return;
    const path = this.upcomingPathForPreload();
    if (path) void mpv()?.preload(path);
  }

  getPeaks(track: Track): number[] | null {
    return this.waveformCache.get(track.id) ?? null;
  }

  /**
   * Waveform peaks come from ffmpeg in the main process rather than
   * decodeAudioData here: decoding a whole file in the renderer competes with
   * playback for the same file and shows up as dropouts. Engine-independent, so
   * the mpv swap did not touch it.
   */
  async warmWaveform(track: Track): Promise<number[] | null> {
    const cached = this.waveformCache.get(track.id);
    if (cached) return cached;
    const pending = this.waveformPending.get(track.id);
    if (pending) return pending;

    const job = (async () => {
      try {
        const peaks = await window.electronAPI?.extractPeaks(track.path, WAVEFORM_PEAK_COUNT);
        if (!peaks) return null;
        this.waveformCache.set(track.id, peaks);
        usePlayerStore.setState((s) => ({
          currentTrack:
            s.currentTrack?.id === track.id ? { ...s.currentTrack, waveformPeaks: peaks } : s.currentTrack,
        }));
        return peaks;
      } catch {
        return null;
      } finally {
        this.waveformPending.delete(track.id);
      }
    })();

    this.waveformPending.set(track.id, job);
    return job;
  }
}

const MEDIA_ERROR_TEXT: Record<number, string> = {
  1: 'Playback aborted',
  2: 'Network error reading the file',
  3: 'This file could not be decoded',
  4: 'This format is not supported by the built-in player',
};

/**
 * Take the words from another window's copy of the same track.
 *
 * Each window resolves a track from its *own* scan, and a scan only knows what
 * was in the file when it was read. An LRCLIB match lives on the object of the
 * window that asked for it, so a widget that rebuilt `currentTrack` from its own
 * library silently dropped the lyric set the library window was showing — the
 * pill's lyric page reading "No words for this track yet" a metre away from a
 * full, scrolling, time-synced one.
 */
/** A row as another window can use it: everything but the cover's base64. */
function noCover(track: Track): Track {
  return track.albumArt ? { ...track, albumArt: null } : track;
}

function carryLyrics(local: Track, from?: Track | null): Track {
  /*
   * The identity test is the whole guard.
   *
   * `applySession` runs this over the *incoming queue* with this window's own
   * `currentTrack` as the donor, and during a track change that donor is the
   * song that just finished. Without the id check, every lyric-less row in the
   * arriving queue inherited the previous song's sheet — a skip to a track LRCLIB
   * has never heard of opened the panel on the words of whatever played before
   * it, and stamped them onto the whole list while it was at it.
   */
  if (!from || from.id !== local.id) return local;
  if (local.lyrics?.length || local.plainLyrics) return local;
  if (!from.lyrics?.length && !from.plainLyrics) return local;
  return { ...local, lyrics: from.lyrics, plainLyrics: from.plainLyrics ?? local.plainLyrics };
}

/** Windows path comparison is case-insensitive and separator-flexible. */
function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

let instance: AudioEngine | null = null;

export function getEngine(): AudioEngine {
  if (!instance) {
    instance = new AudioEngine();
  }
  return instance;
}
