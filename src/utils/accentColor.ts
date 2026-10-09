/**
 * Average-colour sample of an image, used to drive the waveform accent and the
 * pill's veil from the currently playing album art. Kept dependency-free; the
 * saturation bump stops desaturated covers producing a muddy wave.
 */
export function extractAccentColor(imageSrc: string): Promise<string> {
  return extractAccentRgb(imageSrc).then(([r, g, b]) => `rgb(${r}, ${g}, ${b})`);
}

/**
 * The same sample as three numbers.
 *
 * A consumer that paints the colour at a chosen alpha needs the components: a
 * `rgb()` string cannot carry one. The pill's veil is that consumer — it mixes
 * the record's own colour into the glass at a weight the compositor can still
 * read the desktop through.
 */
export async function extractAccentRgb(imageSrc: string): Promise<[number, number, number]> {
  const fallback = hexToRgb(DEFAULT_ACCENT);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 32;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(fallback);
        ctx.drawImage(img, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 32) continue;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
        if (n === 0) return resolve(fallback);
        const [h, s, l] = rgbToHsl(r / n, g / n, b / n);
        resolve(hslToRgb(h, Math.min(1, s * 1.25), Math.min(0.62, Math.max(0.4, l))));
      } catch {
        resolve(fallback);
      }
    };
    img.onerror = () => resolve(fallback);
    img.src = imageSrc;
  });
}

export const DEFAULT_ACCENT = '#fa5f7c';

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
