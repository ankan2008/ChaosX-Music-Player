import React from 'react';
import { buttonGlass } from '../../utils/glass';

/**
 * A primary action in real tinted liquid glass.
 *
 * The user's complaint about these buttons was that they were "css cheap
 * glassmorphism" — a gradient with a highlight painted on it, which cannot bend
 * anything behind it. This is the shader surface instead, with the accent wash
 * kept as a child layer because the canvas is injected at z-index -1 and still
 * paints *over* the element's own background.
 *
 * It is only used where a single action leads a group. Every control in the app
 * becoming real glass would be seven more shader surfaces on a Vega 8, which is
 * the trade that took the record's spin down to one frame a second in the mini
 * card.
 */
interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  radius?: number;
  /**
   * Any CSS colour, painted on the child layer under the label. Defaults to
   * `--glass-tint`, the app accent at wash strength, so a themed build tints its
   * own buttons without anyone passing a colour through four components.
   */
  tint?: string;
}

const GlassButton = React.forwardRef<HTMLButtonElement, Props>(function GlassButton(
  { radius = 12, tint = 'var(--glass-tint, transparent)', className = '', children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={`glass-btn ${className}`}
      data-glass
      data-config={buttonGlass(radius)}
      data-no-capture
      style={{ '--btn-tint': tint, borderRadius: `${radius}px` } as React.CSSProperties}
    >
      <i className="btn-tint" aria-hidden />
      <span className="btn-face">{children}</span>
    </button>
  );
});

export default GlassButton;
