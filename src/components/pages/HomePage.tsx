import React from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { getEngine } from '../../audio/engine';
import Icon from '../ui/Icon';
import GlassButton from '../ui/GlassButton';
import MediaThumb from '../ui/MediaThumb';
import PlayCards, { useRanked } from './PlayCards';

/**
 * The landing page: what you were on, and what you keep coming back to.
 *
 * Home used to be the full track list again — the same thing Library shows, one
 * click away from the thing that picks it. This is the part a list cannot do:
 * carry the last record you started. The two ranking cards underneath are the
 * shared `PlayCards`, the same pair Library shows.
 *
 * There is no artist grouping and no "play similar", both deliberately: the
 * first is what the folder tabs in Library are for, and the second would need a
 * recommendation source this app does not have and will not fake.
 */

interface Props {
  onBrowse: () => void;
}

const HomePage: React.FC<Props> = ({ onBrowse }) => {
  const library = usePlayerStore((s) => s.library);
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const ranked = useRanked();

  /*
   * The hero is the last thing *started*, not whatever is loaded right now.
   * They differ the moment the app is reopened: the restored session points at a
   * track that has not been listened to yet in this one, and "Continue listening"
   * offering it is still the right answer — that is exactly what was left.
   */
  const resume = ranked.slice().sort((a, b) => b.lastPlayed - a.lastPlayed)[0]?.track
    ?? currentTrack
    ?? null;
  const resumeIsCurrent = !!resume && !!currentTrack && resume.id === currentTrack.id;
  const resumePlaying = resumeIsCurrent && isPlaying;

  /*
   * One button, three states.
   *
   * It used to call `playList` unconditionally, so pressing it while the record
   * was already running restarted that record from zero — the button read as
   * "Playing" and did the opposite of what the word promises. When the hero is
   * already the loaded track it drives the deck instead of reloading it.
   */
  const toggleResume = () => {
    if (!resume) return;
    if (resumeIsCurrent) {
      void usePlayerStore.getState().togglePlay();
      return;
    }
    void getEngine().playList([resume], resume);
  };

  return (
    <div className="home-page">
      <section className="home-hero">
        {resume ? (
          <>
            <MediaThumb track={resume} className="home-hero-art" />
            <div className="home-hero-copy">
              <span className="home-hero-eyebrow">
                {resume.kind === 'video' ? 'Continue watching' : 'Continue listening'}
              </span>
              <h2 className="home-hero-title truncate">{resume.name}</h2>
              <p className="home-hero-sub truncate">
                {resume.artist || 'Unknown artist'}
                {resume.album ? ` • ${resume.album}` : ''}
              </p>
            </div>
            <div className="home-hero-actions">
              <GlassButton radius={18} tint="var(--art-tint-strong)" onClick={toggleResume}>
                <Icon name={resumePlaying ? 'pause' : 'play'} size={13} />
                {resumePlaying ? 'Playing' : resumeIsCurrent && !isPlaying ? 'Resume' : 'Play'}
              </GlassButton>
              <button type="button" className="home-btn" onClick={onBrowse}>
                Browse library
              </button>
            </div>
          </>
        ) : (
          <div className="home-hero-copy home-hero-empty">
            <span className="home-hero-eyebrow">Nothing playing yet</span>
            <h2 className="home-hero-title">Pin a folder and press play</h2>
            <p className="home-hero-sub">{library.length} tracks in the library.</p>
            <div className="home-hero-actions">
              <GlassButton radius={18} onClick={onBrowse}>
                Browse library
              </GlassButton>
            </div>
          </div>
        )}
      </section>

      <PlayCards />
    </div>
  );
};

export default HomePage;
