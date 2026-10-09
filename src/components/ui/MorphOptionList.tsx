import React from 'react';

export interface MorphOption {
  value: string;
  label: string;
}

interface MorphOptionListProps {
  options: MorphOption[];
  value: string;
  onSelect: (value: string) => void;
  /** Rendered at the right of each row, e.g. an ascending/descending toggle. */
  renderTrailing?: (option: MorphOption) => React.ReactNode;
  /**
   * `column` is a menu you read down; `row` is a set of choices you scan across.
   * The rate picker is the latter — eight short values that are the same shape —
   * and laying them out as a column made the panel as tall as the widget it
   * belongs to.
   */
  layout?: 'column' | 'row';
}

/**
 * Option list shared by the morphing speed and sort panels. It is deliberately
 * plain markup: the glass shell around it is animated by the panel, and
 * content that carried its own transitions would fight that motion.
 */
const MorphOptionList: React.FC<MorphOptionListProps> = ({
  options,
  value,
  onSelect,
  renderTrailing,
  layout = 'column',
}) => (
  <div
    className={`morph-list ${layout === 'row' ? 'morph-list-row' : ''} ${renderTrailing ? 'has-trailing' : ''}`}
    role="listbox"
  >
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="option"
        aria-selected={option.value === value}
        className={`glass-select-option ${option.value === value ? 'selected' : ''}`}
        onClick={() => onSelect(option.value)}
      >
        {option.label}
        {renderTrailing?.(option)}
      </button>
    ))}
  </div>
);

export default MorphOptionList;
