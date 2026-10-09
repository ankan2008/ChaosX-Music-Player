import { getEngine } from '../audio/engine';
import {
  addFilesToLibrary,
  addManyToPlaylist,
  createPlaylist,
  pickFilesForPlaylist,
} from '../hooks/useLibrary';
import { usePlayerStore } from '../stores/playerStore';
import type { Playlist, Track } from '../types';

/**
 * One row in a floating menu.
 *
 * Lives here rather than beside `SongContextMenu` because the menu is now drawn for
 * two different callers — a right-click on one row, and the multi-select toolbar for
 * a handful — and both have to be able to hand the panel the same shape.
 */
export interface MenuAction {
  label: string;
  icon: 'play' | 'next' | 'queue' | 'download' | 'delete' | 'skip-to-start' | 'plus' | 'music' | 'playlist' | 'pencil';
  danger?: boolean;
  dimmed?: boolean;
  sep?: boolean;
  /**
   * Faded text set beside the label.
   *
   * It exists for the one rule that cannot be carried by dimming alone: a greyed
   * "Play next" says *not now* but not *why not*, and the reason is a number the
   * user can only discover by deselecting rows one at a time.
   */
  hint?: string;
  /**
   * Rows this one opens instead of running.
   *
   * Drawn in place of the parent, at the same anchor, because a context menu
   * spawned by a pointer has no trigger element to grow a morph panel out of — the
   * reason the menu is a fixed panel in the first place. A row that carries one has
   * no `run`, and the panel refuses to press it.
   */
  sub?: MenuAction[];
  run?: () => void;
}

/**
 * How many rows "Play next" will take at once.
 *
 * Six is not an arbitrary cap — it is exactly what the Up Next panel pins
 * (`QueueControl`'s `WINDOW`). Beyond it the additions fall off the bottom of the
 * list the user is watching, so the gesture looks like it did nothing, which is the
 * same failure the six-song loop bug came out of.
 */
export const PLAY_NEXT_MAX = 6;

/** What the page has to tell the menu about itself. */
export interface ListAccess {
  /**
   * The list the visible rows *are*, or `null` for a list that is a query result
   * rather than a collection — search suggestions, Home's ranked cards.
   *
   * Every named list can have rows taken out of it; what differs is what that
   * means. For a playlist it rewrites the `.m3u8` this app wrote. For a folder tab
   * or `All songs` it hides the file from the scanned lists — the row is a
   * reference to a directory the user owns, and deleting the file inside it is not
   * what "remove from this list" asks for. Both are expressed as one `remove`, so
   * the menu cannot offer a row it has not been given a way to carry out.
   */
  list: {
    name: string;
    remove: (paths: string[]) => Promise<{ error?: string }>;
    /** What to say about what removal does, since it differs between the two. */
    notice: string;
  } | null;
  /**
   * Whether this list can be filled from the file manager.
   *
   * True for a playlist (it is a list of paths) and for `All songs` (a picked file
   * joins the library the same way a dropped one does). False for a pinned folder,
   * where the contents of the list *are* the contents of a directory and adding to
   * one would mean copying a real file into the user's music folder.
   */
  canAdd: boolean;
  /** Surface a line the user should see. The library page owns the notice strip. */
  notify: (message: string) => void;
}

/** The paths of these tracks, in the order they are listed. */
const pathsOf = (tracks: Track[]) => tracks.map((t) => t.path);

/**
 * Put a run of tracks immediately after the one that is sounding.
 *
 * Inserted back to front on purpose: `insertNext` parks its argument at
 * *current + 1*, so walking the selection forwards would land the last song first
 * and leave the run in reverse.
 */
function insertRun(tracks: Track[]): void {
  const engine = getEngine();
  for (let i = tracks.length - 1; i >= 0; i--) engine.insertNext(tracks[i]);
}

/**
 * Every list a song can be filed into, as submenu rows.
 *
 * Read off the store each time the menu is built, which is what makes the names
 * current: a playlist created or renamed since the last open is in this list, and
 * one deleted is not.
 */
function targets(tracks: Track[], access: ListAccess): MenuAction[] {
  const paths = pathsOf(tracks);
  const rows: MenuAction[] = usePlayerStore
    .getState()
    .playlists
    .map((playlist) => ({
      label: playlist.name,
      icon: 'music' as const,
      run: () => {
        void addManyToPlaylist(playlist, paths).then((done) => {
          if (done.error) access.notify(done.error);
          else {
            access.notify(
              `Added ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} to ${playlist.name}`,
            );
          }
        });
      },
    }));

  rows.unshift({
    /*
     * "New list…", not "New playlist" — because the default name this app gives the
     * playlists it makes *is* "New playlist", and a row meaning "make one" sitting
     * above a row meaning "put it in this one", both reading the same four words, is
     * a menu that cannot be aimed.
     */
    label: 'New list…',
    icon: 'plus',
    sep: rows.length > 0,
    run: () => {
      void createPlaylist().then((made) => {
        if (!made) {
          access.notify('The playlist could not be created.');
          return;
        }
        void addManyToPlaylist(made, paths).then(() =>
          access.notify(`Made ${made.name} with ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'}`),
        );
      });
    },
  });
  return rows;
}

/**
 * Put picked files into whichever named list the row menu is standing in.
 *
 * Two very different things answer to the same menu row — a playlist takes the
 * paths onto its list, `All songs` takes the files into the library the same way a
 * drag-and-drop does — and the caller has already decided which of the two it is by
 * naming the list.
 */
async function fillList(
  name: string,
  paths: string[],
): Promise<{ added: number; error?: string }> {
  const playlist = usePlayerStore.getState().playlists.find((p) => p.name === name);
  if (!playlist) return { added: await addFilesToLibrary(paths) };
  const done = await addManyToPlaylist(playlist, paths);
  return done.error ? { added: 0, error: done.error } : { added: paths.length };
}

/**
 * The whole "Add songs" gesture in one call, for the toolbar button beside the one
 * in the menu. Both go through the same two steps so neither can forget the notice.
 */
export async function pickAndAddToList(
  name: string,
  notify: (message: string) => void,
): Promise<void> {
  const picked = await pickFilesForPlaylist();
  if (picked.length === 0) return;
  const done = await fillList(name, picked);
  if (done.error) notify(done.error);
  else if (done.added === 0) notify('Those files are already in the list.');
  else notify(`Added ${done.added} to ${name}`);
}

/**
 * The rows a right-click offers, and — with more than one track — the rows the
 * multi-select menu offers. They are the same function so the two can never drift.
 *
 * `runningOrder` is the list the row came from, which "Play now" needs and the bulk
 * menu does not: with several rows chosen there is no single one to start at.
 */
export function songActions(
  tracks: Track[],
  runningOrder: Track[],
  access: ListAccess,
): MenuAction[] {
  if (tracks.length === 0) return [];
  const one = tracks.length === 1 ? tracks[0] : null;
  const many = tracks.length > 1;
  const tooManyForNext = tracks.length > PLAY_NEXT_MAX;
  const paths = pathsOf(tracks);
  const { list } = access;

  const items: MenuAction[] = [
    {
      label: 'Play now',
      icon: 'play',
      /*
       * Greyed above one selection, because "play now" is a promise about a running
       * order — start *here*, then walk this list — and several rows chosen out of
       * it do not name a single place to start.
       */
      dimmed: many,
      run: () => void getEngine().playList(runningOrder, tracks[0]),
    },
    {
      label: 'Play next',
      icon: 'next',
      dimmed: tooManyForNext,
      hint: tooManyForNext ? `Up to ${PLAY_NEXT_MAX} at a time` : undefined,
      run: () => insertRun(tracks),
    },
    {
      label: 'Add to list',
      icon: 'plus',
      sep: true,
      sub: targets(tracks, access),
    },
  ];

  if (list) {
    if (access.canAdd) {
      items.push({
        label: 'Add songs…',
        icon: 'plus',
        run: () => {
          void pickFilesForPlaylist().then((picked) => {
            if (picked.length === 0) return;
            void fillList(list.name, picked).then((done) => {
              if (done.error) access.notify(done.error);
              else if (done.added === 0) access.notify('Those files are already in the list.');
              else access.notify(`Added ${done.added} to ${list.name}`);
            });
          });
        },
      });
    }
    items.push({
      label: `Remove from ${list.name}`,
      icon: 'delete',
      danger: true,
      /*
       * A red row in a context menu reads as a delete, and this one is not: it
       * rewrites the `.m3u8` this app wrote, or hides the row from a scanned list.
       * The media file is never opened, let alone removed.
       */
      run: () => {
        void list.remove(paths).then((done) => {
          if (done.error) access.notify(done.error);
          else {
            access.notify(
              `Removed ${tracks.length} ${tracks.length === 1 ? 'song' : 'songs'} from ${list.name}. ${list.notice}`,
            );
          }
        });
      },
    });
  }

  if (one) {
    items.push({
      label: 'Show in File Explorer',
      icon: 'download',
      sep: true,
      /*
       * Reveal the file, do not run it. This called `openPath` first, which hands
       * the song to whatever Windows has associated with the extension — so the one
       * menu row meant for the filesystem opened a media player and started playing
       * the track the user was trying to locate.
       */
      run: () => void window.electronAPI?.showInFolder?.(one.path),
    });
  }

  return items;
}
