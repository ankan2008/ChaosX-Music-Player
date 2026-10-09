/**
 * liquidglass — A liquid glass effect library for the web.
 *
 * Apply realistic glass refraction, blur, chromatic aberration, and
 * lighting to any HTML element using WebGL shaders.
 *
 * @example
 *   import { LiquidGlass } from '@ybouane/liquidglass';
 *
 *   const instance = await LiquidGlass.init({
 *       root: document.querySelector('#my-root'),
 *       glassElements: document.querySelectorAll('.glass'),
 *   });
 *
 *   // Later:
 *   instance.destroy();
 *
 * @module @ybouane/liquidglass
 */

export { LiquidGlass } from './LiquidGlass';
export type { LiquidGlassOptions } from './LiquidGlass';
export { DEFAULTS } from './defaults';
export type { GlassConfig } from './defaults';
export { invalidateFontEmbedCache } from './HtmlCapture';
