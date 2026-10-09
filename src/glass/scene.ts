import type { GlassEngine } from './types';

/**
 * The one handle every layer shares for telling the glass that the scene
 * behind it moved.
 *
 * Backdrops are painted into canvases by script, so swapping one never
 * mutates the DOM — and the shader only re-renders a panel when the DOM
 * changes or the panel itself moves. A card that sits still over a new
 * album cover would otherwise keep refracting the previous song's colours
 * until something happened to nudge it.
 */
let engine: GlassEngine | null = null;

export function setGlassEngine(next: GlassEngine | null): void {
  engine = next;
}

/** Re-composite every glass panel on the next frame. */
export function invalidateScene(): void {
  engine?.refresh();
}
