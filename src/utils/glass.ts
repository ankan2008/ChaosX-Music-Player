/**
 * Per-element shader config for card surfaces (fed to the vendored
 * LiquidGlass instance via its `data-config` attribute). Slightly calmer
 * than the player pill: big panels read better with a shallower bevel and
 * a touch less refraction.
 */
export function cardGlass(cornerRadius: number): string {
  return JSON.stringify({
    cornerRadius,
    zRadius: 18,
    blurAmount: 0.4,
    refraction: 0.55,
    chromAberration: 0.05,
    edgeHighlight: 0.06,
    fresnel: 0.85,
    specular: 0.16,
    shadowOpacity: 0.3,
    shadowSpread: 14,
    shadowOffsetY: 5,
  });
}

/**
 * The dropdowns: the same liquid glass as the cards, but deliberately lighter.
 *
 * They used to be an alias for `cardGlass`, which meant they carried the cards'
 * 0.4 blur and 0.3 shadow — enough darkening that a menu over the record read as
 * a smoky panel rather than a lens. A flyout is on screen for two seconds and its
 * job is to let you read through it, so it takes less blur, less shadow and more
 * refraction than anything you browse against.
 *
 * Its own helper rather than an alias because these surfaces animate their radius
 * every frame and the config string is compared before it is written — a shared
 * function would read as an accident the next time one of the two is tuned.
 */
export function dropdownGlass(cornerRadius: number): string {
  return JSON.stringify({
    cornerRadius,
    zRadius: 18,
    blurAmount: 0.22,
    refraction: 0.68,
    chromAberration: 0.05,
    edgeHighlight: 0.08,
    fresnel: 0.85,
    specular: 0.16,
    shadowOpacity: 0.14,
    shadowSpread: 12,
    shadowOffsetY: 4,
  });
}

/**
 * The desktop pill.
 *
 * Glass at the four edges of the capsule rather than as a fill across it: the
 * corner radius is large enough, and the strip long and narrow enough, that the
 * bend lives in the rim and the middle stays flat — which is what keeps nine
 * buttons and a waveform legible on top of it.
 *
 * `blurAmount` is the highest of the three configs because this is the only
 * surface in the app whose backdrop is somebody's actual desktop, with text and
 * windows in it, rather than the app's own artwork.
 */
export function pillGlass(cornerRadius: number): string {
  return JSON.stringify({
    cornerRadius,
    zRadius: 22,
    blurAmount: 0.52,
    refraction: 0.5,
    chromAberration: 0.05,
    edgeHighlight: 0.1,
    fresnel: 0.9,
    specular: 0.18,
    shadowOpacity: 0.34,
    shadowSpread: 16,
    shadowOffsetY: 6,
  });
}

/**
 * The transport bar at the foot of the library window.
 *
 * This surface used to carry no config at all, which left it on the engine's
 * defaults — `refraction: 0.69` and `zRadius: 40`, the strongest bend anywhere in
 * the app and a *harder* one than the cards it sits under. On a bar 92 px tall a
 * 40 px bevel means there is no flat middle, so the whole lens curves, and a lens
 * that curves near its top edge samples from above its top edge. Add the 20 px of
 * `SHADOW_PAD` every glass canvas hangs past its own box and the strip was
 * gathering the cards two rows up into its rim.
 *
 * The bend was cut to 0.22, and the reflection people reported did not go away —
 * because the bend was never what put the cards in the picture. Anything painted
 * before the pill is in its scene, and the pill is at the foot of a scrolling
 * column, so every card passes through it. `sceneBackdropOnly` is the fix: the bar
 * samples the wallpaper and its veil and stops, which is what a bar laid *over*
 * content should do, and the bend can stay.
 */
export function transportGlass(cornerRadius: number): string {
  return JSON.stringify({
    cornerRadius,
    sceneBackdropOnly: true,
    zRadius: 26,
    blurAmount: 0.34,
    refraction: 0.22,
    chromAberration: 0.04,
    edgeHighlight: 0.08,
    fresnel: 0.85,
    specular: 0.14,
    shadowOpacity: 0.28,
    shadowSpread: 14,
    shadowOffsetY: 6,
  });
}

/**
 * The primary actions: real glass, but with a colour of its own.
 *
 * These buttons used to be a CSS gradient, which is what the user meant by
 * "cheap glassmorphism" — a flat fill with a highlight painted on it cannot
 * bend anything. A button is a tenth the area of a card, so the bevel is much
 * shallower than `cardGlass` (a 40px z-radius on a 32px-tall pill puts the whole
 * curvature at the rim and the flat middle disappears) and it is the only
 * surface in the app that asks for `tintStrength`: the shader's own tint is the
 * cool blue glass, and the accent wash comes from the caller as a child layer,
 * because a background on this element is painted *under* the shader canvas.
 *
 * `button: true` hands the press and hover states to the engine, which squashes
 * the bevel and lifts the brightness instead of requiring a CSS transform that
 * would fight the shader's own geometry.
 */
export function buttonGlass(cornerRadius: number): string {
  return JSON.stringify({
    cornerRadius,
    zRadius: 11,
    blurAmount: 0.3,
    refraction: 0.72,
    chromAberration: 0.06,
    edgeHighlight: 0.12,
    fresnel: 0.9,
    specular: 0.2,
    tintStrength: 0.22,
    saturation: 0.18,
    shadowOpacity: 0.3,
    shadowSpread: 12,
    shadowOffsetY: 3,
    button: true,
  });
}
