import React, { useEffect, useState } from 'react';
import { cardGlass } from '../../utils/glass';
import d0 from '../../assets/digits/0.png';
import d1 from '../../assets/digits/1.png';
import d2 from '../../assets/digits/2.png';
import d3 from '../../assets/digits/3.png';
import d4 from '../../assets/digits/4.png';
import d5 from '../../assets/digits/5.png';
import d6 from '../../assets/digits/6.png';
import d7 from '../../assets/digits/7.png';
import d8 from '../../assets/digits/8.png';
import d9 from '../../assets/digits/9.png';
import dColon from '../../assets/digits/colon.png';

/**
 * The clock's numerals are the real AG-Stencil outlines, cut out as masks, so
 * the scene behind the window refracts *through* the digits.
 *
 * Each mask was rendered from the font at a common height:
 *   magick -font AG-Stencil.ttf -pointsize 300 -fill white -annotate +0+0 "0"
 *     | magick - -trim +repage -resize x192 digits/0.png
 * The colon is trimmed then padded to that same height so its dots keep their
 * place on the digits' centre line. A mask is required rather than live text
 * because Chromium lets `background-clip: text` shape a gradient but nothing
 * can clip a `backdrop-filter` to glyphs — only a mask clips the shader canvas.
 */
const HEIGHT = 192;
const GLYPHS: Record<string, { src: string; w: number }> = {
  '0': { src: d0, w: 132 },
  '1': { src: d1, w: 76 },
  '2': { src: d2, w: 137 },
  '3': { src: d3, w: 129 },
  '4': { src: d4, w: 145 },
  '5': { src: d5, w: 132 },
  '6': { src: d6, w: 138 },
  '7': { src: d7, w: 126 },
  '8': { src: d8, w: 130 },
  '9': { src: d9, w: 139 },
  ':': { src: dColon, w: 40 },
};

interface GlassClockProps {
  /** Height of one numeral in pixels; everything else scales off it. */
  digitHeight?: number;
  className?: string;
  /**
   * Drop the date's own glass pill. Used where the whole clock already sits on
   * a card of its own — a second piece of glass inside the first just reads as
   * a border.
   */
  plainDate?: boolean;
}

const GlassClock: React.FC<GlassClockProps> = ({
  digitHeight = 44,
  className = '',
  plainDate = false,
}) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hour12 = now.getHours() % 12 || 12;
  const time = `${hour12}:${String(now.getMinutes()).padStart(2, '0')}`;
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div className={`glass-clock ${className}`} aria-label={`${date}, ${time}`}>
      {plainDate ? (
        <p className="gc-date">{date}</p>
      ) : (
        <span
          className="gc-date-shell"
          data-glass
          data-config={cardGlass(14)}
          data-no-capture
        >
          <p className="gc-date">{date}</p>
        </span>
      )}
      <div className="gc-time" aria-hidden style={{ gap: `${Math.round(digitHeight * 0.04)}px` }}>
        {time.split('').map((code, i) => {
          const g = GLYPHS[code];
          if (!g) return null;
          return (
            <span
              key={`${code}-${i}`}
              className="gc-glyph"
              data-glass
              data-config={cardGlass(10)}
              style={
                {
                  width: `${(g.w / HEIGHT) * digitHeight}px`,
                  height: `${digitHeight}px`,
                  WebkitMaskImage: `url(${g.src})`,
                  maskImage: `url(${g.src})`,
                } as React.CSSProperties
              }
            >
              {/* The shader canvas is injected at a negative z-index, which
                  still paints above this element's own background — so the rim
                  tint has to be a child. The parent's mask clips it to the
                  numeral. */}
              <i className="gc-tint" aria-hidden />
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default GlassClock;
