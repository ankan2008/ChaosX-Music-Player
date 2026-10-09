import React, { useEffect, useRef, useState } from 'react';
import { useSceneColour } from '../../hooks/useSceneColour';
import { usePlayerStore } from '../../stores/playerStore';
import type { SysInfo } from '../../vite-env';

/**
 * The machine meters on the Statistics page: battery, memory, processor.
 *
 * They are here because the user reads this page to see what the app is doing to
 * the machine, and the library's own numbers are only half of that — so each ring
 * carries ChaosX's share underneath the whole-machine figure.
 *
 * The colour of the rings comes from the scene behind the app rather than from a
 * fixed green, which is what every system monitor ships and what makes a meter
 * look pasted onto a page that has been tinted by the record it is playing.
 */

function useSysInfo(): SysInfo | null {
  const [info, setInfo] = useState<SysInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void window.electronAPI?.getSysInfo?.().then((v) => {
      if (alive && v) setInfo(v);
    });
    const off = window.electronAPI?.onSysInfo?.((v) => {
      if (alive) setInfo(v);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  return info;
}

const gib = (bytes: number): string => (bytes / 1073741824).toFixed(bytes < 10 * 1073741824 ? 2 : 1);

/**
 * The charge as a liquid in a container.
 *
 * Five pills told you a number; this tells you the same number and that it is
 * moving. Two surfaces run in opposite directions over a fill that rises with the
 * charge, and the hue walks from green through ochre at forty percent to red at
 * twenty, so the colour carries the warning before the digits do.
 */
/*
 * Deliberately narrower than the card it sits in.
 *
 * The liquid used to be 132px inside a 140px pill-mode card with 8px of padding
 * either side — 124px of room — so the container hung past its own glass on both
 * edges, and the panel clipped the overhang. A canvas cannot shrink to fit the
 * way a `<div>` can, because its width is written inline from these two numbers,
 * so the numbers themselves are what has to give.
 */
const LIQUID_W = 108;
const LIQUID_H = 88;
/** Where the bolt glyph sits inside the canvas, so the bubbles start at it. */
const BOLT_X = LIQUID_W * 0.32;
const BOLT_Y = LIQUID_H * 0.34;
interface Bubble {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  life: number;
  span: number;
}
/** Charge → hue, in the order the level passes them on the way down. */
const HUES: Array<[number, number]> = [[1, 142], [0.4, 44], [0.2, 8]];

function hueFor(level: number): number {
  const l = Math.max(0, Math.min(1, level));
  for (let i = 0; i < HUES.length - 1; i++) {
    const [a, ha] = HUES[i];
    const [b, hb] = HUES[i + 1];
    if (l <= a && l >= b) return ha + ((a - l) / (a - b)) * (hb - ha);
  }
  return HUES[HUES.length - 1][1];
}

const LiquidBattery: React.FC<{ level: number; charging: boolean }> = ({ level, charging }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const live = useRef({ level, charging });
  live.current = { level, charging };
  const bubbles = useRef<Bubble[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(LIQUID_W * dpr);
    canvas.height = Math.round(LIQUID_H * dpr);

    let raf = 0;
    let t = 0;
    let last = 0;

    const draw = (dt: number) => {
      t += dt;
      const { level: raw, charging: on } = live.current;
      const lvl = Math.max(0, Math.min(1, raw));
      const hue = hueFor(lvl);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, LIQUID_W, LIQUID_H);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(1, 1, LIQUID_W - 2, LIQUID_H - 2, 16);
      ctx.clip();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.fillRect(0, 0, LIQUID_W, LIQUID_H);

      const base = LIQUID_H - lvl * (LIQUID_H - 16) - 8;

      /*
       * Two surfaces, out of phase. One wave reads as a stripe; two crossing
       * each other is what makes it look like something is moving inside.
       */
      const surface = (amp: number, k: number, phase: number) => {
        ctx.beginPath();
        ctx.moveTo(0, LIQUID_H);
        for (let x = 0; x <= LIQUID_W; x += 3) {
          const y =
            base +
            amp * Math.sin((x / LIQUID_W) * Math.PI * k + phase) +
            amp * 0.45 * Math.sin((x / LIQUID_W) * Math.PI * k * 2.3 - phase * 1.4);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(LIQUID_W, LIQUID_H);
        ctx.closePath();
      };

      ctx.fillStyle = `hsl(${hue} 72% 42% / 0.5)`;
      surface(4.2, 2.6, t * 1.15);
      ctx.fill();

      const g = ctx.createLinearGradient(0, base - 10, 0, LIQUID_H);
      g.addColorStop(0, `hsl(${hue} 82% 58% / 0.95)`);
      g.addColorStop(1, `hsl(${hue} 78% 34% / 0.95)`);
      ctx.fillStyle = g;
      surface(3.1, 3.4, -t * 1.55 + 1.2);
      ctx.fill();

      // A travelling highlight along the surface — the ripple, read at a glance.
      ctx.strokeStyle = `hsl(${hue} 90% 78% / ${on ? 0.5 : 0.3})`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let x = 0; x <= LIQUID_W; x += 3) {
        const y =
          base +
          3.1 * Math.sin((x / LIQUID_W) * Math.PI * 3.4 - t * 1.55 + 1.2) +
          1.4 * Math.sin((x / LIQUID_W) * Math.PI * 7.8 - t * 2.2 + 1.2);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      /*
       * Charging: bubbles off the bolt, dispersing through the liquid.
       *
       * This used to be three horizontal bands of white sweeping upward, and at
       * the size the card draws at they read as one faded line crossing the
       * container — a wipe, not a charge. Bubbles are the other reading of the
       * same idea: they start at the icon, spread out as they go, and die before
       * they reach the wall, so the motion says "energy is going into this"
       * without painting a stripe over the number.
       */
      if (on) {
        const seed = bubbles.current;
        if (seed.length < 26 && Math.random() < 0.55) {
          seed.push({
            x: BOLT_X + (Math.random() - 0.5) * 16,
            y: BOLT_Y + (Math.random() - 0.5) * 10,
            r: 0.9 + Math.random() * 1.9,
            /* Down and out from the icon, with a sideways wobble so the swarm
               fans into the body of the liquid rather than falling in a line. */
            vx: (Math.random() - 0.5) * 26,
            vy: 12 + Math.random() * 26,
            life: 0,
            span: 1.1 + Math.random() * 1.5,
          });
        }
        for (let i = seed.length - 1; i >= 0; i--) {
          const b = seed[i];
          b.life += dt;
          if (b.life > b.span || b.y > LIQUID_H - 3) {
            seed.splice(i, 1);
            continue;
          }
          const k = b.life / b.span;
          b.x += b.vx * dt * (0.4 + k);
          b.y += b.vy * dt;
          b.vy *= 0.985;
          const wob = Math.sin(b.life * 7 + b.r * 9) * 1.1;
          const a = (1 - k) * 0.5;
          ctx.beginPath();
          ctx.arc(b.x + wob, b.y, b.r * (1 + k * 0.5), 0, Math.PI * 2);
          ctx.fillStyle = `hsl(${hue} 95% 88% / ${a * 0.55})`;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(b.x + wob, b.y, b.r * (1 + k * 0.5), 0, Math.PI * 2);
          ctx.strokeStyle = `hsl(${hue} 100% 92% / ${a})`;
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }
      } else if (bubbles.current.length) {
        bubbles.current.length = 0;
      }
      ctx.restore();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(1, 1, LIQUID_W - 2, LIQUID_H - 2, 16);
      ctx.stroke();
    };

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      draw(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame((now) => {
      last = now;
      loop(now);
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="battery-liquid" style={{ width: LIQUID_W, height: LIQUID_H }}>
      <canvas ref={canvasRef} aria-hidden style={{ width: LIQUID_W, height: LIQUID_H }} />
      <div className="liquid-readout">
        {charging ? (
          <svg viewBox="0 0 24 24" className="liquid-bolt" aria-hidden>
            <path d="M13.2 2 4.6 13.4h5.1L9.2 22l8.9-11.6h-5.3z" fill="currentColor" />
          </svg>
        ) : null}
        <span className="liquid-pct">{Math.round(Math.max(0, Math.min(1, level)) * 100)}%</span>
      </div>
    </div>
  );
};

/**
 * Whether this machine has a battery at all.
 *
 * A desktop answers "no system battery", and the card used to draw that as a
 * full container labelled "Mains powered" — which is a meter for something that
 * is not there. On a tower the strip is two rings, not three.
 */
const hasBattery = (info: SysInfo) => info.battery.present && info.battery.level !== null;

const BatteryMeter: React.FC<{ info: SysInfo }> = ({ info }) => {
  const level = info.battery.level ?? 0;
  return (
    <div className="meter-card battery-card">
      <span className="meter-name">Battery</span>
      <LiquidBattery level={level} charging={info.battery.charging} />
      <span className="meter-foot">
        {info.battery.charging ? 'charging' : 'on battery'}
      </span>
    </div>
  );
};

/** A 100-unit circle with an 11-unit stroke leaves the arc inside the box. */
const R = 42;
const C = 2 * Math.PI * R;

const Ring: React.FC<{
  pct: number;
  colour: string;
  centre: string;
  sub: string;
  name: string;
  foot: string;
  /** What ChaosX itself is using, so the page answers the question it is for. */
  mine: string;
}> = ({ pct, colour, centre, sub, name, foot, mine }) => (
  <div className="meter-card ring-card">
    <span className="meter-name">{name}</span>
    {/*
     * The readout is welded to the ring rather than to the card. It used to be
     * `top: 75px` from the card's top edge — a number that stood for "padding,
     * plus the name line, plus the gap, plus half the ring" and broke the moment
     * any one of those four moved, which is how the percentage ended up sitting
     * off-centre in its own circle.
     */}
    <div className="meter-ring-box">
      <svg viewBox="0 0 100 100" className="meter-ring" aria-hidden>
        <circle cx="50" cy="50" r={R} className="ring-track" />
        <circle
          cx="50"
          cy="50"
          r={R}
          className="ring-value"
          stroke={colour}
          strokeDasharray={`${(C * Math.max(0, Math.min(1, pct))).toFixed(2)} ${C.toFixed(2)}`}
        />
      </svg>
      <div className="ring-centre">
        <span className="ring-value-text">{centre}</span>
        <span className="ring-sub">{sub}</span>
      </div>
    </div>
    <span className="meter-foot">{foot}</span>
    <span className="meter-mine">
      <b>ChaosX</b> {mine}
    </span>
  </div>
);

const SystemMeters: React.FC = () => {
  const info = useSysInfo();
  const background = usePlayerStore((s) => s.background);
  const wallpaperPath = usePlayerStore((s) => s.wallpaperPath);
  const artId = usePlayerStore((s) => s.currentTrack?.id);
  const colour = useSceneColour([background, wallpaperPath, artId]);

  if (!info) {
    return (
      <div className="meter-strip">
        {['Memory', 'Processor', 'Battery'].map((name) => (
          <div key={name} className="meter-card">
            <span className="meter-name">{name}</span>
            <span className="meter-foot">Reading…</span>
          </div>
        ))}
      </div>
    );
  }

  const memPct = info.ramUsed / info.ramTotal;
  return (
    <div className="meter-strip">
      <Ring
        name="Memory"
        pct={memPct}
        colour={colour}
        centre={`${Math.round(memPct * 100)}%`}
        sub={`${gib(info.ramUsed)} / ${gib(info.ramTotal)} GB`}
        foot="In use across every process"
        mine={`${gib(info.appRam)} GB`}
      />
      <Ring
        name="Processor"
        pct={info.load}
        colour={colour}
        centre={`${Math.round(info.load * 100)}%`}
        sub={`${info.busyThreads}/${info.threads} threads`}
        foot={`${Math.min(info.cores, info.threads)} cores · ${info.threads} threads`}
        mine={`${Math.round(info.appLoad * 100)}%`}
      />
      {hasBattery(info) ? <BatteryMeter info={info} /> : null}
    </div>
  );
};

export default SystemMeters;
