import { useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { extractNumberPrefix } from '../utils/sorting';
import { parseLrc, looksLikeLrc } from '../utils/parseLrc';
import { extractMetadata } from '../utils/metadata';
import { toMediaUrl } from '../audio/engine';
import { fileExtension, isMediaFile, mediaKind } from '../utils/media';
import { IS_OVERLAY_WINDOW } from '../utils/windowRole';
import type { Track, LibraryFolder, Playlist } from '../types';

/** How often a running app re-walks the pinned folders for new files. */
const LIBRARY_POLL_MS = 10 * 60 * 1000;

/**
 * A row as a store holds it: every field the list draws, none of the cover.
 *
 * Measured against 437 tracks, the base64 was 22.2 MB of a 217 MB heap — about ten
 * seconds of a laptop's whole RAM budget — for the twelve rows that are on screen at
 * once, and it survived every scroll, search keystroke and mode switch for the life
 * of the window. The tiles that need a cover read it themselves, when they are near
 * the screen (`MediaThumb` + `coverFor`), and the only row that keeps its artwork is
 * the one that is sounding, because the disc, the pill's tint and the shell's
 * artwork all find it by walking the store rather than by looking at the row.
 *
 * It is worth being exact about what this does *not* yet reclaim. `libraryCache`
 * below is the same parsed file the rows were copied out of, and until the shell
 * hands a library window the artless index it already builds for widgets, the
 * strings this frees are still held there. Always copy rather than return the
 * row unchanged, too: a cached object must never be aliased into the store, and
 * `publish` writes `folderIndex` onto whatever it is given.
 */
function rowWithoutArt(track: Track): Track {
  return { ...track, albumArt: null };
}

/** Build a fully-enriched Track from an absolute file path (drop target, etc.) */
export async function createTrackFromPath(
  fullPath: string,
  folderId = 'drop',
): Promise<Track> {
  const fileName = fullPath.split(/[\\/]/).pop() ?? fullPath;
  const dirName = fullPath.split(/[\\/]/).slice(0, -1).pop() ?? '';
  // A dropped file goes straight into the store, so its row is stripped the same
  // way a scanned one is; the tile asks for the cover if it is ever looked at.
  return rowWithoutArt(await buildTrack(fullPath, fileName, folderId, dirName));
}

async function buildTrack(
  fullPath: string,
  fileName: string,
  folderId: string,
  dirName: string,
  mtimeMs?: number,
  lrcPath: string | null = null,
): Promise<Track> {
  const numPrefix = extractNumberPrefix(fileName);
  const meta = await extractMetadata(fullPath).catch(() => null);

  // Lyrics: sidecar .lrc wins, then embedded lyrics
  let lyrics: Track['lyrics'] = null;
  let plainLyrics: string | null = null;

  /*
   * The sidecar's existence is passed in rather than probed here.
   *
   * `pathExists` for every candidate used to cost one IPC round trip per track —
   * over four hundred files that is four hundred trips to the main process to
   * discover that almost none of them have a .lrc. The walk already lists every
   * directory, so it can say which sidecars exist for free.
   */
  if (lrcPath) {
    try {
      const content = await window.electronAPI!.readFile(lrcPath);
      const parsed = parseLrc(content);
      if (parsed.length > 0) {
        lyrics = parsed;
      } else if (content.trim()) {
        plainLyrics = content.trim();
      }
    } catch {
      // unreadable sidecar
    }
  }

  if (!lyrics && meta?.lyrics?.length) {
    const joined = meta.lyrics.join('\n');
    if (looksLikeLrc(joined)) {
      const parsed = parseLrc(joined);
      if (parsed.length > 0) lyrics = parsed;
    }
    if (!lyrics) {
      plainLyrics = meta.lyrics.join('\n\n').trim() || null;
    }
  }

  return {
    id: fullPath,
    name: meta?.title?.trim() || fileName.replace(/\.[^.]+$/, ''),
    artist: meta?.artist?.trim() || 'Unknown Artist',
    album: meta?.album?.trim() || dirName || 'Unknown Album',
    albumArt: meta?.albumArt ?? null,
    duration: Math.round(meta?.duration || 0),
    path: fullPath,
    mediaUrl: meta?.mediaUrl || toMediaUrl(fullPath),
    folderId,
    format: fileExtension(fileName),
    kind: mediaKind(fileName) ?? 'audio',
    bitrate: meta?.bitrate || 0,
    sampleRate: meta?.sampleRate || 0,
    bitDepth: meta?.bitDepth || 0,
    channels: meta?.channels || 0,
    trackNumber: numPrefix ?? meta?.track ?? 0,
    year: meta?.year ?? null,
    genre: meta?.genre ?? '',
    lyrics,
    plainLyrics,
    waveformPeaks: [],
    numberPrefix: numPrefix,
    dateAdded: mtimeMs,
    volume: 1.0,
  };
}

interface ScannedFile {
  fullPath: string;
  name: string;
  dirName: string;
  size?: number;
  mtimeMs?: number;
  /** A `.lrc` beside this file, found by the walk rather than by a probe. */
  lrcPath?: string;
}

/**
 * Parsed metadata, kept between runs and reused until the file behind it
 * changes. Without it every startup — and every dev reload — re-read every
 * tag and cover in the library, which is what made the window feel frozen.
 *
 * The entries keep their `albumArt` even though no store row does: this object is
 * the thing that is written back to `library-cache.json`, and the covers in it are
 * the reason a re-scan of an unchanged folder reads no pixels at all. What is
 * written to disk is deliberately untouched by the row strip in `publish`.
 */
type LibraryCache = Record<string, { stamp: string; track: Track }>;

let libraryCache: LibraryCache | null = null;

async function loadLibraryCache(): Promise<LibraryCache> {
  if (libraryCache) return libraryCache;
  const raw = (await window.electronAPI?.loadLibraryCache()) as LibraryCache | null;
  libraryCache = raw && typeof raw === 'object' ? raw : {};
  return libraryCache;
}

/**
 * Folded into every cache stamp so a change to how a track is *derived* — a
 * bigger cover, an extra tag — retires the stored entries instead of serving
 * them to every future launch.
 *
 * Retiring the whole cache is not free: it means re-reading all 437 files, which
 * measured twenty-five minutes of disk and CPU on a 2-core machine. So a bump
 * lists the versions it replaces as still readable — the new derivation applies
 * to anything scanned from now on, and an entry already stored the old way stays
 * valid until its own file changes. Bump `CACHE_VERSION` and add the previous
 * value to `CACHE_LEGACY` together, or the next launch re-scans everything.
 */
const CACHE_VERSION = 'art512';
const CACHE_LEGACY = ['art1024-shrink-only'];

const stampOf = (file: ScannedFile) =>
  `${CACHE_VERSION}|${file.size ?? 0}:${Math.round(file.mtimeMs ?? 0)}`;

/** True when a stored entry was written by this build or one deliberately kept. */
const stampMatches = (stamp: string, file: ScannedFile) => {
  const tail = `|${file.size ?? 0}:${Math.round(file.mtimeMs ?? 0)}`;
  return stamp === `${CACHE_VERSION}${tail}` || CACHE_LEGACY.some((v) => stamp === `${v}${tail}`);
};

// StrictMode double-invokes effects; a startup scan should only ever run once
let startupScanStarted = false;

/**
 * A widget's copy of the library, built from the cache alone.
 *
 * A floating card never walks a folder, never reads a tag and never writes the
 * cache: it is a control surface on the deck the library window owns, and the only
 * thing it needs the rows for is to answer the session's ids and to fill its own
 * search box. Doing the full scan here meant a second directory walk, a second
 * 22 MB parse and a second 437-track store in a process that shows six rows —
 * measured at 43 MB of JS heap for a pill, of which 23 MB was album art.
 *
 * Covers are the part that is deliberately left out: the main process hands the
 * widget the same rows with `albumArt` nulled, and the few covers it actually
 * paints come from `media:read-tags` on demand (`coverFor`).
 */
async function hydrateWidgetLibrary(): Promise<void> {
  const cache = await loadLibraryCache();
  const pinned = new Set(usePlayerStore.getState().folders.map((f) => f.id));
  const byFolder = new Map<string, Track[]>();
  const hidden = new Set(usePlayerStore.getState().hiddenPaths);
  for (const entry of Object.values(cache)) {
    const track = entry.track as Track;
    const folderId = track.folderId ?? '';
    if (!pinned.has(folderId) || hidden.has(track.path)) continue;
    const list = byFolder.get(folderId);
    // A fresh object per row, so a cached entry is never aliased into the store.
    if (list) list.push(rowWithoutArt(track));
    else byFolder.set(folderId, [rowWithoutArt(track)]);
  }

  const tracks: Track[] = [];
  for (const list of byFolder.values()) {
    /*
     * The same order the scan gives the folder, because the list's number column
     * is position-within-folder: a widget that numbered rows differently would
     * show one number and play another when the shuffle is off.
     */
    list.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    list.forEach((track, i) => {
      track.folderIndex = i + 1;
    });
    tracks.push(...list);
  }
  usePlayerStore.setState({ library: tracks });
}

async function collectMediaFiles(
  dirPath: string,
  basePath: string,
  out: ScannedFile[],
  depth = 0,
): Promise<void> {
  if (depth > 12) return;
  try {
    const entries = await window.electronAPI?.listDir(dirPath) ?? [];
    const dirName = dirPath.replace(basePath, '').split(/[\\/]/).filter(Boolean).pop() || '';
    const dirs: string[] = [];
    /*
     * Collected in the same pass rather than asked for per track. The directory
     * listing is already in hand, so knowing which songs have a lyric sidecar
     * costs nothing here and saves one IPC round trip per file later.
     */
    const sidecars = new Map<string, string>();
    const media: ScannedFile[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        dirs.push(`${dirPath}\\${entry.name}`);
      } else if (!entry.isFile) {
        continue;
      } else if (entry.name.toLowerCase().endsWith('.lrc')) {
        sidecars.set(entry.name.replace(/\.lrc$/i, '').toLowerCase(), `${dirPath}\\${entry.name}`);
      } else if (isMediaFile(entry.name)) {
        media.push({
          fullPath: `${dirPath}\\${entry.name}`,
          name: entry.name,
          dirName,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        });
      }
    }
    for (const file of media) {
      const stem = file.name.replace(/\.[^.]+$/, '').toLowerCase();
      const lrc = sidecars.get(stem);
      if (lrc) file.lrcPath = lrc;
      out.push(file);
    }
    for (const dir of dirs) {
      await collectMediaFiles(dir, basePath, out, depth + 1);
    }
  } catch {
    // Skip directories we can't read
  }
}

/**
 * A row that exists before anything has been read off the file.
 *
 * A newly pinned folder used to show nothing at all until the first batch of tags
 * landed, because the only publish before then was gated on the cache having hits —
 * and a folder pinned for the first time has none. Filename, type and location are
 * already known from the directory listing, which is enough to draw the row and let
 * the list scroll, so the wait becomes "the names appear, then the artwork and
 * durations fill in" instead of "nothing, then everything".
 */
function skeletonTrack(file: ScannedFile, folderId: string): Track {
  const fileName = file.name;
  return {
    id: file.fullPath,
    name: fileName.replace(/\.[^.]+$/, ''),
    artist: 'Unknown Artist',
    album: file.dirName || 'Unknown Album',
    albumArt: null,
    duration: 0,
    path: file.fullPath,
    mediaUrl: toMediaUrl(file.fullPath),
    folderId,
    format: fileExtension(fileName),
    kind: mediaKind(fileName) ?? 'audio',
    bitrate: 0,
    sampleRate: 0,
    bitDepth: 0,
    channels: 0,
    trackNumber: extractNumberPrefix(fileName) ?? 0,
    year: null,
    genre: '',
    lyrics: null,
    plainLyrics: null,
    waveformPeaks: [],
    numberPrefix: extractNumberPrefix(fileName),
    dateAdded: file.mtimeMs,
    volume: 1.0,
  };
}

/** Keeps a few metadata reads in flight so big folders don't crawl. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * The rows a playlist tab lists.
 *
 * A path the scan already knows comes through as the library's own row — tags and
 * duration included, cover not, since no store row carries one. A path it does not
 * — a song from a folder that has since been unpinned, or one hand-typed into the
 * file — is still a song the user put in the list, so it gets a row built from the
 * file name rather than being silently dropped. mpv plays either one the same way.
 */
export function playlistTracks(playlist: Playlist, library: Track[]): Track[] {
  const byPath = new Map(library.map((t) => [t.path, t] as const));
  return playlist.tracks.map((filePath) => {
    const known = byPath.get(filePath);
    if (known) return known;
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    return {
      id: filePath,
      name: fileName.replace(/\.[^.]+$/, ''),
      artist: 'Unknown Artist',
      album: filePath.split(/[\\/]/).slice(-2, -1).pop() || 'Unknown Album',
      albumArt: null,
      duration: 0,
      path: filePath,
      mediaUrl: toMediaUrl(filePath),
      format: fileExtension(fileName),
      kind: mediaKind(fileName) ?? 'audio',
      bitrate: 0,
      sampleRate: 0,
      bitDepth: 0,
      channels: 0,
      trackNumber: 0,
      year: null,
      genre: '',
      lyrics: null,
      plainLyrics: null,
      waveformPeaks: [],
      numberPrefix: extractNumberPrefix(fileName),
      volume: 1,
    } satisfies Track;
  });
}

/**
 * Playlists: the lists this app writes for itself, at
 * `<userData>/playlists/<name>.m3u8`.
 *
 * A row of references, never a copy of a record and never a directory, which is why
 * the scanner is kept out of all of this — and why one can be renamed from the
 * library while a pinned folder cannot: moving a playlist is moving one file the app
 * made, while a folder's name belongs wherever the user keeps their music.
 *
 * Module-level rather than inside `useLibrary` because none of them needs a
 * subscription, and the row menu has to reach them without mounting the hook a second
 * time and installing another copy of its rescan interval.
 */

/**
 * `null` when the write failed, so the caller can say so instead of opening a tab
 * that has no file behind it.
 *
 * The name is chosen from the store's list, but the file is created on disk, and
 * the two can disagree — a list left by an older build, a rename that half
 * completed, a file dropped into the folder by hand. Main refuses a name that is
 * already taken rather than merging into it, so the loop keeps walking the numbers
 * until it lands on one the disk also agrees is free. Without it the button
 * silently did nothing, forever, on a name this app had just picked for itself.
 */
export async function createPlaylist(): Promise<Playlist | null> {
  const api = window.electronAPI;
  if (!api) return null;
  /*
   * Empty on purpose. It used to open with whatever was sounding, which read as a
   * courtesy and was a lie the first time a playlist was made to hold something
   * else — the list arrived wearing a song nobody had asked for, and there was no
   * way in the app to take it back out.
   */
  for (let n = 1; n <= 50; n++) {
    const name = `New playlist ${n}`;
    if (usePlayerStore.getState().playlists.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      continue;
    const reply = await api.createPlaylist(name, []);
    if (!reply.ok || !reply.path) {
      if (reply.error && /already exists/i.test(reply.error)) continue;
      return null;
    }
    const playlist: Playlist = { name, path: reply.path, tracks: [] };
    usePlayerStore.getState().addPlaylist(playlist);
    return playlist;
  }
  return null;
}

/** `path` on success — where it lives now — and `error` when nothing changed. */
export async function renamePlaylist(
  playlist: Playlist,
  name: string,
): Promise<{ path?: string; error?: string }> {
  const api = window.electronAPI;
  const clean = name.trim();
  if (!api || !clean || clean === playlist.name) return {};
  const reply = await api.renamePlaylist(playlist.name, clean);
  if (!reply.ok || !reply.path) return { error: reply.error ?? 'That name could not be used.' };
  usePlayerStore.getState().patchPlaylist(playlist.path, { name: clean, path: reply.path });
  return { path: reply.path };
}

/**
 * Rewrite a playlist's contents through one door, for every edit the app makes.
 *
 * `edit` is given the list as the store holds it *now*, not as the caller's copy of
 * it. Two adds fired from the same menu would otherwise both write on top of the
 * first, and a rename between the open and the click would have the file written
 * under a name the tab no longer uses.
 *
 * The result is deduplicated by path. The library page once showed the same song
 * eight rows running because "Add playing" appended unconditionally and was pressed
 * eight times looking for a confirmation that never came; a list of references has
 * no reason to hold the same reference twice, and no way for the user to tell an
 * intentional duplicate from a mis-click.
 *
 * It is an updater rather than a finished list for a reason that bit once already:
 * the first version of this took `next` and prepended the current contents to it,
 * which is right for an add and quietly wrong for a remove — the row came back on
 * the next render while the notice promised it had gone.
 */
async function editPlaylist(
  playlist: Playlist,
  edit: (current: string[]) => string[],
): Promise<{ error?: string }> {
  const api = window.electronAPI;
  if (!api) return { error: 'Playlists need the desktop app.' };
  const live = usePlayerStore.getState().playlists.find((p) => p.path === playlist.path) ?? playlist;
  const tracks = [...new Set(edit(live.tracks))];
  const reply = await api.writePlaylist(live.name, tracks);
  if (!reply.ok) return { error: reply.error ?? 'The playlist could not be written.' };
  usePlayerStore.getState().patchPlaylist(live.path, { tracks });
  return {};
}

export async function addToPlaylist(
  playlist: Playlist,
  trackPath: string,
): Promise<{ error?: string }> {
  return editPlaylist(playlist, (t) => [...t, trackPath]);
}

/** Several songs at once, from the row menu's multi-select. */
export async function addManyToPlaylist(
  playlist: Playlist,
  paths: string[],
): Promise<{ error?: string }> {
  return editPlaylist(playlist, (t) => [...t, ...paths]);
}

/**
 * Take songs out of a list.
 *
 * The list, not the disk: this rewrites the `.m3u8` this app wrote and never touches
 * a media file, which is the distinction that had to be asked for — a row that says
 * "Remove" in red is a row that reads like a delete.
 */
export async function removeFromPlaylist(
  playlist: Playlist,
  paths: string[],
): Promise<{ error?: string }> {
  const gone = new Set(paths);
  return editPlaylist(playlist, (t) => t.filter((p) => !gone.has(p)));
}

export async function removePlaylist(playlist: Playlist): Promise<{ error?: string }> {
  const reply = await window.electronAPI?.removePlaylist(playlist.name);
  // The tab goes either way: a file the user already deleted by hand is not a
  // reason for a playlist that no longer exists to stay on the strip.
  usePlayerStore.getState().removePlaylist(playlist.path);
  return reply && !reply.ok ? { error: reply.error ?? 'The file could not be deleted.' } : {};
}

/**
 * Fill a playlist from the folder tree rather than from what happens to be playing.
 *
 * Returns the paths chosen, or an empty array when the dialog was dismissed, so the
 * caller can tell "nothing added" from "nothing asked for".
 */
export async function pickFilesForPlaylist(): Promise<string[]> {
  const api = window.electronAPI;
  if (!api?.openFiles) return [];
  return (
    (await api.openFiles({
      title: 'Add songs to this playlist',
      filters: [
        {
          name: 'Audio and video',
          extensions: [
            'mp3', 'flac', 'wav', 'ogg', 'm4a', 'opus', 'aac', 'wma',
            'mp4', 'mkv', 'webm', 'mov', 'avi',
          ],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    })) ?? []
  );
}

/**
 * Put files the user picked into the library without pinning their folder.
 *
 * The same route a drag-and-drop takes — a row under the synthetic `drop` folder —
 * so the two cannot disagree about what "a file I added by hand" means, and a
 * rescan of a real folder never claims to own it.
 */
export async function addFilesToLibrary(paths: string[]): Promise<number> {
  const existing = new Set(usePlayerStore.getState().library.map((t) => t.path));
  const fresh: Track[] = [];
  for (const path of paths) {
    if (existing.has(path)) continue;
    fresh.push(await createTrackFromPath(path, 'drop'));
  }
  if (fresh.length === 0) return 0;
  const { library, hiddenPaths } = usePlayerStore.getState();
  const hidden = new Set(hiddenPaths);
  usePlayerStore.setState({
    library: [...library, ...fresh.filter((t) => !hidden.has(t.path))],
  });
  return fresh.length;
}

/**
 * Add paths to whichever playlist is named, creating the file if it has gone.
 *
 * The menu offers a target by name and the store can have moved underneath it —
 * a rename between the open and the click is the whole gap — so the lookup happens
 * here, at the moment of writing, rather than when the row was drawn.
 */
export async function addPathsToPlaylistByName(
  name: string,
  paths: string[],
): Promise<{ error?: string }> {
  const target = usePlayerStore.getState().playlists.find((p) => p.name === name);
  if (!target) return { error: 'That playlist is no longer here.' };
  return addManyToPlaylist(target, paths);
}

export function useLibrary() {
  const isScanning = usePlayerStore((s) => s.isScanning);
  const scanProgress = usePlayerStore((s) => s.scanProgress);
  const playlists = usePlayerStore((s) => s.playlists);
  const scanGeneration = useRef(0);

  const rescanFolder = useCallback(async (folder: LibraryFolder) => {
    if (!window.electronAPI) return 0;

    const cache = await loadLibraryCache();
    const files: ScannedFile[] = [];
    await collectMediaFiles(folder.path, folder.path, files);
    files.sort((a, b) => a.fullPath.localeCompare(b.fullPath, undefined, { numeric: true }));

    const total = files.length;
    const tracks: Track[] = new Array(total);
    const changed: Array<{ index: number; file: ScannedFile }> = [];

    files.forEach((file, index) => {
      const hit = cache[file.fullPath];
      if (hit && stampMatches(hit.stamp, file)) {
        // Copy so a cached object is never aliased into the store, and leave the
        // cover in the cache: the row it belongs to does not carry one.
        tracks[index] = rowWithoutArt(hit.track);
      } else {
        changed.push({ index, file });
      }
    });

    const cachedCount = total - changed.length;
    let finished = 0;
    let lastPublish = 0;

    /*
     * Everything read since the last write, and the one way it leaves this window.
     *
     * The whole index used to be handed to the main process on every publish, and the
     * main process answered by reading the file, parsing it, merging, stringifying and
     * rewriting it — 23 MB of both, three times a second, for the whole of a first
     * scan. That is the five minutes of a 2.3 GB, 100%-CPU, one-frame-a-second boot
     * that only a *fresh* install pays: with a warm cache `changed` is empty and none
     * of it runs, which is exactly why it looked like the uninstall had caused it.
     */
    const dirty: LibraryCache = {};
    const flushDirty = () => {
      const keys = Object.keys(dirty);
      if (!keys.length) return;
      const set: LibraryCache = {};
      for (const key of keys) {
        set[key] = dirty[key];
        delete dirty[key];
      }
      window.electronAPI?.patchLibraryCache({ set });
    };

    const publish = () => {
      /*
       * The list's number column is position-within-folder, and the scan order
       * is already the natural, numeric-aware file order — so this is the one
       * place that can define it. It is assigned here rather than in
       * `buildTrack` because cached entries never go through that function, and
       * a folder restored entirely from cache would otherwise keep whatever
       * numbering an earlier scan gave it.
       */
      tracks.forEach((track, i) => {
        if (track) track.folderIndex = i + 1;
      });
      /*
       * The record that is sounding keeps its cover, and a publish is exactly
       * where it would lose it: the rows rebuilt here come out of the parsed
       * cache stripped, and a poll landing in the middle of a track playing
       * would hand the list back an artless copy of the one row the disc, the
       * pill's tint, the waveform's accent and the shell's artwork are all
       * reading. `fillCurrentCover` in `audio/engine` put it there.
       */
      const state = usePlayerStore.getState();
      const keptArt = state.currentTrack?.albumArt ? state.currentTrack : null;
      const fresh = tracks.filter(Boolean).map((track) =>
        keptArt && track.id === keptArt.id && !track.albumArt
          ? { ...track, albumArt: keptArt.albumArt }
          : track,
      );
      const kept = state.library.filter((t) => t.folderId !== folder.id);
      const hidden = new Set(state.hiddenPaths);
      usePlayerStore.setState({
        library: [...kept, ...fresh.filter((t) => !hidden.has(t.path))],
        scanProgress: total
          ? Math.round(((cachedCount + finished) / total) * 100)
          : 100,
      });
    };

    /*
     * Put the rows on screen before reading a single tag.
     *
     * This used to be gated on `cachedCount > 0`, which is never true the first
     * time a folder is pinned — so the newest thing the user had just asked for
     * was the one case that showed nothing until the metadata arrived.
     */
    files.forEach((file, index) => {
      if (!tracks[index]) tracks[index] = skeletonTrack(file, folder.id);
    });
    publish();

    /*
     * Eight rather than four. The per-file work is a `media://` fetch and a tag
     * parse, which is I/O bound, and the skeletons above mean a slower tail no
     * longer reads as an empty list.
     */
    await mapWithConcurrency(changed, 8, async ({ index, file }) => {
      const track = await buildTrack(
        file.fullPath,
        file.name,
        folder.id,
        file.dirName,
        file.mtimeMs,
        file.lrcPath ?? null,
      );
      /*
       * Two copies of what was just read, deliberately unequal: the cache keeps the
       * cover, because that is the object that gets written to disk and the reason
       * the next scan reads no pixels, and the row does not, because a row is drawn
       * from a screen and a cover is 56 KB.
       */
      tracks[index] = rowWithoutArt(track);
      const entry = { stamp: stampOf(file), track };
      cache[file.fullPath] = entry;
      dirty[file.fullPath] = entry;
      finished++;
      const now = Date.now();
      if (now - lastPublish > 300 || finished === changed.length) {
        lastPublish = now;
        publish();
        /*
         * Persisted as it goes. The save used to sit after the whole loop, so a
         * scan that was interrupted — a reload, a crash, a window closed — kept
         * none of the work it had already paid for and the next one started from
         * zero. Debounced by the same 300 ms gate as the publish; the main process
         * folds those into at most one write every few seconds.
         */
        flushDirty();
      }
    });

    const stillThere = new Set(files.map((f) => f.fullPath));
    const root = folder.path.toLowerCase();
    const gone: string[] = [];
    for (const key of Object.keys(cache)) {
      if (key.toLowerCase().startsWith(root) && !stillThere.has(key)) {
        delete cache[key];
        gone.push(key);
      }
    }
    if (gone.length) window.electronAPI?.patchLibraryCache({ remove: gone });
    flushDirty();
    const found = tracks.filter(Boolean);
    publish();

    usePlayerStore.setState({
      folders: usePlayerStore.getState().folders.map((f) =>
        f.id === folder.id ? { ...f, trackCount: found.length } : f,
      ),
      scanProgress: 100,
    });
    return found.length;
  }, []);

  /** Pick a folder via dialog, pin it, and scan it */
  const pinFolder = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    const folderPath = await api.openFolder();
    if (!folderPath) return;

    const id = folderPath;
    const name = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath;
    usePlayerStore.getState().pinFolder({ id, path: folderPath, name, trackCount: 0 });
    usePlayerStore.setState({ isScanning: true, scanProgress: 0 });
    await rescanFolder({ id, path: folderPath, name, trackCount: 0 });
    usePlayerStore.setState({ isScanning: false, scanProgress: 100 });
  }, [rescanFolder]);

  const unpinFolder = useCallback((folderId: string) => {
    const { library, queue, currentIndex, folders } = usePlayerStore.getState();
    const stillPinned = new Set(folders.filter((f) => f.id !== folderId).map((f) => f.id));
    usePlayerStore.getState().unpinFolder(folderId);
    usePlayerStore.setState({
      library: library.filter((t) => stillPinned.has(t.folderId ?? '')),
      queue: queue.filter((t) => stillPinned.has(t.folderId ?? '')),
      currentIndex,
    });
  }, []);

  /*
   * Playlists live at module scope below `useLibrary`, not in here.
   *
   * They need no subscription, no ref and no state — only the store and the IPC
   * bridge — and calling `useLibrary()` a second time to reach them would install a
   * second ten-minute rescan interval behind the first.
   */

  /*
   * Re-walk every pinned folder.
   *
   * `announce` is what separates the cold-start scan from the recurring ones.
   * Showing "Scanning…" once, while nothing else is happening, is useful. Showing
   * it every ten minutes, and every time the user clicks back into the window,
   * replaces a control they were about to press with a spinner for no reason they
   * can see — so the background passes run with no flag at all and the library
   * simply updates underneath whatever is open.
   */
  const rescanAll = useCallback(
    (announce: boolean) => {
      const folders = usePlayerStore.getState().folders;
      if (folders.length === 0) return;
      const gen = ++scanGeneration.current;
      if (announce) usePlayerStore.setState({ isScanning: true, scanProgress: 0 });
      void (async () => {
        for (const folder of folders) {
          if (scanGeneration.current !== gen) return;
          await rescanFolder(folder);
        }
        if (scanGeneration.current === gen && announce) {
          usePlayerStore.setState({ isScanning: false, scanProgress: 100 });
        }
      })();
    },
    [rescanFolder],
  );

  /*
   * Three chances a session to notice a file that appeared after the scan.
   *
   * Startup, every return to the foreground, and every ten minutes while sitting
   * there. The last one is what covers the case the others miss: the window stays
   * focused while a downloader finishes writing an album, which is exactly when a
   * manual rescan is the last thing anyone remembers to press.
   *
   * `rescanFolder` is already incremental — it compares each file's stamp against
   * the cache and only re-reads metadata for the ones that moved — so a pass that
   * finds nothing costs a directory walk and no decoding.
   */
  useEffect(() => {
    if (startupScanStarted) return;
    startupScanStarted = true;
    if (IS_OVERLAY_WINDOW) {
      void hydrateWidgetLibrary();
      return;
    }
    rescanAll(true);
  }, [rescanAll]);

  useEffect(() => {
    if (IS_OVERLAY_WINDOW) return;
    const timer = window.setInterval(() => rescanAll(false), LIBRARY_POLL_MS);
    const wake = () => {
      if (document.visibilityState === 'visible') rescanAll(false);
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
    };
  }, [rescanAll]);

  return {
    isScanning,
    scanProgress,
    pinFolder,
    unpinFolder,
    rescanFolder,
    rescanAll,
    playlists,
    createPlaylist,
    renamePlaylist,
    addToPlaylist,
    addManyToPlaylist,
    removeFromPlaylist,
    pickFilesForPlaylist,
    removePlaylist,
  };
}

