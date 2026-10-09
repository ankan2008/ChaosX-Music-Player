import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { extractAccentRgb } from '../../utils/accentColor';

/**
 * The hourglass.
 *
 * A port of the reference file the user supplied, coordinate for coordinate: the
 * same two r=167 spheres 410px apart joined by a narrow neck, the same fixed base
 * with its engraving, the same separate specular layer that fades out while the
 * glass comes about, the same rose rings, dome reflections and thick refractive
 * wall, the same clip-polygon liquid with real volume conservation, the same
 * slosh, the same iridescence, and the same turn — including the detail that the
 * liquid starts falling again at 110 degrees, before the rotation has finished.
 *
 * Two things differ from the HTML, both deliberate:
 *
 * - The empty canvas around the drawing is cropped away. `VB` is the tight box
 *   the artwork actually occupies, and the stage keeps the size the sidebar's
 *   budget allows, so the glass is centred inside it by `preserveAspectRatio`.
 * - The sand is not fixed yellow. See `useSandStops`.
 *
 * What replaces the demo's own clock is the pomodoro: `q` comes from the phase
 * progress the card already derives from an absolute end timestamp, and the turn
 * is triggered by `flip` rather than by the drain finishing on a timer.
 *
 * ## Why the turn reads the way it does
 *
 * `render()` swaps which bulb is the source and which is the destination for as
 * long as the glass is turning, and `angle` returns to zero on the same frame that
 * swap is undone. Because the glass is symmetric the two cancel exactly — the last
 * turning frame and the first draining frame are the same picture. That is what
 * makes the hand-off invisible, and it is also why the sand is never seen to run
 * upward: during a turn the full bulb *is* the source, pouring toward what the
 * rotation is about to make the bottom.
 */
interface Props {
  /** 0 full at the top, 1 empty. */
  progress: number;
  /** Whether this glass is the one being timed. */
  active: boolean;
  paused: boolean;
  /** Half-turns taken so far. Increment to turn the glass. */
  flip: number;
  label: string;
}

/** Length of the 180 degree turn, in ms. */
const FLIP_MS = 1700;

/*
 * The reference's canvas is 400x820 and the artwork runs from y=38 (top of the
 * upper sphere) to y=808 (foot of the base), x from 30 to 370. Everything outside
 * that is the blank margin the user asked to have removed.
 */
const VB = { x: 28, y: 34, w: 344, h: 778 };
/*
 * Sized to the sidebar's budget, and — more tightly than the artwork would like
 * — to the pomodoro card's width.
 *
 * A 1:2.05 object sweeping through a half-turn needs a square of its own height
 * to turn inside, so the height here is what the card can give, not what the
 * glass would prefer. It is centred in the stage by `preserveAspectRatio`, which
 * leaves the width slack; the turn then stays inside the card instead of spilling
 * off the window's left edge.
 */
const STAGE_W = 72;
const STAGE_H = 120;

/** The reference's own sand: pale gold over ochre over burnt amber. */
const OCHRE = {
  liq: ['#ffe9a0', '#f6b93a', '#d4820f'],
  stream: ['#ffeaa8', '#f2b13c'],
  hi: '#fff6cf',
};

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(1)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}

/**
 * The sand's three stops, taken from the record that is playing.
 *
 * The reference hardcoded yellow, which the user accepted as the default and then
 * asked to be driven by the artwork instead. What is kept is the reference's
 * *lightness ladder* — 81% / 60% / 44% with a hot, saturated mid — because that
 * spread is what makes it read as a depth of liquid rather than as a flat fill.
 * Only the hue and the saturation come from the cover, and the saturation is
 * floored so a grey or near-black cover still pours something you can see.
 *
 * No artwork, and the whole thing falls back to the original ochre.
 */
function useSandStops(): typeof OCHRE {
  const art = usePlayerStore((s) => s.currentTrack?.albumArt);
  const [stops, setStops] = useState(OCHRE);

  useEffect(() => {
    if (!art) {
      setStops(OCHRE);
      return undefined;
    }
    let alive = true;
    void extractAccentRgb(art).then(([r, g, b]) => {
      if (!alive) return;
      const { h, s } = rgbToHsl(r, g, b);
      const sat = Math.max(0.55, Math.min(0.95, s));
      setStops({
        liq: [hsl(h, sat, 0.81), hsl(h, sat, 0.6), hsl(h, sat, 0.44)],
        stream: [hsl(h, sat, 0.79), hsl(h, sat, 0.59)],
        hi: hsl(h, Math.max(0.35, sat * 0.55), 0.91),
      });
    });
    return () => {
      alive = false;
    };
  }, [art]);

  return stops;
}

function rgbToHsl(r: number, g: number, b: number) {
  const a = [r, g, b].map((v) => v / 255);
  const max = Math.max(...a);
  const min = Math.min(...a);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const idx = a.indexOf(max);
  let h =
    idx === 0
      ? (a[1] - a[2]) / d + (a[1] < a[2] ? 6 : 0)
      : idx === 1
        ? (a[2] - a[0]) / d + 2
        : (a[0] - a[1]) / d + 4;
  h /= 6;
  return { h: h * 360, s, l };
}

const $ = <T extends Element>(r: { current: T | null }): T | null => r.current;

/**
 * True when every point is a real number.
 *
 * `solve()` bisects over a bracket that the geometry can push outside, and when
 * it does the surface lands at infinity: the derived points come back NaN, and
 * `fx()` happily writes "NaN NaN" into `d`. Chromium logs that as an attribute
 * parse error once per frame per path, which is how an idle hourglass produced
 * two hundred console errors a minute. Nothing visible breaks — the bulb simply
 * has no liquid that frame — so the honest response is not to write at all.
 */
const finite = (pts: [number, number][]) =>
  pts.length > 1 && pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

const Hourglass: React.FC<Props> = ({ progress, active, paused, flip, label }) => {
  const glassPathRef = useRef<SVGPathElement>(null);
  const ltP = useRef<SVGPathElement>(null);
  const hiT = useRef<SVGPathElement>(null);
  const glT = useRef<SVGEllipseElement>(null);
  const lbP = useRef<SVGPathElement>(null);
  const hiB = useRef<SVGPathElement>(null);
  const glB = useRef<SVGEllipseElement>(null);
  const stream = useRef<SVGPathElement>(null);
  const streamHi = useRef<SVGPathElement>(null);
  const gIrid = useRef<SVGLinearGradientElement>(null);
  const rotRef = useRef<SVGSVGElement>(null);
  /** The fixed specular layer: it fades out while the glass turns and back in after. */
  const specRef = useRef<SVGSVGElement>(null);

  const sand = useSandStops();

  const live = useRef({ progress, active, paused });
  live.current = { progress, active, paused };

  /** Read by the loop, so it never has to be rebuilt when a turn begins. */
  const turningRef = useRef(false);
  /** Lets the effects below start and stop the loop without rebuilding it. */
  const loopCtl = useRef<{ start: () => void; stop: () => void } | null>(null);

  /** Non-null while the glass is coming about; also what re-keys the animation. */
  const [turning, setTurning] = useState(false);
  turningRef.current = turning;
  const prevFlip = useRef(flip);

  useEffect(() => {
    if (prevFlip.current === flip) return undefined;
    prevFlip.current = flip;
    setTurning(true);
    const id = window.setTimeout(() => setTurning(false), FLIP_MS);
    return () => window.clearTimeout(id);
  }, [flip]);

  useEffect(() => {
    const glass = glassPathRef.current;
    if (!glass) return;

    /* ── GLASS GEOMETRY: gravity-aligned liquid with exact volume ───────── */
    const glassPoly: [number, number][] = [];
    for (let l = 0, L = glass.getTotalLength(); l < L; l += 5) {
      const q = glass.getPointAtLength(l);
      glassPoly.push([q.x, q.y]);
    }

    /** Keep the part of the polygon where nx*x + ny*y >= c. */
    const clip = (poly: [number, number][], nx: number, ny: number, c: number) => {
      const out: [number, number][] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const da = nx * a[0] + ny * a[1] - c;
        const db = nx * b[0] + ny * b[1] - c;
        if (da >= 0) out.push(a);
        if (da >= 0 !== db >= 0) {
          const k = da / (da - db);
          out.push([a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1])]);
        }
      }
      return out;
    };
    const area = (p: [number, number][]) => {
      let s = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i];
        const b = p[(i + 1) % p.length];
        s += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(s) / 2;
    };

    /* The two spheres meet at y=410, which is also the pivot of the turn. */
    const BULB = { top: clip(glassPoly, 0, -1, -412), bot: clip(glassPoly, 0, 1, 412) };
    /** Volume of liquid in a "full" bulb. */
    const VFULL = area(clip(BULB.top, 0, 1, 100));

    /** The surface position that holds `vol`, found by bisection. */
    const solve = (poly: [number, number][], th: number, vol: number) => {
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      let lo = -450;
      let hi = 450;
      for (let i = 0; i < 16; i++) {
        const m = (lo + hi) / 2;
        if (area(clip(poly, sn, cs, m + 200 * sn + 410 * cs)) > vol) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };

    /* ── LIQUID RENDERING ───────────────────────────────────────────────── */
    const gauss = (d: number, s: number) => Math.exp(-(d * d) / (s * s));
    const fx = (p: [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

    const drawBulb = (
      k: 'top' | 'bot',
      vol: number,
      role: 'src' | 'dst',
      th: number,
      t: number,
      amp: number,
      tilt: number,
      q: number,
      flow: number,
    ) => {
      const path = k === 'top' ? $(ltP) : $(lbP);
      const hi = k === 'top' ? $(hiT) : $(hiB);
      const glow = k === 'top' ? $(glT) : $(glB);
      if (!path || !hi || !glow) return null;
      if (vol < VFULL * 0.003) {
        /*
         * The reference cleared `d` to an empty string, which is not a valid path
         * and makes the renderer log a parse error on every frame a bulb is empty.
         * Hiding the clip instead empties the bulb exactly — a `clipPath` with no
         * geometry clips everything away.
         */
        path.style.display = 'none';
        hi.style.display = 'none';
        return null;
      }
      path.style.display = '';
      hi.style.display = '';
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      const g: [number, number] = [sn, cs];
      const tau: [number, number] = [cs, -sn];
      const s0 = solve(BULB[k], th, vol);
      const m = role === 'dst' ? 16 * Math.min(1, q * 8) * (1 - Math.max(0, (q - 0.9) / 0.1)) : 0;
      const dip = role === 'src' ? 11 * Math.min(1, q * 30) : 0;
      const ph = role === 'src' ? 0 : 2;
      const pts: [number, number][] = [];
      /* u is true horizontal position, so the waves stay level in the world. */
      for (let u = -380; u <= 380; u += 10) {
        const wave =
          amp *
          (Math.sin(u * 0.021 + t * 0.0012 + ph) +
            0.55 * Math.sin(u * 0.045 - t * 0.0018 + 1.3 + ph));
        let d = s0 + wave + (tilt * u) / 150;
        d +=
          role === 'src'
            ? dip * gauss(u, 58)
            : -m * gauss(u, 62) +
              flow * 2.6 * Math.exp(-Math.abs(u) / 80) * Math.sin(Math.abs(u) * 0.07 - t * 0.0028);
        pts.push([200 + tau[0] * u + g[0] * d, 410 + tau[1] * u + g[1] * d]);
      }
      if (!finite(pts)) {
        path.style.display = 'none';
        hi.style.display = 'none';
        return null;
      }
      path.style.display = '';
      hi.style.display = '';
      const far = (p: [number, number]): [number, number] => [p[0] + g[0] * 900, p[1] + g[1] * 900];
      path.setAttribute(
        'd',
        `M${pts.map(fx).join('L')}L${fx(far(pts[pts.length - 1]))}L${fx(far(pts[0]))}Z`,
      );
      hi.setAttribute(
        'd',
        `M${pts.map((p) => fx([p[0] + g[0] * 3, p[1] + g[1] * 3])).join('L')}`,
      );
      const gu = -70 + 14 * Math.sin(t * 0.0006);
      const gd = s0 + 34;
      glow.setAttribute('cx', String(200 + tau[0] * gu + g[0] * gd));
      glow.setAttribute('cy', String(410 + tau[1] * gu + g[1] * gd));
      return { s0, m };
    };

    /** The thick thread, which always falls along gravity. */
    const drawStream = (th: number, t: number, end: number, op: number) => {
      const sEl = $(stream);
      const hEl = $(streamHi);
      if (!sEl || !hEl) return;
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      const L: [number, number][] = [];
      const R: [number, number][] = [];
      const H: [number, number][] = [];
      const at = (s: number, o: number): [number, number] => [
        200 + sn * s + cs * o,
        410 + cs * s - sn * o,
      ];
      for (let s = -24; s <= end; s += 6) {
        const c = 1.6 * Math.sin(s * 0.035 - t * 0.0025) * Math.min(1, (s + 24) / 40);
        const hw = 2.1 + 3.6 * Math.exp(-(s + 24) / 22) + 3 * Math.exp(-(end - s) / 16);
        L.push(at(s, c - hw));
        R.push(at(s, c + hw));
        H.push(at(s, c - hw * 0.35));
      }
      /*
       * The reference wrote the path unconditionally, and when the destination
       * surface sits above the neck — which is exactly what happens in the frames
       * either side of a turn, and whenever a bulb has just run out — the loop
       * body never runs and the result is `d="MLZ"` and `d="M"`. Both are invalid
       * paths, and the renderer logged an error for every frame of them.
       */
      if (!finite(L) || !finite(R) || !finite(H)) {
        sEl.style.display = 'none';
        hEl.style.display = 'none';
        return;
      }
      sEl.style.display = '';
      hEl.style.display = '';
      sEl.setAttribute('d', `M${L.map(fx).join('L')}L${R.reverse().map(fx).join('L')}Z`);
      hEl.setAttribute('d', `M${H.map(fx).join('L')}`);
      sEl.style.opacity = String(op);
      hEl.style.opacity = String(op);
    };

    /* ── RUN + TURN OVER ────────────────────────────────────────────────── */
    const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

    let angle = 0;
    let slosh = 0;
    let last = performance.now();
    let turnT0 = 0;
    let wasTurning = false;
    /** Progress already spent by the timer whose turn is finishing. */
    let drainBase = 0;
    let raf = 0;

    const render = (t: number) => {
      const s = live.current;
      const turn = wasTurning;
      /*
       * The turn holds the sand completely still.
       *
       * `q` is forced to zero for the whole 180 degrees, which puts every grain in
       * the glass-coordinate *lower* bulb — the one that is about to be carried up
       * — and lets `solve()` orient the surface against gravity at the current
       * angle, so the sand rides along the neck as the glass comes about rather
       * than pouring anywhere. It then resumes at `drainBase`, the progress the
       * new timer had already reached while the glass was turning, remapped to
       * start at zero. Without that re-baseline the sand jumps down by the turn's
       * own worth of time the instant the glass lands, which on a short break is a
       * visible gulp, and the hand-over frame stops matching.
       */
      const raw = Math.max(0, Math.min(1, s.progress));
      const q = turn
        ? 0
        : drainBase >= 1
          ? 1
          : Math.max(0, Math.min(1, (raw - drainBase) / (1 - drainBase)));
      const th = (angle * Math.PI) / 180;
      const amp = 2.6 + slosh * 10;
      const tilt = slosh * 16 * Math.sin(t * 0.0035);
      const flowing = q > 0.001 && q < 0.999;
      const flow = flowing ? Math.min(1, q * 40, (1 - q) * 40) : 0;
      /*
       * While turning, the liquid is in the bottom bulb and pours "down" — toward
       * what the turn is about to make the new bottom — through the neck.
       */
      const top = drawBulb('top', (turn ? q : 1 - q) * VFULL, turn ? 'dst' : 'src', th, t, amp, tilt, q, flow);
      const bot = drawBulb('bot', (turn ? 1 - q : q) * VFULL, turn ? 'src' : 'dst', th, t, amp, tilt, q, flow);
      const dst = turn ? top : bot;
      if (flow > 0 && dst) drawStream(th, t, dst.s0 - dst.m + 4, flow);
      else drawStream(th, t, 0, 0);
      gIrid.current?.setAttribute(
        'gradientTransform',
        `translate(${(t * 0.015) % 400} ${(t * 0.006) % 160})`,
      );
    };

    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      const turningNow = turningRef.current;
      let target = 0;
      if (turningNow) {
        if (!wasTurning) {
          wasTurning = true;
          turnT0 = now;
          if (specRef.current) specRef.current.style.opacity = '0';
        }
        const u = Math.min(1, (now - turnT0) / FLIP_MS);
        angle = 180 * ease(u);
        target = Math.min(1, 9.6 * u * (1 - u));
        if (u >= 1) {
          /*
           * The glass is symmetric, so the last turning frame — lower bulb full,
           * rotated 180 — is the same picture as the first upright frame with the
           * upper bulb full. Zeroing the angle and re-baselining the drain on this
           * one frame is what makes the hand-over invisible and starts the new
           * timer with its sand already at the top.
           */
          angle = 0;
          wasTurning = false;
          drainBase = Math.max(0, Math.min(1, live.current.progress));
          if (specRef.current) specRef.current.style.opacity = '1';
        }
      } else if (angle !== 0) {
        angle = 0;
        wasTurning = false;
      }
      if (rotRef.current) rotRef.current.style.transform = `rotate(${angle}deg)`;
      slosh += (target - slosh) * (1 - Math.exp(-dt / (target ? 120 : 900)));
      render(now);
      raf = requestAnimationFrame(step);
    };

    /*
     * The loop runs while the glass is being timed or is turning. An idle card has
     * painted its answer and has nothing to animate, so the sidebar does not carry
     * a 60 Hz SVG re-layout — with two gaussian filters in it — for a timer nobody
     * started.
     */
    const needsLoop = () => (live.current.active && !live.current.paused) || turningRef.current;
    const start = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(step);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    render(performance.now());
    if (needsLoop()) start();
    loopCtl.current = { start, stop };
    return () => {
      stop();
      loopCtl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turning]);

  useEffect(() => {
    if ((active && !paused) || turning) loopCtl.current?.start();
    else loopCtl.current?.stop();
  }, [active, paused, turning]);

  const vb = `${VB.x} ${VB.y} ${VB.w} ${VB.h}`;

  return (
    <div className="hg-stage" style={{ width: STAGE_W, height: STAGE_H }} role="img" aria-label={label}>
      {/* fixed base and engraving: they stay put while the glass turns */}
      <svg className="hg-base" viewBox={vb} aria-hidden>
        <defs>
          <linearGradient id="hgGDark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7b8494" />
            <stop offset=".35" stopColor="#3b414d" />
            <stop offset="1" stopColor="#14171d" />
          </linearGradient>
        </defs>
        <path
          d="M62 768 Q62 761 80 761 H320 Q338 761 338 768 C336 792 300 808 200 808 C100 808 64 792 62 768 Z"
          fill="url(#hgGDark)"
        />
        <path d="M70 770 C100 778 300 778 330 770" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth="1.5" />
        <g
          fontFamily="'Segoe Script','Brush Script MT','Segoe UI',cursive"
          fontStyle="italic"
          fontSize="15"
          letterSpacing="1.5"
          textAnchor="middle"
        >
          <text x="200" y="795.4" fill="#000" fillOpacity=".6">
            ChaosX
          </text>
          <text x="200" y="794.6" fill="#fff" fillOpacity=".55">
            ChaosX
          </text>
        </g>
      </svg>

      <svg ref={rotRef} className="hg-rot" viewBox={vb} aria-label={label}>
        <defs>
          {/* two spheres (r=167) 410px apart, joined by a narrow neck */}
          <path
            id="glass"
            ref={glassPathRef}
            d="M112 63 A167 167 0 0 1 288 63 A167 167 0 0 1 254 363
        C232 370 222 378 222 394 L222 426 C222 442 232 450 254 457
        A167 167 0 0 1 288 757 A167 167 0 0 1 112 757 A167 167 0 0 1 146 457
        C168 450 178 442 178 426 L178 394 C178 378 168 370 146 363
        A167 167 0 0 1 112 63 Z"
          />
          <clipPath id="cGlass">
            <use href="#glass" />
          </clipPath>
          <clipPath id="cTop">
            <rect x="0" y="0" width="400" height="412" />
          </clipPath>
          <clipPath id="cBot">
            <rect x="0" y="412" width="400" height="408" />
          </clipPath>
          <clipPath id="cLiqTop">
            <path id="ltP" ref={ltP} />
          </clipPath>
          <clipPath id="cLiqBot">
            <path id="lbP" ref={lbP} />
          </clipPath>

          <linearGradient id="gLiq" gradientUnits="userSpaceOnUse" x1="0" y1="38" x2="0" y2="782">
            <stop offset="0" stopColor={sand.liq[0]} />
            <stop offset=".5" stopColor={sand.liq[1]} />
            <stop offset="1" stopColor={sand.liq[2]} />
          </linearGradient>
          <linearGradient id="gShade" gradientUnits="userSpaceOnUse" x1="33" y1="0" x2="367" y2="0">
            <stop offset="0" stopColor="#5a2a00" stopOpacity=".45" />
            <stop offset=".2" stopColor="#5a2a00" stopOpacity="0" />
            <stop offset=".34" stopColor="#fff" stopOpacity=".3" />
            <stop offset=".5" stopColor="#fff" stopOpacity="0" />
            <stop offset=".85" stopColor="#5a2a00" stopOpacity="0" />
            <stop offset="1" stopColor="#4a2000" stopOpacity=".45" />
          </linearGradient>
          <linearGradient
            id="gIrid"
            ref={gIrid}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1="0"
            x2="400"
            y2="300"
            spreadMethod="reflect"
          >
            <stop offset="0" stopColor="#ff7ad9" />
            <stop offset=".33" stopColor="#6fe0ff" />
            <stop offset=".66" stopColor="#fff07a" />
            <stop offset="1" stopColor="#b585ff" />
          </linearGradient>
          <linearGradient id="gStream" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={sand.stream[0]} />
            <stop offset="1" stopColor={sand.stream[1]} />
          </linearGradient>
          <radialGradient id="gSphere" cx=".5" cy=".5" r=".5">
            <stop offset=".62" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#fff" stopOpacity=".2" />
          </radialGradient>
          <linearGradient id="gRose" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#f6d3c2" />
            <stop offset=".45" stopColor="#b9775d" />
            <stop offset="1" stopColor="#6d3b2d" />
          </linearGradient>
          <filter id="fBlur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1.8" />
          </filter>
          <filter id="fBlur2" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" />
          </filter>

          <g id="ring">
            <rect x="104" y="56" width="192" height="14" rx="7" fill="url(#gRose)" />
            <rect x="112" y="58" width="176" height="2" rx="1" fill="#fff" opacity=".45" />
          </g>
          <ellipse id="dome" cx="200" cy="138" rx="84" ry="22" />
        </defs>

        {/* liquid */}
        <g clipPath="url(#cGlass)">
          <g clipPath="url(#cTop)">
            <g clipPath="url(#cLiqTop)">
              <rect width="400" height="820" fill="url(#gLiq)" />
              <rect width="400" height="820" fill="url(#gShade)" />
              <rect width="400" height="820" fill="url(#gIrid)" style={{ mixBlendMode: 'screen' }} opacity=".22" />
              <ellipse id="glT" ref={glT} rx="36" ry="7" fill="#fff" opacity=".4" filter="url(#fBlur2)" />
              <path
                id="hiT"
                ref={hiT}
                fill="none"
                stroke={sand.hi}
                strokeWidth="4"
                strokeLinecap="round"
                opacity=".8"
                filter="url(#fBlur)"
              />
            </g>
          </g>
          <g clipPath="url(#cBot)">
            <g clipPath="url(#cLiqBot)">
              <rect width="400" height="820" fill="url(#gLiq)" />
              <rect width="400" height="820" fill="url(#gShade)" />
              <rect width="400" height="820" fill="url(#gIrid)" style={{ mixBlendMode: 'screen' }} opacity=".22" />
              <ellipse id="glB" ref={glB} rx="36" ry="7" fill="#fff" opacity=".4" filter="url(#fBlur2)" />
              <path
                id="hiB"
                ref={hiB}
                fill="none"
                stroke={sand.hi}
                strokeWidth="4"
                strokeLinecap="round"
                opacity=".8"
                filter="url(#fBlur)"
              />
            </g>
          </g>
          <path id="stream" ref={stream} fill="url(#gStream)" />
          <path
            id="streamHi"
            ref={streamHi}
            fill="none"
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinecap="round"
            opacity=".7"
          />
        </g>

        {/* glass */}
        <use href="#glass" fill="#a9c1ff" fillOpacity=".05" />
        <g clipPath="url(#cGlass)">
          <circle cx="200" cy="205" r="170" fill="url(#gSphere)" />
          <circle cx="200" cy="615" r="170" fill="url(#gSphere)" />
        </g>
        {/* thick refractive wall: inner band, blue rim light, dome reflection, crisp outer edge */}
        <g clipPath="url(#cGlass)">
          <use href="#glass" fill="none" stroke="#d6e4ff" strokeOpacity=".17" strokeWidth="20" />
          <use
            href="#glass"
            fill="none"
            stroke="#fff"
            strokeOpacity=".28"
            strokeWidth="2"
            transform="translate(200 410) scale(.968) translate(-200 -410)"
          />
          <use href="#glass" fill="none" stroke="#8fb4ff" strokeOpacity=".35" strokeWidth="7" filter="url(#fBlur)" />
          <g fill="#fff" fillOpacity=".05" stroke="#fff" strokeOpacity=".28" strokeWidth="1.6">
            <use href="#dome" filter="url(#fBlur)" />
          </g>
          <use href="#dome" transform="translate(0 820) scale(1 -1)" fill="#fff" fillOpacity=".05" stroke="#fff" strokeOpacity=".28" strokeWidth="1.6" filter="url(#fBlur)" />
        </g>
        <use href="#glass" fill="none" stroke="#0b1236" strokeOpacity=".3" strokeWidth="6" />
        <use href="#glass" fill="none" stroke="#fff" strokeOpacity=".78" strokeWidth="2.2" />
        <use href="#ring" />
        <use href="#ring" transform="translate(0 820) scale(1 -1)" />
      </svg>

      {/* fixed specular highlights: they fade out while the glass turns, back in after */}
      <svg ref={specRef} className="hg-spec" viewBox={vb} aria-hidden>
        <g id="hgSpec" fill="none" stroke="#fff" strokeLinecap="round">
          <path d="M62 178 A146 146 0 0 1 132 72" strokeWidth="8" strokeOpacity=".55" />
          <path d="M74 190 A134 134 0 0 1 112 118" strokeWidth="2.5" strokeOpacity=".8" />
          <path d="M326 112 Q348 156 344 214" strokeWidth="3.5" strokeOpacity=".45" />
          <path d="M338 236 Q326 290 276 336" strokeWidth="2" strokeOpacity=".3" />
          <path d="M156 368 C168 378 170 392 168 404" strokeWidth="2.5" strokeOpacity=".6" />
          <circle cx="108" cy="102" r="4.5" fill="#fff" stroke="none" fillOpacity=".8" />
        </g>
        <use href="#hgSpec" transform="translate(0 820) scale(1 -1)" />
      </svg>
    </div>
  );
};

export default Hourglass;
