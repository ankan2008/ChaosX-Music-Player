/**
 * Default configuration values for the liquid glass effect.
 * These can be overridden per-element via dataset.config (JSON string)
 * or globally via LiquidGlass.init({ defaults: { ... } }).
 */

/** Per-element glass configuration. */
export interface GlassConfig {
	/** Background blur strength (0 = sharp, 1 = maximum blur). */
	blurAmount: number;
	/** Refraction strength — how much the glass bends the image behind it */
	refraction: number;
	/** Chromatic aberration — color fringing at edges */
	chromAberration: number;
	/** Edge highlight intensity (inner glow / rim lighting) */
	edgeHighlight: number;
	/** Specular highlight intensity (Blinn-Phong) */
	specular: number;
	/** Fresnel reflection intensity at grazing angles */
	fresnel: number;
	/** Micro-distortion noise strength */
	distortion: number;
	/** Corner radius in CSS pixels */
	cornerRadius: number;
	/** Z-radius (bevel depth) — controls the curvature of the pill bevel */
	zRadius: number;
	/** Overall opacity of the glass panel */
	opacity: number;
	/** Saturation adjustment (-1 = desaturated, 0 = normal, 1 = vivid) */
	saturation: number;
	/** Tint strength — cool blue-ish glass tint */
	tintStrength: number;
	/** Brightness adjustment (-0.5 to 0.5) */
	brightness: number;
	/** Shadow opacity (0 = no shadow, 1 = full black) */
	shadowOpacity: number;
	/** Shadow spread in CSS pixels */
	shadowSpread: number;
	/** Shadow vertical offset in CSS pixels */
	shadowOffsetY: number;
	/** Whether this glass element can be dragged around (Pointer Events) */
	floating: boolean;
	/** Whether this glass element behaves as a button (hover lift + press effect) */
	button: boolean;
	/**
	 * Bevel mode: 0 = biconvex pill (half-circle cross-section, default),
	 * 1 = dome (flat bottom, quarter-circle top — use with cornerRadius = zRadius
	 * for a perfect half-sphere magnifier effect).
	 */
	bevelMode: number;
	/**
	 * Fill colour of the local scene canvas underneath every glass panel.
	 * Sampled where no other layer paints (e.g. a fully transparent window
	 * backdrop). Use 'rgba(0,0,0,0)' for smoked glass over whatever sits
	 * behind the window itself.
	 */
	sceneFill: string;
	/**
	 * Compose this panel's scene from the layers *behind* the page only.
	 *
	 * A glass normally sees everything painted before it, which includes the
	 * other cards — correct for a card floating in the column, wrong for a
	 * transport bar laid across the foot of a scrolling list, where every card
	 * that passes over it is dragged through and blurred. Set on the pill.
	 */
	sceneBackdropOnly: boolean;
}

export const DEFAULTS: GlassConfig = {
	blurAmount: 0.00,
	refraction: 0.69,
	chromAberration: 0.05,
	edgeHighlight: 0.05,
	specular: 0.00,
	fresnel: 1.00,
	distortion: 0.00,
	cornerRadius: 65,
	zRadius: 40,
	opacity: 1.00,
	saturation: 0.00,
	tintStrength: 0.00,
	brightness: 0.00,
	shadowOpacity: 0.30,
	shadowSpread: 10,
	shadowOffsetY: 1,
	floating: false,
	button: false,
	bevelMode: 0,
	sceneFill: 'rgba(0,0,0,0)',
	sceneBackdropOnly: false,
};

/** Number of Gaussian blur passes (higher = smoother but slower) */
export const BLUR_ITERATIONS = 6;

/** Extra padding around each panel for rendering the drop shadow (px) */
export const SHADOW_PAD = 20;
