import React, { useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import MorphingGlassPanel from '../ui/MorphingGlassPanel';
import Icon from '../ui/Icon';
import { panelDirection } from '../../utils/surface';
import type { Track } from '../../types';

/**
 * Edit the tags written into the file itself.
 *
 * Plan feature #17. The fields are the ones the library actually reads and sorts
 * on, and anything not shown here is left untouched by the write rather than being
 * blanked — a tag editor that quietly drops the lyrics or the composer is worse
 * than no editor at all.
 *
 * It edits the *current* track from the Now Playing card, because that is the one
 * row whose metadata is already on screen and can be checked against what plays.
 * Video files are excluded: remuxing a lecture to change a comment is not what
 * anyone means when they press "edit tags".
 */

interface Field {
  key: string;
  label: string;
  /** Which store field the write refreshes, so the UI agrees before a rescan. */
  patch?: 'name' | 'artist' | 'album' | 'year' | 'genre' | 'trackNumber';
  grow?: boolean;
  numeric?: boolean;
}

const FIELDS: Field[] = [
  { key: 'title', label: 'Title', patch: 'name', grow: true },
  { key: 'artist', label: 'Artist', patch: 'artist', grow: true },
  { key: 'album', label: 'Album', patch: 'album', grow: true },
  { key: 'album_artist', label: 'Album artist' },
  { key: 'genre', label: 'Genre', patch: 'genre', grow: true },
  { key: 'date', label: 'Year', patch: 'year', numeric: true },
  { key: 'track', label: 'No.', patch: 'trackNumber', numeric: true },
];

/** What the file currently reports, with the scanner's placeholders undone. */
function initial(t: Track): Record<string, string> {
  return {
    title: t.name ?? '',
    artist: t.artist === 'Unknown Artist' ? '' : t.artist ?? '',
    album: t.album === 'Unknown Album' ? '' : t.album ?? '',
    album_artist: '',
    genre: t.genre ?? '',
    date: t.year == null ? '' : String(t.year),
    track: t.trackNumber ? String(t.trackNumber) : '',
  };
}

/**
 * A separate component so the form's state is born with the track it describes.
 *
 * The alternative — one long-lived form that re-seeds itself when `currentTrack`
 * changes — means either a render-phase setState or an effect that fights the
 * user's keystrokes, and both have bitten this app already.
 */
const TagForm: React.FC<{ track: Track }> = ({ track }) => {
  const [values, setValues] = useState<Record<string, string>>(() => initial(track));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const api = window.electronAPI;
    if (!api?.writeTags) {
      setError('Tag writing is not available in this window.');
      return;
    }
    setBusy(true);
    setError(null);
    const tags: Record<string, string> = {};
    for (const f of FIELDS) tags[f.key] = (values[f.key] ?? '').trim();
    const result = await api.writeTags(track.path, tags);
    if (!result.ok) {
      setBusy(false);
      setError(result.error ?? 'The file refused the write.');
      return;
    }
    /*
     * Reflect it immediately. The next scan would pick the change up by itself —
     * rewriting the file moves its size and mtime, and the library cache is keyed
     * on both — but "I saved and nothing happened until you restart" is not
     * something to ask of a form.
     */
    const patch: Partial<Track> & { id: string } = { id: track.id };
    for (const f of FIELDS) {
      if (!f.patch) continue;
      const v = (values[f.key] ?? '').trim();
      if (f.patch === 'year') patch.year = /^\d{3,4}$/.test(v) ? parseInt(v, 10) : null;
      else if (f.patch === 'trackNumber') patch.trackNumber = /^\d+$/.test(v) ? parseInt(v, 10) : 0;
      else if (f.patch === 'name') patch.name = v || track.name;
      else if (f.patch === 'artist') patch.artist = v || 'Unknown Artist';
      else if (f.patch === 'album') patch.album = v || 'Unknown Album';
      else if (f.patch === 'genre') patch.genre = v;
    }
    usePlayerStore.getState().updateTrack(patch);
    setBusy(false);
    setError(null);
  };

  return (
    <div className="tag-editor" role="group" aria-label="Tag editor">
      <div className="tag-editor-head">
        <span className="font-heading text-xs">Edit tags</span>
        <span className="tag-editor-file" title={track.path}>
          {track.path.split(/[\\/]/).pop()}
        </span>
      </div>

      {FIELDS.map((f) => (
        <label key={f.key} className={`tag-field${f.grow ? ' grow' : ''}`}>
          <span className="tag-field-label">{f.label}</span>
          <input
            type="text"
            className="tag-field-input"
            inputMode={f.numeric ? 'numeric' : undefined}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            aria-label={f.label}
          />
        </label>
      ))}

      {error ? <p className="tag-editor-error">{error}</p> : null}

      <div className="tag-editor-actions">
        <button
          type="button"
          className="liquid-glass-btn small-text squish"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? 'Writing…' : 'Save'}
        </button>
        <button
          type="button"
          className="liquid-glass-btn small-text squish"
          onClick={() => { setValues(initial(track)); setError(null); }}
          disabled={busy}
        >
          Revert
        </button>
      </div>
      <p className="tag-editor-hint">
        Writes into the file itself. The audio is copied, never re-encoded.
      </p>
    </div>
  );
};

const TagEditor: React.FC<{ triggerRef: React.RefObject<HTMLElement> }> = ({ triggerRef }) => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  if (!currentTrack || currentTrack.kind === 'video') return null;

  return (
    <MorphingGlassPanel
      triggerRef={triggerRef}
      idle={{ width: 26, height: 26, radius: 13 }}
      open={{ width: 330, height: 430, radius: 24 }}
      direction={panelDirection}
      align="center"
    >
      {/* Keyed by id so the form is always born holding the track it edits. */}
      <TagForm key={currentTrack.id} track={currentTrack} />
    </MorphingGlassPanel>
  );
};

export default TagEditor;
