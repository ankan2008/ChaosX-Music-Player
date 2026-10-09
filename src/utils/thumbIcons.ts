import { iconUrlFor, type IconName } from '../components/ui/Icon';

/**
 * The taskbar thumbnail's icons, drawn from the same sources every other control
 * in the app uses.
 *
 * `Icon` resolves a name to either an inline SVG data URL or a PNG from the
 * Plumpy set, and paints it through a CSS mask so it inherits `currentColor`.
 * Reimplementing those glyphs in the main process produced marks that merely
 * rhymed with the app's — the skip icons are 270° rings with an arrowhead and a
 * literal "5", which is not a shape worth redrawing twice. So the renderer draws
 * them instead: load the real URL, mask it to a solid silhouette the way the CSS
 * does, and hand the PNG over. Chromium rasterises it, which means the thumbnail
 * and the transport row cannot drift apart.
 */

/** Names the shell needs, in the order it lays them out left to right. */
const WANTED: Array<{ key: string; name: IconName }> = [
  { key: 'previous', name: 'previous' },
  { key: 'back5', name: 'back-5s' },
  { key: 'play', name: 'play' },
  { key: 'pause', name: 'pause' },
  { key: 'forward5', name: 'forward-5s' },
  { key: 'next', name: 'next' },
];

/** Ink colour: the shell paints the button strip dark, so the marks are light. */
const INK = '#f2f1f5';
const SIDE = 32;

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('icon image failed'));
    img.src = url;
  });
}

/**
 * One icon to a base64 PNG.
 *
 * The image is drawn at the full canvas and then multiplied by the ink colour
 * with `source-in`, which keeps only the pixels the art covers — the same
 * silhouette the CSS mask produces.
 */
async function rasterise(name: IconName): Promise<string | null> {
  const url = iconUrlFor(name);
  if (!url) return null;
  try {
    const img = await load(url);
    const canvas = document.createElement('canvas');
    canvas.width = SIDE;
    canvas.height = SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SIDE, SIDE);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, SIDE, SIDE);
    const data = canvas.toDataURL('image/png');
    return data.startsWith('data:image/png;base64,') ? data.slice('data:image/png;base64,'.length) : null;
  } catch {
    return null;
  }
}

/**
 * Build the set and hand it to the main process, which turns each PNG into an
 * icon handle and refreshes the buttons. Sent once; the art never changes.
 */
export async function publishThumbIcons(): Promise<void> {
  const send = window.electronAPI?.thumbbar?.setIcons;
  if (!send) return;
  const out: Record<string, string> = {};
  for (const { key, name } of WANTED) {
    const png = await rasterise(name);
    if (png) out[key] = png;
  }
  if (Object.keys(out).length) send(out);
}
