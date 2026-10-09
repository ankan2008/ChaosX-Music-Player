import { toMediaUrl } from '../audio/engine';

const posterCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

const POSTER_WIDTH = 320;

export function getCachedPoster(filePath: string): string | null {
  return posterCache.get(filePath) ?? null;
}

/**
 * Grabs a frame out of a video file so it can be shown as a thumbnail.
 * ffmpeg does the work first because it reads containers the browser cannot
 * open at all (mkv, avi, wmv, ...); the element path stays as a fallback.
 * Results are cached per path; only visible rows ever ask for one.
 */
export function loadVideoPoster(filePath: string, atSeconds = 1.5): Promise<string | null> {
  const cached = posterCache.get(filePath);
  if (cached) return Promise.resolve(cached);
  const running = inFlight.get(filePath);
  if (running) return running;

  const job = capture(filePath, atSeconds)
    .then((dataUrl) => {
      if (dataUrl) posterCache.set(filePath, dataUrl);
      return dataUrl;
    })
    .finally(() => {
      inFlight.delete(filePath);
    });

  inFlight.set(filePath, job);
  return job;
}

function waitFor(element: HTMLVideoElement, event: string, timeoutMs = 9000): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error(`video ${event} failed`));
    };
    const timer = window.setTimeout(fail, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timer);
      element.removeEventListener(event, done);
      element.removeEventListener('error', fail);
    };
    element.addEventListener(event, done, { once: true });
    element.addEventListener('error', fail, { once: true });
  });
}

async function capture(filePath: string, atSeconds: number): Promise<string | null> {
  const viaFfmpeg = await window.electronAPI?.extractPoster(filePath, atSeconds).catch(() => null);
  if (viaFfmpeg) return viaFfmpeg;
  return captureWithElement(filePath, atSeconds);
}

async function captureWithElement(filePath: string, atSeconds: number): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.crossOrigin = 'anonymous';
  video.src = toMediaUrl(filePath);

  try {
    await waitFor(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration > 3 ? Math.min(atSeconds, duration * 0.25) : 0;
    if (target > 0.05 && video.currentTime !== target) {
      video.currentTime = target;
      await waitFor(video, 'seeked');
    } else {
      await waitFor(video, 'loadeddata');
    }
    if (!video.videoWidth || !video.videoHeight) return null;

    const scale = Math.min(1, POSTER_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
