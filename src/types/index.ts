import type { MediaKind } from '../utils/media';
import type { Binds } from '../utils/keybinds';

export interface Track {
  id: string;
  name: string;
  artist: string;
  album: string;
  albumArt: string | null;
  duration: number; // seconds
  path: string;
  mediaUrl?: string; // media:// URL used by the audio element
  folderId?: string; // pinned folder this track was scanned from
  format: string; // mp3, flac, wav, etc.
  bitrate: number; // kbps
  sampleRate: number; // Hz
  bitDepth: number; // bits
  channels: number;
  trackNumber: number;
  year: number | null;
  genre: string;
  kind?: MediaKind; // audio vs video, derived from the container
  lyrics: LyricLine[] | null; // synced lyrics
  plainLyrics: string | null; // unsynced embedded lyrics
  waveformPeaks: number[]; // 0..1 amplitude peaks
  numberPrefix: number | null; // extracted leading number for sorting
  /** 1-based position within its pinned folder's scan order — what the list's
      leading column shows, so a folder reads 001,002,003 regardless of the
      track tags baked into the files. */
  folderIndex?: number;
  /** File modification time in ms, used for the "Date Added" sort. */
  dateAdded?: number;
  volume: number; // per-track gain
}

export interface LyricLine {
  time_ms: number;
  text: string;
}

export interface LibraryFolder {
  id: string;
  path: string;
  name: string;
  trackCount: number;
}

/**
 * A list of references the app wrote for itself: `<userData>/playlists/<name>.m3u8`,
 * one absolute audio path per line. Never a directory and never a copy of a record,
 * so a song that moves on disk simply drops out of the list, and the file is one any
 * other player can open.
 */
export interface Playlist {
  name: string;
  /** The `.m3u8` on disk, which is also what identifies it — as a folder's path does. */
  path: string;
  /** Absolute audio paths, in the order the user put them in. */
  tracks: string[];
}

/**
 * What sits behind the glass. One choice, two answers, and no second flag that
 * has to agree with it: `custom` is the picture the user picked, `art` is the
 * record that is sounding.
 */
export type BackdropSource = 'custom' | 'art';
/** One backdrop mode's three sliders, as a set that can be filed away and swapped back in. */
export interface BackdropTune {
  blur: number;
  dim: number;
  sat: number;
}
export type WallpaperKind = 'image' | 'video';

export interface UserInfo {
  username: string;
  displayName: string;
  avatar: string | null;
  /** The machine's network name, for the Statistics page's device card. */
  device: string;
}

export interface ExtractedMetadata {
  mediaUrl: string;
  format: string;
  duration: number;
  sampleRate: number;
  bitrate: number; // kbps
  bitDepth: number;
  channels: number;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  genre: string;
  track: number | null;
  albumArt: string | null;
  lyrics: string[];
}

export interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  volume: number; // 0..1
  speed: number; // 0.25..2.0
  pitch: number; // -12..12 semitones
  repeatMode: 'off' | 'one' | 'all';
  shuffle: boolean;
  /**
   * The seed behind the play order. See `seededPermutation` in utils/sorting:
   * the shuffled order is a function of this and the number of tracks, so the
   * queue panel can list the order that will actually play instead of a preview
   * of a permutation drawn later. Switching shuffle over draws a new one.
   */
  shuffleSeed: number;
  queue: Track[];
  currentIndex: number;
  library: Track[];
  searchQuery: string;
  /** What sits behind the glass: a chosen picture, the record, or the record's colours. */
  background: BackdropSource;
  /** Only read in `custom` mode — the other two sources have no file behind them. */
  wallpaperPath: string | null;
  wallpaperKind: WallpaperKind;
  /**
   * Blur radius baked into the backdrop canvas itself, 0..64.
   *
   * The room's own softness, and the only blur the interface asks the *source*
   * for. The cards' blur is not a number this app stores any more: every card is
   * a lens, and a lens's blur is a term in its optics.
   */
  wallpaperBlur: number;
  tintStrength: number; // 0..100 dark veil over the backdrop
  /** 0..100 black veil baked into the backdrop canvas itself, so the glass
      shader samples the dimmed scene in both blur styles */
  backdropDim: number;
  /**
   * 0..100 colour depth, baked into that same canvas.
   *
   * A saturation lift on the wallpaper and nothing else: `0` is the identity, so
   * the default picture is exactly the one that shipped before this existed, and
   * the range runs to `2.5` times the source's own saturation. Saturation is the
   * one control that cannot darken anything — the matrix holds the picture's
   * luma fixed by construction — which is what "deeper, not darker" asks for.
   */
  backdropSat: number;
  /**
   * The three sliders above, remembered once per backdrop source.
   *
   * The flat fields stay the ones everything reads, because `BackdropLayer` paints
   * from them and a mode change should not have to wait on a lookup. This is the
   * drawer they are filed back into: a wallpaper tuned soft and dark and a record
   * tuned bright and deep are two different pictures asking for two different
   * settings, and sharing one set meant every mode switch silently re-painted the
   * room the previous mode was wearing.
   */
  tuneByMode: Record<BackdropSource, BackdropTune>;
  /**
   * A playlist that was just made and has not been shown yet, by its path.
   *
   * The Library page used to detect a new list by comparing the end of `playlists`
   * against a ref of its own, which lost in two ordinary cases: a first run with no
   * playlists yet left the ref at `null`, which is also what "I have not looked yet"
   * looked like, so the very first list created was recorded rather than opened; and
   * creating one from anywhere but the Library page meant the page mounted after the
   * event, with nothing left to replay. Carrying the request in the store makes it
   * outlive whichever page happened to be up.
   *
   * Deliberately not persisted — a restart should not jump to a list made yesterday.
   */
  revealPlaylist: string | null;
  isScanning: boolean;
  scanProgress: number; // 0..100
  /** True when the loaded media stream actually carries video */
  mediaHasVideo: boolean;
  /**
      The film's own pixel dimensions, from whichever engine is drawing it — the
      `<video>` element once it has metadata, mpv's `dwidth`/`dheight` otherwise.
      Null until one of them answers, and while it is null nothing may guess an
      aspect ratio: a 4:3 file sized from a 16:9 assumption is a stretched picture. */
  videoNatural: { w: number; h: number } | null;
  /**
      True when that picture is drawn by the page's own `<video>` element rather
      than by mpv's native window. Only then is it something the glass shader can
      read, so this is what decides whether the surfaces over a film are real
      liquid glass or a plain translucent fill. */
  videoInPage: boolean;
  playbackError: string | null;
  /** Video takeover mode: video fills the app, everything else hides */
  videoFullscreen: boolean;
  /** Spicetify-style takeover: blurred artwork backdrop with the full player */
  nowPlayingFull: boolean;
  /** A floating vertical pill: the transport with nothing else around it */
  pillMode: boolean;
  /** Trim over-full-scale tracks and limit peaks so playback never distorts */
  clipGuard: boolean;
  /**
   * Whether the first-run setup has been closed.
   *
   * Persisted rather than derived from `folders.length` because the two are not
   * the same fact: a user who pins nothing on purpose has answered the question,
   * and re-asking it on every launch would be re-asking it forever.
   */
  onboarded: boolean;
}

/**
 * The four shapes the app can take. Mutually exclusive by construction —
 * `setView` is the only thing that changes them in combination.
 */
export type ViewMode = 'normal' | 'full' | 'mini' | 'pill';

export type SortMode = 'number' | 'title' | 'artist' | 'album' | 'duration' | 'dateAdded';

export interface AudioEngine {
  load(track: Track): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  seekRelative(delta: number): Promise<void>;
  setVolume(vol: number): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  setPitch(semitones: number): Promise<void>;
  stop(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  toggleShuffle(): Promise<void>;
  toggleRepeat(): Promise<void>;
  getDuration(): Promise<number>;
  getPosition(): Promise<number>;
  on(event: string, callback: (data: unknown) => void): void;
}