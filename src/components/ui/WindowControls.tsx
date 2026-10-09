import React, { useEffect, useState } from 'react';
import { cardGlass } from '../../utils/glass';

/*
 * The three window controls, drawn by the page rather than by Windows.
 *
 * The operating system can be handed this strip — `titleBarOverlay` paints exactly these
 * three buttons over the top-right — and its minimise and close work. Its maximise
 * cannot: the button posts `SC_MAXIMIZE`, and Chromium's views layer answers that command
 * through a check that fails for every window whose titlebar is hidden, so the message is
 * dropped before Win32 ever sees it. `SC_RESTORE` on the same window works, and so does
 * the shell's snap preset, which is why the symptom reads as a one-way button.
 * See the note on `titleBarStyle` in `electron/main.ts`.
 *
 * A button in the page sidesteps all of it: it calls into the main process, which moves
 * the window with `ShowWindow` — the same call the real maximise ends in, just not the
 * one views is asked to approve.
 */
export default function WindowControls() {
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return undefined;
    void api.getWindowState().then((s) => setZoomed(Boolean(s?.isMaximized)));
    return api.onZoomed?.(setZoomed);
  }, []);

  return (
    <div
      className="win-controls"
      data-glass
      data-config={cardGlass(16)}
      data-no-capture
    >
      <button
        type="button"
        className="win-btn"
        aria-label="Minimize"
        data-tip="Minimize"
        onClick={() => void window.electronAPI?.minimizeWindow()}
      >
        <i className="cap-min" />
      </button>
      <button
        type="button"
        className="win-btn"
        aria-label={zoomed ? 'Restore' : 'Maximize'}
        data-tip={zoomed ? 'Restore' : 'Maximize'}
        onClick={() => void window.electronAPI?.maximizeWindow().then(setZoomed)}
      >
        <i className={zoomed ? 'cap-restore' : 'cap-max'} />
      </button>
      <button
        type="button"
        className="win-btn is-close"
        aria-label="Close"
        data-tip="Close"
        onClick={() => void window.electronAPI?.closeWindow()}
      >
        <i className="cap-x" />
      </button>
    </div>
  );
}
