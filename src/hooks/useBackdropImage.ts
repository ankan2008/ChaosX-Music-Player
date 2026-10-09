import { usePlayerStore } from '../stores/playerStore';
import { toMediaUrl } from '../audio/engine';

/**
 * The image the room is actually wearing.
 *
 * `art` paints the playing record, so out there the cover *is* the backdrop and
 * sampling it is sampling the right thing. `custom` paints a file the user chose,
 * and the record has nothing to do with what is behind the glass — which is why the
 * hourglass poured the same sand over a blue wallpaper and a red one whenever the
 * same song was up.
 *
 * A video wallpaper has no still to sample, so it falls back to the cover. That is
 * the honest answer rather than a wrong one: the film's colour is its own and moves.
 */
export function useBackdropImage(): string | null {
  const background = usePlayerStore((s) => s.background);
  const path = usePlayerStore((s) => s.wallpaperPath);
  const kind = usePlayerStore((s) => s.wallpaperKind);
  const art = usePlayerStore((s) => s.currentTrack?.albumArt ?? null);
  if (background === 'custom' && path && kind === 'image') return toMediaUrl(path);
  return art;
}
