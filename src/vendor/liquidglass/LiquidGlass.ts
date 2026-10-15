/**
 * LiquidGlass — main orchestrator for the liquid glass effect library.
 *
 * Coordinates between:
 *   - HtmlCapture  (captures individual DOM elements into reusable canvases)
 *   - GlassRenderer (WebGL pipeline for the glass effect)
 *
 * Handles child ordering, layered compositing, floating (drag)
 * behaviour, resize, and the render loop.
 *
 * Usage:
 *   import { LiquidGlass } from '@ybouane/liquidglass';
 *   LiquidGlass.init({ root, glassElements });
 */

import { DEFAULTS, SHADOW_PAD } from './defaults';
import type { GlassConfig } from './defaults';
import { HtmlCapture } from './HtmlCapture';
import { GlassRenderer } from './GlassRenderer';

/** Options accepted by {@link LiquidGlass.init}. */
export interface LiquidGlassOptions {
	/** Root container element. */
	root: HTMLElement;
	/** Elements to apply the glass effect to. */
	glassElements?: NodeListOf<HTMLElement> | HTMLElement[];
	/** Override the default configuration values. */
	defaults?: Partial<GlassConfig>;
	/**
	 * Re-run the shader for every glass on every animation frame instead of
	 * only when something marks it dirty. Elements that move under CSS
	 * animation (popups, the sliding row sheet) otherwise keep sampling the
	 * scene from where they were created, which reads as the refraction
	 * lagging behind the motion.
	 */
	realtime?: boolean;
	/**
	 * Stop scheduling animation frames once the scene has gone genuinely
	 * static, and start them again the moment anything that could change a
	 * pixel does.
	 *
	 * Without this the loop runs at display rate whatever the state of the
	 * page: an idle app measured 46 frames a second in which nothing was
	 * dirty, no media was live and nothing was drawn, and every one of those
	 * frames still paid for a `getBoundingClientRect()` sweep of the root plus
	 * an `offsetWidth`/`offsetHeight` sweep of every registered glass — 0.82 ms
	 * of forced layout per frame, ~3.8% of a core, forever. Layout reads are
	 * worse than their own cost suggests, because each one can make the
	 * compositor redo work the page never asked for.
	 *
	 * Off by default so the shipped behaviour is unchanged for any caller that
	 * does not ask for it. The ChaosX wrapper feeds it from `GLASS_REST_WHEN_IDLE`,
	 * which is currently `false`: the machinery here is complete and dormant, and the
	 * app is running the original always-rendering loop.
	 */
	restWhenIdle?: boolean;
	/**
	 * Resolution multiplier for the glass's own device pixels: the WebGL render
	 * targets, the per-surface shader canvases they are copied into, the scene
	 * canvas they are composed from, and the html-to-image snapshots of the
	 * backdrop.
	 *
	 * 1 renders at the display's native ratio, exactly as this library has always
	 * done. The cost it exists for is the one nobody chose: a 1920x1080 display at
	 * `devicePixelRatio` 1.25 allocates every glass surface 1.56x the pixels the
	 * panel covers on screen, and on a tiled GPU those pixels are filled, sampled
	 * by a six-iteration blur and copied again per panel.
	 *
	 * Like every other optional behaviour here it is gated behind an option and
	 * defaults to off, and everything the value touches is an *allocation*: set it
	 * to 1 and the arithmetic this file does is bit-for-bit the arithmetic it did
	 * before.
	 */
	renderScale?: number;
}

interface DragState {
	active: boolean;
	element: HTMLElement | null;
	startX: number;
	startY: number;
	origTx: number;
	origTy: number;
}

interface GlassCacheEntry {
	centerX: number;
	centerY: number;
}

interface ConfigCachedElement extends HTMLElement {
	configCache?: Partial<GlassConfig>;
	configCacheKey?: string;
}

interface SizeEntry {
	w: number;
	h: number;
}

interface ObjectFitRect {
	sx: number;
	sy: number;
	sw: number;
	sh: number;
}

interface SampleRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

const BUTTON_CLASS = 'liquid-glass-button';
const STYLE_ID = 'liquid-glass-button-styles';
const BUTTON_CSS = `
.${BUTTON_CLASS} {
	cursor: pointer;
}
`;

interface ButtonState {
	hover: boolean;
	pressed: boolean;
}

/**
 * `MutationObserver.unobserve()` is in the standard and in this Chromium, but the DOM
 * lib this project typechecks against only declares `observe()`/`disconnect()`, and
 * `disconnect()` on the shared subtree observer would stop watching every *other*
 * panel to stop watching one.
 */
type UnobservingMutationObserver = MutationObserver & {
	unobserve?(target: Node): void;
};

/**
 * How often a resting loop re-reads geometry, in ms, for the first second of
 * the rest, and `REST_PROBE_SLOW_MS` after that. This is the backstop for
 * movement nothing else can see — a script writing `style.transform` on a
 * wrapper that is neither a panel nor a root layer, a Web Animations API tween,
 * or a reflow caused by an image arriving — none of which mutate a node we
 * observe or fire a CSS event. One sample costs a single rect read per
 * registered glass, so even at the fast rate the loop is a third as busy as the
 * 46 Hz chain it replaces and does a tenth of the work per sample; the slow rate
 * is what a scene that has really settled drops to.
 */
const REST_PROBE_MS = 120;
const REST_PROBE_SLOW_MS = 400;
const REST_PROBE_FAST_SAMPLES = 8;

/**
 * Consecutive idle frames required before the loop parks itself. One frame of
 * quiet can be a lull in the middle of an animation; three is a scene that has
 * actually stopped.
 */
const REST_SETTLE_FRAMES = 3;

/**
 * How long a surface has to be impossible to see for before the reap releases what
 * it holds, in ms.
 *
 * Not immediate, because the general test for "invisible" is a lie in both
 * directions: a page swap holds the leaving layer for the full length of its
 * gesture, a dropdown blinks out and back inside a second, and the takeover animates
 * over hundreds of milliseconds. Releasing on the first frame a surface cannot be
 * seen frees a render target and then reallocates every one of them on the frame the
 * panel returns, which puts the stall exactly in the middle of the animation the user
 * is watching — and this pipeline has no frame budget to spare for that. Half a
 * second of confirmed absence is the difference between a surface that is hidden and
 * a surface that has been left.
 *
 * Measured in time rather than frames because the loop does not have frames to spare:
 * with `restWhenIdle` on, a parked scene is the moment a surface nobody has looked at
 * for five minutes should stop costing, and there are no frames to count then.
 */
const REAP_SUSPEND_MS = 500;

/** How often the live surfaces are re-asked whether they can still be seen, in ms. */
const REAP_DEPART_MS = 250;

/**
 * How far past the viewport a surface has to sit before the viewport is said to be
 * unable to show it.
 *
 * The naive test — "its box does not intersect the viewport" — is wrong, because a
 * glass surface is not only its box: the shader canvas is `SHADOW_PAD` bigger on
 * every side, and the scene pass composites any *earlier* glass whose padded rect
 * intersects a panel's padded rect, whatever that earlier element's own visibility
 * says. Park a surface 10px off screen and a panel at the edge still refracts it,
 * which is a change to the look. The distance that closes it is the padding (40) plus
 * how far the refraction can displace a sample — the bend reaches roughly
 * `refraction * 30` device pixels plus the chromatic split, about 12 CSS px at these
 * settings — and a fragment that is on screen at all is at worst `x = 0`, so it can
 * only read back to about -52. A hundred is that number with room for the panel that
 * is mid-animation, and to move a surface from out there to in here you have to
 * scroll, which repaints the scene anyway.
 */
const REAP_OFFSCREEN_MARGIN = 100;

/** Frames between sweeps of the capture cache for elements that have left the page. */
const REAP_PRUNE_FRAMES = 30;

/** Geometry of a resting scene, read at park time and compared by the probe. */
interface RestGeometry {
	x: number;
	y: number;
	w: number;
	h: number;
	cw: number;
	ch: number;
}

export class LiquidGlass {
	// ────────────────────────────────────────────
	// Static entry point
	// ────────────────────────────────────────────

	static async init(options: LiquidGlassOptions): Promise<LiquidGlass> {
		const instance = new LiquidGlass(options);
		instance.realtime = options.realtime ?? false;
		instance.restWhenIdle = options.restWhenIdle ?? false;
		instance.renderScale = options.renderScale ?? 1;
		await instance._start();
		return instance;
	}

	/** See `LiquidGlassOptions.realtime`. Skipped while the window is hidden. */
	realtime = false;
	/** See {@link LiquidGlassOptions.restWhenIdle}. Off unless the caller asks. */
	restWhenIdle = false;
	/** See {@link LiquidGlassOptions.renderScale}. 1 unless the caller asks. */
	private _renderScale = 1;

	/**
	 * See {@link LiquidGlassOptions.renderScale}.
	 *
	 * Readable and writable at any time, and writing it re-sizes the world: every
	 * target, shader canvas and backdrop snapshot in the pipeline is allocated from
	 * this number times `devicePixelRatio`, so a change has to go through the same
	 * path a display-scale change goes through — which is `resize()`, and it already
	 * flushes the render-target pool and the capture cache. Flipping it back to 1
	 * therefore restores today's exact output rather than approximating it.
	 */
	get renderScale(): number {
		return this._renderScale;
	}

	set renderScale(value: number) {
		const next = Number.isFinite(value) && value > 0 ? value : 1;
		if (next === this._renderScale) return;
		this._renderScale = next;
		if (this._running) this._handleResize();
	}

	/**
	 * The device-pixel ratio the glass allocates at.
	 *
	 * Deliberately not `window.devicePixelRatio`: that number describes the display,
	 * and it is used unchanged everywhere the browser is being imitated — CSS layout
	 * widths, the screen grab's own resolution, the strip's wallpaper placement.
	 * This one is only for the pixels the glass owns, and multiplying it into a
	 * target's size is what makes the lever cost memory and not the page's geometry.
	 */
	private _devicePixels(): number {
		return (window.devicePixelRatio || 1) * this._renderScale;
	}

	/**
	 * Pin the quality tier at 1 — render every frame, whatever the governor says.
	 * For a surface whose job is bending something that moves at display rate.
	 */
	holdQuality = false;

	// ────────────────────────────────────────────
	// Instance fields
	// ────────────────────────────────────────────

	readonly root: HTMLElement;
	readonly defaults: GlassConfig;
	readonly glassSet: Set<HTMLElement>;
	readonly glassCanvases: Map<HTMLElement, HTMLCanvasElement>;
	readonly capture: HtmlCapture;
	readonly renderer: GlassRenderer;

	/** Current frames-per-second (updated every frame). */
	fps = 0;

	private _running = false;
	private _rafId = 0;
	private _hasDynamic = false;
	/**
	 * Genuinely-global dirty flag — set by events that legitimately
	 * affect every glass at once (resize, WebGL context restored,
	 * structural mutation of root, end of _start). On the next frame
	 * the entry guard promotes it into per-element dirty marks for
	 * every glass in glassSet, then clears itself.
	 */
	private _globalDirty = true;
	/**
	 * Per-element shader-render dirty set. Each entry is a glass
	 * element that needs its WebGL pipeline to re-run on the next
	 * frame. Drained at the end of _renderFrame.
	 *
	 * Mirrors _glassContentDirty (which tracks html-to-image content
	 * captures) but for the WebGL shader pass instead of the DOM
	 * raster pass — they have different triggers.
	 */
	private readonly _glassDirty = new Set<HTMLElement>();
	/**
	 * Elements (typically wrappers, glasses themselves, or descendants
	 * of root) explicitly marked changed via the public markChanged()
	 * API. The next frame fans each one out into _glassDirty by
	 * intersecting against every glass's sample rect, then clears
	 * the set.
	 */
	private readonly _userMarkedChanged = new Set<HTMLElement>();
	private _capturingGlassContent = false;
	/**
	 * Glass elements whose content image is stale and needs to be
	 * re-captured. Per-element rather than a single global flag so a
	 * mutation inside one glass subtree only re-captures that one
	 * element instead of every glass on the page.
	 */
	private readonly _glassContentDirty = new Set<HTMLElement>();
	private _fpsFrames = 0;
	private _fpsTime = 0;
	/**
	 * Shader frames rendered per animation frame, inverted: 1 draws every
	 * frame, 2 every other one. Adjusted by `_governQuality`.
	 */
	quality = 1;
	private _frameTick = 0;
	private _slowSince = 0;
	private _fastSince = 0;
	/** ms spent inside `_renderFrame` since the last governor tick. */
	private _renderMs = 0;
	private _dutyTime = 0;

	/**
	 * Trade refraction refresh rate for frame rate when the machine cannot
	 * afford both, and give it back as soon as it can.
	 *
	 * The fullscreen takeover is the case this exists for: its scene is a
	 * 4839px record that is genuinely turning, so every panel is dirty every
	 * frame and the shader pass costs roughly half the frame budget no matter
	 * how few panels there are. Measured, one surface cost as much as three —
	 * a cliff, not a gradient — so the only way to keep real glass in that mode
	 * is to run it less often rather than to take it away.
	 *
	 * Both directions are deliberately slow and asymmetric. Dropping after a
	 * sustained second of shortfall avoids flinching at a single expensive
	 * frame, and the wider band and longer window on the way back up stop the
	 * governor from oscillating around the threshold, which would look far
	 * worse than either tier on its own.
	 */
	private _governQuality(fps: number, now: number): void {
		/*
		 * Degrade only when the glass is the thing eating the frames.
		 *
		 * The original rule was `fps < 45 -> drop a tier`, and that is a one-way
		 * ratchet: `fps` counts rAF ticks, while dropping a tier skips *this loop's*
		 * rendering. When the window is slow for a reason the shader does not control
		 * — a page compositing a turning record, another application, a busy main
		 * thread — skipping glass changes nothing about the tick rate, so the
		 * governor keeps stepping down to the floor and then needs 56 fps to climb
		 * back, which never arrives. The widget windows were measured parked at
		 * quality 4, refracting about 10 times a second, which is exactly the
		 * "the dropdown shows what was behind it a while ago and never refreshes"
		 * complaint.
		 *
		 * So the trigger is now a duty cycle: the fraction of the last second this
		 * loop actually spent rendering glass. A window that is slow while its glass
		 * is cheap stays at quality 1, because degrading it would cost accuracy and
		 * buy nothing back.
		 */
		const elapsed = now - this._dutyTime;
		this._dutyTime = now;
		const duty = elapsed > 0 ? this._renderMs / elapsed : 0;
		this._renderMs = 0;

		/*
		 * Held at full rate: the caller has a surface whose whole job is to bend
		 * something that moves every frame — the video pill over a film in the page
		 * — so a tier above 1 is not a saving there, it is a visible stutter in the
		 * refraction. The duty-cycle maths still runs so the counters stay honest
		 * when the hold is released.
		 */
		if (this.holdQuality) {
			this._slowSince = 0;
			this._fastSince = 0;
			if (this.quality > 1) this.quality = 1;
			return;
		}

		if (fps < 45 && duty > 0.3) {
			this._fastSince = 0;
			if (!this._slowSince) this._slowSince = now;
			else if (now - this._slowSince >= 1200 && this.quality < 3) this.quality++;
		} else if (fps > 50 || duty < 0.12) {
			this._slowSince = 0;
			if (!this._fastSince) this._fastSince = now;
			else if (now - this._fastSince >= 2000 && this.quality > 1) this.quality--;
		} else {
			this._slowSince = 0;
			this._fastSince = 0;
		}
	}
	/**
	 * Stage timings for the last completed frame, in ms. Off unless `profile`
	 * is set, so shipping code pays nothing but the truthy check.
	 */
	profile = false;
	/** Force a GPU sync at each stage boundary. Slow, but the only honest split. */
	profileSync = true;
	_prof = {
		panels: 0,
		compose: 0,
		uploadBlur: 0,
		glassShader: 0,
		canvasCopy: 0,
		gate: 0,
		bookkeeping: 0,
		cPrepare: 0,
		cLoop: 0,
		cMedia: 0,
		cPrior: 0,
		frame: 0,
		frames: 0,
		/**
		 * Never reset, unlike `panels`. That one is the per-frame counter the render
		 * loop and `profileFrames` both clear between frames, so dividing it by the
		 * frame count reported the last frame of the run averaged over all of it:
		 * 0.14 where the truth was 17. This is the running sum.
		 */
		panelsSum: 0,
	};
	/** Completed-frame averages over the last profiling window. */
	profStats(): Record<string, number> {
		const p = this._prof;
		const n = Math.max(1, p.frames);
		return {
			frames: p.frames,
			panelsPerFrame: +(p.panelsSum / n).toFixed(2),
			composeMs: +(p.compose / n).toFixed(3),
			uploadBlurMs: +(p.uploadBlur / n).toFixed(3),
			glassShaderMs: +(p.glassShader / n).toFixed(3),
			canvasCopyMs: +(p.canvasCopy / n).toFixed(3),
			gateMs: +(p.gate / n).toFixed(3),
			bookkeepingMs: +(p.bookkeeping / n).toFixed(3),
			cPrepareMs: +(p.cPrepare / n).toFixed(3),
			cLoopMs: +(p.cLoop / n).toFixed(3),
			cMediaMs: +(p.cMedia / n).toFixed(3),
			cPriorMs: +(p.cPrior / n).toFixed(3),
			frameMs: +(p.frame / n).toFixed(3),
			fps: this.fps,
		};
	}
	profReset(): void {
		this._prof.panels = 0;
		this._prof.compose = 0;
		this._prof.uploadBlur = 0;
		this._prof.glassShader = 0;
		this._prof.canvasCopy = 0;
		this._prof.gate = 0;
		this._prof.bookkeeping = 0;
		this._prof.cPrepare = 0;
		this._prof.cLoop = 0;
		this._prof.cMedia = 0;
		this._prof.cPrior = 0;
		this._prof.frame = 0;
		this._prof.frames = 0;
		this._prof.panelsSum = 0;
	}
	/**
	 * Time N frames of real work on demand, and return the per-frame averages.
	 *
	 * This exists because sampling the live loop is not a valid measurement of
	 * per-frame cost: an unfocused Electron window runs rAF at roughly 1Hz, so a
	 * three-second sample collects a handful of frames and most of them draw
	 * nothing. Measuring the work itself needs the work driven directly, with the
	 * scene invalidated each time so every panel actually re-renders — which is the
	 * cost an optimization to the render path is supposed to reduce.
	 *
	 * Not part of the shipped render path; called from the console to get a
	 * before/after number that means something.
	 */
	profileFrames(n = 40, force = true): Record<string, number> {
		const wasProfiling = this.profile;
		this.profReset();
		const perFramePanels: number[] = [];
		this.profile = true;
		try {
			for (let i = 0; i < n; i++) {
				/*
				 * `force` picks between two different questions. Forced, every panel
				 * re-renders, which is the cost of a frame where all the glass changed
				 * — the right number for stress, the wrong one for "what does this app
				 * cost while a song plays". Unforced, the normal dirty rules apply, so
				 * only panels whose scene actually moved re-render, which is the steady
				 * state a user feels. Both are worth knowing; conflating them is how you
				 * optimize a case that never happens.
				 */
				if (force) {
					this._globalDirty = true;
					for (const el of this.glassSet) this._glassDirty.add(el);
				}
				this._prof.panels = 0;
				const t0 = performance.now();
				this._renderFrame();
				this._prof.frame += performance.now() - t0;
				this._prof.frames++;
				perFramePanels.push(this._prof.panels);
			}
		} finally {
			this.profile = wasProfiling;
		}
		// The run above leaves whatever it marked dirty still marked; hand it to a
		// frame rather than letting a resting loop sit on it.
		this._wake();
		const s = this.profStats();
		const sorted = [...perFramePanels].sort((a, b) => a - b);
		return {
			...s,
			panelsMedian: sorted[Math.floor(sorted.length / 2)],
			panelsMin: sorted[0],
			panelsMax: sorted[sorted.length - 1],
			surfaceCount: this.glassSet.size,
		};
	}

	private _observer: MutationObserver | null = null;
	private _glassSubtreeObserver: UnobservingMutationObserver | null = null;
	private _dynamicObserver: MutationObserver | null = null;
	private _needsDynamicRescan = false;

	private _sortedChildren: HTMLElement[] = [];
	/**
	 * Paint order of every registered glass. Rebuilding it walks the whole
	 * glass set for each root child, and it used to be rebuilt once per
	 * rendered panel per frame — cached and dropped whenever the set or the
	 * child order changes.
	 */
	private _orderedCache: HTMLElement[] | null = null;
	/**
	 * Per-frame memo of each element's painted bounds. A single frame composes
	 * every glass against the same wrapper children, so with a few hundred
	 * thumbnails in the list the same `getBoundingClientRect` +
	 * `getComputedStyle` pair ran thousands of times per frame and the app
	 * dropped to ~16fps. Cleared at the top of every frame.
	 */
	private readonly _boundsMemo = new Map<HTMLElement, SampleRect>();
	private readonly _mediaMemo = new Map<HTMLElement, HTMLElement[]>();
	private readonly _insideGlassMemo = new Map<HTMLElement, boolean>();
	/**
	 * Whether a media element sits under a `data-no-scene` wrapper.
	 *
	 * `data-no-capture` keeps a live UI layer's own HTML out of the scene, but
	 * it never kept its `<img>`s out: `_captureMediaDescendants` queries every
	 * img/video/canvas beneath each root child and draws the ones that touch a
	 * dirty panel. Under a virtualised track list that is sixty 150 KB covers,
	 * re-queried and re-measured for every panel that the scroll dirties, which
	 * measured at 120 ms a frame — the list crawled and the rows arriving late
	 * read as vanishing. A subtree that is interface rather than backdrop says
	 * so with `data-no-scene` and is skipped.
	 */
	private readonly _noSceneMemo = new Map<HTMLElement, boolean>();
	/** Whether a root-level layer paints anything at all this frame. */
	private readonly _visibleMemo = new Map<HTMLElement, boolean>();
	/** O(1) test for "is this one of the canvases we injected?". */
	private readonly _glassCanvasSet = new Set<HTMLCanvasElement>();
	private readonly _glassCache = new Map<HTMLElement, GlassCacheEntry>();
	private readonly _glassContentImages = new Map<HTMLElement, HTMLCanvasElement>();
	private readonly _glassLastSize = new Map<HTMLElement, SizeEntry>();
	private readonly _lastRects = new Map<HTMLElement, { x: number; y: number; w: number; h: number }>();
	/**
	 * Registered surfaces the reap has released the memory of, and why: `gone` for a
	 * node that has left the page, `offscreen` for one the viewport cannot show.
	 * See `_reapSurfaces()`.
	 */
	private readonly _idle = new Map<HTMLElement, 'gone' | 'offscreen'>();
	/** When a surface first stopped being paintable, for the sustained test. */
	private readonly _unpaintableSince = new Map<HTMLElement, number>();
	/** `performance.now()` at the last sweep of the surfaces still being painted. */
	private _departCheckAt = 0;
	/**
	 * The largest scene canvas the last rendered frame asked for. The reap needs it to
	 * know how far the grow-only buffer may come down without being grown again on the
	 * next frame; see `_trimTargets()`.
	 */
	private _frameDemandW = 0;
	private _frameDemandH = 0;
	/** Frames since the last sweep for snapshots of elements that have left the page. */
	private _reapTick = 0;
	/**
	 * The sizes of the surfaces being painted, as a string, so the expensive half of
	 * the reap — trimming the render-target pool and the shared canvases — only runs
	 * when the surfaces have genuinely changed rather than every frame. `null` means
	 * "work out again on the next sweep"; an empty string is the honest answer for a
	 * page with nothing painted, so the two are not the same value.
	 */
	private _liveSignature: string | null = null;
	private readonly _buttonStates = new Map<HTMLElement, ButtonState>();
	private readonly _buttonListeners = new Map<HTMLElement, Array<() => void>>();
	private readonly _sceneCanvas: HTMLCanvasElement;
	private readonly _sceneCtx: CanvasRenderingContext2D;

	private readonly _drag: DragState = {
		active: false,
		element: null,
		startX: 0,
		startY: 0,
		origTx: 0,
		origTy: 0,
	};

	private readonly _onResize: () => void;
	private readonly _onPointerDown: (e: PointerEvent) => void;
	private readonly _onPointerMove: (e: PointerEvent) => void;
	private readonly _onPointerUp: (e: PointerEvent) => void;
	private readonly _onScroll: (e: Event) => void;
	private readonly _onMediaState: (e: Event) => void;

	// ────────────────────────────────────────────
	// Idle resting state (all of it gated by `restWhenIdle`)
	// ────────────────────────────────────────────

	/** True while the rAF chain is stopped and the probe is the only heartbeat. */
	private _resting = false;
	/** Low-rate geometry check armed while `_resting`. */
	private _restProbeTimer = 0;
	/** Samples taken since this park, for the fast-then-slow probe schedule. */
	private _restProbeCount = 0;
	/** Consecutive frames that found nothing to do; parks at `REST_SETTLE_FRAMES`. */
	private _idleStreak = 0;
	/**
	 * A surface is waiting to be painted: its canvas was just re-sized, which
	 * cleared it, so the quality tier cannot be allowed to skip this frame.
	 */
	private _mustPaint = false;
	/** Where every registered glass was painted when the loop parked. */
	private _restRects: Array<RestGeometry & { el: HTMLElement }> = [];
	/** Where the root was when the loop parked. */
	private _restRootRect: RestGeometry | null = null;
	/** Watches the attributes a panel can move by — `style`/`class` on the panel itself. */
	private _motionObserver: UnobservingMutationObserver | null = null;
	/** Wakes the loop when a CSS transition or animation starts anywhere in root. */
	private readonly _onMotionStart: (e: Event) => void;
	// ────────────────────────────────────────────
	// Constructor (prefer LiquidGlass.init)
	// ────────────────────────────────────────────

	constructor({ root, glassElements, defaults = {} }: LiquidGlassOptions) {
		if (!root) throw new Error('LiquidGlass: `root` element is required.');

		this.root = root;
		this.defaults = { ...DEFAULTS, ...defaults };
		this.glassSet = new Set(Array.from(glassElements || []));
		this.glassCanvases = new Map();
		this.capture = new HtmlCapture(root);
		// When an async html-to-image re-capture finishes, mark only
		// the glasses whose sample rect intersects that element's
		// bounds — they're the only ones whose composed scene
		// actually changed. Other glasses on the page can keep
		// their existing shader output unchanged.
		this.capture.onCacheUpdate = (element) => {
			this._markGlassesIntersecting(element);
		};
		this.renderer = new GlassRenderer();
		this._sceneCanvas = document.createElement('canvas');
		this._sceneCtx = this._sceneCanvas.getContext('2d')!;

		// When the WebGL context is restored, invalidate all caches so
		// the render loop rebuilds everything on the next frame. This
		// is genuinely global — every shader output canvas was lost.
		this.renderer.canvas.addEventListener('webglcontextrestored', () => {
			this._glassCache.clear();
			this._globalDirty = true;
			this._wake();
		});

		this._onResize = this._handleResize.bind(this);
		this._onPointerDown = this._handlePointerDown.bind(this);
		this._onPointerMove = this._handlePointerMove.bind(this);
		this._onPointerUp = this._handlePointerUp.bind(this);
		// `scroll` does not bubble, so this is captured on the root: a list
		// sliding under a stationary panel changes the pixels behind it and
		// nothing else about the page. No DOM mutates and no panel moves, so
		// without this the glass keeps reframing the scene from where it was
		// created and the refraction visibly trails the scroll. Chromium
		// coalesces scroll events to one per frame, so this is already paced
		// to the render loop.
		this._onScroll = (e: Event) => {
			const target = e.target as HTMLElement | null;
			if (target && target.nodeType === 1) this.markChanged(target);
		};
		/*
		 * `play`, `pause` and `ended` do not bubble either, so they are captured on
		 * the root alongside `scroll`.
		 *
		 * Whether the scene contains a live video is the one fact that decides if
		 * the loop re-composites everything every frame or only what moved, and
		 * until now it was only re-read on init and on a DOM mutation. A clip that
		 * starts playing on hover mutates nothing, so the engine would keep
		 * refracting the frame it froze on; a clip that stops would leave it
		 * re-composing the whole scene forever, which on the wallpaper grid — six
		 * paused thumbnails — was measured at 110 ms a frame against 36 ms.
		 */
		this._onMediaState = () => {
			this._needsDynamicRescan = true;
			this._wake();
		};
		// A CSS transition or animation beginning is movement we cannot see in
		// the DOM, and once the loop has parked there is no frame left to notice
		// it. Both events bubble, so one listener on root covers panels and the
		// layers that carry them.
		this._onMotionStart = () => this._wake();
	}

	// ────────────────────────────────────────────
	// Lifecycle
	// ────────────────────────────────────────────

	private async _start(): Promise<void> {
		this.root.style.userSelect = 'none';
		(this.root.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';
		this._setupGlassElements();
		this._hasDynamic = this._detectDynamic();
		this._sortedChildren = this._getSortedChildren();
		this._orderedCache = null;
		this._handleResize();

		// Resolve the page's @font-face rules to base64 data URLs once
		// up front, so every subsequent html-to-image capture renders
		// text with the page's actual webfont (matching glyph metrics
		// with the live DOM under the glass).
		await this.capture.prefetchFontEmbedCSS();

		await this._captureGlassContent();
		// Pre-warm the static-content cache so the first rendered frame
		// has real DOM behind every glass panel — without this, the
		// shader briefly samples an empty (white) local scene while
		// async html-to-image captures resolve.
		await this._prewarmStaticCaptures();

		window.addEventListener('resize', this._onResize);
		this.root.addEventListener('pointerdown', this._onPointerDown);
		window.addEventListener('pointermove', this._onPointerMove);
		window.addEventListener('pointerup', this._onPointerUp);
		this.root.addEventListener('scroll', this._onScroll, true);
		this.root.addEventListener('play', this._onMediaState, true);
		this.root.addEventListener('pause', this._onMediaState, true);
		this.root.addEventListener('ended', this._onMediaState, true);

		this._observer = new MutationObserver(() => {
			// Structural mutation: painting order may have shifted,
			// every glass needs to re-render.
			this._sortedChildren = this._getSortedChildren();
			this._orderedCache = null;
			this._globalDirty = true;
			this._wake();
		});
		this._observer.observe(this.root, { childList: true });

		// Live media can appear long after boot — a movie starts, or the user
		// picks a video wallpaper. `_hasDynamic` is otherwise only recomputed
		// on init/add/remove, so without this rescan the loop keeps deciding
		// "nothing is moving", stops refreshing the shader, and the glass
		// shows a stale scene until something forces a full re-init.
		this._dynamicObserver = new MutationObserver(() => {
			this._needsDynamicRescan = true;
			this._wake();
		});
		this._dynamicObserver.observe(this.root, { childList: true, subtree: true });

		this._glassSubtreeObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				const owner = this._closestGlassAncestor(mutation.target);
				if (mutation.type === 'attributes' && mutation.attributeName === 'data-config') {
					// Config change → just re-shade this glass + any
					// glass that depends on its rendered output.
					if (owner) this._markGlassAndDependents(owner);
					continue;
				}
				// Subtree mutation → the glass's content image needs
				// to be re-captured AND its shader re-run (since the
				// content image is what we composite on top of the
				// shader output).
				if (owner) {
					this._glassContentDirty.add(owner);
					this._markGlassAndDependents(owner);
				}
			}
			this._wake();
		});
		for (const el of this.glassSet) {
			this._glassSubtreeObserver.observe(el, {
				childList: true,
				subtree: true,
				characterData: true,
				attributes: true,
				attributeFilter: ['data-config'],
			});
		}
		this._glassContentDirty.clear();

		this._armRestWatchers();

		this._running = true;
		this._globalDirty = true;
		this._rafId = requestAnimationFrame(() => this._renderLoop());
	}

	destroy(): void {
		this._running = false;
		cancelAnimationFrame(this._rafId);
		this._disarmRestWatchers();

		this.root.style.removeProperty('user-select');
		this.root.style.removeProperty('-webkit-user-select');

		window.removeEventListener('resize', this._onResize);
		this.root.removeEventListener('pointerdown', this._onPointerDown);
		window.removeEventListener('pointermove', this._onPointerMove);
		window.removeEventListener('pointerup', this._onPointerUp);
		this.root.removeEventListener('scroll', this._onScroll, true);
		this.root.removeEventListener('play', this._onMediaState, true);
		this.root.removeEventListener('pause', this._onMediaState, true);
		this.root.removeEventListener('ended', this._onMediaState, true);

		this._observer?.disconnect();
		this._observer = null;
		this._dynamicObserver?.disconnect();
		this._dynamicObserver = null;
		this._glassSubtreeObserver?.disconnect();
		this._glassSubtreeObserver = null;

		for (const [el, canvas] of this.glassCanvases) {
			canvas.width = 0;
			canvas.height = 0;
			canvas.remove();
			el.style.removeProperty('position');
			el.style.removeProperty('overflow');
			el.style.removeProperty('touch-action');
			el.classList.remove(BUTTON_CLASS);
		}
		this.glassCanvases.clear();
		this._glassCanvasSet.clear();
		this._orderedCache = null;
		this._glassCache.clear();
		for (const img of this._glassContentImages.values()) {
			img.width = 0;
			img.height = 0;
		}
		this._glassContentImages.clear();
		this._glassLastSize.clear();
		this._idle.clear();
		this._unpaintableSince.clear();
		this._departCheckAt = 0;
		this._liveSignature = null;
		// Not in the document, and the only thing keeping its store alive is this
		// field, which outlives the loop that painted into it.
		this._sceneCanvas.width = 0;
		this._sceneCanvas.height = 0;

		for (const removers of this._buttonListeners.values()) {
			for (const r of removers) r();
		}
		this._buttonListeners.clear();
		this._buttonStates.clear();

		document.getElementById(STYLE_ID)?.remove();

		this.capture.destroy();
		this.renderer.destroy();
	}

	// ────────────────────────────────────────────
	// Nested glass support
	// ────────────────────────────────────────────

	/**
	 * The root-level child an element paints under. For direct children
	 * this is the element itself; for nested glasses it's the ancestor
	 * whose z-order decides what can appear behind the glass.
	 */
	private _anchorChild(el: HTMLElement): HTMLElement | null {
		if (el.parentElement === this.root) return el;
		let p: HTMLElement | null = el.parentElement;
		while (p && p !== this.root) {
			if (p.parentElement === this.root) return p;
			p = p.parentElement;
		}
		return null;
	}

	/** Glasses registered inside a given root child, in document order. */
	private _nestedGlassesIn(rootChild: HTMLElement): HTMLElement[] {
		const out: HTMLElement[] = [];
		for (const glass of this.glassSet) {
			if (glass === rootChild) continue;
			if (this._anchorChild(glass) === rootChild) out.push(glass);
		}
		out.sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
		);
		return out;
	}

	/**
	 * Every registered glass in paint order: root-child glasses in stacking
	 * order, each followed by the nested glasses living inside it.
	 */
	private _orderedGlasses(): HTMLElement[] {
		if (this._orderedCache) return this._orderedCache;
		const out: HTMLElement[] = [];
		for (const child of this._sortedChildren) {
			if (this.glassSet.has(child)) out.push(child);
			for (const nested of this._nestedGlassesIn(child)) out.push(nested);
		}
		// Glasses whose anchor disappeared mid-frame (detached during a
		// React unmount) — render them last so their teardown stays ordered.
		for (const glass of this.glassSet) {
			if (!out.includes(glass)) out.push(glass);
		}
		this._orderedCache = out;
		return out;
	}

	/**
	 * Register a glass element after init — for UI that mounts lazily
	 * (settings panels, overlays, cards that come and go). Safe to call
	 * repeatedly for the same element.
	 */
	addGlassElement(el: HTMLElement): void {
		if (this.glassSet.has(el) || !this.root.contains(el)) return;
		this.glassSet.add(el);
		if (!this._setupSingleGlassElement(el)) {
			this.glassSet.delete(el);
			return;
		}
		// Clean slate: an element can be registered, released and registered again,
		// and a mark left by the reap on the way out must not be trusted to still
		// describe the canvas this call has just injected.
		this._idle.delete(el);
		this._unpaintableSince.delete(el);
		this._liveSignature = null;
		this._updateGlassCanvasSize(el);
		this._glassSubtreeObserver?.observe(el, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
			attributeFilter: ['data-config'],
		});
		this._orderedCache = null;
		this._hasDynamic = this._detectDynamic();
		this._globalDirty = true;
		this._observeGlassMotion(el);
		this._wake();
	}

	/**
	 * Unregister a glass element and give back everything it was holding on the GPU.
	 *
	 * This used to be a bookkeeping operation: take the canvas out of the document,
	 * forget the element from the eleven maps that keyed on it, and let the garbage
	 * collector notice the rest. Which it does — eventually, on its own schedule, and
	 * only for the JavaScript object. The canvas's backing store and the render
	 * targets sized to that canvas are the GPU process's business, and an element
	 * that leaves the page without the store being emptied leaves its pixels resident
	 * there: measured as a GPU process that sat at 386 MB through a mode switch, a
	 * takeover, and Small Potato Mode, which takes every surface away and changed it
	 * by 2 MB.
	 *
	 * Zeroing `width`/`height` is the release. It is also the only way to do it from
	 * outside a WebGL context that has already been lost, which is why every path
	 * here checks `contextLost` before touching a GL handle.
	 */
	removeGlassElement(el: HTMLElement): void {
		if (!this.glassSet.has(el)) return;
		const canvas = this.glassCanvases.get(el);
		if (canvas) {
			// A 2D context that has been handed out keeps its frame buffer alive with
			// or without the element in the document; taking the store down to nothing
			// is what hands the memory back now rather than at the next collection.
			if (canvas.width || canvas.height) {
				canvas.width = 0;
				canvas.height = 0;
			}
			canvas.remove();
			this._glassCanvasSet.delete(canvas);
		}
		this.glassCanvases.delete(el);
		this._releaseContentImage(el);
		this.capture.invalidateCache(el);
		this._idle.delete(el);
		this._unpaintableSince.delete(el);
		this._lastRects.delete(el);
		this.glassSet.delete(el);
		this._orderedCache = null;
		this._glassCache.delete(el);
		this._glassLastSize.delete(el);
		this._glassContentDirty.delete(el);
		this._glassDirty.delete(el);
		this._userMarkedChanged.delete(el);
		// The subtree observer is scoped per element and nothing else disconnects it,
		// so an unobserved panel keeps the MutationObserver's strong reference to a
		// DOM node that has otherwise been thrown away. Same for the motion watcher —
		// which only exists while `restWhenIdle` is on, and would leak identically.
		this._glassSubtreeObserver?.unobserve?.(el);
		this._motionObserver?.unobserve?.(el);
		const listeners = this._buttonListeners.get(el);
		if (listeners) {
			for (const r of listeners) r();
			this._buttonListeners.delete(el);
		}
		this._buttonStates.delete(el);
		el.classList.remove(BUTTON_CLASS);
		el.style.removeProperty('position');
		el.style.removeProperty('overflow');
		el.style.removeProperty('touch-action');
		this._hasDynamic = this._detectDynamic();
		this._globalDirty = true;
		// One fewer live size, so the pool and the shared canvases may now come down.
		this._liveSignature = null;
		this._wake();
	}

	/**
	 * Drop a glass element's captured content image, pixels and all.
	 *
	 * It is a full-size canvas — the element's own box at the render ratio — and the
	 * only reason it exists is to be composited into the scene for panels drawn above
	 * this one. Once there is no panel to draw it for, keeping it is keeping a
	 * screenshot of a subtree that may already be gone.
	 */
	private _releaseContentImage(el: HTMLElement): void {
		const img = this._glassContentImages.get(el);
		if (!img) return;
		img.width = 0;
		img.height = 0;
		this._glassContentImages.delete(el);
	}

	/**
	 * Declare that pixels *behind* the glass have changed even though the
	 * DOM did not — a canvas repainted by script, an image that swapped
	 * source, a colour that drifted.
	 *
	 * Dirty marking is otherwise driven by DOM mutation and by panels
	 * moving, so a panel that sits perfectly still over a changing
	 * backdrop keeps refracting whatever was there when it last rendered
	 * until something nudges it. One flag costs a single full re-composite
	 * on the next frame, which is what a one-off backdrop change needs.
	 */
	markSceneStale(): void {
		this._globalDirty = true;
		this._wake();
	}

	// ────────────────────────────────────────────
	// Glass element setup
	// ────────────────────────────────────────────

	private _setupGlassElements(): void {
		let needsButtonStyles = false;

		for (const el of this.glassSet) {
			if (this._setupSingleGlassElement(el)) {
				needsButtonStyles = needsButtonStyles || this._getConfig(el).button;
			} else {
				this.glassSet.delete(el);
			}
		}

		// Inject button styles once if any glass element uses button mode
		if (needsButtonStyles && !document.getElementById(STYLE_ID)) {
			const style = document.createElement('style');
			style.id = STYLE_ID;
			style.textContent = BUTTON_CSS;
			document.head.appendChild(style);
		}

	}

	/**
	 * Per-element glass setup: canvas injection, position fix, button
	 * listeners. Shared by init and the dynamic addGlassElement() API.
	 * Returns true when the element was wired up.
	 */
	private _setupSingleGlassElement(el: HTMLElement): boolean {
		// Glass elements must live inside the root. They no longer have to
		// be direct children — nested glasses compose against their root
		// ancestor's paint order (see _composeSceneForGlass).
		if (!this.root.contains(el)) {
			console.warn('LiquidGlass: glass element is not inside root, skipping.', el);
			return false;
		}

		const currentPosition = window.getComputedStyle(el).position;
		if (currentPosition === 'static') {
			el.style.position = 'relative';
		}
		el.style.overflow = 'visible';

		const config = this._getConfig(el);

		// Prevent browser from hijacking pointer events for
		// scroll/pan on floating (draggable) glass elements.
		if (config.floating) {
			el.style.touchAction = 'none';
		}

		// Button mode — cursor + hover/press shader-state listeners
		if (config.button) {
			el.classList.add(BUTTON_CLASS);
			this._setupButtonListeners(el);
		}

		const canvas = document.createElement('canvas');
		canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:-1;';
		el.insertBefore(canvas, el.firstChild);

		this.glassCanvases.set(el, canvas);
		this._glassCanvasSet.add(canvas);
		this._orderedCache = null;
		return true;
	}

	/**
	 * Walk up from a mutation target until we hit a glass element
	 * registered on this instance. Returns null if the node isn't
	 * inside any glass subtree (shouldn't normally happen since the
	 * observers are scoped to glass elements, but the mutation target
	 * may be a Text node or detached during a removal).
	 */
	private _closestGlassAncestor(node: Node): HTMLElement | null {
		let cur: Node | null = node;
		while (cur) {
			if (cur.nodeType === 1 && this.glassSet.has(cur as HTMLElement)) {
				return cur as HTMLElement;
			}
			cur = cur.parentNode;
		}
		return null;
	}

	/**
	 * Mark a glass element (and any glass that visually depends on it
	 * via z-order overlap) as needing a shader re-render on the next
	 * frame.
	 *
	 * `rectOverride` lets callers pass a rect that differs from the
	 * element's current bounding box — useful for drag, where we
	 * want to invalidate both the *old* and *new* footprints in the
	 * same call so glasses behind the dragged panel can clear its
	 * trail and glasses ahead can pick up its new shadow.
	 */
	private _markGlassAndDependents(
		element: HTMLElement,
		rectOverride?: DOMRect,
	): void {
		// 1. The element itself, if it's a glass.
		if (this.glassSet.has(element)) {
			this._glassDirty.add(element);
		}

		// 2. Glass elements rendered AFTER `element` in the painting
		//    order whose sample rect intersects element's bounds.
		//    They read element via _composeSceneForGlass (either as a
		//    non-glass contributor or via _drawPriorGlassToScene).
		const rootRect = this.root.getBoundingClientRect();
		const dpr = this._devicePixels();
		const elementDOMRect = rectOverride ?? element.getBoundingClientRect();
		// Pad by SHADOW_PAD when the element itself is a glass — its
		// rendered output extends that far past its CSS box. For non-
		// glass contributors the bounds are exact (their paint overflow
		// is handled by `_getPaintOverflowPad` at draw time, which is
		// fine for visual fidelity but not relevant to dirty marking).
		const elementBox = this._getPixelRect(
			elementDOMRect,
			rootRect,
			dpr,
			this.glassSet.has(element) ? SHADOW_PAD : 0,
		);

		let seenElement = false;
		for (const glass of this._orderedGlasses()) {
			if (glass === element) { seenElement = true; continue; }
			if (!seenElement) continue;
			const sampleRect = this._getPixelRect(
				glass.getBoundingClientRect(), rootRect, dpr, SHADOW_PAD,
			);
			if (LiquidGlass._rectsIntersect(elementBox, sampleRect)) {
				this._glassDirty.add(glass);
			}
		}
		this._wake();
	}

	/**
	 * Mark every glass element whose sample rect intersects the given
	 * element's bounding rect, regardless of stacking order. Used by
	 * the async cache-update callback (a wrapper's pixels just got
	 * fresh, so any glass that samples them needs to re-render) and
	 * by the public markChanged() API for elements outside the glass
	 * set.
	 */
	private _markGlassesIntersecting(element: HTMLElement): void {
		const rootRect = this.root.getBoundingClientRect();
		const dpr = this._devicePixels();
		const elementBox = this._getPixelRect(
			element.getBoundingClientRect(), rootRect, dpr,
			this.glassSet.has(element) ? SHADOW_PAD : 0,
		);
		for (const glass of this.glassSet) {
			if (this._idle.has(glass)) continue;
			const sampleRect = this._getPixelRect(
				glass.getBoundingClientRect(), rootRect, dpr, SHADOW_PAD,
			);
			if (LiquidGlass._rectsIntersect(elementBox, sampleRect)) {
				this._glassDirty.add(glass);
			}
		}
		this._wake();
	}

	/**
	 * Public API: mark an element (or all glass elements when called
	 * with no arguments) as needing a shader re-render on the next
	 * frame. Useful for content the library can't observe on its own —
	 * a `<canvas>` whose pixels you just updated, an `<img>` you just
	 * swapped via JS, a wrapper whose CSS background-image you just
	 * changed, etc.
	 *
	 * For elements registered via `data-dynamic`, the library already
	 * treats them as always-dirty and re-renders affected glasses
	 * every frame; calling markChanged() on them is a no-op but is
	 * harmless.
	 *
	 * @param element The element that changed visually. Pass nothing
	 * (or `undefined`) to mark every glass on this instance dirty.
	 */
	markChanged(element?: HTMLElement): void {
		if (!element) {
			this._globalDirty = true;
			this._wake();
			return;
		}
		this._userMarkedChanged.add(element);
		this._wake();
	}

	private _setupButtonListeners(el: HTMLElement): void {
		const state: ButtonState = { hover: false, pressed: false };
		this._buttonStates.set(el, state);

		// Button state change just affects this button's shader uniforms
		// (brightness on hover, zRadius/shadowSpread on press) — only
		// this glass and any glass that overlays it need to re-render.
		const mark = () => this._markGlassAndDependents(el);
		const onOver = () => { state.hover = true; mark(); };
		const onOut = () => { state.hover = false; state.pressed = false; mark(); };
		const onDown = () => { state.pressed = true; mark(); };
		const onUp = () => { state.pressed = false; mark(); };

		el.addEventListener('pointerover', onOver);
		el.addEventListener('pointerout', onOut);
		el.addEventListener('pointerdown', onDown);
		el.addEventListener('pointerup', onUp);
		el.addEventListener('pointercancel', onUp);

		this._buttonListeners.set(el, [
			() => el.removeEventListener('pointerover', onOver),
			() => el.removeEventListener('pointerout', onOut),
			() => el.removeEventListener('pointerdown', onDown),
			() => el.removeEventListener('pointerup', onUp),
			() => el.removeEventListener('pointercancel', onUp),
		]);
	}

	// ────────────────────────────────────────────
	// Glass content pre-capture
	// ────────────────────────────────────────────

	/**
	 * Re-capture the DOM content (text, icons, etc.) of glass elements
	 * whose subtrees have been mutated since the last capture, hiding
	 * the injected shader canvas so it isn't included.
	 *
	 * Pass `targets = null` to capture every glass element (used at
	 * init and on resize); pass a Set to capture only specific ones.
	 *
	 * Guarded against concurrent execution: if a capture is already
	 * running, the affected elements stay in `_glassContentDirty` and
	 * the next render-loop tick picks them up.
	 */
	private async _captureGlassContent(
		targets: Set<HTMLElement> | null = null,
	): Promise<void> {
		if (this._capturingGlassContent) return;
		this._capturingGlassContent = true;
		try {
			for (const [el, glassCanvas] of this.glassCanvases) {
				if (targets && !targets.has(el)) continue;
				// Opting a glass element out of content capture keeps the
				// shader sampling only the backdrop behind it, and avoids
				// rasterizing (potentially live) UI inside the glass.
				if (el.hasAttribute('data-no-capture')) {
					this._glassContentImages.delete(el);
					continue;
				}
				// A parked surface is not in anyone's scene this frame, and an
				// html-to-image run for it is a full-size raster of a subtree the user
				// cannot see. `_resumeSurface()` asks for it when the panel is back.
				if (this._idle.has(el)) continue;
				const rect = el.getBoundingClientRect();
				const img = await this.capture.captureToCanvas(
					el,
					rect.width,
					rect.height,
					[glassCanvas],
				);
				if (img) {
					this._glassContentImages.set(el, img);
					/*
					 * The capture is async, so it can land after the frame that asked
					 * for it has parked. A fresh content image is only useful if the
					 * panel that owns it is re-composited, and while the loop runs at
					 * display rate the next frame did that for free — resting has to
					 * ask for it explicitly.
					 */
					if (this.restWhenIdle) {
						this._glassDirty.add(el);
						this._wake();
					}
				}
			}
		} finally {
			this._capturingGlassContent = false;
			// Mutations that arrived mid-capture stayed in the live set; make sure
			// a frame is coming for them.
			if (this.restWhenIdle && this._glassContentDirty.size > 0) this._wake();
		}
	}

	/**
	 * Synchronously walk every non-glass direct child of root and
	 * await its html-to-image capture so the cache is fully populated
	 * by the time the render loop starts. Without this, the first
	 * frame's glass shader sees an empty (white) local scene for
	 * ~one or two frames while the async captures resolve.
	 */
	private async _prewarmStaticCaptures(): Promise<void> {
		for (const child of this._sortedChildren) {
			if (this.glassSet.has(child)) continue;
			const tag = child.tagName;
			if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO') continue;
			if (child.hasAttribute('data-dynamic')) continue;
			if (child.hasAttribute('data-no-capture')) continue;
			try {
				await this.capture.captureElement(child, false);
			} catch (err) {
				console.warn('LiquidGlass: prewarm capture failed:', child, err);
			}
		}
	}

	// ────────────────────────────────────────────
	// Child ordering & stacking context
	// ────────────────────────────────────────────

	private _getSortedChildren(): HTMLElement[] {
		const children = Array.from(this.root.children) as HTMLElement[];
		const rootDisplay = window.getComputedStyle(this.root).display;
		const isFlexOrGridParent =
			rootDisplay === 'flex' || rootDisplay === 'inline-flex' ||
			rootDisplay === 'grid' || rootDisplay === 'inline-grid';

		const tagged = children.map((el, domIndex) => {
			const style = window.getComputedStyle(el);
			const hasStackingContext =
				LiquidGlass._formsStackingContext(style, isFlexOrGridParent);
			const rawZ = parseInt(style.zIndex, 10);
			const zIndex = isNaN(rawZ) ? 0 : rawZ;
			return { el, domIndex, hasStackingContext, zIndex };
		});

		tagged.sort((a, b) => {
			if (!a.hasStackingContext && b.hasStackingContext) return -1;
			if (a.hasStackingContext && !b.hasStackingContext) return 1;
			if (a.hasStackingContext && b.hasStackingContext) {
				if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
			}
			return a.domIndex - b.domIndex;
		});

		return tagged.map(t => t.el);
	}

	/**
	 * Returns true when the element forms a CSS stacking context — i.e.
	 * when its z-index participates in painting order. Mirrors the spec:
	 * https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_positioned_layout/Stacking_context
	 *
	 * Used by `_getSortedChildren` to decide painting order for the
	 * local scene assembly. The set of triggers needs to match the
	 * browser's actual stacking model — otherwise overlays end up
	 * painted before the background image and get erased.
	 */
	private static _formsStackingContext(
		style: CSSStyleDeclaration,
		isFlexOrGridParent: boolean,
	): boolean {
		if (style.position !== 'static') return true;
		if (isFlexOrGridParent && style.zIndex !== 'auto') return true;
		if (parseFloat(style.opacity) < 1) return true;
		if (style.transform !== 'none' && style.transform !== '') return true;
		if (style.filter !== 'none' && style.filter !== '') return true;
		if (style.perspective !== 'none' && style.perspective !== '') return true;
		if (style.clipPath !== 'none' && style.clipPath !== '') return true;
		if (style.mixBlendMode !== 'normal' && style.mixBlendMode !== '') return true;
		if (style.isolation === 'isolate') return true;

		const bf = style.backdropFilter
			|| (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
		if (bf && bf !== 'none') return true;

		const mask = style.maskImage
			|| (style as unknown as { webkitMaskImage?: string }).webkitMaskImage;
		if (mask && mask !== 'none') return true;

		const contain = style.contain;
		if (contain && /\b(layout|paint|strict|content)\b/.test(contain)) return true;

		if (style.willChange) {
			const triggers = new Set([
				'transform', 'opacity', 'filter', 'backdrop-filter',
				'perspective', 'clip-path', 'mask', 'mask-image',
				'isolation', 'mix-blend-mode',
			]);
			const tokens = style.willChange.split(',').map(t => t.trim());
			for (const t of tokens) {
				if (triggers.has(t)) return true;
			}
		}

		return false;
	}

	private _detectDynamic(): boolean {
		// Check the entire subtree for data-dynamic elements
		// (video with data-dynamic, etc.).
		const dynEls = this.root.querySelectorAll('[data-dynamic]');
		for (const el of dynEls) {
			if (!this.glassSet.has(el as HTMLElement)) {
				return true;
			}
		}
		// Also: a video that is actually delivering frames is dynamic.
		//
		// "any video element" was the rule, and it read as safe — a video is
		// moving, so re-composite. It is wrong for a video that is sitting paused
		// on screen, which is the state every thumbnail strip and every hover
		// preview lives in: `hasDynamic` short-circuits the per-panel dirty check
		// and forces the whole scene to re-composite on every frame, forever, for a
		// picture that is not changing. Measured on the wallpaper grid — six paused
		// clips, and scrolling went from 36 ms a frame to 110 ms.
		const videos = this.root.querySelectorAll('video');
		for (const vid of videos) {
			if (this.glassSet.has(vid as unknown as HTMLElement)) continue;
			if (vid.paused || vid.ended) continue;
			return true;
		}
		return false;
	}

	// ────────────────────────────────────────────
	// Configuration
	// ────────────────────────────────────────────

	private _getConfig(el: HTMLElement): GlassConfig {
		const cachedEl = el as ConfigCachedElement;
		const configKey = el.dataset.config ?? '';

		if (cachedEl.configCacheKey !== configKey) {
			let perElement: Partial<GlassConfig> = {};
			if (configKey) {
				try {
					const parsed = JSON.parse(configKey);
					if (parsed && typeof parsed === 'object') {
						perElement = parsed as Partial<GlassConfig>;
					} else {
						console.warn('LiquidGlass: data-config must decode to an object for element:', el);
					}
				} catch (_e) {
					console.warn('LiquidGlass: invalid JSON in data-config for element:', el);
				}
			}
			cachedEl.configCache = perElement;
			cachedEl.configCacheKey = configKey;
		}

		const config = { ...this.defaults, ...(cachedEl.configCache || {}) };

		if (config.button) {
			const state = this._buttonStates.get(el);
			if (state) {
				if (state.pressed) {
					config.zRadius = config.zRadius * 0.8;
					config.shadowSpread = config.shadowSpread * 1.2;
					// brightness reset to original (no hover boost)
				} else if (state.hover) {
					config.brightness = config.brightness + 0.2;
				}
			}
		}

		return config;
	}

	// ────────────────────────────────────────────
	// Resize
	// ────────────────────────────────────────────

	private _handleResize(): void {
		const dpr = this._devicePixels();
		const rect = this.root.getBoundingClientRect();

		this.capture.resize(dpr);
		this.renderer.resize(
			Math.round(rect.width * dpr),
			Math.round(rect.height * dpr),
			this._renderScale,
		);

		for (const el of this.glassSet) {
			// An idle surface owns no canvas store right now and `_resumeSurface()`
			// sizes it from this same ratio when it comes back; re-allocating one for
			// a panel nobody can see is the opposite of what this pass is for.
			if (this._idle.has(el)) continue;
			this._updateGlassCanvasSize(el);
		}

		this._glassCache.clear();
		// Every canvas is a new size, so so is the set of sizes the render-target
		// pool has to be able to serve.
		this._liveSignature = null;
		// Resize affects every glass canvas — mark all of them dirty
		// (both content image and shader output).
		for (const el of this.glassSet) this._glassContentDirty.add(el);
		this._globalDirty = true;
		this._wake();
	}

	private _updateGlassCanvasSize(el: HTMLElement): void {
		const canvas = this.glassCanvases.get(el);
		if (!canvas) return;
		const dpr = this._devicePixels();
		// Use offsetWidth/Height — the CSS box size before transforms.
		// This prevents button hover scale from inflating the canvas.
		const elW = Math.round(el.offsetWidth);
		const elH = Math.round(el.offsetHeight);
		const padW = SHADOW_PAD * 2;
		const padH = SHADOW_PAD * 2;
		canvas.width = Math.round((elW + padW) * dpr);
		canvas.height = Math.round((elH + padH) * dpr);
		canvas.style.cssText = [
			'position:absolute',
			`left:${-SHADOW_PAD}px`,
			`top:${-SHADOW_PAD}px`,
			`width:${elW + padW}px`,
			`height:${elH + padH}px`,
			'pointer-events:none',
			'z-index:-1'
		].join(';') + ';';
		this._glassLastSize.set(el, { w: elW, h: elH });
	}

	private _checkGlassSizeChanges(): boolean {
		let changed = false;
		for (const el of this.glassSet) {
			// An idle surface has no canvas store to resize. `_resumeSurface()` gives it
			// one, at the live box, in the frame it is needed again — and it has to be
			// that path and not this one, because this one runs first and would hand the
			// memory straight back.
			if (this._idle.has(el)) continue;
			// Use offsetWidth/Height instead of getBoundingClientRect so
			// CSS transforms (e.g. button hover scale) don't trigger
			// false size-change detections and render loops.
			const w = el.offsetWidth;
			const h = el.offsetHeight;
			const last = this._glassLastSize.get(el);
			if (!last
				|| Math.abs(last.w - w) > 0.5
				|| Math.abs(last.h - h) > 0.5
			) {
				this._updateGlassCanvasSize(el);
				this._glassCache.delete(el);
				this.capture.invalidateCache(el);
				// Only this element's content image needs to be
				// re-captured, not every glass on the page.
				this._glassContentDirty.add(el);
				this._liveSignature = null;
				changed = true;
			}
		}
		return changed;
	}

	// ────────────────────────────────────────────
	// Surface reaping — bounding what the registered set costs
	// ────────────────────────────────────────────

	/**
	 * Take the memory back from the surfaces that cannot be seen, and hand it over
	 * again the frame they can.
	 *
	 * Registration is not the thing that costs memory, and until this pass existed
	 * the engine treated it as if it were: `glassSet` is the loop's work list, and an
	 * element stays in it until the app calls `removeGlassElement()` — which a React
	 * app does, but a frame later, from an observer callback, and only for the
	 * surfaces it decides are live. Everything the loop held for a surface that had
	 * left the page or the viewport stayed held: the shader canvas's backing store,
	 * the render-target set sized to it, the panel's captured content image, the
	 * html-to-image snapshot of its subtree, and the grow-only scene canvas and WebGL
	 * drawing buffer, both of which were set by the largest surface the session had
	 * ever seen rather than the largest one it was showing.
	 *
	 * What this is not: a visibility engine. `_surfacePaintable()` answers a narrow
	 * question deliberately, because the broad one — "is this panel hidden" — has
	 * answers the scene pass does not respect, and releasing a surface somebody else
	 * is refracting is a change to the look.
	 */
	private _reapSurfaces(now: number): void {
		/*
		 * Parked surfaces are asked every frame, because the frame one of them comes
		 * back is the frame its glass has to be there, and a shader canvas with no
		 * backing store is a panel that paints without its dome. Live surfaces are
		 * asked every `REAP_DEPART_MS`, because taking memory back has no deadline —
		 * and a second `getBoundingClientRect()` sweep of the whole surface set every
		 * frame is exactly the forced-layout cost `restWhenIdle` exists to remove
		 * (0.82 ms of it at twenty-six surfaces), which this pass would add on top.
		 * With the throttle and the sustained test together, a surface that leaves the
		 * page is released about three quarters of a second later.
		 */
		const sweep = now - this._departCheckAt >= REAP_DEPART_MS;
		if (sweep) this._departCheckAt = now;

		for (const el of this.glassSet) {
			if (this._idle.has(el)) {
				if (this._surfacePaintable(el)) this._resumeSurface(el);
				continue;
			}
			if (!sweep) continue;
			if (this._surfacePaintable(el)) {
				this._unpaintableSince.delete(el);
				continue;
			}
			const since = this._unpaintableSince.get(el);
			if (since === undefined) {
				this._unpaintableSince.set(el, now);
				continue;
			}
			if (now - since < REAP_SUSPEND_MS) continue;
			this._unpaintableSince.delete(el);
			// Failed the paintability test, so it is one of exactly two things: out of
			// the page, or in it but past the viewport. Which one decides whether its
			// rasters can go with it.
			this._suspendSurface(el, el.isConnected && this.root.contains(el)
				? 'offscreen'
				: 'gone');
		}

		// Rasters of subtrees that have left the page are unreachable by anything, and
		// no surface event announces them, so this is the sweep that catches them.
		if (++this._reapTick >= REAP_PRUNE_FRAMES) {
			this._reapTick = 0;
			this.capture.pruneStale();
		}

		this._trimTargets();
	}

	/**
	 * Could this surface put a pixel on the screen, or hand one to someone else's
	 * backdrop, right now?
	 *
	 * Two tests, and both are the narrow kind on purpose.
	 *
	 * The general test people reach for is `checkVisibility()` with the opacity and
	 * visibility flags. It is wrong here twice over. It is a forced style
	 * recalculation per surface per frame, which is the same class of cost the idle
	 * work measured at 0.82 ms of a 16.7 ms frame with twenty-six surfaces. And it
	 * calls a panel that is mid-fade invisible, at the
	 * exact moment the layer it belongs to is still being composited into the backdrop
	 * of the panel above it: `_drawPriorGlassToScene` blits any earlier glass whose
	 * padded rect intersects, without asking whether that element paints. Free the
	 * surface of an opacity-0 panel and a visible neighbour loses pixels it refracts
	 * today.
	 *
	 * Left with: a node that is not in the document, or in it but outside this
	 * instance's root — the scene walk only ever visits live children of root, so such
	 * a surface cannot even be a contributor — and a box wholly past the viewport by
	 * `REAP_OFFSCREEN_MARGIN`, where neither it nor its padded ring can be sampled by
	 * a fragment that is on screen.
	 *
	 * What is deliberately *not* here is the zero-size box. A `display:none` panel
	 * still has a registered canvas, and the padding makes that canvas 40 CSS px big
	 * on every side of a box that has no size, so it is a handful of kilobytes rather
	 * than a megabyte — and it sits at the root's origin, which every panel's padded
	 * sample rect reaches. That is the case where freeing it would change what
	 * someone else refracts, for a saving that is not worth making.
	 */
	private _surfacePaintable(el: HTMLElement): boolean {
		if (!el.isConnected || !this.root.contains(el)) return false;
		return this._intersectsViewport(el);
	}

	/** False when the element's box lies wholly outside the viewport, plus a margin. */
	private _intersectsViewport(el: HTMLElement): boolean {
		const r = el.getBoundingClientRect();
		const vw = window.innerWidth || this.root.clientWidth;
		const vh = window.innerHeight || this.root.clientHeight;
		return !(
			r.right <= -REAP_OFFSCREEN_MARGIN
			|| r.bottom <= -REAP_OFFSCREEN_MARGIN
			|| r.left >= vw + REAP_OFFSCREEN_MARGIN
			|| r.top >= vh + REAP_OFFSCREEN_MARGIN
		);
	}

	/**
	 * Release everything a surface holds that the next frame it is seen will need to
	 * re-make anyway.
	 *
	 * `gone` also drops the panel's captured content image and its backdrop snapshot:
	 * both are full-size rasters, and a node that has left the page is only ever
	 * coming back as a *new* element with a new registration. `offscreen` keeps them,
	 * because a panel that comes back into view by scrolling has to be refracted
	 * immediately — refilling an image is an async html-to-image run, and a panel that
	 * loses its text for two frames every time the user scrolls is a visible bug
	 * traded for an invisible one.
	 */
	private _suspendSurface(el: HTMLElement, kind: 'gone' | 'offscreen'): void {
		const canvas = this.glassCanvases.get(el);
		if (canvas && (canvas.width || canvas.height)) {
			canvas.width = 0;
			canvas.height = 0;
		}
		this._idle.set(el, kind);
		this._glassLastSize.delete(el);
		this._glassCache.delete(el);
		this._lastRects.delete(el);
		this._glassDirty.delete(el);
		this._glassContentDirty.delete(el);
		this._userMarkedChanged.delete(el);
		if (kind === 'gone') {
			this._releaseContentImage(el);
			this.capture.invalidateCache(el);
		}
		this._liveSignature = null;
	}

	/**
	 * Put a surface back on the GPU.
	 *
	 * Runs from `_reapSurfaces()`, which the render loop calls before `_renderFrame()`
	 * — so the canvas is sized, the shader re-runs and the panel's pixels are in the
	 * store in the same frame the browser composites it appearing. That ordering is
	 * the whole reason this is safe to do at all; a resume that landed a frame late
	 * would be a flash, and a flash in the glass is the one thing this file is not
	 * allowed to produce.
	 */
	private _resumeSurface(el: HTMLElement): void {
		this._idle.delete(el);
		this._updateGlassCanvasSize(el);
		this._glassDirty.add(el);
		// Re-sizing the canvas above emptied it, so this frame cannot be the one
		// the quality tier skips.
		this._mustPaint = true;
		// Panels drawn above this one read its shader canvas, so they need the frame
		// that puts it back too.
		this._markGlassAndDependents(el);
		if (!el.hasAttribute('data-no-capture') && !this._glassContentImages.has(el)) {
			this._glassContentDirty.add(el);
		}
		this._liveSignature = null;
	}

	/**
	 * Bring the shared allocations down to the surfaces that are being painted.
	 *
	 * The scene canvas and the WebGL drawing buffer are grow-only for a good reason —
	 * `_prepareSceneCanvas()` records what re-allocating one per panel costs, 2.55 ms
	 * of a 26 ms frame — and that same reason made them permanent: the biggest surface
	 * the session has ever shown set their size for the rest of the run, takeover and
	 * unmounted layers included. The renderer's pool is keyed by exact size and was
	 * only ever flushed by a window resize, so every size any panel has ever had was
	 * resident at once, three textures each.
	 *
	 * None of it is state. Every one of those buffers is cleared and written in full
	 * before the panel that reads it copies it out, which is why trimming them to the
	 * live set is a memory operation and not a visual one. Gated on the size set
	 * changing, so the cost is one reallocation per change instead of one per frame.
	 */
	private _trimTargets(): void {
		const sizes = new Set<string>();
		let maxW = 0;
		let maxH = 0;
		for (const [el, canvas] of this.glassCanvases) {
			if (this._idle.has(el)) continue;
			const w = canvas.width;
			const h = canvas.height;
			if (w <= 0 || h <= 0) continue;
			sizes.add(`${w}x${h}`);
			if (w > maxW) maxW = w;
			if (h > maxH) maxH = h;
		}
		const signature = [...sizes].sort().join(',');
		if (signature === this._liveSignature) return;
		this._liveSignature = signature;
		this.renderer.trimTo(sizes, maxW, maxH);
		/*
		 * The scene canvas is not sized by any surface: it is sized by the union of
		 * the surface and the region of the scene it samples, and a panel inside a
		 * `transform: scale()` layer — a page glide, a button press — samples more
		 * than its own box. Shrinking it to the canvas sizes alone would cut it under
		 * what the next frame asks for and pay for a re-allocation to grow it back,
		 * which is precisely the cost `_prepareSceneCanvas()` exists to avoid, so the
		 * bound is the demand of the frame that just rendered as well.
		 */
		const wantW = Math.max(maxW, this._frameDemandW);
		const wantH = Math.max(maxH, this._frameDemandH);
		/*
		 * Only on a frame that has nothing left to paint.
		 *
		 * Assigning `canvas.width` clears the canvas, and the scene canvas is the
		 * buffer every panel samples from. `_frameDemand*` is zeroed at the top of
		 * `_renderFrame` and refilled as panels are drawn, so when a frame is still
		 * pending the bound being computed here is last frame's — and during a fast
		 * scroll this frame's panels want more than that. The shrink then cut the
		 * buffer out from under them and they sampled past its edge, which is the
		 * glass going flat black mid-flick. Deferring to a quiet frame costs one
		 * reallocation and removes the class of it.
		 */
		if (this._glassDirty.size > 0
			|| this._userMarkedChanged.size > 0
			|| this._globalDirty
			|| this._hasDynamic
			|| this._drag.active) return;
		if (wantW > 0 && this._sceneCanvas.width > wantW) this._sceneCanvas.width = wantW;
		if (wantH > 0 && this._sceneCanvas.height > wantH) this._sceneCanvas.height = wantH;
	}

	/**
	 * What the glass is holding, for the console: live and parked surfaces, the size
	 * of the shared buffers, and the bytes in the render-target pool.
	 */
	memoryReport(): Record<string, number> {
		let canvasPx = 0;
		for (const canvas of this.glassCanvases.values()) {
			canvasPx += canvas.width * canvas.height;
		}
		let contentPx = 0;
		for (const img of this._glassContentImages.values()) {
			contentPx += img.width * img.height;
		}
		return {
			surfaces: this.glassSet.size,
			parked: this._idle.size,
			sceneCanvasPx: this._sceneCanvas.width * this._sceneCanvas.height,
			drawingBufferPx: this.renderer.canvas.width * this.renderer.canvas.height,
			surfaceCanvasPx: canvasPx,
			contentImagePx: contentPx,
			captureCachePx: this.capture.cachedPixels,
			renderTargetBytes: this.renderer.poolBytesHeld,
		};
	}

	// ────────────────────────────────────────────
	// Floating (drag) behaviour — Pointer Events
	// ────────────────────────────────────────────

	/** Parse the current translate(x, y) values from an element's transform. */
	private static _getTranslateXY(el: HTMLElement): [number, number] {
		const style = getComputedStyle(el);
		const matrix = style.transform;
		if (!matrix || matrix === 'none') return [0, 0];
		// matrix(a, b, c, d, tx, ty)
		const m = matrix.match(/matrix\(([^)]+)\)/);
		if (m) {
			const parts = m[1].split(',').map(Number);
			return [parts[4] || 0, parts[5] || 0];
		}
		return [0, 0];
	}

	private _handlePointerDown(e: PointerEvent): void {
		// Iterate all glass elements in reverse stacking order (topmost first).
		for (let i = this._sortedChildren.length - 1; i >= 0; i--) {
			const el = this._sortedChildren[i];
			if (!this.glassSet.has(el)) continue;

			const config = this._getConfig(el);
			if (!config.floating) continue;

			const rect = el.getBoundingClientRect();
			// Use the CSS box size (offsetWidth/Height) for hit testing,
			// but use the bounding rect position (which is correct for
			// elements positioned via CSS, grid, etc.).
			const elW = el.offsetWidth;
			const elH = el.offsetHeight;
			// The visual position includes the shadow canvas overflow.
			// Compute the element's true visual origin by centering the
			// offset size within the bounding rect.
			const visualLeft = rect.left + (rect.width - elW) / 2;
			const visualTop = rect.top + (rect.height - elH) / 2;

			if (
				e.clientX >= visualLeft && e.clientX <= visualLeft + elW &&
				e.clientY >= visualTop && e.clientY <= visualTop + elH
			) {
				const [tx, ty] = LiquidGlass._getTranslateXY(el);
				this._drag.active = true;
				this._drag.element = el;
				this._drag.startX = e.clientX;
				this._drag.startY = e.clientY;
				this._drag.origTx = tx;
				this._drag.origTy = ty;
				// A drag makes `isDragging` force every panel to re-shade, so the
				// loop has to be running to see it. Woken here, before anything
				// that can throw: a parked loop with an active drag would sit on a
				// stale scene for the whole drag.
				this._wake();
				el.style.cursor = 'grabbing';
				el.setPointerCapture(e.pointerId);
				e.preventDefault();
				break;
			}
		}
	}

	private _handlePointerMove(e: PointerEvent): void {
		if (!this._drag.active) {
			for (const el of this.glassSet) {
				const config = this._getConfig(el);
				if (!config.floating) continue;
				const rect = el.getBoundingClientRect();
				const elW = el.offsetWidth;
				const elH = el.offsetHeight;
				const visualLeft = rect.left + (rect.width - elW) / 2;
				const visualTop = rect.top + (rect.height - elH) / 2;
				if (
					e.clientX >= visualLeft && e.clientX <= visualLeft + elW &&
					e.clientY >= visualTop && e.clientY <= visualTop + elH
				) {
					el.style.cursor = 'grab';
				} else {
					el.style.cursor = '';
				}
			}
			return;
		}

		const el = this._drag.element!;
		const dx = e.clientX - this._drag.startX;
		const dy = e.clientY - this._drag.startY;
		let newTx = this._drag.origTx + dx;
		let newTy = this._drag.origTy + dy;

		// Constrain within root bounds with margin.
		// For nested elements, offsetLeft/Top is relative to offsetParent
		// (which may not be root). Use getBoundingClientRect to compute
		// the element's position relative to root, then subtract the
		// current translate to get the base (CSS layout) position.
		const rootRect = this.root.getBoundingClientRect();
		const elW = el.offsetWidth;
		const elH = el.offsetHeight;
		const elRect = el.getBoundingClientRect();
		const [curTx, curTy] = LiquidGlass._getTranslateXY(el);
		const baseLeft = (elRect.left + (elRect.width - elW) / 2) - rootRect.left - curTx;
		const baseTop = (elRect.top + (elRect.height - elH) / 2) - rootRect.top - curTy;
		const margin = 10;
		const posLeft = baseLeft + newTx;
		const posTop = baseTop + newTy;
		const maxLeft = rootRect.width - elW - margin;
		const maxTop = rootRect.height - elH - margin;
		if (posLeft < margin) newTx += margin - posLeft;
		if (posTop < margin) newTy += margin - posTop;
		if (posLeft > maxLeft) newTx -= posLeft - maxLeft;
		if (posTop > maxTop) newTy -= posTop - maxTop;

		// Mark glasses overlapping the OLD position so they re-render
		// to clear the dragged element's previous footprint, THEN move
		// the element, THEN mark glasses overlapping the NEW position
		// so they pick up its new footprint.
		const oldRect = el.getBoundingClientRect();
		this._markGlassAndDependents(el, oldRect);
		el.style.transform = `translate(${newTx}px, ${newTy}px)`;
		this._markGlassAndDependents(el);
	}

	private _handlePointerUp(_e: PointerEvent): void {
		if (!this._drag.active) return;
		const dragged = this._drag.element!;
		dragged.style.cursor = '';
		this._drag.active = false;
		this._drag.element = null;
		// `isDragging` flips off, so the per-glass gate stops forcing
		// every-frame re-renders for this glass and its overlapping
		// neighbours. Mark them once so they get a final clean render.
		this._markGlassAndDependents(dragged);
	}

	// ────────────────────────────────────────────
	// Idle resting — every entry point below is gated by `restWhenIdle`
	// ────────────────────────────────────────────

	/**
	 * Is there any work the loop would do on a frame right now?
	 *
	 * Deliberately the conjunction of every pending-work flag the loop
	 * consults, so a parked loop cannot miss a queued re-capture, a
	 * `markChanged()` that arrived from a scroll handler, a rescan someone
	 * asked for, or a drag in progress.
	 */
	private _sceneIsStatic(): boolean {
		return !this._globalDirty
			&& !this._needsDynamicRescan
			&& !this._hasDynamic
			&& !this._drag.active
			&& !this._capturingGlassContent
			&& this._glassDirty.size === 0
			&& this._glassContentDirty.size === 0
			&& this._userMarkedChanged.size === 0;
	}

	/**
	 * End of a frame: schedule the next one, or park.
	 *
	 * Parking means *not* calling `requestAnimationFrame` at all. That is the
	 * whole of the saving — an unscheduled loop asks the browser for no frames,
	 * so it pays no forced layout, no capture pass, no texture upload, and the
	 * compositor stops being woken once a second sixty times a minute.
	 */
	private _scheduleNext(): void {
		if (!this.restWhenIdle || !this._running) {
			this._rafId = requestAnimationFrame(() => this._renderLoop());
			return;
		}
		if (this._sceneIsStatic()) {
			this._idleStreak++;
			if (this._idleStreak >= REST_SETTLE_FRAMES) {
				this._park();
				return;
			}
		} else {
			this._idleStreak = 0;
		}
		this._rafId = requestAnimationFrame(() => this._renderLoop());
	}

	/** Stop the rAF chain and remember where everything is, so movement is still detectable. */
	private _park(): void {
		if (this._resting) return;
		this._resting = true;
		this._idleStreak = 0;
		this._restProbeCount = 0;
		this._snapshotRestGeometry();
		this._armRestProbe();
	}

	/**
	 * Start the loop again. Safe to call from anywhere, and a no-op when the
	 * loop is already running, which is what lets every dirty-marking path in
	 * this class simply call it.
	 */
	private _wake(): void {
		if (!this._resting) return;
		this._resting = false;
		this._idleStreak = 0;
		this._restProbeCount = 0;
		window.clearTimeout(this._restProbeTimer);
		this._restProbeTimer = 0;
		this._restRects = [];
		this._restRootRect = null;
		/*
		 * Restart the fps window. `fps` counts rAF ticks over a rolling second,
		 * so time spent parked would read as a frame-rate collapse and the
		 * quality governor would step the tier down for a scene that was simply
		 * standing still. The governor's other input, the render duty cycle, is
		 * reset for the same reason.
		 */
		this._fpsFrames = 0;
		this._fpsTime = performance.now();
		this._dutyTime = this._fpsTime;
		this._renderMs = 0;
		if (this._running) this._rafId = requestAnimationFrame(() => this._renderLoop());
	}

	private _armRestProbe(): void {
		const slow = this._restProbeCount >= REST_PROBE_FAST_SAMPLES;
		window.clearTimeout(this._restProbeTimer);
		this._restProbeTimer = window.setTimeout(
			() => this._restProbeTick(),
			slow ? REST_PROBE_SLOW_MS : REST_PROBE_MS,
		);
	}

	private _restProbeTick(): void {
		this._restProbeTimer = 0;
		if (!this._running || !this._resting) return;
		this._restProbeCount++;
		if (this._geometryMovedSincePark()) {
			this._wake();
			return;
		}
		/*
		 * A parked loop is the best case for the reap, not a problem for it: this is a
		 * scene that has been still long enough for every surface that left it to be
		 * well past `REAP_SUSPEND_MS`, and it is holding that memory for however long
		 * the user leaves it alone. So the sweep runs on the probe's own heartbeat —
		 * which is why the suspend test is measured in ms and not in frames.
		 */
		this._reapSurfaces(performance.now());
		this._armRestProbe();
	}

	private _snapshotRestGeometry(): void {
		const rr = this.root.getBoundingClientRect();
		this._restRootRect = { x: rr.left, y: rr.top, w: rr.width, h: rr.height, cw: 0, ch: 0 };
		const out: Array<RestGeometry & { el: HTMLElement }> = [];
		for (const el of this.glassSet) {
			const r = el.getBoundingClientRect();
			out.push({
				el,
				x: r.left,
				y: r.top,
				w: r.width,
				h: r.height,
				cw: el.offsetWidth,
				ch: el.offsetHeight,
			});
		}
		this._restRects = out;
	}

	/**
	 * Has anything that the loop would have noticed on a frame happened while
	 * it was asleep? Only geometry is compared — a panel that moved or resized
	 * — because that is the one class of change no listener here can see: it
	 * needs no DOM mutation and fires no event when a script or a Web Animation
	 * writes a transform. Every other wake source is event-driven and instant.
	 */
	private _geometryMovedSincePark(): boolean {
		const base = this._restRootRect;
		if (!base) return false;
		const rr = this.root.getBoundingClientRect();
		let moved = Math.abs(base.x - rr.left) > 0.5
			|| Math.abs(base.y - rr.top) > 0.5
			|| Math.abs(base.w - rr.width) > 0.5
			|| Math.abs(base.h - rr.height) > 0.5;
		for (const s of this._restRects) {
			if (moved) break;
			// A surface unregistered while parked is not a change to render.
			if (!this.glassSet.has(s.el)) continue;
			const r = s.el.getBoundingClientRect();
			moved = Math.abs(s.x - r.left) > 0.5
				|| Math.abs(s.y - r.top) > 0.5
				|| Math.abs(s.w - r.width) > 0.5
				|| Math.abs(s.h - r.height) > 0.5
				|| s.cw !== s.el.offsetWidth
				|| s.ch !== s.el.offsetHeight;
		}
		return moved;
	}

	/**
	 * Event and attribute watchers that exist only to notice the moment a
	 * resting scene stops being restful. Armed once, and they cost nothing
	 * while the loop is running: `_wake()` returns immediately unless parked.
	 */
	private _armRestWatchers(): void {
		if (!this.restWhenIdle || this._motionObserver) return;
		this.root.addEventListener('transitionstart', this._onMotionStart);
		this.root.addEventListener('transitionrun', this._onMotionStart);
		this.root.addEventListener('animationstart', this._onMotionStart);
		this._motionObserver = new MutationObserver(() => this._wake());
		// `style` and `class` are how a panel is repositioned without a CSS
		// transition (React writes them, or a rAF loop does), and how a backdrop
		// layer is swapped. The library's own canvas is a child, so observing
		// non-subtree keeps our per-frame writes out of the callback.
		this._motionObserver.observe(this.root, {
			attributes: true,
			attributeFilter: ['style', 'class', 'data-dynamic'],
		});
		for (const child of this.root.children) {
			if (child.nodeType !== 1) continue;
			this._motionObserver.observe(child as HTMLElement, {
				attributes: true,
				attributeFilter: ['style', 'class', 'data-dynamic'],
			});
		}
		for (const el of this.glassSet) this._observeGlassMotion(el);
	}

	private _disarmRestWatchers(): void {
		if (this._motionObserver) {
			this.root.removeEventListener('transitionstart', this._onMotionStart);
			this.root.removeEventListener('transitionrun', this._onMotionStart);
			this.root.removeEventListener('animationstart', this._onMotionStart);
			this._motionObserver.disconnect();
			this._motionObserver = null;
		}
		window.clearTimeout(this._restProbeTimer);
		this._restProbeTimer = 0;
		this._resting = false;
		this._idleStreak = 0;
		this._restProbeCount = 0;
		this._restRects = [];
		this._restRootRect = null;
	}

	private _observeGlassMotion(el: HTMLElement): void {
		this._motionObserver?.observe(el, {
			attributes: true,
			attributeFilter: ['style', 'class', 'data-dynamic'],
		});
	}

	// ────────────────────────────────────────────
	// Render loop
	// ────────────────────────────────────────────

	private _renderLoop(): void {
		if (!this._running) return;

		// FPS tracking
		const now = performance.now();
		this._fpsFrames++;
		if (now - this._fpsTime >= 1000) {
			this.fps = this._fpsFrames;
			this._fpsFrames = 0;
			this._fpsTime = now;
			this._governQuality(this.fps, now);
		}

		if (this._checkGlassSizeChanges()) {
			// _checkGlassSizeChanges already added the resized
			// elements to _glassDirty per-element; nothing more to do.
		}

		/*
		 * Parked surfaces are released here rather than in `_renderFrame()` because it
		 * does not always reach the body of that function: it returns early when
		 * nothing is dirty, which is most frames in a window that is showing a still
		 * album cover. Waiting for a dirty frame to free memory is how the memory got
		 * left in place in the first place.
		 */
		this._reapSurfaces(now);

		if (this._glassContentDirty.size > 0 && !this._capturingGlassContent) {
			// Snapshot the dirty set before draining: any mutations
			// that arrive while the async capture is in flight stay
			// in the live set and are picked up on the next tick.
			const targets = new Set(this._glassContentDirty);
			this._glassContentDirty.clear();
			this._captureGlassContent(targets);
		}

		/*
		 * Skipping a shader pass leaves the previous frame's glass on screen —
		 * it is a canvas that simply is not redrawn — so the cost of dropping a
		 * tier is that refraction updates at 30 Hz instead of 60. Nothing that
		 * moves sharply does: the record underneath keeps turning at whatever
		 * rate the page is running, because that is CSS, not this loop.
		 *
		 * That reasoning fails in two cases, and both were visible. A surface
		 * that was just resumed has had its canvas re-sized, which clears it, so
		 * the frame it is skipped in is a panel painted from an empty buffer —
		 * the glass going black for a beat on exactly the cards that are moving.
		 * And a scroll arrives as `markChanged()` calls rather than as dirties,
		 * because nothing in the DOM mutated, so the tier dropped the one refresh
		 * the user is watching for. Both now hold the frame.
		 */
		const mustDraw = this._mustPaint
			|| this._glassDirty.size > 0
			|| this._userMarkedChanged.size > 0
			|| this._drag.active;
		this._mustPaint = false;
		if (this.quality > 1 && !mustDraw && this._frameTick % this.quality !== 0) {
			this._frameTick++;
			this._scheduleNext();
			return;
		}
		this._frameTick++;

		try {
			if (this.profile) {
				const t0 = performance.now();
				this._prof.panels = 0;
				this._prof.compose = 0;
				this._prof.uploadBlur = 0;
				this._prof.glassShader = 0;
				this._prof.canvasCopy = 0;
				this._renderFrame();
				/*
				 * Only count frames that actually drew a panel. `_renderFrame`
				 * early-returns when nothing is dirty, and averaging those ~0.02ms
				 * no-op frames in with the real ones would make an idle app look
				 * fast and a busy app look faster still — the number has to be
				 * "cost of a frame that renders glass".
				 */
				if (this._prof.panels > 0) {
					this._prof.frame += performance.now() - t0;
					this._prof.frames++;
				}
			} else {
				const t0 = performance.now();
				this._renderFrame();
				this._renderMs += performance.now() - t0;
			}
		} catch (err) {
			console.error('LiquidGlass: render error:', err);
		}

		this._scheduleNext();
	}

	private _renderFrame(): void {
		const dpr = this._devicePixels();
		const rootRect = this.root.getBoundingClientRect();
		const isDragging = this._drag.active;
		// The memos are valid for this composition pass only: every rect is
		// read against this frame's root origin and the DOM moves between
		// frames.
		this._boundsMemo.clear();
		this._mediaMemo.clear();
		this._dynamicMemo.clear();
		this._insideGlassMemo.clear();
		this._noSceneMemo.clear();
		this._visibleMemo.clear();

		// 1. Fan out user markChanged() calls into per-glass dirty marks.
		if (this._userMarkedChanged.size > 0) {
			for (const el of this._userMarkedChanged) {
				this._markGlassesIntersecting(el);
			}
			this._userMarkedChanged.clear();
		}

		// 1b. A structural change may have added or removed live media.
		//     Re-detect at most once per frame, and only force a global
		//     re-render when the verdict actually flips.
		if (this._needsDynamicRescan) {
			this._needsDynamicRescan = false;
			const dynamicNow = this._detectDynamic();
			if (dynamicNow !== this._hasDynamic) {
				this._hasDynamic = dynamicNow;
				this._globalDirty = true;
			}
		}

		// 2. Promote any global dirty into per-element dirties so the
		//    rest of the loop only ever consults `_glassDirty`.
		if (this._globalDirty) {
			for (const el of this.glassSet) this._glassDirty.add(el);
			this._globalDirty = false;
		}

		// 2b. Realtime mode: re-render a panel only when it actually moved.
		//     A panel mid-animation otherwise keeps sampling the scene from
		//     where it was created, which reads as the refraction lagging
		//     behind the motion. Marking every panel dirty each frame instead
		//     costs a full scene re-composition and dropped the app to ~18fps
		//     while scrolling on integrated graphics, so the rect is compared
		//     and only genuine movement pays.
		if (this.realtime) {
			for (const el of this.glassSet) {
				// A parked surface has nothing to move on screen; reading its rect would
				// cost a forced layout and leave it dirty forever, since the render pass
				// below declines parked panels.
				if (this._idle.has(el)) continue;
				const rect = el.getBoundingClientRect();
				const last = this._lastRects.get(el);
				if (
					!last
					|| Math.abs(last.x - rect.left) > 0.5
					|| Math.abs(last.y - rect.top) > 0.5
					|| Math.abs(last.w - rect.width) > 0.5
					|| Math.abs(last.h - rect.height) > 0.5
				) {
					this._lastRects.set(el, {
						x: rect.left,
						y: rect.top,
						w: rect.width,
						h: rect.height,
					});
					this._glassDirty.add(el);
				}
			}
		}

		const needsRender = this._glassDirty.size > 0
			|| this._hasDynamic
			|| isDragging;
		if (!needsRender) return;

		// The frame that is about to run is the one the reap will size the scene buffer
		// from, so it starts empty. Left alone on a frame that renders nothing: a panel
		// that did not re-composite this frame may still be sitting on a sample region
		// bigger than its own box, and forgetting that would shrink the buffer the reap
		// is about to hand back to the next frame.
		this._frameDemandW = 0;
		this._frameDemandH = 0;

		// 3. Snapshot + drain the dirty set so anything added during
		//    this frame's work (e.g. async cache landings) is picked
		//    up on the next frame instead of getting clobbered.
		const dirtyTargets = new Set(this._glassDirty);
		this._glassDirty.clear();

		/*
		 * The paint-order list is rebuilt here. It is memoised, but the memo is
		 * cleared at the top of every frame, so this sorts and re-reads the whole
		 * child set each time. Timed separately because it is frame cost that no
		 * per-panel optimization can remove.
		 */
		const tOrder = this.profile ? performance.now() : 0;
		const ordered = this._orderedGlasses();
		if (this.profile) this._prof.bookkeeping += performance.now() - tOrder;

		// 4. Track which glass elements actually re-rendered this
		//    frame, with their sample rect, so later glasses in the
		//    z-order can detect "a prior glass that I overlap just
		//    re-rendered → I need to refresh too."
		const renderedThisFrame: Array<{ rect: SampleRect }> = [];

		for (const glass of ordered) {
			this._renderGlassElement(
				glass,
				rootRect,
				dpr,
				isDragging,
				dirtyTargets,
				renderedThisFrame,
			);
		}
	}

	/**
	 * Render a single glass element by composing just the scene region
	 * that can affect it, then running the shader over that local input.
	 *
	 * Whether the shader actually re-runs depends on:
	 *   - explicit dirty mark for this element (in `dirtyTargets`),
	 *   - any earlier glass in z-order that re-rendered this frame
	 *     and whose rect intersects this glass's sample rect,
	 *   - this glass having moved since last frame (position cache),
	 *   - this glass having dynamic contributors in its sample (video,
	 *     data-dynamic),
	 *   - or active drag involving this element.
	 *
	 * On render, an entry is pushed to `renderedThisFrame` so later
	 * glasses can check whether they need to refresh too.
	 */
	private _renderGlassElement(
		child: HTMLElement,
		rootRect: DOMRect,
		dpr: number,
		isDragging: boolean,
		dirtyTargets: Set<HTMLElement>,
		renderedThisFrame: Array<{ rect: SampleRect }>,
	): void {
		/*
		 * A parked surface has no canvas store to draw into and cannot be seen, so
		 * there is nothing for this pass to be for. `_reapSurfaces()` gives it back its
		 * size and its dirty mark in the frame it returns, before the frame is
		 * composited, which is what makes skipping it here invisible rather than a
		 * flash.
		 */
		if (this._idle.has(child)) return;
		const config = this._getConfig(child);
		/*
		 * Everything up to and including the "does this panel need work" decision.
		 * It is not part of the shader path, but it is per-panel per-frame, and it
		 * calls getBoundingClientRect() and _glassHasDynamicContributors() — which
		 * walks children and calls checkVisibility(), a call that forces a style
		 * recalculation. Named here so the frame cost has an owner instead of
		 * silently landing in "unaccounted".
		 */
		const tGate0 = this.profile ? performance.now() : 0;
		const elRect = child.getBoundingClientRect();
		const elW = child.offsetWidth;
		const elH = child.offsetHeight;
		const centerX = (elRect.left - rootRect.left) + elRect.width / 2;
		const centerY = (elRect.top - rootRect.top) + elRect.height / 2;
		const glassCanvas = this.glassCanvases.get(child);
		const isBeingDragged = isDragging && this._drag.element === child;
		const sampleRect = this._getPixelRect(elRect, rootRect, dpr, SHADOW_PAD);

		const cached = this._glassCache.get(child);
		const posChanged = !cached
			|| Math.abs(cached.centerX - centerX) > 0.5
			|| Math.abs(cached.centerY - centerY) > 0.5;
		const hasDynamicContributors = this._hasDynamic
			&& this._glassHasDynamicContributors(child, sampleRect, rootRect, dpr);

		// Did any earlier-rendered glass actually overlap this glass's
		// sample rect? Replaces the old monotonic `bgChanged` boolean
		// with a per-element intersection check.
		let priorGlassChanged = false;
		for (const r of renderedThisFrame) {
			if (LiquidGlass._rectsIntersect(r.rect, sampleRect)) {
				priorGlassChanged = true;
				break;
			}
		}

		const isExplicitlyDirty = dirtyTargets.has(child);

		const needsShaderRender = isDragging
			? (isBeingDragged || isExplicitlyDirty || priorGlassChanged || hasDynamicContributors)
			: (!cached || posChanged || isExplicitlyDirty || priorGlassChanged || hasDynamicContributors);

		if (this.profile) this._prof.gate += performance.now() - tGate0;

		if (needsShaderRender && glassCanvas) {
			const P = this.profile ? this._prof : null;
			const sync = this.profileSync;
			if (P) { P.panels++; P.panelsSum++; }
			/*
			 * WebGL calls return as soon as they are queued, so a plain
			 * performance.now() pair around them measures CPU submission and
			 * reports a blur as ~0ms while the GPU is still doing it. With
			 * `profileSync` on, gl.finish() is called at each stage boundary so
			 * the cost lands on the stage that actually caused it — which is the
			 * only way to tell "compose is expensive" from "blur is expensive",
			 * and the two want completely different fixes.
			 */
			const stage = (name: 'compose' | 'uploadBlur' | 'glassShader' | 'canvasCopy', from: number) => {
				if (!P) return performance.now();
				if (sync) this.renderer.gl.finish();
				const t = performance.now();
				P[name] += t - from;
				return t;
			};
			// Use glassCanvas dimensions as the authoritative size for
			// the renderer pass. sampleRect.w/h (from getBoundingClientRect)
			// can differ from glassCanvas.width/height (from offsetWidth)
			// by ±1 device pixel due to sub-pixel rounding differences.
			// If the renderer clears fewer pixels than drawImage copies,
			// the rightmost/bottom columns contain stale pixels → a thin
			// visible line. Using the same source of truth for both avoids
			// the mismatch.
			const renderW = glassCanvas.width;
			const renderH = glassCanvas.height;
			let t = P ? performance.now() : 0;
			this._composeSceneForGlass(child, sampleRect, rootRect, dpr, renderW, renderH);
			t = stage('compose', t);
			this.renderer.uploadAndBlur(
				this._sceneCanvas,
				0,
				0,
				renderW,
				renderH,
				config.blurAmount,
			);
			t = stage('uploadBlur', t);
			this.renderer.clear();
			this.renderer.renderGlassPanel(
				config,
				elW,
				elH,
				dpr,
			);
			t = stage('glassShader', t);

			const ctx = glassCanvas.getContext('2d')!;
			ctx.clearRect(0, 0, glassCanvas.width, glassCanvas.height);
			ctx.drawImage(
				this.renderer.canvas,
				0, 0, glassCanvas.width, glassCanvas.height,
				0, 0, glassCanvas.width, glassCanvas.height,
			);
			if (P) stage('canvasCopy', t);

			this._glassCache.set(child, { centerX, centerY });
			renderedThisFrame.push({ rect: sampleRect });
		}
	}

	/**
	 * Build the local input scene for a glass panel by walking only the
	 * contributors that paint before it in the stacking order.
	 */
	private _composeSceneForGlass(
		currentGlass: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
		renderW = 0,
		renderH = 0,
	): void {
		/*
		 * Sub-stage timers, because the frame profile showed compose at 46% of a
		 * 26ms frame — more than the blur pass the brief blamed. Deciding what to
		 * fix needs to know whether that is the canvas resize, the media draws, the
		 * prior-glass blits, or just walking the child list fifteen times.
		 */
		const P = this.profile ? this._prof : null;
		let t = P ? performance.now() : 0;
		/*
		 * Prepare the union of the sample rect and the renderer upload size. The
		 * two differ by up to a device pixel (getBoundingClientRect rounds
		 * differently from offsetWidth), and uploadAndBlur reads renderW x
		 * renderH — so sizing for the sample rect alone leaves the last column or
		 * row holding some other panel's pixels. Grow-only allocation turns that
		 * from a rare edge case into a permanent one, which is why it has to be
		 * handled here rather than in the caller.
		 */
		this._prepareSceneCanvas(
			Math.max(sampleRect.w, renderW),
			Math.max(sampleRect.h, renderH),
		);
		if (P) { P.cPrepare += performance.now() - t; t = performance.now(); }

		// A nested glass paints inside its root-level ancestor: everything
		// before that ancestor is behind it, everything after is above it.
		const anchor = this._anchorChild(currentGlass);
		const backdropOnly = this._getConfig(currentGlass).sceneBackdropOnly === true;
		if (P) { P.cLoop += performance.now() - t; t = performance.now(); }

		for (const child of this._sortedChildren) {
			if (child === anchor) {
				/*
				 * The transport pill sits across the foot of a scrolling column, so
				 * every card in the page is painted before it and lands in its scene —
				 * and a card passing over the pill's top edge is dragged through the
				 * bar and blurred there. That reads as a reflection trailing behind the
				 * card, and no amount of softening the bend removes it, because the
				 * bend is not what puts the card in the picture: the compositing is.
				 *
				 * A bar laid over content is not floating in it, so it samples only the
				 * layers behind the page — the wallpaper and its veil — and stops.
				 */
				if (backdropOnly) break;
				if (child !== currentGlass) {
					// Nested glass: the anchor contributes its own pixels,
					// then prior glasses nested alongside it, then stop.
					this._drawNonGlassChildToScene(child, sampleRect, rootRect, dpr);
					for (const nested of this._nestedGlassesIn(child)) {
						if (nested === currentGlass) break;
						this._drawPriorGlassToScene(nested, sampleRect, rootRect, dpr);
					}
				}
				break;
			}
			if (this.glassSet.has(child)) {
				this._drawPriorGlassToScene(child, sampleRect, rootRect, dpr);
			} else {
				this._drawNonGlassChildToScene(child, sampleRect, rootRect, dpr);
				// Glasses nested in this root child paint above it, so for
				// any glass composed after it they count as prior glass.
				for (const nested of this._nestedGlassesIn(child)) {
					if (nested === currentGlass) continue;
					this._drawPriorGlassToScene(nested, sampleRect, rootRect, dpr);
				}
			}
		}
		if (P) P.cLoop += performance.now() - t;
	}

	private _prepareSceneCanvas(width: number, height: number): void {
		/*
		 * Grow only. Assigning `canvas.width` reallocates the backing store and
		 * implicitly clears it, so with panels of different sizes the old
		 * equality test resized on almost every panel — measured at 2.55ms of a
		 * 26ms frame, entirely for re-allocating a buffer that was already big
		 * enough. Shrinking is never needed: everything outside the cleared and
		 * filled region is unread, and the caller passes the union of the sample
		 * rect and the upload size so no stale pixel can be sampled.
		 *
		 * The demand is recorded on the way through because grow-only has no way back:
		 * the buffer used to be a one-way high-water mark of the whole session. The
		 * reap reads it, so `_trimTargets()` can bring the buffer down to what a frame
		 * actually asked for rather than to what it can prove it will need.
		 */
		if (width > this._frameDemandW) this._frameDemandW = width;
		if (height > this._frameDemandH) this._frameDemandH = height;
		const c = this._sceneCanvas;
		if (c.width < width || c.height < height) {
			c.width = Math.max(width, c.width);
			c.height = Math.max(height, c.height);
		} else {
			this._sceneCtx.clearRect(0, 0, width, height);
		}
		this._sceneCtx.fillStyle = this.defaults.sceneFill;
		this._sceneCtx.fillRect(0, 0, width, height);
	}

	private _glassHasDynamicContributors(
		currentGlass: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): boolean {
		// A glass element marked data-dynamic on its own root counts
		// as always-dirty: forces every-frame shader re-runs.
		if (this._childHasDynamicContent(currentGlass)) return true;

		// Nothing painted after the glass's anchor can appear in its scene,
		// so the scan stops there (for nested glasses that's earlier than
		// the whole child list).
		const anchor = this._anchorChild(currentGlass);

		for (const child of this._sortedChildren) {
			if (child === currentGlass || child === anchor) break;
			if (this.glassSet.has(child)) continue;
			if (!this._childVisible(child)) continue;
			if (!this._childHasDynamicContent(child)) continue;
			if (this._childTouchesSample(child, sampleRect, rootRect, dpr)) {
				return true;
			}
		}
		return false;
	}

	private _childHasDynamicContent(child: HTMLElement): boolean {
		if (child.hasAttribute('data-dynamic')) return true;
		if (child.tagName === 'VIDEO') return true;
		return child.querySelector('[data-dynamic], video') !== null;
	}

	/**
	 * Whether a layer paints anything a glass panel could sample.
	 *
	 * Modes are layered, not swapped: the library stays mounted and laid out
	 * under the fullscreen takeover so returning from it is instant. Without
	 * this check its several hundred thumbnail `<img>`s are walked for every
	 * panel on every refresh — which is why the record spun smoothly from a
	 * small folder and stuttered from a large one, the only difference between
	 * the two being how many hidden rows the scene pass had to measure.
	 */
	private _childVisible(child: HTMLElement): boolean {
		const hit = this._visibleMemo.get(child);
		if (hit !== undefined) return hit;
		let visible = true;
		try {
			visible = child.checkVisibility({
				contentVisibilityAuto: true,
				opacityProperty: true,
				visibilityProperty: true,
			});
		} catch {
			// `checkVisibility` is recent; a subtree this dead is rare enough
			// that falling back to "draw it" is the safer guess.
			visible = true;
		}
		this._visibleMemo.set(child, visible);
		return visible;
	}

	private _drawNonGlassChildToScene(
		child: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): void {
		if (!this.profile) { this._drawNonGlassChildToSceneImpl(child, sampleRect, rootRect, dpr); return; }
		const t0 = performance.now();
		this._drawNonGlassChildToSceneImpl(child, sampleRect, rootRect, dpr);
		this._prof.cMedia += performance.now() - t0;
	}

	private _drawNonGlassChildToSceneImpl(
		child: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): void {
		if (!this._childVisible(child)) return;
		const tag = child.tagName;

		if (tag === 'CANVAS' || tag === 'IMG' || tag === 'VIDEO') {
			this._drawMediaElement(child, this._sceneCtx, sampleRect, rootRect, dpr);
			return;
		}

		// Wrapper-level early-out: if the wrapper's own (paint-padded)
		// bounds don't intersect the sample rect, neither it nor its
		// descendants can affect this glass panel — skip the entire
		// querySelectorAll + html-to-image work.
		//
		// Caveat: a descendant absolutely-positioned outside the
		// wrapper's box won't be drawn here. Such descendants are
		// vanishingly rare in practice; if you hit it, give the escaped
		// element its own wrapper or a `data-dynamic` annotation.
		if (!this._elementTouchesSample(child, sampleRect, rootRect, dpr)) {
			return;
		}

		// Draw any live media descendants (img/video/canvas) directly
		// from their source elements via the fast `drawImage` path,
		// since html-to-image can't rasterise videos.
		this._captureMediaDescendants(child, this._sceneCtx, sampleRect, rootRect, dpr);

		// Then composite the wrapper's HTML content via the cached
		// html-to-image snapshot. captureElement is async; concurrent
		// calls for the same element from multiple glass panels in the
		// same frame are deduped via HtmlCapture's `_capturing` set,
		// so the html-to-image pipeline runs at most once per frame
		// per element regardless of how many glasses overlap it.
		//
		// `data-no-capture` wrappers opt out of the html-to-image pass
		// entirely (only their live media descendants are drawn). Used for
		// large live UI containers whose pixels should never be frozen
		// into a raster just to be refracted.
		if (child.hasAttribute('data-no-capture')) return;
		const isDynamic = child.hasAttribute('data-dynamic');
		this.capture.captureElement(child, isDynamic);
		const rect = this._getPixelRect(child.getBoundingClientRect(), rootRect, dpr);
		this.capture.drawCachedElement(
			child,
			this._sceneCtx,
			rect.x - sampleRect.x,
			rect.y - sampleRect.y,
			rect.w,
			rect.h,
		);
		// On the very first frame nothing is in the cache yet — the
		// async capture will fire onCacheUpdate when it lands, which
		// adds the affected glasses back to _glassDirty for the next
		// frame. No need to set a dirty flag synchronously.
	}

	/**
	 * Recursively find and draw all img/video/canvas elements inside
	 * a wrapper, skipping any glass elements and their injected canvases.
	 */
	private _captureMediaDescendants(
		parent: HTMLElement,
		targetCtx: CanvasRenderingContext2D,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): void {
		let mediaEls = this._mediaMemo.get(parent);
		if (!mediaEls) {
			mediaEls = Array.from(parent.querySelectorAll<HTMLElement>('img, video, canvas'));
			this._mediaMemo.set(parent, mediaEls);
		}
		for (const htmlEl of mediaEls) {
			// Skip the injected glass shader canvases
			if (this._glassCanvasSet.has(htmlEl as HTMLCanvasElement)) continue;

			// Skip media that lives inside any glass element: it paints
			// above that glass, so it must never be sampled into a scene
			// (doing so feeds a glass its own content back, and double-
			// draws media already represented by prior-glass compositing).
			if (this._insideGlass(htmlEl)) continue;

			// `data-no-scene` wrappers hold interface artwork — a track list's
			// covers — which is the one thing that must not be refracted, and
			// the one thing whose rect is too expensive to read per frame.
			if (this._inNoScene(htmlEl, parent)) continue;

			this._drawMediaElement(htmlEl, targetCtx, sampleRect, rootRect, dpr);
		}
	}

	/**
	 * Ancestor walk from `el` up to `parent`, looking for `data-no-scene`.
	 *
	 * Memoised for the frame for the same reason `_insideGlass` is: this runs
	 * once per media element per dirty glass, and the DOM does not move between
	 * those calls.
	 */
	private _inNoScene(el: HTMLElement, parent: HTMLElement): boolean {
		const hit = this._noSceneMemo.get(el);
		if (hit !== undefined) return hit;
		let inside = false;
		let p: HTMLElement | null = el.parentElement;
		while (p && p !== parent) {
			if (p.hasAttribute('data-no-scene')) {
				inside = true;
				break;
			}
			p = p.parentElement;
		}
		this._noSceneMemo.set(el, inside);
		return inside;
	}

	/**
	 * Memoised because the whole list of thumbnails is scanned for every
	 * glass in the frame — without the cache the ancestor walk ran once per
	 * image per panel per frame.
	 */
	private _insideGlass(el: HTMLElement): boolean {
		const hit = this._insideGlassMemo.get(el);
		if (hit !== undefined) return hit;
		let inside = false;
		let p: HTMLElement | null = el.parentElement;
		while (p && p !== this.root) {
			if (this.glassSet.has(p)) {
				inside = true;
				break;
			}
			p = p.parentElement;
		}
		this._insideGlassMemo.set(el, inside);
		return inside;
	}

	/** Draw a single img/video/canvas into a local scene canvas. */
	private _drawMediaElement(
		el: HTMLElement,
		targetCtx: CanvasRenderingContext2D,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): boolean {
		const tag = el.tagName;
		// Intersect first: the rect is only worth reading for the handful of
		// media items that actually land under this panel.
		if (!this._elementTouchesSample(el, sampleRect, rootRect, dpr)) return false;
		const r = el.getBoundingClientRect();
		const rect = this._getPixelRect(r, rootRect, dpr);
		const dx = rect.x - sampleRect.x;
		const dy = rect.y - sampleRect.y;
		const dw = rect.w;
		const dh = rect.h;

		// Hidden / collapsed media element — nothing to draw, but
		// drawImage with zero dimensions throws InvalidStateError, so
		// short-circuit.
		if (dw <= 0 || dh <= 0) return false;

		if (tag === 'CANVAS') {
			const liveCanvas = el as HTMLCanvasElement;
			if (liveCanvas.width <= 0 || liveCanvas.height <= 0) return false;
			targetCtx.drawImage(liveCanvas, dx, dy, dw, dh);
			return true;
		} else if (tag === 'IMG') {
			const img = el as HTMLImageElement;
			if (!img.complete || img.naturalWidth === 0) return false;
			this._drawMediaFitted(
				targetCtx,
				img,
				img.naturalWidth,
				img.naturalHeight,
				el,
				r,
				dx,
				dy,
				dw,
				dh,
			);
			return true;
		} else if (tag === 'VIDEO') {
			const vid = el as HTMLVideoElement;
			// readyState 0 = HAVE_NOTHING (no data at all — skip).
			// readyState >= 1 = HAVE_METADATA (dimensions known; during
			// seeking the readyState may drop to 1, but drawImage still
			// draws the last decoded frame, which is far better than a
			// white hole in the glass effect).
			if (vid.readyState < 1) return false;
			try {
				this._drawMediaFitted(
					targetCtx,
					vid,
					vid.videoWidth,
					vid.videoHeight,
					el,
					r,
					dx,
					dy,
					dw,
					dh,
				);
			} catch {
				// Broken source, revoked blob URL, or decoder error —
				// skip gracefully rather than crashing the render loop.
				return false;
			}
			return true;
		}
		return false;
	}

	/** Draw an img or video onto a local scene canvas, respecting object-fit. */
	private _drawMediaFitted(
		targetCtx: CanvasRenderingContext2D,
		mediaEl: HTMLImageElement | HTMLVideoElement,
		natW: number,
		natH: number,
		child: HTMLElement,
		r: DOMRect,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
	): void {
		if (natW && natH) {
			const computed = getComputedStyle(child);
			const fit = computed.objectFit || 'fill';
			const pos = computed.objectPosition || '50% 50%';
			const src = LiquidGlass._objectFitRect(natW, natH, r.width, r.height, fit, pos);
			targetCtx.drawImage(mediaEl, src.sx, src.sy, src.sw, src.sh, dx, dy, dw, dh);
		} else {
			targetCtx.drawImage(mediaEl, dx, dy, dw, dh);
		}
	}

	private _drawPriorGlassToScene(
		child: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): void {
		if (!this.profile) { this._drawPriorGlassToSceneImpl(child, sampleRect, rootRect, dpr); return; }
		const t0 = performance.now();
		this._drawPriorGlassToSceneImpl(child, sampleRect, rootRect, dpr);
		this._prof.cPrior += performance.now() - t0;
	}

	private _drawPriorGlassToSceneImpl(
		child: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): void {
		const glassCanvas = this.glassCanvases.get(child);
		const elRect = child.getBoundingClientRect();
		/*
		 * `width > 0` is not a size check, it is the check for a parked surface: a
		 * canvas whose store the reap has released has no source rectangle, and
		 * `drawImage` throws on one rather than drawing nothing. Nothing is what it
		 * should do — the surface is either out of the page or out of the viewport, so
		 * no fragment this panel paints could have sampled it anyway.
		 */
		if (glassCanvas && glassCanvas.width > 0 && glassCanvas.height > 0) {
			const shaderRect = this._getPixelRect(elRect, rootRect, dpr, SHADOW_PAD);
			if (LiquidGlass._rectsIntersect(shaderRect, sampleRect)) {
				this._sceneCtx.drawImage(
					glassCanvas,
					0,
					0,
					glassCanvas.width,
					glassCanvas.height,
					shaderRect.x - sampleRect.x,
					shaderRect.y - sampleRect.y,
					shaderRect.w,
					shaderRect.h,
				);
			}
		}

		const contentImg = this._glassContentImages.get(child);
		if (!contentImg) return;
		const contentRect = this._getPixelRect(elRect, rootRect, dpr);
		if (!LiquidGlass._rectsIntersect(contentRect, sampleRect)) return;
		this._sceneCtx.drawImage(
			contentImg,
			contentRect.x - sampleRect.x,
			contentRect.y - sampleRect.y,
			contentRect.w,
			contentRect.h,
		);
	}

	private _getPixelRect(
		rect: DOMRect,
		rootRect: DOMRect,
		dpr: number,
		pad = 0,
	): SampleRect {
		return {
			x: Math.round((rect.left - rootRect.left - pad) * dpr),
			y: Math.round((rect.top - rootRect.top - pad) * dpr),
			w: Math.round((rect.width + pad * 2) * dpr),
			h: Math.round((rect.height + pad * 2) * dpr),
		};
	}

	private _childTouchesSample(
		child: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): boolean {
		if (this._elementTouchesSample(child, sampleRect, rootRect, dpr)) return true;

		for (const el of this._dynamicDescendants(child)) {
			if (this._elementTouchesSample(el, sampleRect, rootRect, dpr)) {
				return true;
			}
		}
		return false;
	}

	private readonly _dynamicMemo = new Map<HTMLElement, HTMLElement[]>();

	private _dynamicDescendants(child: HTMLElement): HTMLElement[] {
		let hit = this._dynamicMemo.get(child);
		if (!hit) {
			hit = Array.from(child.querySelectorAll<HTMLElement>('[data-dynamic], video'));
			this._dynamicMemo.set(child, hit);
		}
		return hit;
	}

	private _elementTouchesSample(
		element: HTMLElement,
		sampleRect: SampleRect,
		rootRect: DOMRect,
		dpr: number,
	): boolean {
		return LiquidGlass._rectsIntersect(
			this._paintedBounds(element, rootRect, dpr),
			sampleRect,
		);
	}

	/** The element's box, padded by whatever makes it paint outside of it. */
	private _paintedBounds(
		element: HTMLElement,
		rootRect: DOMRect,
		dpr: number,
	): SampleRect {
		const hit = this._boundsMemo.get(element);
		if (hit) return hit;
		const bounds = this._getPixelRect(
			element.getBoundingClientRect(),
			rootRect,
			dpr,
			this._getPaintOverflowPad(element),
		);
		this._boundsMemo.set(element, bounds);
		return bounds;
	}

	private _getPaintOverflowPad(element: HTMLElement): number {
		if (this.glassSet.has(element)) return SHADOW_PAD;

		const style = getComputedStyle(element);
		const backdropFilter = style.backdropFilter
			|| (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter;
		const maskImage = style.maskImage
			|| (style as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage;

		const paintsOutsideBounds =
			(style.boxShadow && style.boxShadow !== 'none')
			|| (style.textShadow && style.textShadow !== 'none')
			|| (style.filter && style.filter !== 'none')
			|| (backdropFilter && backdropFilter !== 'none')
			|| (maskImage && maskImage !== 'none')
			|| (style.mixBlendMode && style.mixBlendMode !== 'normal');

		return paintsOutsideBounds ? SHADOW_PAD : 0;
	}

	private static _rectsIntersect(a: SampleRect, b: SampleRect): boolean {
		return a.x < b.x + b.w
			&& a.x + a.w > b.x
			&& a.y < b.y + b.h
			&& a.y + a.h > b.y;
	}

	/** Compute the source rectangle for drawImage that replicates CSS object-fit / object-position. */
	static _objectFitRect(
		natW: number,
		natH: number,
		boxW: number,
		boxH: number,
		fit: string,
		pos: string,
	): ObjectFitRect {
		let sx = 0, sy = 0, sw = natW, sh = natH;

		if (fit === 'fill' || (fit === 'scale-down' && natW <= boxW && natH <= boxH)) {
			return { sx, sy, sw, sh };
		}

		const parts = pos.split(/\s+/);
		const parseFrac = (v: string, total: number): number => {
			if (v.endsWith('%')) return parseFloat(v) / 100;
			return parseFloat(v) / total;
		};
		const fx = parseFrac(parts[0] || '50%', boxW);
		const fy = parseFrac(parts[1] || '50%', boxH);

		if (fit === 'cover') {
			const scale = Math.max(boxW / natW, boxH / natH);
			sw = boxW / scale;
			sh = boxH / scale;
			sx = (natW - sw) * fx;
			sy = (natH - sh) * fy;
		} else if (fit === 'contain' || fit === 'scale-down') {
			return { sx: 0, sy: 0, sw: natW, sh: natH };
		} else if (fit === 'none') {
			sw = boxW;
			sh = boxH;
			sx = (natW - sw) * fx;
			sy = (natH - sh) * fy;
		}

		sx = Math.max(0, Math.min(sx, natW - 1));
		sy = Math.max(0, Math.min(sy, natH - 1));
		sw = Math.min(sw, natW - sx);
		sh = Math.min(sh, natH - sy);

		return { sx, sy, sw, sh };
	}
}
