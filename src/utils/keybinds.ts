/**
 * The keyboard map, as data.
 *
 * The shortcuts used to be a `switch` on `e.code` with the modifier tests
 * inlined in each arm, and the Settings page carried a second, hand-written copy
 * of what they did — which is how it ended up listing `←/→` and `Ctrl+←/→` as two
 * different seeks. One table now, read by the hook that acts on it and by the
 * page that shows it, and editable by the user.
 */

export type BindId =
  | 'playpause'
  | 'seek-back'
  | 'seek-forward'
  | 'previous'
  | 'next'
  | 'volume-up'
  | 'volume-down'
  | 'mute'
  | 'fullscreen'
  | 'pill'
  | 'mini'
  | 'escape'
  | 'zoom-in'
  | 'zoom-out';

export interface KeyBind {
  /** `KeyboardEvent.code`, so a French keyboard's `KeyM` is still the M key. */
  code: string;
  /** Lower-case modifier names: any of ctrl / alt / shift / meta. */
  mods: string[];
}

export const MOD_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

export const BIND_LABELS: Record<BindId, string> = {
  playpause: 'Play / Pause',
  'seek-back': 'Seek back 5 seconds',
  'seek-forward': 'Seek forward 5 seconds',
  previous: 'Previous track',
  next: 'Next track',
  'volume-up': 'Volume up',
  'volume-down': 'Volume down',
  mute: 'Mute',
  fullscreen: 'Fullscreen — Esc leaves it',
  pill: 'Pill mode — again to close',
  mini: 'Mini player — again to close',
  escape: 'Close a panel or fullscreen',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
};

/** The order the table is listed and rebound in. */
export const BIND_ORDER: BindId[] = [
  'playpause',
  'seek-back',
  'seek-forward',
  'previous',
  'next',
  'volume-up',
  'volume-down',
  'mute',
  'fullscreen',
  'pill',
  'mini',
  'escape',
  'zoom-in',
  'zoom-out',
];

/*
 * The two zoom defaults are the combinations the app already answered to — and it
 * answered to them by accident, because Chromium's own page zoom has always been
 * wired to them. `Equal` with Ctrl+Shift is the plus key on the main row: the
 * cap reads `=+` and the combination the user pressed is Ctrl+Shift+"+", which is
 * this code plus the shift. `Minus` needs no shift, so it is Ctrl on its own.
 *
 * They are ordinary entries now, which is what makes them rebindable and what
 * puts them inside the recorder's clash rule — a zoom bound to `Space` would be
 * refused for the same reason as anything else.
 */
export const DEFAULT_BINDS: Record<BindId, KeyBind> = {
  playpause: { code: 'Space', mods: [] },
  'seek-back': { code: 'ArrowLeft', mods: [] },
  'seek-forward': { code: 'ArrowRight', mods: [] },
  previous: { code: 'ArrowLeft', mods: ['ctrl'] },
  next: { code: 'ArrowRight', mods: ['ctrl'] },
  'volume-up': { code: 'ArrowUp', mods: [] },
  'volume-down': { code: 'ArrowDown', mods: [] },
  mute: { code: 'KeyM', mods: [] },
  fullscreen: { code: 'KeyF', mods: ['shift'] },
  pill: { code: 'KeyP', mods: ['shift'] },
  mini: { code: 'KeyM', mods: ['shift'] },
  escape: { code: 'Escape', mods: [] },
  'zoom-in': { code: 'Equal', mods: ['ctrl', 'shift'] },
  'zoom-out': { code: 'Minus', mods: ['ctrl'] },
};

export type Binds = Record<BindId, KeyBind>;

/** Merge what the user has stored over the defaults, dropping stale keys. */
export function resolveBinds(stored: Partial<Binds> | undefined): Binds {
  const out: Binds = { ...DEFAULT_BINDS };
  for (const id of BIND_ORDER) {
    const b = stored?.[id];
    if (b && typeof b.code === 'string' && Array.isArray(b.mods)) out[id] = { code: b.code, mods: b.mods };
  }
  return out;
}

/**
 * One row, with the default behind it.
 *
 * `resolveBinds` runs in the store's `migrate`, and `migrate` only runs when the
 * persisted blob's version has actually ticked — so a map saved by the build before
 * a row existed comes back whole and short, and every reader that indexed it by id
 * got `undefined` for the new one. That is how adding two rows took the Settings
 * page down with `Cannot read properties of undefined (reading 'mods')`: the row
 * renderer read `s.binds[id]` directly, and the two zoom ids were simply not in
 * anyone's stored map.
 *
 * Reading through the default instead of storing one means a new row is live the
 * moment it is added to the table, with no version bump and no migration, which is
 * the right shape for a table the user is expected to grow.
 */
export const readBind = (binds: Partial<Binds> | undefined, id: BindId): KeyBind =>
  binds?.[id] ?? DEFAULT_BINDS[id];

/** The lookup key: modifiers in a fixed order, then the code. */
export const comboKey = (code: string, mods: string[]): string =>
  [...MOD_ORDER.filter((m) => mods.includes(m)), code].join('+');

export function keyOf(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return comboKey(e.code, mods);
}

/**
 * `id → combo key`, with the first claimant kept.
 *
 * Two actions on one combination is a user error, not a runtime one, and the last
 * entry in the table would silently win if this were a plain map. The settings page
 * refuses the clash before it ever gets here; this is the backstop.
 */
export function bindIndex(binds: Partial<Binds>): Map<string, BindId> {
  const index = new Map<string, BindId>();
  for (const id of BIND_ORDER) {
    const b = readBind(binds, id);
    const k = comboKey(b.code, b.mods);
    if (!index.has(k)) index.set(k, id);
  }
  return index;
}

const PRETTY: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Minus: '−',
  Equal: '=',
  /*
   * The numpad's own arithmetic keys, before the generic `Numpad7`-style branch
   * turns them into "Add (num)". Someone who binds zoom to the numeric keypad
   * should read a plus sign on the cap, because that is what is printed on it.
   */
  NumpadAdd: '+',
  NumpadSubtract: '−',
  NumpadEnter: 'Enter',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  Backquote: '`',
  Tab: 'Tab',
  Backspace: '⌫',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Delete: 'Del',
};

const MOD_KEYS: Record<string, string> = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Meta: 'Win',
};

/** A key press as it should read on a key cap. */
export function codeLabel(code: string): string {
  if (PRETTY[code]) return PRETTY[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `${code.slice(6)} (num)`;
  return code;
}

/** A whole combination, modifiers first, joined with the separator the app uses. */
export function bindLabel(b: KeyBind): string {
  const mods = MOD_ORDER.filter((m) => b.mods.includes(m)).map((m) => MOD_KEYS[m] ?? m);
  return [...mods, codeLabel(b.code)].join(' + ');
}

/**
 * The event turned into a binding, ignoring a bare modifier press — those arrive
 * as `Shift` with no key, and recording one would leave the row unreadable.
 */
export function bindFromEvent(e: KeyboardEvent): KeyBind | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return { code: e.code, mods };
}

/**
 * Which other action, if any, already owns this combination.
 *
 * Refusing the clash in the editor is the difference between a map you chose and
 * a map where one key silently does whatever happens to be listed last.
 */
export function clashWith(binds: Partial<Binds>, id: BindId, bind: KeyBind): BindId | null {
  const k = comboKey(bind.code, bind.mods);
  for (const other of BIND_ORDER) {
    if (other === id) continue;
    const b = readBind(binds, other);
    if (comboKey(b.code, b.mods) === k) return other;
  }
  return null;
}
