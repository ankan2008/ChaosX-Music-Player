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
/**
 * Once the glass has come past this angle the liquid is over the neck and starts
 * falling again, while the glass is still finishing its half-turn.
 */
const FLOW_ANGLE = 110;

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
/*
 * The glass turns about the neck, (200, 410) in the artwork's own coordinates, not
 * about the middle of the cropped box (which sits 13 units lower because the base
 * hangs below the glass). Turning about the box centre drifts the glass about 4px
 * by the end of the half-turn, and the hand-off back to angle 0 then shows as a
 * hop. This is that point in the stage's pixels.
 */
const PIVOT = (() => {
  const k = Math.min(STAGE_W / VB.w, STAGE_H / VB.h);
  const ox = (STAGE_W - VB.w * k) / 2 + (200 - VB.x) * k;
  const oy = (STAGE_H - VB.h * k) / 2 + (410 - VB.y) * k;
  return `${ox.toFixed(2)}px ${oy.toFixed(2)}px`;
})();

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
  /** Lets the effects below start, stop and repaint the loop without rebuilding it. */
  const loopCtl = useRef<{ start: () => void; stop: () => void; paint: () => void } | null>(null);

  /** True from the moment `flip` changes until the loop has finished the 180 degrees. */
  const [turning, setTurning] = useState(false);
  const prevFlip = useRef(flip);
  /*
   * `flip` and the new timer's progress arrive in the same render. If the loop only
   * heard about the turn a render later, one frame would be drawn with the new
   * (near-zero) progress and the old orientation: the full bulb would jump from the
   * bottom to the top before the glass had moved. Reading the change here closes that.
   */
  turningRef.current = turning || prevFlip.current !== flip;

  useEffect(() => {
    if (prevFlip.current === flip) return undefined;
    prevFlip.current = flip;
    setTurning(true);
    loopCtl.current?.start();
    return undefined;
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
      ramp: number,
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
        /*
         * Still report where the floor of this bulb is. The thread has to be able to
         * land on a bulb that is only just starting to fill, otherwise nothing is seen
         * to fall for the first seconds of a long timer.
         */
        const floor = solve(BULB[k], th, VFULL * 0.003);
        return Number.isFinite(floor) ? { s0: floor, m: 0 } : null;
      }
      path.style.display = '';
      hi.style.display = '';
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      const g: [number, number] = [sn, cs];
      const tau: [number, number] = [cs, -sn];
      const s0 = solve(BULB[k], th, vol);
      const m = role === 'dst' ? 16 * ramp * (1 - Math.max(0, (q - 0.9) / 0.1)) : 0;
      const dip = role === 'src' ? 11 * ramp : 0;
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
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

    let angle = 0;
    let slosh = 0;
    let last = performance.now();
    let dtMs = 16;
    let turnT0 = 0;
    let wasTurning = false;
    /** Timer progress at the instant the liquid started to fall during a turn; null before. */
    let flowRaw: number | null = null;
    /** Timer progress the current drain is counted from. */
    let drainBase = 0;
    /** Where the surface of the bulb being poured from sat on the last frame. */
    let lastS0 = 99;
    /**
     * How fully the thread, funnel and mound are showing. Eased by time, not by `q`:
     * on a twenty-minute timer `q` takes a minute to leave zero, and the liquid would
     * be seen not to fall at all for that long.
     */
    let ramp = 0;
    let raf = 0;

    const render = (t: number, snap = false) => {
      const s = live.current;
      const turn = wasTurning;
      const raw = clamp01(s.progress);
      if (!turn && raw < drainBase) drainBase = 0; // the timer was reset or restarted
      /*
       * Before the liquid reaches the neck (turn, no flowRaw yet) every grain is in
       * the glass-coordinate lower bulb, which is the one being carried up. From the
       * moment it does, the amount fallen is measured from that instant, so the sand
       * runs out exactly when the timer does, and the turn's hand-off keeps the same
       * baseline: the last turning frame and the first upright one are the same picture.
       */
      const base = turn ? flowRaw : drainBase;
      const q = base === null ? 0 : base >= 1 ? 1 : clamp01((raw - base) / (1 - base));
      const th = (angle * Math.PI) / 180;
      const amp = 2.6 + slosh * 10;
      const tilt = slosh * 16 * Math.sin(t * 0.0035);
      const flowing = q < 0.999 && (turn ? flowRaw !== null : q > 0 || (s.active && !s.paused));
      const target = flowing ? 1 : 0;
      ramp = snap ? target : ramp + (target - ramp) * (1 - Math.exp(-dtMs / 140));
      const flow = Math.min(ramp, (1 - q) * 40);
      /*
       * While turning, the liquid is in the bottom bulb and pours "down" — toward
       * what the turn is about to make the new bottom — through the neck.
       */
      const top = drawBulb('top', (turn ? q : 1 - q) * VFULL, turn ? 'dst' : 'src', th, t, amp, tilt, q, ramp, flow);
      const bot = drawBulb('bot', (turn ? 1 - q : q) * VFULL, turn ? 'src' : 'dst', th, t, amp, tilt, q, ramp, flow);
      const src = turn ? bot : top;
      const dst = turn ? top : bot;
      lastS0 = src ? src.s0 : 99;
      if (flow > 0.002 && dst) drawStream(th, t, dst.s0 - dst.m + 4, flow);
      else drawStream(th, t, 0, 0);
      gIrid.current?.setAttribute(
        'gradientTransform',
        `translate(${(t * 0.015) % 400} ${(t * 0.006) % 160})`,
      );
    };

    const step = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      dtMs = dt;
      let target = 0;
      if (turningRef.current && !wasTurning) {
        wasTurning = true;
        turnT0 = now;
        flowRaw = null;
        if (specRef.current) specRef.current.style.opacity = '0';
      }
      if (wasTurning) {
        const u = Math.min(1, (now - turnT0) / FLIP_MS);
        angle = 180 * ease(u);
        target = Math.min(1, 9.6 * u * (1 - u));
        /* Over the neck: the liquid falls again before the turn has even finished. */
        if (flowRaw === null && angle >= FLOW_ANGLE && lastS0 <= 4) {
          flowRaw = clamp01(live.current.progress);
        }
        if (u >= 1) {
          /*
           * The glass is symmetric, so the last turning frame — lower bulb pouring,
           * rotated 180 — is the same picture as the first upright frame with the upper
           * bulb pouring. Zeroing the angle and carrying the baseline across on this one
           * frame makes the hand-over invisible, and the sand never stops or restarts.
           */
          angle = 0;
          wasTurning = false;
          drainBase = flowRaw ?? clamp01(live.current.progress);
          flowRaw = null;
          turningRef.current = false;
          setTurning(false);
          if (specRef.current) specRef.current.style.opacity = '1';
        }
      } else if (angle !== 0) {
        angle = 0;
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
    /** One still frame, for when the loop is stopped but the props have changed. */
    const paint = () => {
      if (!raf) render(performance.now(), true);
    };

    render(performance.now(), true);
    if (needsLoop()) start();
    loopCtl.current = { start, stop, paint };
    return () => {
      stop();
      loopCtl.current = null;
    };
    // Built once: the turn lives in this closure, so it must not be torn down by state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if ((active && !paused) || turning) loopCtl.current?.start();
    else loopCtl.current?.stop();
  }, [active, paused, turning]);

  /* A reset or a paused card changes props without the loop running: repaint once. */
  useEffect(() => {
    loopCtl.current?.paint();
  }, [progress, active, paused]);

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

      <svg ref={rotRef} className="hg-rot" viewBox={vb} aria-label={label} style={{ transformOrigin: PIVOT }}>
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
      <svg ref={specRef} className="hg-spec" viewBox={vb} aria-hidden style={{ transition: 'opacity .35s' }}>
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
