import type { GlassEngine, GlassEngineOptions } from './types';

export type { GlassEngine, GlassEngineOptions } from './types';

/** Boots the vendored liquid-glass WebGL shader that renders every surface. */
export async function createGlassEngine(
  options: GlassEngineOptions,
): Promise<GlassEngine> {
  const { createLiquidGlassEngine } = await import('./liquidglass');
  return createLiquidGlassEngine(options);
}
