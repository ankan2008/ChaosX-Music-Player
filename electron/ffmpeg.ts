import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { execFile } from 'child_process';

const isDev = process.env.NODE_ENV === 'development';

/** ffmpeg lives next to the sources in dev and in resources/ when packaged. */
const FFMPEG_DIR = isDev
  ? path.join(process.cwd(), 'resources', 'ffmpeg')
  : path.join(process.resourcesPath, 'ffmpeg');

const exe = (name: string) => path.join(FFMPEG_DIR, process.platform === 'win32' ? `${name}.exe` : name);

export function ffmpegAvailable(): boolean {
  try {
    return fs.existsSync(exe('ffmpeg'));
  } catch {
    return false;
  }
}

/**
 * Never let more than two ffmpeg children run at once: starting a track kicks
 * off both a loudness scan and a waveform decode, and a handful of parallel
 * decoders is enough to starve playback of CPU.
 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function run(args: string[], timeoutMs = 120000): Promise<{ stdout: Buffer; stderr: string }> {
  return withSlot(
    () =>
      new Promise((resolve, reject) => {
        execFile(
          exe('ffmpeg'),
          args,
          { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true, encoding: 'buffer' },
          (err, stdout, stderr) => {
            if (err) reject(Object.assign(err, { stderr: String(stderr) }));
            else resolve({ stdout: stdout as unknown as Buffer, stderr: String(stderr) });
          },
        );
      }),
  );
}

export interface GainAnalysis {
  /** Highest sample peak seen, in dBFS (can exceed 0 on hot masters) */
  truePeakDb: number;
  /** Mean RMS of the sampled windows, dBFS */
  rmsDb: number;
  /** Linear gain to apply so the peak lands at the target ceiling */
  gainDb: number;
}

const TARGET_CEILING_DB = -1.5;

/**
 * Measures loudness on a few 20s windows rather than the whole file: a full
 * scan of every track would cost minutes, while three windows catch the
 * loudest section of virtually any master. Results are cached by
 * path+mtime+size, so each file is only ever measured once.
 */
const WINDOW_SECONDS = 20;
const WINDOW_FRACTIONS = [0.2, 0.5, 0.8];

function cacheDir(): string {
  const dir = path.join(app.getPath('userData'), 'analysis-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A fixed-length digest of the path plus the file's size and mtime.
 *
 * This used to be `base64url(raw).slice(0, 120)`, which silently cut the
 * *encoded* string — so for any long path the size and mtime fell off the end
 * entirely and the key became the first ~86 characters of the filename alone.
 * Two tracks in the same deep folder then shared a cache entry, which meant a
 * decoded PCM file could be served for the wrong song, and editing a track
 * never invalidated anything. Hashing instead of truncating keeps the key both
 * short and dependent on the whole identity.
 */
function cacheKey(filePath: string): string {
  let stamp = filePath;
  try {
    const st = fs.statSync(filePath);
    stamp = `${filePath}|${st.size}|${Math.round(st.mtimeMs)}`;
  } catch {
    // Path unreadable — fall back to the path alone rather than fail the call.
  }
  return createHash('sha1').update(stamp).digest('hex').slice(0, 24);
}

function readCache<T>(filePath: string, kind: string): T | null {
  try {
    const file = path.join(cacheDir(), `${kind}-${cacheKey(filePath)}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeCache(filePath: string, kind: string, value: unknown): void {
  try {
    const file = path.join(cacheDir(), `${kind}-${cacheKey(filePath)}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
  } catch {
    // cache is best-effort
  }
}

async function measureWindow(filePath: string, startSec: number): Promise<{ peakDb: number; rmsDb: number } | null> {
  try {
    const { stderr } = await run([
      '-hide_banner',
      '-ss', String(Math.max(0, Math.round(startSec))),
      '-t', String(WINDOW_SECONDS),
      '-i', filePath,
      '-map', 'a:0',
      '-af', 'astats=metadata=1:reset=0',
      '-f', 'null',
      '-',
    ], 60000);
    const peaks = [...stderr.matchAll(/Peak level dB:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const rms = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    if (peaks.length === 0) return null;
    const valid = peaks.filter((p) => Number.isFinite(p));
    const validRms = rms.filter((r) => Number.isFinite(r));
    if (valid.length === 0) return null;
    return {
      peakDb: Math.max(...valid),
      rmsDb: validRms.length ? validRms.reduce((a, b) => a + b, 0) / validRms.length : -70,
    };
  } catch {
    return null;
  }
}

export async function analyzeLoudness(filePath: string, durationSec: number): Promise<GainAnalysis | null> {
  if (!ffmpegAvailable()) return null;
  const cached = readCache<GainAnalysis>(filePath, 'gain');
  if (cached) return cached;

  const dur = durationSec > WINDOW_SECONDS * 2 ? durationSec : 0;
  const starts = dur
    ? WINDOW_FRACTIONS.map((f) => Math.max(0, dur * f - WINDOW_SECONDS / 2))
    : [0];

  const results = (await Promise.all(starts.map((s) => measureWindow(filePath, s)))).filter(
    (r): r is { peakDb: number; rmsDb: number } => r !== null,
  );
  if (results.length === 0) {
    // No audio stream (video-only file): remember that so we stop asking
    const silent: GainAnalysis = { truePeakDb: 0, rmsDb: -70, gainDb: 0 };
    writeCache(filePath, 'gain', silent);
    return silent;
  }

  const truePeakDb = Math.max(...results.map((r) => r.peakDb));
  const rmsDb = results.reduce((a, r) => a + r.rmsDb, 0) / results.length;
  const analysis: GainAnalysis = {
    truePeakDb: Number(truePeakDb.toFixed(2)),
    rmsDb: Number(rmsDb.toFixed(2)),
    gainDb: Number(Math.min(0, TARGET_CEILING_DB - truePeakDb).toFixed(2)),
  };
  writeCache(filePath, 'gain', analysis);
  return analysis;
}

/** Decoded PCM peaks for the waveform slider, computed off the renderer. */
export async function extractPeaks(filePath: string, count: number): Promise<number[] | null> {
  if (!ffmpegAvailable()) return null;
  const cached = readCache<number[]>(filePath, 'peaks');
  if (cached && cached.length === count) return cached;
  try {
    const { stdout } = await run([
      '-hide_banner',
      '-i', filePath,
      '-map', 'a:0',
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      '-',
    ], 180000);
    const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
    if (samples.length < count) return null;
    const block = Math.floor(samples.length / count);
    const peaks: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      let max = 0;
      const from = i * block;
      const to = Math.min(from + block, samples.length);
      for (let j = from; j < to; j++) {
        const v = samples[j] < 0 ? -samples[j] : samples[j];
        if (v > max) max = v;
      }
      peaks[i] = max / 32768;
    }
    const maxPeak = Math.max(...peaks, 0.001);
    const normalized = peaks.map((p) => Number((p / maxPeak).toFixed(4)));
    writeCache(filePath, 'peaks', normalized);
    return normalized;
  } catch {
    return null;
  }
}

/** First usable frame, as a data URL. Works for containers Chromium can't open. */
/**
 * Containers ffmpeg can rewrite metadata for without touching the audio.
 *
 * `-c copy` remuxes, so the stream bytes are preserved and the operation is
 * lossless and fast. Anything not here is refused rather than attempted, because
 * the failure mode of trying is a command that silently re-encodes the track — a
 * two-hour lecture quietly resampled on a metadata edit.
 */
const TAGGABLE = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'aac', 'wav', 'aiff', 'aif', 'webm', 'wma']);

export interface TagWrite {
  title?: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  genre?: string;
  date?: string;
  track?: string;
}

/**
 * Write tags into the file itself.
 *
 * The temp file is written next to the original so the rename is same-volume and
 * therefore atomic: the original is untouched until the new one is proven to exist
 * and be non-empty, so a crash, a full disk or a bad container cannot leave the
 * user with a truncated file.
 *
 * The rewrite changes the file's size and mtime, which is exactly what the library
 * cache's stamp is made of — so the next scan re-reads the tags on its own and
 * there is nothing to invalidate by hand.
 */
export async function writeTags(
  filePath: string,
  tags: TagWrite,
): Promise<{ ok: boolean; error?: string }> {
  if (!ffmpegAvailable()) return { ok: false, error: 'ffmpeg is not available in this build.' };
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  if (!TAGGABLE.has(ext)) return { ok: false, error: `.${ext} files cannot be tagged in place.` };
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.chaosx-tags.${ext}`);
  try {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath, '-map', '0', '-c', 'copy'];
    // ID3v2.4 keeps the cover art where every player looks for it; v2.2/2.3
    // written by older tools is what makes artwork vanish from some apps.
    if (ext === 'mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
    for (const [k, v] of Object.entries(tags)) args.push('-metadata', `${k}=${v ?? ''}`);
    args.push('-y', tmp);
    await run(args, 60000);
    const stat = fs.statSync(tmp);
    if (stat.size < 1024) {
      fs.unlinkSync(tmp);
      return { ok: false, error: 'ffmpeg produced a file too small to be the real audio.' };
    }
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best effort */ }
    const err = e as { stderr?: string; message?: string };
    return { ok: false, error: (err.stderr || err.message || 'ffmpeg failed').split('\n').filter(Boolean).slice(-2).join(' ') };
  }
}

export async function extractPoster(filePath: string, atSec = 1): Promise<string | null> {
  if (!ffmpegAvailable()) return null;
  // The kind is part of the cache filename, so bumping it retires entries made
  // at the old size rather than serving them forever.
  const cached = readCache<string>(filePath, 'poster2');
  if (cached) return cached;
  try {
    const { stdout } = await run([
      '-hide_banner',
      '-ss', String(Math.max(0, atSec)),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=640:-2:flags=lanczos',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '4',
      '-',
    ], 60000);
    if (stdout.length < 128) return null;
    const dataUrl = `data:image/jpeg;base64,${stdout.toString('base64')}`;
    writeCache(filePath, 'poster2', dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}
