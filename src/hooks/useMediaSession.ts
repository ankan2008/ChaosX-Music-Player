import { useEffect } from 'react';
import { usePlayerStore } from '../stores/playerStore';
import { getEngine } from '../audio/engine';
import { claimMediaKey } from '../utils/mediaGuard';

const ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'previoustrack',
  'nexttrack',
  'stop',
  'seekbackward',
  'seekforward',
  'seekto',
];

/**
 * Windows delivers touchpad media gestures and Bluetooth headset buttons to
 * whichever app owns the SMTC session, not through global hotkeys — so the
 * app has to claim that session here or the keys go to another player.
 */
export function useMediaSession(): void {
  const currentTrack = usePlayerStore((s) => s.currentTrack);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const store = () => usePlayerStore.getState();

    const bind = (action: MediaSessionAction, fn: (d: MediaSessionActionDetails) => void) => {
      try {
        ms.setActionHandler(action, (d) => {
          if (!claimMediaKey()) return;
          fn(d);
        });
      } catch {
        // Action unsupported by this Chromium build
      }
    };

    bind('play', () => void store().play());
    bind('pause', () => store().pause());
    bind('previoustrack', () => store().playPrevious());
    bind('nexttrack', () => store().playNext());
    bind('stop', () => store().stop());
    bind('seekbackward', (d) => getEngine().seekBy(-(d.seekOffset || 5)));
    bind('seekforward', (d) => getEngine().seekBy(d.seekOffset || 5));
    bind('seekto', (d) => {
      if (d.seekTime != null) getEngine().seek(d.seekTime);
    });

    return () => {
      for (const action of ACTIONS) {
        try {
          ms.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
    };
  }, []);

  /*
   * The taskbar thumbnail's transport buttons arrive as an IPC from the main
   * process, where a WM_COMMAND on this window carried the button id. They drive
   * the same store actions as the media keys, and they deliberately do not go
   * through `claimMediaKey`: that guard exists to stop one physical press firing
   * twice, and a thumbnail click is never also a media key.
   */
  useEffect(() => {
    const store = () => usePlayerStore.getState();
    return window.electronAPI?.thumbbar?.onCommand((action) => {
      if (action === 'next') store().playNext();
      else if (action === 'prev') store().playPrevious();
      else if (action === 'back') getEngine().seekBy(-5);
      else if (action === 'forward') getEngine().seekBy(5);
      else if (store().isPlaying) store().pause();
      else store().play();
    });
  }, []);

  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.metadata = currentTrack
      ? new MediaMetadata({
          title: currentTrack.name,
          artist: currentTrack.artist || 'Unknown Artist',
          album: currentTrack.album || 'Unknown Album',
          artwork: currentTrack.albumArt
            ? [{ src: currentTrack.albumArt, sizes: '512x512', type: 'image/jpeg' }]
            : [],
        })
      : null;
  }, [currentTrack?.id, currentTrack?.albumArt]);

  /*
   * The system position is pushed from the engine's own listener rather than
   * recomputed on render: this hook has no UI of its own, and taking the
   * playhead through React here would wake the whole tree twice a second just
   * to tell the OS where the song is.
   */
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = isPlaying ? 'playing' : 'paused';
    const duration = currentTrack?.duration ?? 0;
    if (duration <= 0) return;
    return getEngine().onPosition((seconds) => {
      try {
        ms.setPositionState({
          duration,
          position: Math.min(seconds, duration),
          playbackRate: usePlayerStore.getState().speed,
        });
      } catch {
        // Position state rejected while the session has no metadata
      }
    });
  }, [isPlaying, currentTrack?.duration]);
}
