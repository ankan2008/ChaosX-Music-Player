import React, { useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { formatTime } from '../../utils/formatTime';
import MediaThumb from '../ui/MediaThumb';
import TagEditor from './TagEditor';
import Icon from '../ui/Icon';
import { cardGlass } from '../../utils/glass';
import Elapsed from '../ui/Elapsed';

const NowPlaying: React.FC<{ className?: string }> = ({ className = '' }) => {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const tagTriggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section
      className={`liquid-glass-panel now-playing ${className}`}
      data-glass
      data-config={cardGlass(26)}
      data-no-capture
    >
      <MediaThumb track={currentTrack} className="art-tile flex-shrink-0" />

      <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
        <h2 className="text-xl leading-tight truncate">
          {currentTrack?.name || 'ChaosX'}
        </h2>
        <p className="text-glass-textMuted text-sm truncate">
          {currentTrack ? `${currentTrack.artist} — ${currentTrack.album}` : 'Nothing playing'}
        </p>

        <div className="flex items-center gap-2 flex-wrap mt-1">
          <span className="glass-badge">
            {isPlaying ? 'Playing' : currentTrack ? 'Paused' : 'Ready'}
          </span>
          {currentTrack?.format && (
            <span className="glass-badge">{currentTrack.format.toUpperCase()}</span>
          )}
          {currentTrack && currentTrack.bitrate > 0 && (
            <span className="glass-badge">{currentTrack.bitrate} kbps</span>
          )}
          {currentTrack && currentTrack.sampleRate > 0 && (
            <span className="glass-badge">
              {(currentTrack.sampleRate / 1000).toFixed(1)} kHz
              {currentTrack.bitDepth > 0 && ` / ${currentTrack.bitDepth}-bit`}
            </span>
          )}
          {currentTrack && currentTrack.kind !== 'video' && (
            <button
              ref={tagTriggerRef}
              type="button"
              className="liquid-glass-btn icon small squish tag-edit-trigger"
              data-tip="Edit this file's tags"
              aria-label="Edit tags"
            >
              <Icon name="pencil" size={13} />
            </button>
          )}
          <TagEditor triggerRef={tagTriggerRef} />
        </div>

        <p className="text-xs text-glass-textDim mt-1">
          <Elapsed className="" />
          {currentTrack ? ` / ${formatTime(currentTrack.duration)}` : ''}
        </p>
      </div>
    </section>
  );
};

export default NowPlaying;
