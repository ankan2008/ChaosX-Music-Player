import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { cardGlass } from '../../utils/glass';

export interface GlassSelectOption {
  value: string;
  label: string;
}

interface GlassSelectProps {
  value: string;
  options: GlassSelectOption[];
  onChange: (value: string) => void;
  title?: string;
  className?: string;
  /** Direction the menu opens toward */
  direction?: 'up' | 'down';
  icon?: React.ReactNode;
}

/**
 * Glass dropdown — replaces the native <select>, whose popup Windows paints
 * with its own (white) system colors and therefore ignored the dark theme.
 */
const GlassSelect: React.FC<GlassSelectProps> = ({
  value,
  options,
  onChange,
  title,
  className = '',
  direction = 'down',
  icon,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  // Grace both ways: brushing past shouldn't flash a menu, and crossing the
  // gap from trigger to menu shouldn't dismiss it.
  const onEnter = () => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(true);
    }, 280);
  };
  const onLeave = () => {
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setOpen(false);
    }, 260);
  };

  useEffect(() => () => clear(), []);

  // Lift the hover label clear of the open menu instead of colliding with it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const menu = menuRef.current;
    if (!root) return;
    if (open && menu && direction === 'up') {
      root.style.setProperty('--tip-rise', `${menu.offsetHeight + 22}px`);
    } else {
      root.style.removeProperty('--tip-rise');
    }
  }, [open, direction, options.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? options[0];

  return (
    <div
      className={`glass-select ${className}`}
      ref={rootRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <button
        type="button"
        className={`glass-select-trigger ${open ? 'open' : ''} ${title ? 'tip-high' : ''}`}
        onClick={() => setOpen((v) => !v)}
        data-tip={title} aria-label={title}
      >
        {icon}
        <span className="truncate">{selected?.label}</span>
        <Icon name="collapse" size={11} rotate={open ? 180 : 0} className="glass-select-caret-icon" />
      </button>

      {open && (
        <div
          className={`glass-select-menu ${direction === 'up' ? 'up' : 'down'}`}
          ref={menuRef}
          role="listbox"
          data-glass
          data-config={cardGlass(16)}
          data-no-capture
        >
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`glass-select-option ${opt.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default GlassSelect;
