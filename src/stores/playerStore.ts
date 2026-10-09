import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Track,
  PlayerState,
  LibraryFolder,
  Playlist,
  ViewMode,
  SortMode,
  BackdropTune,
} from '../types';
import type { BindId, Binds, KeyBind } from '../utils/keybinds';
import { BIND_LABELS, DEFAULT_BINDS, clashWith, resolveBinds } from '../utils/keybinds';
import type { Quote } from '../data/quotes';
import { EQ_BANDS_HZ } from '../../shared/audio';
import { getEngine } from '../audio/engine';
import { IS_PILL_WINDOW, IS_MINI_WINDOW, IS_OVERLAY_WINDOW, WINDOW_ROLE, PILL_SIDE_FROM_URL } from '../utils/windowRole';
import {
  clearPlayStats,
  readPlayStats,
  subscribePlayStats,
  writePlayStat,
  type PlayStat,
  type PlayStats,
} from '../utils/playStats';

export type { ViewMode };
export type { PlayStat };

export interface EqState {
  enabled: boolean;
  gains: number[]; // dB per band, matches EQ_BANDS_HZ
}

export type SettingsSection = 'general' | 'eq';
/** Which page the library window is on. See `PlayerState.section`. */
export type AppSection = 'home' | 'library' | 'statistics' | 'settings';
/** The sidebar's own order, which is what "forwards" means to a user. */
export const SECTION_ORDER: AppSection[] = ['home', 'library', 'statistics', 'settings'];

interface PlayerStore extends PlayerState {
  folders: LibraryFolder[];
  /**
   * The lists the app wrote itself, as `.m3u8` files in its own data folder.
   *
   * Kept apart from `folders` because a folder is a directory the user owns and a
   * playlist is a list of paths this app owns: one is walked by the scanner and can
   * be renamed wherever it lives, the other is edited here and renamed by moving one
   * file. Folding them together would have made the scanner try to walk a text file.
   */
  playlists: Playlist[];
  /**
   * Files taken out of a scanned list — the folder tab's or `All songs`' — without
   * being touched on disk.
   *
   * A playlist is a list of references this app wrote, so "remove from this list"
   * there rewrites the `.m3u8`. A folder tab is a directory the scanner walked, and
   * the only honest reading of "remove" there is "stop showing it to me", which is
   * what this is. The scanner drops these paths when it publishes, so a rescan does
   * not silently undo the removal, and the folder bar offers to put them back.
   */
  hiddenPaths: string[];
  selectedFolderId: string; // 'all' or a folder id
  miniPlayer: boolean;
  /**
   * Which floating widget the main window has open, in its own separate window.
   *
   * The library window no longer changes shape for mini or pill — it stays normal
   * or fullscreen while the widget sits alongside it — so this is the only thing
   * that records the widget's existence on this side. It exists so the switcher
   * can show the right button as active.
   */
  overlayRole: 'mini' | 'pill' | null;
  /**
   * Set only inside the pill overlay: which layout to hand the library window
   * back to when the user picks one. The overlay itself keeps drawing the pill.
   */
  pillReturnTo: ViewMode | null;
  /** Which settings group a caller wants landed on. */
  settingsSection: SettingsSection;
  avatarPath: string | null;
  /** The mini player's second fixed state: the dark glass lyrics overlay. */
  miniLyrics: boolean;
  /**
   * Which edge of the screen the strip docks to.
   *
   * The main process owns the desk bar and the window's position, so this is
   * written through `setPillSide`, which tells main and waits for it to agree
   * before committing. A store field that disagreed with where the window
   * actually is would mirror the layout against nothing.
   */
  pillSide: 'left' | 'right';
  /** Listens per track id. Drives Home's continue-listening card and Statistics. */
  playStats: PlayStats;
  /**
   * The three sidebar widgets, each independently switchable.
   *
   * They are opt-out rather than opt-in because they ship on: a user who wants a
   * bare strip of navigation should be able to take the clock and the quotes away
   * without editing anything.
   */
  clockEnabled: boolean;
  quotesEnabled: boolean;
  pomodoroEnabled: boolean;
  /*
   * Whether the clock and the quote also appear in the fullscreen music takeover.
   *
   * These are independent switches, not sub-switches: `clockEnabled` decides the
   * sidebar and `clockInFullscreen` decides the takeover, and neither reads the
   * other. A takeover is the artwork's page and a person may want nothing on it, or
   * may want nothing *but* the time on it while the sidebar stays out of the way —
   * the two pages are different enough that sharing one answer for both was the
   * thing being complained about.
   *
   * The pomodoro has no equivalent because it is not mounted in the takeover at all:
   * the hourglass brings a second column of controls with it, and the artwork needs
   * the room.
   */
  clockInFullscreen: boolean;
  quotesInFullscreen: boolean;
  /**
   * The lyrics card on the Library page and in the fullscreen takeover.
   *
   * A separate switch from the per-song hide: this one takes the whole surface
   * out for someone who never reads along, while the hide is one song at a time
   * for someone who likes the words but not this particular match.
   */
  lyricsEnabled: boolean;
  /**
   * The lyrics card's read-all mode: every line the same, no highlighter.
   *
   * Persisted, because it is a statement about how a person wants to read rather
   * than about the song playing — someone whose sheets are routinely out of step
   * will want it to stay on.
   */
  lyricsFlat: boolean;
  /**
   * Quotes the user added. They join the rotation after the built-in pool, so a
   * stored order of the right length still points at the same lines.
   */
  customQuotes: Quote[];
  /** A shuffled walk of the pool, and where in that walk this hour is reading. */
  quoteOrder: number[];
  quotePos: number;
  /** The hour bucket `quotePos` was last advanced for. Rotation is keyed on the
   *  clock, not on a timer, so a window that was closed all morning still lands
   *  on the current quote rather than replaying a queue of missed ones. */
  quoteHour: number;
  /** Pomodoro durations in seconds, and how many work rounds make a cycle. */
  pomodoroWorkSec: number;
  pomodoroBreakSec: number;
  pomodoroRounds: number;
  /** Launch with Windows. Applied through the main process, not here. */
  autoStartup: boolean;
  /** Close button hides to the taskbar overflow instead of quitting the app. */
  closeToTray: boolean;
  eq: EqState;
  /**
   * Which page the library window is showing.
   *
   * `home` is what the app calls its normal mode: the record, the track list, the
   * lyrics. `library` is the folder-management page, and `statistics` is derived
   * from the scanned library. This is a page within a view mode, not a fifth view
   * mode — mini, pill and fullscreen each keep whatever page the library window was
   * on, because they are surfaces on the same player rather than places of their own.
   */
  section: AppSection;
  /**
   * Which way the last navigation moved, in sidebar order.
   *
   * Latched here rather than derived in the page component, because any other
   * store change — a play state, a position tick — re-renders the page switcher,
   * and a component that works out "am I going forwards" from the previous
   * render's value gets that wrong on the second render and restarts the
   * entrance animation in the opposite direction.
   */
  sectionDir: 'fwd' | 'back';
  /**
   * Manual lyric timing shift in milliseconds, applied where the active line is
   * chosen rather than baked into the parsed cue times.
   *
   * Stored as an offset, not written into `time_ms`, because the lyric set a window
   * is displaying may have been fetched by another window and re-sent over the wire
   * — mutating the cues would compound every time the track came round again.
   */
  lyricsOffsetMs: number;
  /**
   * The keyboard map, as the user has set it.
   *
   * In the store rather than in the shortcut hook's closure because the Settings
   * page has to read it, write it, and warn about a clash between two rows it is
   * not the author of.
   */
  binds: Binds;
  /** The user's saved band curve, kept apart from the live eq and the presets. */
  customEq: number[];
  /**
   * The library's column order. It lives here rather than in the list's own
   * state because three surfaces read it: the Library page, the queue panel over
   * the transport, and the list the app seeds the deck with on first load. Kept
   * apart locally, they would disagree about what row 2 is.
   */
  sortMode: SortMode;
  sortDesc: boolean;
  mutedVolume: number | null;

  setCurrentTrack: (track: Track | null) => void;
  setIsPlaying: (playing: boolean) => void;
  setVolume: (vol: number) => void;
  toggleMute: () => void;
  setSpeed: (speed: number) => void;
  setPitch: (pitch: number) => void;
  setRepeatMode: (mode: PlayerState['repeatMode']) => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
  play: () => Promise<void>;
  pause: () => void;
  stop: () => void;
  togglePlay: () => Promise<void>;
  /**
   * Take a list as the play order.
   *
   * `arm` defaults to true — a queue the user chose is a queue they are about to
   * hear, so its first row loads. The cold-start seed passes false, because a row
   * nobody picked is not worth an mpv process.
   */
  setQueue: (queue: Track[], index: number, arm?: boolean) => void;
  playNext: () => void;
  /** Put a track immediately after the one that is sounding. */
  insertTrackNext: (track: Track) => void;
  playPrevious: () => void;
  setLibrary: (tracks: Track[]) => void;
  setSearchQuery: (query: string) => void;
  setBackground: (mode: PlayerState['background']) => void;
  setWallpaper: (path: string | null, kind: PlayerState['wallpaperKind']) => void;
  setWallpaperBlur: (val: number) => void;
  setTintStrength: (val: number) => void;
  setBackdropDim: (val: number) => void;
  setBackdropSat: (val: number) => void;
  setIsScanning: (val: boolean) => void;
  setScanProgress: (val: number) => void;
  pinFolder: (folder: LibraryFolder) => void;
  unpinFolder: (folderId: string) => void;
  addPlaylist: (playlist: Playlist) => void;
  /** Clear a pending "open this list" request once the Library page has honoured it. */
  clearRevealPlaylist: () => void;
  /** Hide these files from every scanned list. Nothing on disk changes. */
  hideTracks: (paths: string[]) => void;
  /** Put them back. Pass nothing to restore the whole list. */
  unhideTracks: (paths: string[]) => void;
  /** Rename it, move it, or change its entries. Keyed by the file it lives at now. */
  patchPlaylist: (path: string, patch: Partial<Playlist>) => void;
  removePlaylist: (path: string) => void;
  setSelectedFolder: (folderId: string) => void;
  setMiniPlayer: (mini: boolean) => void;
  setMiniLyrics: (on: boolean) => void;
  setPillSide: (side: 'left' | 'right') => void;
  setClockEnabled: (on: boolean) => void;
  setQuotesEnabled: (on: boolean) => void;
  setPomodoroEnabled: (on: boolean) => void;
  setClockInFullscreen: (on: boolean) => void;
  setQuotesInFullscreen: (on: boolean) => void;
  setLyricsEnabled: (on: boolean) => void;
  setLyricsFlat: (on: boolean) => void;
  setAutoStartup: (on: boolean) => void;
  setCloseToTray: (on: boolean) => void;
  setVideoFullscreen: (full: boolean) => void;
  setNowPlayingFull: (full: boolean) => void;
  /** The one entry point for changing view — the four modes are exclusive. */
  setView: (mode: ViewMode) => void;
  setAvatar: (path: string | null) => void;
  /** Closes the first-run setup, whether it was finished or skipped. */
  setOnboarded: (done: boolean) => void;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setClipGuard: (enabled: boolean) => void;
  setEq: (eq: Partial<EqState>) => void;
  setLyricsOffset: (ms: number) => void;
  /** Returns a message when the combination is already taken, and changes nothing. */
  setBind: (id: BindId, bind: KeyBind) => string | null;
  resetBinds: () => void;
  setSection: (section: AppSection) => void;
  /** Persist the user's own band curve as the Custom profile. */
  setCustomEq: (gains: number[]) => void;
  setSort: (mode: SortMode, desc: boolean) => void;
  /**
   * Merge a partial into every copy of one track — the library row, the
   * playing track and the queue entry all hold their own object, and letting
   * them disagree is how the lyrics card and the sidebar started showing
   * different things for the same file.
   */
  updateTrack: (patch: Partial<Track> & { id: string }) => void;
  /**
   * Count a listen.
   *
   * Called from the engine's `syncTrackToStore`, not from a `currentTrack`
   * subscription: watching that field made a folder rescan re-resolve every
   * loaded track and measured 8342 plays for a single song.
   *
   * The tally is keyed by track id, which comes from the file path, so it
   * survives a rescan of the same folder and dies with a file that is genuinely
   * moved or renamed. Not keyed by title/artist — two different songs called
   * "Perfect" would merge.
   */
  recordPlay: (trackId: string) => void;
  /**
   * Empty the listen tally, so "Most played" and "Last played" start again from
   * nothing. The counts survive a restart precisely because they are on disk, so
   * the only honest reset has to take the disk copy with them.
   */
  resetPlayStats: () => void;
  /**
   * Add a line to the quote rotation. Blank text is ignored; an unknown author
   * is stored as "You", which is what it is.
   */
  addQuote: (text: string, author: string) => void;
  /** Remove a user quote by its index into `customQuotes`. */
  removeQuote: (index: number) => void;
  setPomodoroWorkSec: (sec: number) => void;
  setPomodoroBreakSec: (sec: number) => void;
  setPomodoroRounds: (rounds: number) => void;
}

/**
 * The fields the library window owns outright.
 *
 * `partialize` output *replaces* the whole `silent-chaos-settings` key, and all
 * three renderers write that key — so a field a window leaves out of its copy is
 * deleted from storage, not merely skipped. These are read and changed only by the
 * library window, so every other window has to hand the stored values back
 * unchanged. Leaving them out is what made the first-run setup ask again on every
 * launch: a pill or mini card keeps syncing the deck in the background even while
 * hidden, and its next write erased the flag. The quote rotation and the pomodoro
 * durations were being wiped by the same pass.
 */
const LIBRARY_OWNED = [
  'onboarded',
  'playlists',
  'customQuotes',
  'quoteOrder',
  'quotePos',
  'quoteHour',
  'pomodoroWorkSec',
  'pomodoroBreakSec',
  'pomodoroRounds',
] as const;

const initialState: PlayerState = {
  currentTrack: null,
  isPlaying: false,
  volume: 0.8,
  speed: 1.0,
  pitch: 0,
  repeatMode: 'off',
  shuffle: false,
  shuffleSeed: (Math.random() * 0xffffffff) | 0,
  queue: [],
  currentIndex: -1,
  library: [],
  searchQuery: '',
  /*
   * The app's own background, not the machine's.
   *
   * Reading Windows' current wallpaper is the right answer for a person who chose
   * one and wants the player to agree with it, and the wrong one for a first run,
   * where the app has no idea what the desktop looks like and inherits a screenshot
   * of somebody's holiday. ChaosX ships with the moon over red leaves; Settings
   * offers the record and the record's colours as the two alternatives, and either
   * choice persists over this default the moment it is made.
   */
  background: 'custom',
  wallpaperPath: '/brand/wallpaper.jpg',
  wallpaperKind: 'image',
  /*
   * The backdrop's own blur. Zero leaves the picture as it came off the disk;
   * the shipped 24 is what the glass was set against before the blurred-cover
   * mode existed, and it is the number the wallpaper was painted with.
   */
  wallpaperBlur: 24,
  tintStrength: 30,
  backdropDim: 0,
  /*
   * Zero, because zero is the picture this app shipped with.
   *
   * The control deliberately does not sit on a hidden baseline boost of its own:
   * the wallpaper's saturation at rest is the file's, and every lift the panels
   * add on top of it belongs to those panels and is untouched by this slider. A
   * default above zero would mean the neutral setting was a setting.
   */
  backdropSat: 0,
  /*
   * Every mode starts on the shipped picture. The two are spelled out rather than
   * generated from one object so that changing what `art` rests at cannot move
   * what `custom` rests at, which is the whole point of the field.
   */
  tuneByMode: {
    custom: { blur: 24, dim: 0, sat: 0 },
    art: { blur: 24, dim: 0, sat: 0 },
  },
  revealPlaylist: null,
  isScanning: false,
  scanProgress: 0,
  mediaHasVideo: false,
  videoNatural: null,
  videoInPage: false,
  playbackError: null,
  videoFullscreen: false,
  nowPlayingFull: false,
  pillMode: false,
  /*
   * Off. This is the per-track true-peak trim — the app measuring a file and
   * turning it down so it lands under a ceiling — which is loudness normalisation
   * under another name, and the user asked for it off. Settings still offers it.
   */
  clipGuard: false,
  /**
   * False so a first launch gets asked. Anyone who already has settings saved
   * gets asked once too, which is the honest cost of adding a question that was
   * never asked before — and the wizard is three presses with a skip on every
   * step, so the cost is bounded.
   */
  onboarded: false,
};

// Imported lazily at call time to avoid a store <-> engine import cycle.
// Both modules only reference each other inside functions, so ESM live
// bindings make this safe.

/**
 * Move one backdrop slider and file the same value under the mode that is showing.
 *
 * Both halves in one object because the two must never disagree: the flat field is
 * what `BackdropLayer` paints from, and the map is what the next mode switch reads
 * back. Writing only the flat one is what made every mode inherit whichever picture
 * the user last happened to be standing in.
 */
function writeTune(
  s: PlayerState,
  key: 'blur' | 'dim' | 'sat',
  val: number,
): Partial<PlayerState> {
  const tuneByMode = {
    ...s.tuneByMode,
    [s.background]: { ...s.tuneByMode[s.background], [key]: val },
  };
  if (key === 'blur') return { tuneByMode, wallpaperBlur: val };
  if (key === 'dim') return { tuneByMode, backdropDim: val };
  return { tuneByMode, backdropSat: val };
}

export const usePlayerStore = create<PlayerStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      folders: [],
      playlists: [],
      hiddenPaths: [],
      selectedFolderId: 'all',
      /* Each overlay window is born in the one mode its frame can hold, and
         never leaves it: a 240×470 frameless strip cannot show a library, and
         neither can a small square card. Picking another mode from inside an
         overlay is a request to hand back, recorded rather than rendered. */
      miniPlayer: IS_MINI_WINDOW,
      pillMode: IS_PILL_WINDOW,
      overlayRole: null,
      pillReturnTo: null,
      settingsSection: 'general',
      avatarPath: null,
      miniLyrics: false,
      pillSide: PILL_SIDE_FROM_URL,
      playStats: readPlayStats(),
      sectionDir: 'fwd',
      clockEnabled: true,
      quotesEnabled: true,
      pomodoroEnabled: true,
      clockInFullscreen: true,
      quotesInFullscreen: true,
      lyricsEnabled: true,
      lyricsFlat: false,
      customQuotes: [],
      quoteOrder: [],
      quotePos: 0,
      quoteHour: 0,
      /* 20 and 5, the classic ratio, in seconds — the card edits them as
         h/m/s, and storing seconds keeps the timer free of unit maths. */
      pomodoroWorkSec: 20 * 60,
      pomodoroBreakSec: 5 * 60,
      pomodoroRounds: 4,
      autoStartup: false,
      closeToTray: false,
      eq: { enabled: true, gains: EQ_BANDS_HZ.map(() => 0) },
      section: 'home',
      lyricsOffsetMs: 0,
      binds: resolveBinds({}),
      customEq: EQ_BANDS_HZ.map(() => 0),
      sortMode: 'number',
      sortDesc: false,
      mutedVolume: null,

      setCurrentTrack: (track) => set({ currentTrack: track }),
      setIsPlaying: (playing) => set({ isPlaying: playing }),
      setVolume: (vol) => {
        const clamped = Math.max(0, Math.min(1, vol));
        set({ volume: clamped, mutedVolume: null });
        if (typeof window !== 'undefined' && window.electronAPI) {
          getEngine().setVolume(clamped);
        }
      },
      toggleMute: () => {
        const { volume, mutedVolume } = get();
        if (mutedVolume === null) {
          set({ mutedVolume: volume, volume: 0 });
          getEngine().setVolume(0);
        } else {
          set({ mutedVolume: null, volume: mutedVolume });
          getEngine().setVolume(mutedVolume);
        }
      },
      setSpeed: (speed) => {
        set({ speed: Math.max(0.25, Math.min(2.0, speed)) });
        getEngine().setSpeed(get().speed);
      },
      setPitch: (pitch) => {
        set({ pitch: Math.max(-12, Math.min(12, pitch)) });
        getEngine().setPitch(get().pitch);
      },
      setRepeatMode: (mode) => set({ repeatMode: mode }),
      toggleShuffle: () => {
        const nextSeed =
          get().shuffle ? get().shuffleSeed : (Math.random() * 0xffffffff) | 0;
        set((s) => ({ shuffle: !s.shuffle, shuffleSeed: nextSeed }));
        /*
         * The engine caches the permutation it is playing so that Up Next, the
         * pre-buffer and the deck agree. Toggling hands over a brand new seed, and
         * a cache of the same length would otherwise be kept — so this is the call
         * that makes shuffle off-and-on actually mean a different order.
         */
        getEngine().invalidateShuffle();
        getEngine().publishSession();
      },
      toggleRepeat: () => {
        set((s) => ({
          repeatMode:
            s.repeatMode === 'off' ? 'one' : s.repeatMode === 'one' ? 'all' : 'off',
        }));
        // Same reason shuffle does: repeat is part of the play order, and a
        // widget that never hears about it keeps showing the mode it booted with.
        getEngine().publishSession();
      },
      play: async () => {
        await getEngine().play();
      },
      pause: () => getEngine().pause(),
      stop: () => getEngine().stop(),
      togglePlay: async () => {
        await getEngine().togglePlay();
      },
      setQueue: (queue, index, arm) => {
        getEngine().setQueue(queue, index, arm);
      },
      playNext: () => getEngine().next(),
      /**
       * Put a row directly after the one that is sounding.
       *
       * The deck is never restarted: the engine edits whichever order is live, so
       * this is the one line that carries "play next" from a right-click into the
       * real sequence rather than into a list nobody follows.
       */
      insertTrackNext: (track) => getEngine().insertNext(track),
      playPrevious: () => getEngine().previous(),
      setLibrary: (tracks) => set({ library: tracks }),
      setOnboarded: (done) => set({ onboarded: done }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      /*
       * File the outgoing mode's sliders away and put the incoming mode's back on.
       * Both halves happen in one `set` so no render ever sees the new background
       * still wearing the old mode's numbers.
       */
      setBackground: (mode) => {
        const s = get();
        if (s.background === mode) return;
        const tune = { ...s.tuneByMode };
        tune[s.background] = {
          blur: s.wallpaperBlur,
          dim: s.backdropDim,
          sat: s.backdropSat,
        };
        const next = tune[mode];
        set({
          background: mode,
          tuneByMode: tune,
          wallpaperBlur: next.blur,
          backdropDim: next.dim,
          backdropSat: next.sat,
        });
      },
      setWallpaper: (path, kind) => set({ wallpaperPath: path, wallpaperKind: kind }),
      setWallpaperBlur: (val) => set((s) => writeTune(s, 'blur', Math.max(0, Math.min(64, val)))),
      setTintStrength: (val) => set({ tintStrength: Math.max(0, Math.min(100, val)) }),
      setBackdropDim: (val) => set((s) => writeTune(s, 'dim', Math.max(0, Math.min(100, val)))),
      setBackdropSat: (val) => set((s) => writeTune(s, 'sat', Math.max(0, Math.min(100, val)))),
      setIsScanning: (val) => set({ isScanning: val }),
      setScanProgress: (val) => set({ scanProgress: val }),
      pinFolder: (folder) =>
        set((s) => ({
          folders: s.folders.some((f) => f.id === folder.id)
            ? s.folders
            : [...s.folders, folder],
        })),
      unpinFolder: (folderId) =>
        set((s) => ({
          folders: s.folders.filter((f) => f.id !== folderId),
          selectedFolderId:
            s.selectedFolderId === folderId ? 'all' : s.selectedFolderId,
        })),
      /*
       * Making a list is also asking to be shown it. The section change rides along
       * because a playlist can be created from a song's context menu while the user
       * is standing on Home, and a list that was made but is still two pages away
       * has not been made in the sense that matters. The Library page picks up
       * `revealPlaylist` and scrolls the strip to it.
       */
      addPlaylist: (playlist) =>
        set((s) => ({
          playlists: s.playlists.some((p) => p.path === playlist.path)
            ? s.playlists
            : [...s.playlists, playlist],
          revealPlaylist: playlist.path,
          section: 'library',
          sectionDir:
            SECTION_ORDER.indexOf('library') >= SECTION_ORDER.indexOf(s.section)
              ? 'fwd'
              : 'back',
        })),
      clearRevealPlaylist: () => set({ revealPlaylist: null }),
      hideTracks: (paths) =>
        set((s) => ({ hiddenPaths: [...new Set([...s.hiddenPaths, ...paths])] })),
      unhideTracks: (paths) =>
        set((s) => {
          if (paths.length === 0) return { hiddenPaths: [] };
          const gone = new Set(paths);
          return { hiddenPaths: s.hiddenPaths.filter((p) => !gone.has(p)) };
        }),
      patchPlaylist: (path, patch) =>
        set((s) => ({
          playlists: s.playlists.map((p) => (p.path === path ? { ...p, ...patch } : p)),
        })),
      removePlaylist: (path) =>
        set((s) => ({ playlists: s.playlists.filter((p) => p.path !== path) })),
      setSelectedFolder: (folderId) => set({ selectedFolderId: folderId }),
      setMiniPlayer: (mini) => {
        get().setView(mini ? 'mini' : 'normal');
      },
      setNowPlayingFull: (full) => {
        get().setView(full ? 'full' : 'normal');
      },
      setView: (mode) => {
        /*
         * The two floating widgets are music surfaces, and a film cannot live on
         * one of them.
         *
         * It was tried twice. First as a second `<video>` decoding the same file
         * the deck already had open, which cost a decoder, a synchronised clock and
         * about two hundred megabytes; then as mpv's native picture reparented onto
         * the card's own window, which cost none of that and still was not right —
         * the card is a drag handle, a scrub bar and a transport row, and a film
         * underneath them is a film with controls floating in front of its face.
         * The user's verdict was "this simply aint working", so the widgets decline
         * a video outright and the film keeps the one surface built for it.
         *
         * Guarded at the single writer for the same reason the potato guard is: the
         * buttons that would open a widget are in the sidebar, both strips, the
         * takeover and whatever the user has bound in Keyboard shortcuts.
         */
        if ((mode === 'mini' || mode === 'pill') && get().currentTrack?.kind === 'video') return;
        if (IS_OVERLAY_WINDOW) {
          /* Inside a widget there is nothing to resize and nothing to redraw —
             the window already *is* the card. */
          if (mode === WINDOW_ROLE) return;
          if (mode === 'mini' || mode === 'pill') {
            /*
             * Mini and pill are mutually exclusive but share the one overlay
             * window, so picking the other widget is a request to retarget this
             * window — not a request to hand back to the library. Routing it
             * through `pillReturnTo` instead closed the widget and left the user
             * looking at the library, which reads as the button doing nothing.
             */
            void window.electronAPI?.setViewMode(mode, getEngine().handoffState());
            return;
          }
          // Normal or fullscreen from here is a request to hand back, and the
          // target travels with it rather than re-rendering a card as a library.
          set({ pillReturnTo: mode });
          return;
        }
        const widget = mode === 'mini' || mode === 'pill';
        set({
          /*
           * Only a widget switch changes the answer. Picking Normal or Fullscreen
           * here is a statement about the *library* window, and the pill or card
           * floating beside it is unaffected — so its role is left exactly as the
           * main process last reported it. Clearing it used to be the local half
           * of "leaving fullscreen puts the widget away", and it lit the wrong
           * switcher button while a strip was plainly still on screen.
           */
          overlayRole: widget ? mode : get().overlayRole,
          /*
           * Leaving for a widget does not change what the library window is
           * showing. It stays normal, or stays fullscreen, with the widget drawn
           * alongside it — which is the whole point of the widget living in its
           * own window.
           */
          nowPlayingFull: widget ? get().nowPlayingFull : mode === 'full',
          // The lyrics overlay is a state of the mini card, so it only
          // survives a switch that stays inside mini.
          miniLyrics: mode === 'mini' ? get().miniLyrics : false,
        });
        /*
         * Resizing or handing over the OS window belongs with the mode, not at
         * each call site. Mini and pill both go through the same channel now:
         * pill used to be opened from an effect watching `view`, which stopped
         * firing as soon as the library window stopped adopting the pill layout.
         */
        void window.electronAPI?.setViewMode(mode, getEngine().handoffState());
      },
      setMiniLyrics: (on) => set({ miniLyrics: on }),
      setClockEnabled: (on) => set({ clockEnabled: on }),
      setQuotesEnabled: (on) => set({ quotesEnabled: on }),
      setPomodoroEnabled: (on) => set({ pomodoroEnabled: on }),
      setClockInFullscreen: (on) => set({ clockInFullscreen: on }),
      setQuotesInFullscreen: (on) => set({ quotesInFullscreen: on }),
      setLyricsEnabled: (on) => set({ lyricsEnabled: on }),
      setLyricsFlat: (on) => set({ lyricsFlat: on }),
      /*
       * Startup and tray are process settings, so the store asks main rather than
       * pretending to own them. The field is written optimistically and main's
       * reply is not awaited: a refused registration (a locked-down machine, a
       * group policy that forbids the Run key) should leave the switch honest
       * rather than spinning forever.
       */
      setAutoStartup: (on) => {
        set({ autoStartup: on });
        void window.electronAPI?.setAutoLaunch?.(on);
      },
      setCloseToTray: (on) => {
        set({ closeToTray: on });
        void window.electronAPI?.setCloseToTray?.(on);
      },
      recordPlay: (trackId) => {
        /*
         * One listen per track per few seconds, however many times it was started.
         *
         * Three renderers share this store and a handoff between them can make the
         * same start look like two; the dedupe window lives in the stored timestamp
         * rather than in a per-window Map so it holds across that handoff too.
         */
        const next = writePlayStat(trackId);
        if (next) set({ playStats: next });
      },
      resetPlayStats: () => {
        clearPlayStats();
        set({ playStats: {} });
      },
      addQuote: (text, author) => {
        const t = text.trim();
        if (!t) return;
        set((s) => ({ customQuotes: [...s.customQuotes, { t, a: author.trim() || 'You' }] }));
      },
      removeQuote: (index) => {
        set((s) => ({
          customQuotes: s.customQuotes.filter((_, i) => i !== index),
        }));
      },
      setPomodoroWorkSec: (sec) =>
        set({ pomodoroWorkSec: Math.max(5, Math.min(99 * 3600 + 59 * 60 + 59, Math.round(sec))) }),
      setPomodoroBreakSec: (sec) =>
        set({ pomodoroBreakSec: Math.max(5, Math.min(99 * 3600 + 59 * 60 + 59, Math.round(sec))) }),
      setPomodoroRounds: (rounds) =>
        set({ pomodoroRounds: Math.max(1, Math.min(12, Math.round(rounds))) }),
      /*
       * Flip the strip to the other edge.
       *
       * Committed only after main confirms it has moved the desk bar and the
       * window, because the mirrored layout has to follow the real edge rather
       * than lead it — otherwise the buttons spend a frame facing a screen edge
       * that the flyouts are still opening towards the wrong way.
       */
      setPillSide: (side) => {
        const api = window.electronAPI?.overlay;
        if (!api?.setPillSide) {
          set({ pillSide: side });
          return;
        }
        void api.setPillSide(side).then((reply) => set({ pillSide: reply.side }));
      },
      setLyricsOffset: (ms) => set({ lyricsOffsetMs: Math.round(ms) }),
      setBind: (id, bind) => {
        const clash = clashWith(get().binds, id, bind);
        if (clash) return `That combination is already ${BIND_LABELS[clash]}.`;
        set({ binds: { ...get().binds, [id]: bind } });
        return null;
      },
      resetBinds: () => set({ binds: { ...DEFAULT_BINDS } }),
      setSection: (section) =>
        set((s) => ({
          section,
          sectionDir:
            SECTION_ORDER.indexOf(section) >= SECTION_ORDER.indexOf(s.section) ? 'fwd' : 'back',
        })),
      setVideoFullscreen: (full) => set({ videoFullscreen: full }),
      openSettings: (section = 'general') =>
        set({ section: 'settings', settingsSection: section }),
      closeSettings: () => set({ settingsSection: 'general' }),
      setAvatar: (path) => set({ avatarPath: path }),
      setClipGuard: (enabled) => {
        set({ clipGuard: enabled });
        getEngine().setClippingGuard(enabled);
      },
      /**
       * The one writer for the equaliser: it updates the store *and* pushes the
       * result to the shared deck.
       *
       * It used to touch only the store, leaving every call site to remember the
       * second line that actually applied it. Any caller that forgot — a preset, a
       * future quick-toggle, a test — changed the button and not the sound, and left
       * the other windows showing the deck's answer while this one showed its own.
       * Volume, speed and pitch already work this way; the equaliser was the outlier.
       *
       * No echo: `AudioEngine.applyMix` writes incoming mixer state straight through
       * `setState`, not through this action, so the broadcast cannot loop back here.
       */
      setEq: (eq) => {
        set((s) => ({
          eq: {
            ...s.eq,
            ...eq,
            gains: eq.gains ?? s.eq.gains,
          },
        }));
        const next = get().eq;
        getEngine().setEqGains(next.enabled ? next.gains : next.gains.map(() => 0));
      },
      /**
       * The user's own curve. Band edits land here as well as in the live eq,
       * so picking a preset and coming back restores what they dialled in
       * instead of losing it to the preset that overwrote it.
       */
      setCustomEq: (gains) => set({ customEq: [...gains] }),
      setSort: (mode, desc) => set({ sortMode: mode, sortDesc: desc }),
      updateTrack: (patch) =>
        set((s) => ({
          library: s.library.map((t) => (t.id === patch.id ? { ...t, ...patch } : t)),
          currentTrack:
            s.currentTrack?.id === patch.id
              ? { ...s.currentTrack, ...patch }
              : s.currentTrack,
          queue: s.queue.map((t) => (t.id === patch.id ? { ...t, ...patch } : t)),
        })),
    }),
    {
      name: 'silent-chaos-settings',
      partialize: (s) => {
        const persisted: Record<string, unknown> = {
          volume: s.volume,
          /*
           * The mute has to be saved with the level it replaced, or it cannot be
           * undone. `volume` was persisted and `mutedVolume` was not, so muting at
           * 60% stored `volume: 0, mutedVolume: 0.6`, the restart brought back only
           * the zero, and `toggleMute` then read `mutedVolume === null` — the "we
           * are not muted" branch — and muted again, from zero, to zero. Every
           * subsequent press of the speaker icon re-muted a track that was already
           * silent. That is the "the audio itself stops working, even when the app
           * and the device are unmuted" report, and it is permanent until the
           * slider is dragged by hand, which is why it read as random.
           */
          mutedVolume: s.mutedVolume,
          speed: s.speed,
          pitch: s.pitch,
          repeatMode: s.repeatMode,
          shuffle: s.shuffle,
          shuffleSeed: s.shuffleSeed,
          background: s.background,
          wallpaperPath: s.wallpaperPath,
          wallpaperKind: s.wallpaperKind,
          wallpaperBlur: s.wallpaperBlur,
          tintStrength: s.tintStrength,
          backdropDim: s.backdropDim,
          backdropSat: s.backdropSat,
          tuneByMode: s.tuneByMode,
          clipGuard: s.clipGuard,
          folders: s.folders,
          hiddenPaths: s.hiddenPaths,
          avatarPath: s.avatarPath,
          pillSide: s.pillSide,
          eq: s.eq,
          customEq: s.customEq,
          lyricsOffsetMs: s.lyricsOffsetMs,
          binds: s.binds,
          sortMode: s.sortMode,
          sortDesc: s.sortDesc,
          clockEnabled: s.clockEnabled,
          quotesEnabled: s.quotesEnabled,
          pomodoroEnabled: s.pomodoroEnabled,
          clockInFullscreen: s.clockInFullscreen,
          quotesInFullscreen: s.quotesInFullscreen,
          lyricsEnabled: s.lyricsEnabled,
          lyricsFlat: s.lyricsFlat,
          autoStartup: s.autoStartup,
          closeToTray: s.closeToTray,
        };
        /*
         * Only the library window ever shows setup, so only it records that setup
         * happened; only its sidebar card turns the quote and runs the pomodoro, so
         * only it moves those. The other windows write the same key, so they carry
         * these through from storage instead of dropping them — see `LIBRARY_OWNED`.
         *
         * `playStats` is absent for every window because it has its own key
         * (`utils/playStats`) to live in. Volume, speed and pitch are in every
         * window because the deck mirrors them, and there is no deck behind these.
         */
        if (IS_OVERLAY_WINDOW) {
          try {
            /*
             * The stored shape is `{ state, version }`, so the fields to carry live
             * one level below what `getItem` hands back. Reading them off the
             * envelope finds nothing and silently carries nothing, which is the bug
             * this whole branch exists to close.
             */
            const env = JSON.parse(localStorage.getItem('silent-chaos-settings') ?? 'null') as
              | { state?: Record<string, unknown> }
              | null;
            const stored = env?.state;
            if (stored) for (const key of LIBRARY_OWNED) if (key in stored) persisted[key] = stored[key];
          } catch {
            // An unreadable blob is no different from an empty one: nothing to carry.
          }
        } else {
          persisted.onboarded = s.onboarded;
          persisted.playlists = s.playlists;
          persisted.customQuotes = s.customQuotes;
          persisted.quoteOrder = s.quoteOrder;
          persisted.quotePos = s.quotePos;
          persisted.quoteHour = s.quoteHour;
          persisted.pomodoroWorkSec = s.pomodoroWorkSec;
          persisted.pomodoroBreakSec = s.pomodoroBreakSec;
          persisted.pomodoroRounds = s.pomodoroRounds;
        }
        return persisted as never;
      },
      /*
       * v3 moves the listen tally out of this blob.
       *
       * The old field has to be deleted on the way through, not just stopped from
       * being written: rehydration merges the persisted object over the live state,
       * so a stored copy from an earlier build would overwrite the fresh read from
       * the new key on every start and the counts would freeze at whatever they
       * were when the change shipped.
       *
       * v2 turned the per-track loudness trim off. It shipped on, so every existing
       * install has `clipGuard: true` sitting in localStorage, and a changed source
       * default would be overwritten by it on the first hydrate — a migration is the
       * only way to flip it once without making the Settings toggle pointless.
       */
      version: 7,
      migrate: (persisted, from) => {
        const p = persisted as Record<string, unknown> | null;
        if (p && from < 2) p.clipGuard = false;
        if (p && from < 3) delete p.playStats;
        /*
         * A stored map from before the keys were editable may be missing rows, or
         * hold a row shape this build does not recognise. `resolveBinds` fills the
         * gaps from the defaults and drops anything malformed, so a partial map
         * degrades to the built-in one rather than to an unresponsive keyboard.
         */
        if (p) p.binds = resolveBinds(p.binds as Partial<Binds> | undefined);
        /*
         * The potato modes and the gaussian card material are gone, and the
         * backdrop went from "`background: 'wallpaper'` plus an `artBackdrop`
         * flag" to one three-value field.
         *
         * Without this an install that had been left on the custom wallpaper
         * hydrates `background: 'wallpaper'`, which is not a value this build
         * recognises, and `BackdropLayer` finds neither source it paints and
         * renders a window with nothing behind its glass. The two old fields are
         * folded into the new one before they are dropped, so the room the user
         * had set up is the room they wake up to.
         */
        if (p && from < 5) {
          const was = p.background;
          p.background =
            p.artBackdrop === true
              ? 'art'
              : was === 'art' || was === 'gradient'
                ? was
                : 'custom';
          delete p.artBackdrop;
          delete p.blurStyle;
          delete p.blurAmount;
          delete p.wallpaperBlurByStyle;
          delete p.potatoMode;
          delete p.modePrefs;
        }
        /*
         * An install from before the sliders were per-mode gets the picture it is
         * already showing copied into all three drawers. Anything else would be a
         * surprise: the user set one backdrop, and waking up to two of the three
         * modes wearing a default they never chose is a regression dressed as a
         * migration. From here the three are free to drift apart.
         */
        if (p && from < 6) {
          const flat = {
            blur: typeof p.wallpaperBlur === 'number' ? (p.wallpaperBlur as number) : 24,
            dim: typeof p.backdropDim === 'number' ? (p.backdropDim as number) : 0,
            sat: typeof p.backdropSat === 'number' ? (p.backdropSat as number) : 0,
          };
          p.tuneByMode = {
            custom: { ...flat },
            art: { ...flat },
          };
        }
        /*
         * The blurred-cover mode is gone, and it owned two pieces of state: its own
         * value in `background` and its own drawer of sliders.
         *
         * Someone who left the app on it gets the album art instead of the shipped
         * wallpaper, because the mode they chose was the record's colours and the
         * record is still what is playing. Their numbers move over with them when
         * the `art` drawer was never touched, so the room does not change shape on
         * upgrade — only the amount of blur in it does.
         */
        if (p && from < 7) {
          const tune = p.tuneByMode as
            | Record<string, Partial<BackdropTune> | undefined>
            | undefined;
          if (p.background === 'gradient') {
            p.background = 'art';
            if (tune?.gradient && !tune.art) tune.art = tune.gradient;
          }
          if (tune) delete tune.gradient;
        }
        /*
         * One last narrowing, whatever the stored version was: `background` must be
         * a value this build paints and `tuneByMode` must have a row for it, or
         * `setBackground` reads a slider set that is `undefined` and throws on the
         * first mode switch after hydrate.
         */
        if (p) {
          const tune = p.tuneByMode as Record<string, BackdropTune> | undefined;
          if (p.background !== 'art' && p.background !== 'custom') p.background = 'custom';
          if (!tune || typeof tune.art !== 'object' || typeof tune.custom !== 'object') {
            const flat = {
              blur: typeof p.wallpaperBlur === 'number' ? (p.wallpaperBlur as number) : 24,
              dim: typeof p.backdropDim === 'number' ? (p.backdropDim as number) : 0,
              sat: typeof p.backdropSat === 'number' ? (p.backdropSat as number) : 0,
            };
            p.tuneByMode = {
              custom: tune?.custom ?? flat,
              art: tune?.art ?? flat,
            };
          }
        }
        return p as never;
      },
    },
  ),
);

/*
 * Keep the tally honest across the three renderers.
 *
 * A listen started from the strip is written to the shared key by the strip, and
 * the library window is the one showing Most played. `storage` reaches every
 * document but the writer, so this is the whole of the sync — no IPC, and no
 * window can be more than one listen behind.
 */
subscribePlayStats((playStats) => usePlayerStore.setState({ playStats }));

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__store = usePlayerStore;
}
