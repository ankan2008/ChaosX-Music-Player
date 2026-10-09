import React from 'react';
import { cardGlass } from '../../utils/glass';

/**
 * The app's name as a mark rather than as a string.
 *
 * Two surfaces, one beside the other: the artwork on a liquid-glass squircle,
 * and the drawn wordmark on a liquid-glass pill. Both are glass cards, so the
 * image has to be a child of them rather than a background — the shader canvas
 * paints over anything the element itself paints.
 *
 * The artwork is no longer a squircle, so it is given more of its plate than the
 * old one needed: a rounded badge used to fill the frame on its own, and a
 * headphones-and-X drawn to a square leaves its own corners empty.
 */
const BrandMark: React.FC<{ className?: string; wordmark?: boolean }> = ({
  className = '',
  wordmark = false,
}) => (
  <div className={`brand-mark ${wordmark ? 'wordmark-only' : ''} ${className}`}>
    {!wordmark && (
      <span
        className="brand-plate"
        data-glass
        data-config={cardGlass(20)}
        data-no-capture
      >
        <img className="brand-art" src="./brand/icon.png" alt="" draggable={false} />
      </span>
    )}
    <span
      className="brand-pill"
      data-glass
      data-config={cardGlass(16)}
      data-no-capture
    >
      <img className="brand-word" src="./brand/wordmark.png" alt="ChaosX" draggable={false} />
    </span>
  </div>
);

export default BrandMark;
