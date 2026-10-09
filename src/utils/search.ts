import type { LibraryFolder, Track } from '../types';

/**
 * One search, shared by the bar at the top and the list it filters.
 *
 * The bar used to write `searchQuery` and nothing else, so it only appeared to
 * work on the page that happened to read that field — Home and Settings showed
 * no results, and typing a song's name from Settings did nothing at all. Both
 * the filtering and the "what should Enter play" answer now come from here, so
 * the two cannot disagree about what a match is.
 */

/** Every metadata field a person might type at, in the order they'd notice it. */
export function matchesQuery(track: Track, needle: string, folderName?: string): boolean {
  if (!needle) return true;
  const q = needle;
  return (
    track.name.toLowerCase().includes(q) ||
    (track.artist ?? '').toLowerCase().includes(q) ||
    (track.album ?? '').toLowerCase().includes(q) ||
    (track.format ?? '').toLowerCase().includes(q) ||
    (folderName ?? '').toLowerCase().includes(q)
  );
}

/** The library as the search bar sees it: same predicate, same folder names. */
export function filterLibrary(
  library: Track[],
  folders: LibraryFolder[],
  query: string,
): Track[] {
  const q = query.trim().toLowerCase();
  if (!q) return library;
  const names = new Map(folders.map((f) => [f.id, f.name.toLowerCase()]));
  return library.filter((t) => matchesQuery(t, q, names.get(t.folderId ?? '')));
}

export interface Hit {
  track: Track;
  /** What matched, for the label beside the title. */
  why: string;
}

/**
 * Score a track against the query. Higher is better; 0 means no match.
 *
 * Title beats artist beats album because that is the order people remember
 * things in, and a prefix match beats a substring one so "Sha" puts "Shallow"
 * above "Pushing Shallow".
 */
function score(track: Track, q: string, folderName: string): { value: number; why: string } {
  const name = track.name.toLowerCase();
  const artist = (track.artist ?? '').toLowerCase();
  const album = (track.album ?? '').toLowerCase();
  const words = name.split(/[^a-z0-9]+/);

  if (name === q) return { value: 100, why: 'Title' };
  if (name.startsWith(q)) return { value: 88, why: 'Title' };
  if (words.some((w) => w.startsWith(q))) return { value: 74, why: 'Title' };
  if (name.includes(q)) return { value: 62, why: 'Title' };
  if (artist.startsWith(q)) return { value: 52, why: 'Artist' };
  if (artist.includes(q)) return { value: 44, why: 'Artist' };
  if (album.startsWith(q)) return { value: 34, why: 'Album' };
  if (album.includes(q)) return { value: 28, why: 'Album' };
  if (folderName.startsWith(q)) return { value: 18, why: 'Folder' };
  if (folderName.includes(q)) return { value: 14, why: 'Folder' };
  if ((track.format ?? '').toLowerCase().includes(q)) return { value: 8, why: 'Format' };
  return { value: 0, why: '' };
}

/** The best matches, for the bar's suggestion list. */
export function searchLibrary(
  library: Track[],
  folders: LibraryFolder[],
  query: string,
  limit = 7,
): Hit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const names = new Map(folders.map((f) => [f.id, f.name.toLowerCase()]));
  const hits: Array<Hit & { value: number }> = [];
  for (const track of library) {
    const s = score(track, q, names.get(track.folderId ?? '') ?? '');
    if (s.value > 0) hits.push({ track, why: s.why, value: s.value });
  }
  hits.sort(
    (a, b) => b.value - a.value || a.track.name.localeCompare(b.track.name),
  );
  return hits.slice(0, limit).map(({ track, why }) => ({ track, why }));
}
