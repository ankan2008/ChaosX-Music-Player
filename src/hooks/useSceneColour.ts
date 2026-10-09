import { useEffect, useState } from 'react';

/**
 * The average colour of whatever is behind the app, as a CSS colour.
 *
 * The pomodoro sand is meant to be "coloured from the dominant colour of the
 * app wallpaper", and the only thing in the renderer that knows what the
 * wallpaper currently *is* — desktop image, live desktop, album art, a custom
 * picture, any of the blur styles over any of them — is the backdrop canvas
 * itself. Sampling it answers the question without re-implementing the six
 * source paths that feed it.
 *
 * The same trick `useSceneScrim` uses for luminance, at the same size: a 16×16
 * draw of a canvas into a scratch buffer is a few microseconds, and doing it on
 * a slow poll plus the scene's own dependency list means a track change
 * recolours the sand without a subscription.
 */

const SAMPLE = 16;

/** Kept away from the app's own accent so a failed sample still looks intended. */
const FALLBACK = 'rgb(232 180 180)';
const FALLBACK_RGB = '232 180 180';

/**
 * Turn a muddy backdrop average into a pigment.
 *
 * A wallpaper's average is a mid-grey-brown: the darks and the lights cancel.
 * Pushing saturation and lifting lightness into the band where a colour still
 * reads as a colour is what turns that into something a surface can be tinted
 * with. `floor`/`ceiling` are that band: the sand wants to be bright enough to
 * see, an interface wash wants to be dark enough to read white text on.
 */
function boost(r: number, g: number, b: number, floor = 0.4, ceiling = 0.62) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6);
    else if (max === gg) h = 60 * ((bb - rr) / d + 2);
    else h = 60 * ((rr - gg) / d + 4);
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : Math.min(1, d / (1 - Math.abs(2 * l - 1)));
  const sat = Math.min(1, s * 1.9 + 0.12);
  const light = Math.min(ceiling, Math.max(floor, l));
  return { h: Math.round(h), s: Math.round(sat * 100), l: Math.round(light * 100) };
}

/** The backdrop's average as 0-255 channels, or null when there is nothing to read. */
function averageBackdrop(): [number, number, number] | null {
  const backdrop = document.querySelector<HTMLCanvasElement>('.backdrop-layer');
  if (!backdrop || !backdrop.width || !backdrop.height) return null;
  const scratch = document.createElement('canvas');
  scratch.width = SAMPLE;
  scratch.height = SAMPLE;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(backdrop, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  } catch {
    // A tainted canvas (a cross-origin backdrop) leaves the caller's fallback.
    return null;
  }
}

/**
 * The backdrop's average as the three numbers `rgb(var(--x) / a)` wants.
 *
 * Sampled on the same slow poll as `useSceneColour`, and deliberately a whole
 * step darker: this is the value every accent-washed interface surface reads,
 * and a bright wallpaper average turned the nav highlight and the Resume button
 * into glowing slabs that out-shone the text sitting on them.
 */
export function useSceneRgb(reactOn: unknown[]): string {
  const [rgb, setRgb] = useState(FALLBACK_RGB);

  useEffect(() => {
    const sample = () => {
      const avg = averageBackdrop();
      if (!avg) return;
      const { h, s, l } = boost(avg[0], avg[1], avg[2], 0.24, 0.42);
      // HSL → RGB, so a stylesheet can write `rgb(var(--art-rgb) / <alpha>)`.
      const c = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100);
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
      const m = l / 100 - c / 2;
      const seg = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
      setRgb(seg.map((v) => Math.round((v + m) * 255)).join(' '));
    };
    sample();
    const id = window.setInterval(sample, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, reactOn);

  return rgb;
}

export function useSceneColour(reactOn: unknown[]): string {
  const [colour, setColour] = useState(FALLBACK);

  useEffect(() => {
    const sample = () => {
      const avg = averageBackdrop();
      if (!avg) return;
      const { h, s, l } = boost(avg[0], avg[1], avg[2]);
      setColour(`hsl(${h} ${s}% ${l}%)`);
    };
    sample();
    const id = window.setInterval(sample, 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, reactOn);

  return colour;
}
