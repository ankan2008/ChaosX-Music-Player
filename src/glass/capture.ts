import { toMediaUrl } from '../audio/engine';
import type { CaptureGeometry, WallpaperInfo } from '../vite-env.d';

/**
 * What shows through the glass of a floating widget.
 *
 * The two surfaces need different things, and conflating them is what produced
 * both of this file's bug histories. A `backdrop-filter` cannot reach what sits
 * behind a floating widget, because in a transparent window there is nothing
 * behind the page — the wallpaper and the neighbouring application belong to
 * somebody else's surface. So each surface gets its own honest source:
 *
 * **The strip shows the desktop wallpaper, placed exactly where Windows places
 * it.** The pill registers as an application desk bar and takes its own width out
 * of the work area, so nothing but the wallpaper can ever be behind the capsule.
 * The file is read from the registry and laid out with the shell's own arithmetic
 * — see `wallpaperRect()`. Nothing in this path captures the screen, so there is
 * no frame in which the strip's own pixels can appear in its own backdrop. That is
 * the "without a single reflection" property, and it holds by construction rather
 * than by a clip that has to be kept in register.
 *
 * **A dropdown shows a live grab of the monitor.** A flyout leaves the strip
 * sideways into the transparent gutter, and behind *it* is whatever application
 * happens to be there. Only a screen grab can show that, and the reflection it does
 * contain is the panel's own — which at 40px of blur converges to frost inside a
 * frame rather than blooming into a tunnel.
 *
 * Neither one uses `WDA_EXCLUDEFROMCAPTURE`. That flag is a single switch for every
 * capture on the desktop including the user's own screenshot tool, and reaching for
 * it to stop the strip bending itself is exactly what made the widgets impossible to
 * photograph.
 */

/**
 * How long the grab outlives the last panel that asked for it.
 *
 * Bringing a screen capture up costs a main-thread stall of roughly a hundred
 * milliseconds — the geometry round trip, the grant, the stream negotiating. Spent
 * on every dropdown-to-dropdown switch, that is the lag, so it is kept warm across a
 * short gap instead.
 */
const RELEASE_GRACE_MS = 4000;

/** The widget moves and its panels animate. Timers, not rAF: an occluded overlay
 *  starves below 1Hz, which is the whole reason the record used to tick. */
const TRACK_MS = 60;

/** How far past the panel the blurred frame has to overhang. */
const MICA_BLEED = 48;

/** How often a show re-asks for the wallpaper after the registry read fails. */
const WALLPAPER_TRIES = 5;
const WALLPAPER_RETRY_MS = 900;

let geometry: CaptureGeometry | null = null;
let geometryArmed = false;
let tracker = 0;

let stream: MediaStream | null = null;
let starting: Promise<void> | null = null;
let releaseTimer = 0;

/* ── The strip: the wallpaper, placed exactly as the shell places it ──────────── */

/** Everything but the file: the settings and topology that say where it goes. */
type WallpaperPlacement = Omit<WallpaperInfo, 'path'>;

/** Where the wallpaper's pixels land, in this display's CSS coordinates. */
interface StripLayout {
  /** The element's box on the display. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The sub-rectangle the image is actually painted into, once object-fit has
    had its say. The luminance probe maps the capsule through this, so the veil
    is measured from the pixels that are genuinely on screen. */
  drawnX: number;
  drawnY: number;
  drawnW: number;
  drawnH: number;
}

let strip: HTMLImageElement | null = null;
let stripHost: HTMLElement | null = null;
let wallpaper: string | null = null;
let wallpaperLoading: Promise<string | null> | null = null;
let lastClip = '';
let placement: WallpaperPlacement | null = null;
let layout: StripLayout | null = null;

/** `"r g b"` from the registry, or nothing. */
function solidCss(value: string | undefined): string {
  const parts = (value ?? '').trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return 'rgb(0, 0, 0)';
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

/**
 * Ask the main process what is set as the desktop background, and where Windows
 * puts it.
 *
 * Read from the registry rather than captured, because a capture of the whole
 * monitor contains this window — it is the one source that can put the strip inside
 * the strip. The file is served over the same `media://` scheme the tracks use, so
 * there is no second loader.
 *
 * Which also settles what this field is worth. `wallpaper` is a `media://` string —
 * a few dozen bytes of percent-encoded path, not a data URL — so nothing about the
 * album-art backdrop's memory lives here, and shrinking it would reclaim nothing.
 * What is resident behind the capsule is the decoded `<img>` the URL points at, at
 * the desktop picture's own resolution rather than the capsule's: a 1920x1080
 * wallpaper is 8.3 MB of RGBA serving a strip 48 px tall, which is the desk-bar
 * reservation the work area reports. That one is deliberate and stays. The strip is the pill's refraction source, it is magnified
 * by the shell's own placement arithmetic rather than by a resampler this file
 * controls, and it is bounded by there being exactly one capsule on the desktop.
 *
 * A null answer is not cached, and `askForWallpaper` re-asks it a few times. The
 * read is a child process, so it can fail for a reason that fixes itself a second
 * later; latching that failure would leave the capsule with no backdrop for the rest
 * of the window's life, which is indistinguishable from the glass not working.
 */
function loadWallpaper(force = false): Promise<string | null> {
  if (wallpaper && !force) return Promise.resolve(wallpaper);
  if (wallpaperLoading) return wallpaperLoading;
  wallpaperLoading = (async () => {
    try {
      const info = await window.electronAPI?.desktop?.wallpaper?.();
      if (!info?.path) return null;
      placement = info;
      return toMediaUrl(info.path);
    } catch {
      return null;
    }
  })().then((url) => {
    wallpaperLoading = null;
    if (url) wallpaper = url;
    return url;
  });
  return wallpaperLoading;
}

/**
 * Load the wallpaper for this show, retrying a failed read while the strip is up.
 *
 * Bounded and abandoned on release: a desktop with a solid colour and no picture
 * returns null forever, and a widget that is no longer on screen must not keep
 * spawning `reg.exe`.
 */
function askForWallpaper(alive: () => boolean): void {
  let tries = 0;
  const ask = () => {
    void loadWallpaper(true).then((url) => {
      if (!alive()) return;
      if (url) {
        applyWallpaper(url);
        return;
      }
      if (++tries < WALLPAPER_TRIES) window.setTimeout(ask, WALLPAPER_RETRY_MS);
    });
  };
  ask();
}

/**
 * Point the capsule's backdrop at a file, forcing a fresh decode when it changed.
 *
 * Assigned to `src` rather than to an attribute so a `media://` URL with an encoded
 * drive letter is not re-encoded on the way through.
 */
function applyWallpaper(url: string): void {
  if (!strip || strip.getAttribute('src') === url) return;
  strip.removeAttribute('src');
  strip.src = url;
}

/** The strip's box, in the same CSS pixels the window reports. */
function capsule(): DOMRect | null {
  const el = document.querySelector('.float-pill');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

/**
 * Where Windows actually draws the wallpaper, in this display's CSS pixels.
 *
 * The shell's rules are not "stretch it over the monitor":
 *
 *   Center, Tile, Mirror and Span are positioned against the **virtual desktop** —
 *   the union of every monitor — so on a two-monitor rig a centred wallpaper hangs
 *   half off each screen. Fit, Fill and Stretch are computed **per monitor**.
 *
 *   Fit scales down to sit inside the target and leaves bars behind it; Fill scales
 *   up to cover it and crops; Stretch distorts to fill exactly; Center does not
 *   scale at all.
 *
 * Getting this wrong does not look like a bug. It looks like the strip is reflecting
 * something that is not there, because it is blurring the right picture sampled at
 * the wrong coordinates — and after the last two attempts at this, "looks like a
 * reflection" is precisely the failure to avoid.
 *
 * Tiling is folded into Fill: a wallpaper repeated at native size and then blurred
 * 40px deep is indistinguishable from one that covers the same area, and it keeps
 * the backdrop a single element rather than a repeat pattern.
 */
function wallpaperRect(natural: { w: number; h: number }): StripLayout | null {
  if (!placement || !geometry) return null;
  if (natural.w <= 0 || natural.h <= 0) return null;
  const sf = geometry.scaleFactor || 1;
  const dw = geometry.displayWidth;
  const dh = geometry.displayHeight;
  // The display this window is on. Matched by size because `captureGeometry`
  // reports DIP bounds and the registry read gives no id to correlate.
  const here =
    placement.displays.find((d) => Math.round(d.width) === Math.round(dw) && Math.round(d.height) === Math.round(dh))
    ?? placement.displays[0];
  if (!here) return null;

  const style = parseInt(placement.style, 10) || 0;
  const tiled = placement.tile === '1';
  const againstVirtual = tiled || style === 0 || style === 10;
  const target = againstVirtual && placement.virtual ? placement.virtual : here;

  // Device pixels of the surface the shell scales against.
  const tw = target.width * sf;
  const th = target.height * sf;
  let scale = 1;
  let bars = false;
  if (tiled || style === 0) scale = 1;                                  // Tile / Center
  else if (style === 6) { scale = Math.min(tw / natural.w, th / natural.h); bars = true; }
  else scale = Math.max(tw / natural.w, th / natural.h);                // Fill / Span / Stretch

  const w = natural.w * scale;
  const h = natural.h * scale;
  // Centred on the target, then shifted by where this display sits inside it.
  const left = ((tw - w) / 2 - (here.x - target.x) * sf) / sf;
  const top = ((th - h) / 2 - (here.y - target.y) * sf) / sf;

  if (bars) {
    // Fit: the element covers the display, the image is letterboxed inside it, and
    // the bars take the desktop's own solid colour.
    return { x: 0, y: 0, w: dw, h: dh, drawnX: left, drawnY: top, drawnW: w / sf, drawnH: h / sf };
  }
  return { x: left, y: top, w: w / sf, h: h / sf, drawnX: left, drawnY: top, drawnW: w / sf, drawnH: h / sf };
}

/**
 * Lay the wallpaper where the desktop shows it, then cut it down to the capsule.
 *
 * Clipping is not cosmetic: unpainted, the element covers the widget's transparent
 * gutter with a copy of the desktop and the application beside the pill looks
 * duplicated and frozen. The insets are measured from the element's own border box,
 * so they stay correct however the element is sized or moved — which is what let the
 * placement above stop being "assume the element is the display".
 */
function placeStrip(): void {
  const el = strip;
  if (!el || !stripHost || !geometry) return;
  if (el.parentElement !== stripHost) stripHost.appendChild(el);
  // Set on every pass, not just on mount: the wallpaper resolves asynchronously and
  // the first `placeStrip()` can run before there is anything to show.
  if (wallpaper && !el.getAttribute('src')) el.src = wallpaper;
  const c = capsule();
  if (!c) return;
  const { offsetX, offsetY, displayWidth: dw, displayHeight: dh } = geometry;

  layout = wallpaperRect({ w: el.naturalWidth, h: el.naturalHeight });
  // Until the image decodes there is no geometry to honour, so cover the display.
  const box = layout ?? { x: 0, y: 0, w: dw, h: dh, drawnX: 0, drawnY: 0, drawnW: dw, drawnH: dh };

  /*
   * A letterboxed wallpaper (`Fit`) needs the element to cover the whole display and
   * the image centred inside it; every other placement gives the element exactly the
   * box the shell scales into, so `fill` reproduces the shell's arithmetic rather
   * than fighting it.
   */
  const bars = !!layout && (Math.abs(box.drawnW - box.w) > 0.5 || Math.abs(box.drawnH - box.h) > 0.5);
  el.style.objectFit = bars ? 'contain' : 'fill';
  el.style.background = bars ? solidCss(placement?.solid) : 'none';

  const host = document.querySelector('.float-pill');
  const round = host ? getComputedStyle(host).borderTopLeftRadius : '0px';
  // Insets from the element's own border box, so they follow the placement instead
  // of assuming the element is the display.
  const elLeft = box.x - offsetX;
  const elTop = box.y - offsetY;
  const clip =
    `inset(${c.top - elTop}px ${elLeft + box.w - (c.left + c.width)}px ` +
    `${elTop + box.h - (c.top + c.height)}px ${c.left - elLeft}px round ${round})`;

  el.style.position = 'fixed';
  el.style.left = `${elLeft}px`;
  el.style.top = `${elTop}px`;
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
  if (clip !== lastClip) {
    lastClip = clip;
    el.style.clipPath = clip;
  }
}

/**
 * Measure the slice of wallpaper that is actually behind the capsule.
 *
 * The strip's veil adapts to this the same way a dropdown's does, so it has to come
 * from the same quantity — the region the widget covers, not the whole monitor.
 * Averaging the entire wallpaper would report nearly the same number whatever the
 * desktop looked like, which defeats the point of an adaptive veil.
 *
 * Mapped through `drawn*` rather than the element box, so a letterboxed Fit
 * wallpaper is measured from the picture and not from its bars.
 *
 * The source is a static image, so this runs on load and on a window move — never
 * on the 60 ms timer, because a per-tick `getImageData` is the kind of cost that has
 * already cost this window its frame rate once.
 */
function measureStrip(el: HTMLImageElement): void {
  const host = document.querySelector<HTMLElement>('.float-pill');
  if (!host || !probeCtx || !geometry || !layout) return;
  const c = capsule();
  if (!c || el.naturalWidth <= 0) return;
  try {
    const sx = ((c.left + geometry.offsetX) - layout.drawnX) / layout.drawnW * el.naturalWidth;
    const sy = ((c.top + geometry.offsetY) - layout.drawnY) / layout.drawnH * el.naturalHeight;
    const sw = (c.width / layout.drawnW) * el.naturalWidth;
    const sh = (c.height / layout.drawnH) * el.naturalHeight;
    probeCtx.drawImage(el, sx, sy, sw, sh, 0, 0, 4, 4);
    const d = probeCtx.getImageData(0, 0, 4, 4).data;
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      sum += (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    }
    host.style.setProperty('--mica-lum', Math.min(1, Math.max(0, sum / 16)).toFixed(3));
  } catch {
    /* A wallpaper we cannot read leaves the veil at its default weight. */
  }
}

/* ── The panels: a live grab of the monitor ───────────────────────────────────── */

type Mica = { el: HTMLVideoElement; rect: () => DOMRect | null };
const micas = new Set<Mica>();

/**
 * The one panel that is actually decoding the grab.
 *
 * Every panel's mica is the whole monitor: `.mica-layer` is `object-fit: fill` and
 * sized to `displayWidth + bleed` so the desktop pixel under the panel's corner
 * lands at that corner (see `layoutMicas`). Two live layers is therefore two
 * monitor-sized compositor textures — the largest single allocation in this file —
 * each pulling its own copy of a stream that only has to be decoded once. The
 * surfaces that need it are already mutually exclusive: opening a dropdown closes
 * the last (`closeActive` in MorphingGlassPanel), so exactly one is on screen. Keep
 * the newest mounted panel bound and hand the stream back to the next still-mounted
 * one when it lets go. The strip is not in this set (it samples the wallpaper, never
 * the grab), so its refraction is untouched by any of this.
 */
let liveMica: Mica | null = null;

/** Bind the newest connected panel to the grab and release every other layer. */
function enforceLiveCap(): void {
  let newest: Mica | null = null;
  for (const m of micas) if (m.el.isConnected) newest = m;
  for (const m of micas) {
    if (m === newest || !m.el.isConnected) continue;
    m.el.pause();
    m.el.srcObject = null;
  }
  if (newest && newest !== liveMica && stream) {
    newest.el.srcObject = stream;
    roll(newest.el);
  }
  liveMica = newest;
}

/**
 * Read the average colour of the slice a panel is sitting on.
 *
 * The user asked for the dropdown tint to be "way lighter, adapting to whatever
 * colour is there behind them". A fixed veil cannot do that: the same charcoal that
 * keeps white labels legible over a cream wallpaper buries the blur over a dark one,
 * which is the whole complaint. So the veil's opacity is derived from the backdrop's
 * own luminance — barely there when there is nothing to wash out, and only as heavy
 * as the brightest thing behind it requires.
 *
 * A 4x4 downscale is a fraction of a millisecond, and it rides the existing timer
 * rather than a frame loop.
 */
const probe = document.createElement('canvas');
probe.width = 4;
probe.height = 4;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
let probeTick = 0;

function measureMicas(): void {
  if (!probeCtx) return;
  // The live layer is the only one holding a frame; the others are parked at
  // `srcObject = null` and would read `readyState 0`.
  const src = (liveMica ?? micas.values().next().value)?.el;
  if (!src || src.readyState < 2) return;
  try {
    probeCtx.drawImage(src, 0, 0, 4, 4);
    const d = probeCtx.getImageData(0, 0, 4, 4).data;
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      sum += (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    }
    const lum = Math.min(1, Math.max(0, sum / 16));
    for (const m of micas) {
      const panel = m.el.parentElement;
      if (panel) panel.style.setProperty('--mica-lum', lum.toFixed(3));
    }
  } catch {
    /* A frame we cannot read is not worth a panel over. */
  }
}

function layoutMicas(): void {
  if (!geometry) return;
  let reaped = false;
  for (const m of micas) {
    /*
     * A panel whose element is no longer in the document cannot be served by this
     * entry any more, and nothing is going to delete it: the release a component's
     * cleanup returns is the only other way out, and a node removed by a hot reload
     * or by a parent that was thrown away mid-animation never runs one. Every entry
     * left behind keeps a `<video>` bound to the display grab, which is a decoded
     * frame and a compositor layer at the size of the *monitor* — the largest single
     * per-panel cost in this file, and one that outlives the panel.
     *
     * A detached element paints nothing, so letting go of it here cannot be seen.
     */
    if (!m.el.isConnected) {
      m.el.pause();
      m.el.srcObject = null;
      if (m === liveMica) liveMica = null;
      micas.delete(m);
      reaped = true;
      continue;
    }
    const r = m.rect();
    if (!r || r.width <= 0 || r.height <= 0) continue;
    m.el.style.width = `${geometry.displayWidth + MICA_BLEED * 2}px`;
    m.el.style.height = `${geometry.displayHeight + MICA_BLEED * 2}px`;
    m.el.style.left = `${-(geometry.offsetX + r.left) - MICA_BLEED}px`;
    m.el.style.top = `${-(geometry.offsetY + r.top) - MICA_BLEED}px`;
  }
  /*
   * A reaped layer was the only thing bound to the grab, so the panel still on
   * screen — a sheet under a dropdown that a hot reload tore out — is currently
   * dark. Hand it the stream rather than waiting for the next mount or release to
   * do it.
   */
  if (reaped) enforceLiveCap();
  // Roughly every 250 ms rather than every 60 ms tick.
  if (probeTick++ % 4 === 0) measureMicas();
}

function tick(): void {
  // A widget that came up before main had finished positioning it reads no
  // geometry at all, so the timer keeps asking until it does.
  if (!geometry) void readGeometry();
  placeStrip();
  layoutMicas();
}

async function readGeometry(): Promise<CaptureGeometry | null> {
  if (geometry) return geometry;
  const geo = await window.electronAPI?.overlay?.captureGeometry?.();
  if (geo) geometry = geo;
  return geometry;
}

/**
 * Both consumers need to know where this window sits on which display, and the
 * answer changes when the widget is dragged or re-docked.
 *
 * The listener and the timer are armed before the first read, not after it. A
 * freshly created overlay can answer `null` here — main has not finished docking
 * the strip into the work area yet — and returning early used to skip the arming,
 * which left the pill with no backdrop mechanism at all for the life of the
 * document: the strip was never even appended.
 */
async function ensureGeometry(): Promise<CaptureGeometry | null> {
  if (!geometryArmed) {
    geometryArmed = true;
    window.electronAPI?.overlay?.onGeometry?.((g) => {
      if (!g) return;
      geometry = g;
      // The capsule is over a different part of the wallpaper now, so both the clip
      // and the veil's weight have to be recomputed.
      if (strip && strip.complete) {
        placeStrip();
        measureStrip(strip);
      }
    });
  }
  if (!tracker) tracker = window.setInterval(tick, TRACK_MS);
  return readGeometry();
}

/**
 * Put a live frame on a media element fed by a `MediaStream`.
 *
 * Setting `srcObject` is not enough. The load algorithm runs, `readyState` climbs
 * to 4 and the element looks healthy in every probe — but a media element with no
 * `autoplay` and no `play()` stays `paused`, and a *paused* element on a live stream
 * paints nothing at all. That is the whole of "the dropdowns are a mere dark tint, no
 * blur": the panel's mica was bound, measured, aligned to the display and filtered
 * correctly, and held a black frame forever, so the only pixel anyone could see was
 * the veil underneath it.
 */
function roll(el: HTMLVideoElement): void {
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  void el.play().catch(() => undefined);
}

/** Attach a panel's own copy of the screen. Returns the release. */
export function mountPanelMica(
  el: HTMLVideoElement,
  rect: () => DOMRect | null,
): () => void {
  const entry: Mica = { el, rect };
  micas.add(entry);
  /*
   * A close and a re-open inside the grace window is one continuous session, and
   * the timer the close armed has to be cancelled by the re-open. It used to not be,
   * so the stream died four seconds after the first close with a panel still open on
   * screen — a mica that blurred the desktop and then went grey.
   */
  window.clearTimeout(releaseTimer);
  releaseTimer = 0;
  el.className = 'mica-layer';
  el.setAttribute('data-no-capture', '');
  if (!stream && !starting) {
    starting = startCapture().catch(() => { starting = null; });
  }
  /*
   * The newest panel is the one on screen, so it is the one that gets the frame;
   * `enforceLiveCap` releases whatever older layer was holding it. On a cold start
   * there is no stream yet and this simply records the newest — `startCapture` runs
   * the same call once the grab lands.
   */
  enforceLiveCap();
  layoutMicas();
  return () => {
    micas.delete(entry);
    el.pause();
    el.srcObject = null;
    // Hand the grab to the next panel still on screen (a sheet under a dropdown
    // that has just closed), or let go of the record if there is none.
    if (liveMica === entry) liveMica = null;
    enforceLiveCap();
    if (micas.size > 0 || releaseTimer) return;
    releaseTimer = window.setTimeout(stopCapture, RELEASE_GRACE_MS);
  };
}

async function openStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: 60, max: 60 },
      width: { ideal: Math.round((geometry?.displayWidth ?? 1920) * (window.devicePixelRatio || 1)) },
      height: { ideal: Math.round((geometry?.displayHeight ?? 1080) * (window.devicePixelRatio || 1)) },
    },
    audio: false,
    /*
     * There is no way to ask for the frame without the mouse pointer in it. The
     * Screen Capture level-3 `cursor` constraint is accepted and silently ignored by
     * this Chromium (`applyConstraints({cursor:'never'})` resolves and leaves
     * `getSettings().cursor` at `"always"`), so the pointer appears in a panel's
     * glass when it is over that panel. Clipping to the panel's own box is what
     * keeps that from being the disaster it was when it covered the whole gutter.
     */
    selfBrowserSurface: 'include',
    preferCurrentTab: false,
    surfaceSwitching: 'exclude',
  } as MediaStreamConstraints);
}

async function startCapture(allowEmpty = false): Promise<void> {
  try {
    await ensureGeometry();
    if (!geometry || (micas.size === 0 && !allowEmpty)) return;
    const next = await openStream();
    if (micas.size === 0) {
      /*
       * A pre-warmed grab with nothing mounted to it yet is kept — that is the
       * whole point — but it is kept on a leash. The release timer is the same one
       * a closing panel arms, so a pointer that entered the strip and never clicked
       * a button costs the machine a grab for four seconds and then stops.
       */
      if (!allowEmpty) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = next;
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(stopCapture, RELEASE_GRACE_MS);
      return;
    }
    stream = next;
    // One layer decodes, however many panels are mounted.
    enforceLiveCap();
    next.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (micas.size === 0) stopCapture();
    });
  } catch {
    /*
     * A machine can refuse display capture outright. Nothing here may throw out of
     * the controller: a panel keeps its tint, which is duller than mica and never
     * black.
     */
    stopCapture();
  } finally {
    /*
     * Cleared on every exit, including the early returns above. It used to be left
     * set by them, and since it doubles as the "a grab is already coming up" latch,
     * one abandoned attempt at cold start silenced the capture for the rest of the
     * window's life: every later panel found `starting` truthy and never asked
     * again, so its mica was an empty black rectangle.
     */
    starting = null;
  }
}

function stopCapture(): void {
  window.clearTimeout(releaseTimer);
  releaseTimer = 0;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  for (const m of micas) {
    m.el.pause();
    m.el.srcObject = null;
  }
  liveMica = null;
  starting = null;
  /*
   * The 60 ms tracker is here to keep the strip's clip and the panels' slice in
   * register with the display. Once neither consumer is mounted there is nothing to
   * keep in register, and stopping the capture used to leave that interval running
   * — `ensureGeometry` armed it and only the backdrop release reached for it, and
   * only when `stripHost` had already been cleared. A panel that opened on its own
   * and closed therefore orphaned a timer for the life of the document. This is the
   * single place both consumers check out, so it is the single place the timer goes.
   */
  if (!stripHost && micas.size === 0) {
    window.clearInterval(tracker);
    tracker = 0;
  }
}

/**
 * Ask for the screen grab before any panel needs it.
 *
 * `getDisplayMedia` plus the geometry round trip costs the better part of a second
 * cold, and a dropdown that opens while that is in flight is a second of interface
 * drawn on nothing — the panel morphs out of its button, shows text over the
 * desktop with no surface behind it, and then the gaussian lands. The user reads
 * that as the background loading late, because that is what it is.
 *
 * So the grab is started on the pointer entering the widget instead. Reaching for a
 * control means the cursor is already on the strip, and the time it spends there —
 * long enough to read the track title, which is the reason the strip is on screen —
 * is longer than the grab takes.
 */
export function prewarmCapture(): void {
  /*
   * A grab is already up or on its way, so hover has nothing to do here. It used
   * to re-arm the release leash on this branch, which meant a cursor walked across
   * the pill — firing `pointerenter` on every control it crossed — refreshed the
   * four-second timer each time and kept a whole-monitor 60 fps capture alive for
   * as long as the mouse stayed anywhere in the widget. Hover is not a consumer.
   * The idle leash a warm pre-warmed grab already carries is left to expire on its
   * own; a panel that genuinely opens re-arms through `mountPanelMica`.
   */
  if (stream || starting) return;
  starting = startCapture(true).catch(() => {
    starting = null;
  });
}

/**
 * Show the wallpaper through the capsule for as long as the pill is on screen.
 *
 * Returns the release. The caller keys it to visibility rather than to the window's
 * life, because collapsing a widget only hides it, and a hidden pill that keeps a
 * full-monitor image mounted pays for pixels nobody is looking at.
 *
 * The placement is re-read on every show rather than cached for the window's life,
 * because Windows Spotlight and a slideshow change the file underneath us and the
 * strip would otherwise keep blurring yesterday's desktop. One registry query per
 * appearance is not a cost worth arguing about.
 */
export function mountDesktopBackdrop(root: HTMLElement): () => void {
  stripHost = root;
  if (!strip) {
    const img = document.createElement('img');
    img.className = 'pill-desktop';
    img.setAttribute('data-no-capture', '');
    img.alt = '';
    img.addEventListener('load', () => {
      // The geometry only becomes knowable once the pixels exist.
      placeStrip();
      measureStrip(img);
    });
    strip = img;
  }
  void ensureGeometry().then(() => placeStrip());
  // `stripHost` is the liveness test: once the pill has been released, the retry
  // chain has nothing left to paint and must stop asking.
  askForWallpaper(() => stripHost === root);
  return () => {
    stripHost = null;
    strip?.remove();
    /*
     * The box the wallpaper is painted into is stale the moment the capsule is gone,
     * and `onGeometry` outlives this release — it is armed once for the life of the
     * document, and a window move or a re-dock that lands while the widget is
     * collapsed still calls it. `placeStrip()` stops itself without a host, so it
     * never refreshes the layout, but `measureStrip()` reads whatever is in the field
     * and would write a luminance measured against the old box onto a pill that is not
     * on screen — the veil comes back the wrong weight when the user expands it again.
     *
     * What is deliberately *not* released here is `strip` and `wallpaper`. The image
     * is one decoded copy of the desktop, bounded by there being one capsule, and it
     * is wanted again the moment the widget is expanded — which is a collapse, not an
     * unmount. Dropping the element would force a fresh decode through
     * `applyWallpaper()` on every expand, and the capsule's backdrop is the one
     * surface in this app that is looked at continuously: taking one frame off its
     * refraction source is not a saving, it is the flicker this file exists to avoid.
     */
    layout = null;
    if (micas.size > 0 || releaseTimer) return;
    releaseTimer = window.setTimeout(() => {
      releaseTimer = 0;
      if (micas.size > 0) return;
      /*
       * `stopCapture` owns the tracker now: it clears the 60 ms interval whenever
       * neither a panel nor this backdrop is left mounted. As `stripHost` was set
       * null above, that is exactly the state here, so the timer goes with the
       * capture it was watching instead of outliving it.
       */
      stopCapture();
    }, RELEASE_GRACE_MS);
  };
}
