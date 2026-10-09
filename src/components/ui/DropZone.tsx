import React, { useState, useEffect } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { createTrackFromPath } from '../../hooks/useLibrary';
import { isMediaFile } from '../../utils/media';
import { getEngine } from '../../audio/engine';

const DropZone: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(true);
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (e.relatedTarget === null) setIsDragging(false);
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const api = window.electronAPI;
      if (!api) return;

      const dropped = Array.from(e.dataTransfer?.files ?? []);
      const paths: string[] = [];
      for (const file of dropped) {
        // Electron exposes the absolute path on File (deprecated but present in v30)
        const filePath = (file as File & { path?: string }).path;
        if (filePath && isMediaFile(file.name)) {
          paths.push(filePath);
        }
      }
      if (paths.length === 0) return;

      const { library, setLibrary } = usePlayerStore.getState();
      const known = new Set(library.map((t) => t.id));
      const fresh = [];
      for (const p of paths) {
        if (known.has(p)) continue;
        fresh.push(await createTrackFromPath(p, 'drop'));
      }
      if (fresh.length > 0) {
        setLibrary([...library, ...fresh]);
        void getEngine().playTrack(fresh[0]);
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);

  return (
    <>
      {children}
      {isDragging && (
        <div className="drop-overlay">
          <div className="liquid-glass-panel liquid-glass-card large">
            <p className="font-heading text-lg">Drop Audio Files Here</p>
            <p className="text-glass-textMuted text-xs mt-2">
              Supports: MP3, FLAC, WAV, OGG, AAC, M4A, WMA, ALAC, AIFF, Opus, WebM
            </p>
          </div>
        </div>
      )}
    </>
  );
};

export default DropZone;
