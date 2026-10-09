import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import { cardGlass, dropdownGlass } from '../../utils/glass';
import { filterLibrary, searchLibrary } from '../../utils/search';
import Icon from './Icon';
import MediaThumb from './MediaThumb';
import type { Track } from '../../types';

/**
 * The search bar, and the page it belongs to.
 *
 * It used to write a `searchQuery` field that exactly one page read, so typing
 * the name of a song while sitting on Home or Settings appeared to do nothing —
 * "the search bar can't really work properly in home page" — even though the
 * whole library was scanned and in memory the entire time.
 *
 * Now it answers from anywhere: the list under the bar is the best metadata
 * match across the library whatever page is showing, and committing a result
 * moves to Library and plays it there. That is the behaviour the user described,
 * and it is also the only one that keeps a single source of truth for "what is
 * playing" — the search does not have its own player.
 */
export const SearchBar: React.FC<{
  placeholder?: string;
  className?: string;
}> = ({ placeholder = 'Search tracks...', className = '' }) => {
  const query = usePlayerStore((s) => s.searchQuery);
  const library = usePlayerStore((s) => s.library);
  const folders = usePlayerStore((s) => s.folders);
  const setSearchQuery = usePlayerStore((s) => s.setSearchQuery);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const hits = useMemo(() => searchLibrary(library, folders, query, 7), [library, folders, query]);

  useEffect(() => {
    setPick(0);
  }, [query]);

  /* Dismiss on anything outside the bar. The panel is a child of the bar, so
     clicking a result does not count as going outside. */
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);

  /**
   * Play a result from the Library page, then put the bar away.
   *
   * The queue handed to the engine is the *filtered* list, not the single
   * track: that is what the Library page was showing at the moment of the
   * press, so "next" walks down the results the user chose from rather than off
   * into the rest of the library.
   *
   * The query is then cleared. Leaving it in the box meant the Library page came
   * back filtered to one song, which is the opposite of "bring back the
   * library" — the search was a gesture, not a mode the page stays in. With no
   * match the same happens minus the playing: the bar closes and the library
   * returns whole.
   */
  const commit = (track: Track | undefined) => {
    const store = usePlayerStore.getState();
    const list = track ? filterLibrary(library, folders, query) : [];
    store.setSection('library');
    store.setSearchQuery('');
    setOpen(false);
    inputRef.current?.blur();
    if (!track) return;
    void getEngine().playList(list.length ? list : [track], track);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' && hits.length) {
      e.preventDefault();
      setOpen(true);
      setPick((p) => (p + 1) % hits.length);
      return;
    }
    if (e.key === 'ArrowUp' && hits.length) {
      e.preventDefault();
      setPick((p) => (p - 1 + hits.length) % hits.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(hits[Math.min(pick, hits.length - 1)]?.track ?? hits[0]?.track);
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div className={`search-wrap ${className}`} ref={rootRef}>
      <div
        className="liquid-glass-card search-bar"
        data-glass
        data-config={cardGlass(20)}
        data-no-capture
      >
        <Icon name="search" size={15} className="search-icon" />
        <input
          ref={inputRef}
          type="search"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="search-input"
          aria-label="Search the library"
          spellCheck={false}
        />
        {query && (
          <button
            onClick={() => {
              setSearchQuery('');
              setOpen(false);
            }}
            className="search-clear"
            data-tip="Clear search"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      {showList ? (
        <div
          className="search-results"
          data-glass
          data-config={dropdownGlass(16)}
          data-no-capture
          role="listbox"
          aria-label="Search results"
        >
          {hits.length === 0 ? (
            <p className="search-none">Nothing matches “{query.trim()}”.</p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={hit.track.id}
                type="button"
                role="option"
                aria-selected={i === pick}
                className={`search-hit ${i === pick ? 'picked' : ''}`}
                onMouseEnter={() => setPick(i)}
                onClick={() => commit(hit.track)}
              >
                <MediaThumb track={hit.track} className="search-hit-art" sync={false} />
                <span className="search-hit-names">
                  <span className="search-hit-title truncate">{hit.track.name}</span>
                  <span className="search-hit-sub truncate">
                    {hit.track.artist || 'Unknown artist'}
                    {hit.track.album ? ` · ${hit.track.album}` : ''}
                  </span>
                </span>
                <span className="search-hit-why">{hit.why}</span>
              </button>
            ))
          )}
          <p className="search-foot">Enter plays it in Library</p>
        </div>
      ) : null}
    </div>
  );
};
