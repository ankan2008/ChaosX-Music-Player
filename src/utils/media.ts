/**
 * Anything worth offering as a track. mpv carries all of these itself, so an
 * exotic container costs nothing at play time any more -- it used to cost a
 * full PCM conversion through ffmpeg first.
 */
export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'flac', 'wav', 'wave', 'ogg', 'opus', 'oga', 'spx', 'm4a', 'mp4a',
  'aac', 'alac', 'aiff', 'aif', 'aifc', 'wma', 'ape', 'mac', 'wv', 'wvp',
  'mpc', 'mp+', 'mpp', 'tta', 'tak', 'shn', 'la', 'lpac', 'amr', 'awb',
  'au', 'snd', 'caf', 'dsf', 'dff', 'ac3', 'eac3', 'dts', 'mka',
  'm4b', 'm4p', 'f4a', 'f4b', 'ra', 'rm', 'voc', 'w64', 'rf64', 'bwf',
  '3gp', '3g2', 'omus', 'xm', 'mod', 's3m', 'it', 'mtm', 'stm', 'ult',
  'far', 'med', '669', 'liq', 'imp', 'no', 'glue', 'alaw', 'ulaw', 'cdda',
]);

/*
 * No MPEG transport stream. `.ts` and `.m2ts` used to be here, and Chromium
 * cannot decode them, so every one fell through to mpv's native child window —
 * which is the surface that will not clip, will not refract, and will not resize
 * cleanly out of a fullscreen takeover. That is the whole of "the ts file, when
 * fullscreened, is being weird". Supporting the container meant supporting that
 * code path, and no film in a normal library needs it: anything that arrives as a
 * `.ts` is a recording, and a recording wants to be an mp4.
 */
export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'avi', 'divx', 'mov', 'wmv', 'flv',
  'mpg', 'mpeg', 'ogv', '3gp', 'vob',
]);

export type MediaKind = 'audio' | 'video';

export function fileExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx < 0 ? '' : filename.slice(idx + 1).toLowerCase();
}

/** Container-level guess. The engine refines this from the decoded stream. */
export function mediaKind(filename: string): MediaKind | null {
  const ext = fileExtension(filename);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return null;
}

export function isMediaFile(filename: string): boolean {
  return mediaKind(filename) !== null;
}

export function isVideoPath(filePath: string): boolean {
  return mediaKind(filePath) === 'video';
}
