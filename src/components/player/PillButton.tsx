import React from 'react';
import Icon, { type IconName } from '../ui/Icon';

/**
 * A named square in the pill's two-column grid.
 *
 * The strip's controls are one cell each in a fixed grid, so every one of them
 * has to report the same box — the row height is measured from the cell, not
 * from the glyph. They stay plain buttons rather than sharing
 * `TransportControls`, because the pill reads its rows bottom-to-top and needs
 * each action in a specific cell, which a single flex row cannot express.
 */
const PillButton: React.FC<{
  icon: IconName;
  /** Lets one cell break out of the grid, e.g. play across both columns. */
  className?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}> = ({ icon, label, onClick, disabled, active, className = '' }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`liquid-glass-btn icon small squish ${active ? 'mode-btn active' : ''} ${className}`}
    data-tip={label}
    aria-label={label}
    aria-pressed={active === undefined ? undefined : active}
  >
    <Icon name={icon} size={15} />
  </button>
);

export default PillButton;
