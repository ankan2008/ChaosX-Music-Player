import { OVERLAY_ROLE } from './windowRole';

/**
 * Which way a control's panel leaves its button.
 *
 * The pill is a strip against a screen edge with a transparent gutter beside it.
 * A panel that opened up or down would cover the very row of buttons it came
 * from, and the strip is far too narrow to hold one; `left` sends it out into
 * the gutter, level with its own control.
 */
export const panelDirection: 'up' | 'left' = OVERLAY_ROLE === 'pill' ? 'left' : 'up';
