/**
 * Number-prefix extraction & natural sort
 * Handles filenames like "005 - N - Born For This.mp3"
 * Primary sort by integer prefix, secondary by filename
 */

const NUMBER_PREFIX_RE = /^(\d+)\s*[-_\s]?/;

export function extractNumberPrefix(filename: string): number | null {
  const match = filename.match(NUMBER_PREFIX_RE);
  if (match) {
    const num = parseInt(match[1], 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

export function naturalSortCompare(a: string, b: string): number {
  const aNum = extractNumberPrefix(a);
  const bNum = extractNumberPrefix(b);

  if (aNum !== null && bNum !== null) {
    if (aNum !== bNum) return aNum - bNum;
    return a.localeCompare(b);
  }

  if (aNum !== null) return -1;
  if (bNum !== null) return 1;

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function sortTracksByNumber(tracks: any[]): any[] {
  return [...tracks].sort((a, b) => {
    /*
     * Position within the folder, which is the numeric-aware file order the
     * scan already established. The leading number in a filename is not usable
     * as an ordering key here: a folder of standalone singles tags every one of
     * them `01 - Artist - Title`, so the whole list collapsed onto `001` and the
     * run only moved on for tracks whose *album* number happened to differ.
     */
    if (a.folderIndex != null && b.folderIndex != null && a.folderIndex !== b.folderIndex) {
      return a.folderIndex - b.folderIndex;
    }
    if (a.folderIndex != null && b.folderIndex == null) return -1;
    if (a.folderIndex == null && b.folderIndex != null) return 1;

    const aNum = a.numberPrefix ?? extractNumberPrefix(a.name);
    const bNum = b.numberPrefix ?? extractNumberPrefix(b.name);

    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
      return a.name.localeCompare(b.name);
    }

    if (aNum !== null) return -1;
    if (bNum !== null) return 1;

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

export function sortTracksByTitle(tracks: any[]): any[] {
  return [...tracks].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function sortTracksByArtist(tracks: any[]): any[] {
  return [...tracks].sort((a, b) =>
    (a.artist || '').localeCompare(b.artist || '', undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function sortTracksByAlbum(tracks: any[]): any[] {
  return [...tracks].sort((a, b) =>
    (a.album || '').localeCompare(b.album || '', undefined, { numeric: true, sensitivity: 'base' }),
  );
}

export function sortTracksByDuration(tracks: any[]): any[] {
  return [...tracks].sort((a, b) => (a.duration || 0) - (b.duration || 0));
}

/** Falls back to scan order for entries cached before the field existed. */
export function sortTracksByDateAdded(tracks: any[]): any[] {
  return [...tracks].sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
}

/**
 * Position of each pinned folder in the library, 1-based.
 *
 * `LibraryFolder.id` *is* the absolute folder path, and `pinFolder` appends, so
 * the array order is both meaningful and durable — it survives a rescan and only
 * changes when the user adds or removes a folder. That is what makes it usable
 * as the leading half of a track number.
 *
 * Paths are compared the way Windows does it: case-insensitively and ignoring a
 * trailing separator. Without that, a folder pinned as `D:\Music` and a track
 * scanned under `d:\music\` miss each other in the map and every row falls back
 * to the same rank — which is how both folders ended up numbered `1-`.
 *
 * `tracks` matters for the same reason: a library restored from cache can carry
 * a folder that is no longer in `folders` (or was pinned before this build).
 * Those get ranks after the pinned ones instead of colliding at zero.
 */
export function folderKey(id?: string): string {
  return (id ?? '').replace(/[\\/]+$/, '').toLowerCase();
}

export function buildFolderRank(
  folders: { id: string }[],
  tracks: { folderId?: string }[] = [],
): Map<string, number> {
  const rank = new Map<string, number>();
  const add = (id: string | undefined) => {
    const key = folderKey(id);
    if (key && !rank.has(key)) rank.set(key, rank.size + 1);
  };
  folders.forEach((folder) => add(folder.id));
  // Sorted so an unpinned leftover still gets the same number every render.
  [...new Set(tracks.map((t) => folderKey(t.folderId)))]
    .filter(Boolean)
    .sort()
    .forEach((key) => {
      if (!rank.has(key)) rank.set(key, rank.size + 1);
    });
  return rank;
}

export function rankOf(rank: Map<string, number>, folderId?: string): number {
  return rank.get(folderKey(folderId)) ?? 0;
}

/**
 * Folder-major ordering: each pinned folder keeps its own run of numbers, and
 * the chosen sort applies *inside* a folder rather than across the merge.
 *
 * Sorting the whole merged list by number interleaves every folder's 001 with
 * every other's, which is the thing that makes a multi-folder library unreadable.
 * Descending is applied per group, not to the concatenated result, so folder 1
 * still leads folder 2 whichever way the user flips the arrow.
 */
export function orderTracksByFolder<T extends { folderId?: string }>(
  tracks: T[],
  compare: (tracks: any[]) => any[],
  rank: Map<string, number>,
  desc: boolean,
): T[] {
  const groupCount = new Set(tracks.map((t) => folderKey(t.folderId))).size;
  if (groupCount < 2) {
    const ordered = compare(tracks);
    return desc ? [...ordered].reverse() : ordered;
  }

  const groups = new Map<string, T[]>();
  for (const track of tracks) {
    const key = folderKey(track.folderId);
    const bucket = groups.get(key);
    if (bucket) bucket.push(track);
    else groups.set(key, [track]);
  }

  const ordered = [...groups.keys()]
    .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
    .flatMap((key) => {
      const inside = compare(groups.get(key)!);
      return desc ? [...inside].reverse() : inside;
    });
  return ordered;
}

/**
 * The library's display order, by sort name. Shared by the list and by the
 * queue the app seeds on first load, so Up Next can never disagree with the
 * rows the user is looking at.
 */
const COMPARATORS: Record<string, (tracks: any[]) => any[]> = {
  number: sortTracksByNumber,
  title: sortTracksByTitle,
  artist: sortTracksByArtist,
  album: sortTracksByAlbum,
  duration: sortTracksByDuration,
  dateAdded: sortTracksByDateAdded,
};

/**
 * xorshift32. Tiny, and good enough to make a playlist order that nobody will
 * spot as patterned — the point is reproducibility, not cryptographic mixing.
 */
function bits(seed: number): () => number {
  let x = seed | 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x |= 0;
    x ^= x >>> 17;
    x ^= x << 5; x |= 0;
    return (x >>> 0) / 4294967296;
  };
}

/**
 * The play order shuffle mode means, as a function of nothing but the number of
 * tracks and one seed.
 *
 * The queue panel lists whole folders as well as the library, and the engine
 * permutes whatever list it is handed. Both used to reach for Math.random, which
 * meant the panel could not show the order it was about to play — it showed a
 * preview of a permutation that would not exist until the first skip. Deriving
 * the order from a seed both windows can read is what makes the two agree.
 */
export function seededPermutation(length: number, seed: number): number[] {
  const order = Array.from({ length }, (_, i) => i);
  const next = bits(seed);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}

export function applyShuffle<T>(tracks: T[], on: boolean, seed: number): T[] {
  if (!on || tracks.length < 2) return tracks;
  const order = seededPermutation(tracks.length, seed);
  return order.map((i) => tracks[i]);
}

export function orderLibrary<T extends { folderId?: string }>(
  tracks: T[],
  sortMode: string,
  rank: Map<string, number>,
  desc: boolean,
): T[] {
  return orderTracksByFolder(tracks, COMPARATORS[sortMode] ?? sortTracksByNumber, rank, desc);
}

/**
 * The number shown in the list's first column: `1-002`.
 *
 * The leading digit is the folder's position among the pinned folders and the
 * tail is the track's position within that folder, so one glance says which
 * folder a song came from and where in it. It is deliberately *not* conditional
 * on several folders being in view: a single pinned folder still reads `1-002`,
 * and the same row shows the same number in All Music and in that folder's own
 * list. Anything else made the two views disagree about which song was which.
 *
 * The tail is the scan position rather than a number read off the file: a folder
 * of singles names every track `01 - …`, which made the whole column read
 * `001` and jump only where an album number happened to differ.
 */
export function trackNumberLabel(
  track: { folderIndex?: number; name: string; folderId?: string },
  rank: Map<string, number>,
): string | null {
  const num = track.folderIndex ?? null;
  if (num === null) return null;
  const padded = String(num).padStart(3, '0');
  const folder = rankOf(rank, track.folderId);
  return folder ? `${folder}-${padded}` : padded;
}
/**
 * The songs a merged music list should hold.
 *
 * A pinned folder may contain films as well as records, and the All-songs view
 * is a *music* list: a video row sitting among the songs plays a picture into
 * what is meant to be an audio queue. Folders keep showing everything they
 * contain — that is the whole point of pinning one — so only the merged views
 * filter, and they filter on the track's own kind rather than on an extension
 * table that would have to be kept current with every container in existence.
 */
export function audioOnly<T extends { kind?: string }>(tracks: T[]): T[] {
  return tracks.filter((t) => t.kind !== 'video');
}

/**
 * The mirror of `audioOnly`: every film across every pinned folder.
 *
 * Folder tabs already show films, because pinning a folder that contains video is
 * the only way to reach them — but that scatters a library's videos across as many
 * tabs as there are folders. This is the one list that gathers them.
 */
export function videoOnly<T extends { kind?: string }>(tracks: T[]): T[] {
  return tracks.filter((t) => t.kind === 'video');
}
