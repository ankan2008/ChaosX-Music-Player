import React from 'react';
import { ICON_URLS } from '../../assets/assets';

export type IconName =
  | 'add'
  | 'clock'
  | 'close'
  | 'collapse'
  | 'dock'
  | 'delete'
  | 'edit'
  | 'end'
  | 'expand'
  | 'download'
  | 'fast-forward'
  | 'home'
  | 'list'
  | 'music'
  | 'mute'
  | 'next'
  | 'pause'
  | 'pencil'
  | 'play'
  | 'playlist'
  | 'plus'
  | 'previous'
  | 'refresh'
  | 'repeat'
  | 'rewind'
  | 'search'
  | 'settings'
  | 'shuffle'
  | 'skip-to-start'
  | 'sort'
  | 'speaker'
  | 'stop'
  | 'volume'
  | 'equalizer'
  | 'lyrics'
  | 'pill'
  | 'mini'
  | 'laptop'
  | 'desktop'
  | 'queue'
  | 'back-5s'
  | 'forward-5s'
  | 'hide'
  | 'quote'
  | 'theatre'
  | 'check'
  | 'image'
  | 'restart-app';

/**
 * Icons with no Plumpy source: drawn as SVG and used through the same mask
 * pipeline, so they still inherit `currentColor`. The skip glyphs carry a
 * literal "5" because the arrow alone reads as a track skip, not a seek.
 */
/*
 * The two 270° rings, named for the direction they actually travel.
 *
 * Solved from the arc flags rather than read off them, because reading them off
 * is what got this wrong once: with y pointing down, sweep-flag 1 is *clockwise*
 * on screen, not counter-clockwise. The rewind glyph was handed the clockwise
 * ring while its arrowhead pointed left, so the curve contradicted the head and
 * the control read as a fast-forward. The head at the top of a ring points the
 * way that ring turns, so back-5s takes the anticlockwise ring and forward-5s
 * the clockwise one.
 */
const ARC_CW = 'M12 4.2A7.8 7.8 0 1 1 4.2 12';
const ARC_ACW = 'M12 4.2A7.8 7.8 0 1 0 19.8 12';
const skipIcon = (head: string, arc: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.1" stroke-linecap="round"><path d="${arc}"/><path d="${head}" fill="black" stroke="none"/><text x="12" y="17" font-family="Arial,Helvetica,sans-serif" font-size="12.5" font-weight="700" text-anchor="middle" fill="black" stroke="none">5</text></svg>`;

const INLINE_ICONS: Partial<Record<IconName, string>> = {
  /*
   * The bundled `volume.png` is a bare cone with no throw, so it reads as the
   * same speaker whether sound is coming out or not. Drawn here instead: cone
   * plus three arcs of increasing radius, which is what makes "sound is leaving
   * this" legible at 13px next to the mute glyph.
   */
  volume:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.4h3.6L11.4 5.2v13.6L6.6 14.6H3z" fill="black" stroke="none"/><path d="M14.6 9.2a4 4 0 0 1 0 5.6"/><path d="M17.2 6.8a7.6 7.6 0 0 1 0 10.4"/><path d="M19.8 4.4a11 11 0 0 1 0 15.2"/></svg>',
  equalizer:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><path d="M6 3.5v17M12 3.5v17M18 3.5v17"/><rect x="3.4" y="7.5" width="5.2" height="4.2" rx="1.6" fill="black" stroke="none"/><rect x="9.4" y="13" width="5.2" height="4.2" rx="1.6" fill="black" stroke="none"/><rect x="15.4" y="5.5" width="5.2" height="4.2" rx="1.6" fill="black" stroke="none"/></svg>',
  /*
   * No `download.png` exists in the bundled set. Drawn as the arrow-into-a-tray
   * everyone reads as "save to disk", with the tray open at the top so it does
   * not look like a box the arrow is already inside.
   */
  download:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2v11.4"/><path d="M7.2 10.2 12 15l4.8-4.8"/><path d="M4.2 16.4v2.4a2 2 0 0 0 2 2h11.6a2 2 0 0 0 2-2v-2.4"/></svg>',
  'back-5s': skipIcon('M12 1.1 8.3 4.3 12 7.5Z', ARC_ACW),  'forward-5s': skipIcon('M12 1.1 15.7 4.3 12 7.5Z', ARC_CW),
  lyrics:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.4v9.4a1.4 1.4 0 0 1-1.4 1.4h-8.6l-4.4 3.8v-3.8H4.6a1.4 1.4 0 0 1-1.4-1.4V5.4A1.4 1.4 0 0 1 4.6 4h14.8a1.4 1.4 0 0 1 1.4 1.4Z"/><path d="M7.4 8.6h9.2M7.4 12h6.2"/></svg>',
  // A tall capsule with the artwork dot at its head — the pill mode at a glance.
  pill:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><rect x="7.6" y="2.4" width="8.8" height="19.2" rx="4.4"/><circle cx="12" cy="7.4" r="2" fill="black" stroke="none"/><path d="M9.8 13.6h4.4M9.8 17h4.4"/></svg>',
  queue:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><path d="M4 6.4h11M4 11.4h11M4 16.4h7"/><path d="M17.4 13.2v7.2l5.2-3.6Z" fill="black" stroke="none"/></svg>',
  // Collapse = the strip sliding out through the screen edge it is docked to.
  hide:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 3.6v16.8"/><path d="M14.6 7.8 10.4 12l4.2 4.2"/><path d="M8.6 7.8 4.4 12l4.2 4.2"/></svg>',
  /*
   * A plain cross. Drawn rather than taken from the bitmap set because it is the
   * one glyph every surface needs and the set has no candidate that is not
   * already a delete or a close-window button; the round caps keep it in step
   * with the rest of the inline drawings at 12px.
   */
  close:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.3" stroke-linecap="round"><path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/></svg>',
  /*
   * The tick that closes the setup rail's completed steps. `close` is its pair —
   * same weight, same round caps — so a step reading done and a dialog reading
   * dismissed belong to each other rather than to two different alphabets.
   */
  check:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 12.8 9.6 17.6 19.2 6.6"/></svg>',
  /*
   * A framed picture with a sun and a hill in it — the thing every OS draws for
   * "an image file", and the only glyph that separates "choose a wallpaper" from
   * "choose a file" at a glance.
   */
  image:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.4" width="18" height="15.2" rx="2.6"/><circle cx="8.4" cy="9.6" r="1.9"/><path d="M3.6 17.2 9 11.6l3.6 3.6 3.2-2.8 4.6 4.8"/></svg>',
  /*
   * A screen with the strip on its right edge and an arrow pushing it across.
   * Drawn for the right-hand case only; `.pill-left` mirrors it, so the glyph
   * always points the strip towards the edge it is about to leave.
   */
  dock:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4.2" width="18.8" height="15.6" rx="2.6"/><path d="M17.6 6.6v10.8" stroke-width="2.6"/><path d="M6.8 12h7.4M11.4 8.8 14.6 12l-3.2 3.2"/></svg>',
  /*
   * The two shapes the Statistics page's device card can wear. Drawn plump —
   * thick, round-capped strokes with a filled slab — because they sit beside the
   * rest of the app's iconography at 22px and a hairline machine glyph reads as
   * a different design language. Which one shows is `battery.present`: a machine
   * with a cell is a laptop, and one without is a desktop.
   */
  laptop:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="10.6" rx="1.9"/><path d="M2.6 18.4h18.8" stroke-width="2.6"/><path d="M10.2 18.4h3.6" stroke-width="2.6" opacity="0.55"/></svg>',
  desktop:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="4" width="18.4" height="11.8" rx="2.2"/><path d="M12 15.8v3.2" stroke-width="2.4"/><path d="M7.8 19.8h8.4" stroke-width="2.6"/></svg>',
  // Fullscreen music mode. Not the four-arrow "expand" the video surface uses:
  // this mode is not a bigger rectangle, it is the record filling the screen, and
  // the arrows read as "make this window larger" on every other control on it.
  theatre:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4.4" width="18.8" height="13" rx="2.6"/><path d="M8.2 20.4h7.6"/><path d="M10.4 8.6v5l4.4-2.5Z" fill="black" stroke="none"/></svg>',
  /*
   * Two quotation marks, filled. The quote card's control was a shuffle glyph,
   * which said "randomise" about a card that walks a shuffled order you never
   * see; what the button actually means is "the next line", and a quote mark is
   * the only icon in the set that already says so.
   */
  /*
   * The power glyph: a ring broken at the top with a stem through the gap.
   *
   * `refresh` was here first, and it is the wrong shape for this button — the two
   * ±5s seeks either side of the transport are the same 270° ring with an arrow
   * head, so a repair on the process sat in a row of controls about the record
   * wearing their family's face. Nothing in the app uses a power symbol for
   * anything else, and everyone knows what it means.
   */
  'restart-app':
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4v7.4"/><path d="M7.2 5.9a7.7 7.7 0 1 0 9.6 0"/></svg>',
  quote:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="black" stroke="none"><path d="M4.5 13.3c0-3.5 2.1-6.1 5.5-7.3l.9 1.8c-2 1-3.1 2.2-3.2 3.8.3-.2.6-.3 1-.3 1.8 0 3.1 1.3 3.1 3 0 1.8-1.4 3.1-3.2 3.1-2.5 0-4.1-1.7-4.1-4.1Z"/><path d="M12.9 13.3c0-3.5 2.1-6.1 5.5-7.3l.9 1.8c-2 1-3.1 2.2-3.2 3.8.3-.2.6-.3 1-.3 1.8 0 3.1 1.3 3.1 3 0 1.8-1.4 3.1-3.2 3.1-2.5 0-4.1-1.7-4.1-4.1Z"/></svg>',
  /*
   * Mini mode: a card with a smaller card inside it.
   *
   * The chevron this control used to wear is the caret every dropdown in the app
   * carries, so the button that changes the whole window's shape was drawn with
   * the same face as the one that opens a menu — and a chevron points, which is
   * not something a mode does. The frame-within-a-frame is the picture-in-picture
   * convention, and it says "a small version of this, floating" without a label.
   */
  mini:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="5" width="18.8" height="14" rx="4.4"/><rect x="6" y="8.2" width="6" height="3.8" rx="1.9" fill="black" stroke="none"/></svg>',
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Rotation in degrees — used for e.g. an expand chevron */
  rotate?: number;
}

/**
 * The one place that decides what an icon *is*: an inline drawing wins over the
 * bitmap, so a glyph can be corrected without editing the PNG set.
 *
 * Exported because the taskbar thumbnail has to render the same art through a
 * completely different pipeline — rasterise, mask to a silhouette, hand a PNG to
 * the shell — and a second copy of this rule is how two renderings of one icon
 * start to disagree.
 */
export function iconUrlFor(name: IconName): string | null {
  const inline = INLINE_ICONS[name];
  return inline ? `data:image/svg+xml,${encodeURIComponent(inline)}` : ICON_URLS[name] ?? null;
}

/**
 * Plumpy (icons8) icon rendered as a masked span so it inherits
 * `currentColor` and can be tinted/animated with CSS.
 */
const Icon: React.FC<IconProps> = ({ name, size = 16, className = '', rotate = 0 }) => {
  const url = iconUrlFor(name);
  if (!url) return null;
  return (
    <span
      className={`plumpy ${className}`}
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
        transform: rotate ? `rotate(${rotate}deg)` : undefined,
      }}
      aria-hidden
    />
  );
};

export default Icon;
