import { parseBlob } from 'music-metadata';
import { toMediaUrl } from '../audio/engine';
import type { ExtractedMetadata } from '../types';

/**
 * The cap on a stored cover, in its longest edge.
 *
 * Covers are embedded anywhere from 300 to 1400px, and two copies of every one of
 * them outlive the scan: the parsed cache file in the main process and the JSON on
 * disk. At 1024 that measured 156 KB per track and 66.6 MB across 437 tracks, twice
 * over — the single biggest thing in the app's memory, and nothing on screen asks
 * for it. The largest surface that ever shows a cover whole is the now-playing card
 * at about 300 CSS px, and the backdrop that used to justify the size stretches its
 * source across the window behind a blur heavy enough that a 300px cover already
 * read fine. 512 leaves headroom for a 1.25x display without paying for pixels
 * nobody resolves.
 *
 * The renderer's own copy is gone: no window keeps a cover in a library row any
 * more, so this number now prices the cache file rather than the heap. Raising it
 * is still not free — it re-encodes every cover in the library, so it has to come
 * with `CACHE_VERSION`.
 *
 * Exported because `BackdropLayer` needs it as the ceiling on how far it may shrink
 * the wallpaper's source: a cover is never re-sampled larger than it was stored, and
 * the two numbers have to be allowed to disagree only on purpose.
 */
export const ART_MAX_PX = 512;

async function pictureToDataUrl(
  data: Uint8Array,
  mime: string,
  maxPx: number = ART_MAX_PX,
): Promise<string | null> {
  try {
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    const source = await createImageBitmap(new Blob([bytes], { type: mime }));
    /*
     * Shrink only. Growing a 300px cover to 1024 buys no detail — the resampler
     * is doing at display time whatever it would do here — and measured it cost
     * 415 KB of JPEG per track, which across a 400-file library is the bulk of
     * the cache. The one place a bigger stored image did help is a filter that
     * resamples cheaply, and `BackdropLayer` sets `imageSmoothingQuality: 'high'`
     * on its own context, so it is not one.
     */
    const scale = Math.min(1, maxPx / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const resize = scale < 1;
    // Resizing through createImageBitmap rather than drawImage puts the work on
    // Chromium's highest-quality resampler (a Lanczos-family filter), which is
    // what makes enlarging a small cover to backdrop size come out smooth
    // instead of blocky.
    const bitmap = resize
      ? await createImageBitmap(source, {
          resizeWidth: width,
          resizeHeight: height,
          resizeQuality: 'high',
        })
      : source;
    source.close();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    // Re-encoding keeps hundreds of covers from ballooning memory
    return canvas.toDataURL('image/jpeg', 0.86);
  } catch {
    return null;
  }
}

/** What the shell's streaming reader answers with, in the units the container reports. */
interface StreamedTags {
  format: string;
  duration: number;
  sampleRate: number;
  bitrate: number;
  bitDepth: number;
  channels: number;
  title: string;
  artist: string;
  album: string;
  year: number | null;
  genre: string;
  track: number | null;
  lyrics: string[];
  picture: { data: Uint8Array; mime: string } | null;
}

async function fromStreamed(filePath: string, m: StreamedTags): Promise<ExtractedMetadata> {
  return {
    mediaUrl: toMediaUrl(filePath),
    format: m.format,
    duration: m.duration,
    sampleRate: m.sampleRate,
    bitrate: Math.round(m.bitrate / 1000),
    bitDepth: m.bitDepth,
    channels: m.channels,
    title: m.title,
    artist: m.artist,
    album: m.album,
    year: m.year,
    genre: m.genre,
    track: m.track,
    albumArt: m.picture ? await pictureToDataUrl(m.picture.data, m.picture.mime) : null,
    lyrics: m.lyrics,
  };
}

/**
 * Tags for one file.
 *
 * The shell is asked first, because it reads through `fs` and touches only the
 * ranges a parser needs. The renderer's own path — fetch the file over `media://`,
 * hand the Blob to the browser build — stays as the fallback, both for containers
 * whose length only a full scan gives and for a shell that could not open the file
 * at all. It used to be the only path, and it read every byte of every file: a
 * 437-file library took twenty-five minutes and half a 2-core CPU, which is what
 * the app looked like it was frozen for.
 */
export async function extractMetadata(filePath: string): Promise<ExtractedMetadata | null> {
  const asked = window.electronAPI?.readTags?.(filePath);
  if (asked) {
    const streamed = await asked.catch(() => null);
    // A zero length means the header did not carry one, so the scan is not finished.
    if (streamed && streamed.duration > 0) return fromStreamed(filePath, streamed);
  }

  try {
    const response = await fetch(toMediaUrl(filePath));
    if (!response.ok) return null;
    const blob = await response.blob();
    const meta = await parseBlob(blob);

    let albumArt: string | null = null;
    const picture = meta.common.picture?.[0];
    if (picture?.data?.length) {
      albumArt = await pictureToDataUrl(
        picture.data instanceof Uint8Array ? picture.data : new Uint8Array(picture.data as ArrayBuffer),
        picture.format || 'image/jpeg',
      );
    }

    const rawLyrics = meta.common.lyrics;
    const lyrics: string[] = [];
    if (Array.isArray(rawLyrics)) {
      for (const entry of rawLyrics) {
        const text = typeof entry === 'string' ? entry : entry?.text ?? '';
        if (text.trim()) lyrics.push(text);
      }
    }

    const genre = Array.isArray(meta.common.genre)
      ? meta.common.genre.join(', ')
      : meta.common.genre ?? '';

    return {
      mediaUrl: toMediaUrl(filePath),
      format: meta.format.container || meta.format.codec || '',
      duration: meta.format.duration ?? 0,
      sampleRate: meta.format.sampleRate ?? 0,
      bitrate: Math.round((meta.format.bitrate ?? 0) / 1000),
      bitDepth: meta.format.bitsPerSample ?? 0,
      channels: meta.format.numberOfChannels ?? 0,
      title: meta.common.title ?? '',
      artist: meta.common.artist ?? meta.common.albumartist ?? '',
      album: meta.common.album ?? '',
      year: typeof meta.common.year === 'number' ? meta.common.year : null,
      genre,
      track: meta.common.track?.no ?? null,
      albumArt,
      lyrics,
    };
  } catch {
    return null;
  }
}

/**
 * Covers pulled on demand, for rows the store holds without one.
 *
 * Neither window keeps the library's artwork in its rows any more: a widget's rows
 * and the library's 437 of them both arrive with `albumArt` nulled (see
 * `hydrateWidgetLibrary` and `rowWithoutArt` in `useLibrary`), because 56 KB of
 * base64 per track is a memory bill for the twelve tiles a screen can paint. So a
 * row asks for its art the moment it comes near the screen, this cache answers for
 * the ones it has already read, and the record that is sounding is the only cover
 * the store carries at all.
 *
 * The cap is deliberate, and no longer tiny. Twenty-four was counted for a card
 * that paints eight tiles; a list screen is taller than that and its rows are
 * windowed, so at 24 the band one flick away had already been evicted and every row
 * coming back went to the disk for its tags a second time. Sixty-four holds a
 * screenful plus the overscan either side of it, which is the whole set of tiles a
 * scroll can be about to need at once. An entry is a re-encoded 256px JPEG, so
 * sixty-four of them is a little over a megabyte, and a long session still evicts
 * rather than grows.
 */
const COVER_KEEP = 64;
const COVER_THUMB_PX = 256;
/**
 * Tag reads in flight at once.
 *
 * Every row that comes near the screen calls `coverFor`, and the library's first
 * paint puts a dozen of them in the same frame. Each one is a file open plus a
 * header parse in the main process, so a burst that is not held back is a queue
 * nobody can see, and it is the queue the *playing* record's cover has to get
 * through. Three fill the visible rows inside a few frames while a flick waits its
 * turn behind them, which is a slower picture but never a slower list.
 */
const COVER_READERS = 3;
/** A cover, and the longest edge it was re-encoded to. See `coverFor`. */
interface StoredCover {
  url: string | null;
  px: number;
}
const covers = new Map<string, StoredCover>();
const coverJobs = new Map<string, { px: number; promise: Promise<string | null> }>();
let readersBusy = 0;
const readersQueued: Array<() => void> = [];

/** Take a slot at the shell's tag reader, or queue for the next one to free. */
function acquireReader(): Promise<void> {
  if (readersBusy < COVER_READERS) {
    readersBusy++;
    return Promise.resolve();
  }
  return new Promise((start) => readersQueued.push(start));
}

/**
 * Hand the slot to whoever queued for it rather than counting it down and back up,
 * so a queue cannot leapfrog itself into an unbounded burst the moment two reads
 * finish in the same tick.
 */
function releaseReader(): void {
  const next = readersQueued.shift();
  if (next) next();
  else readersBusy--;
}

/**
 * The cover already read for this file, at whatever size the first asker wanted.
 *
 * `null` means it was asked for and the file carries no picture; `undefined` means
 * nobody has asked yet. A row needs the difference, because painting the default
 * tile over an answer that is already on its way is the flash that reads as "the
 * artwork disappears on scroll".
 */
export function cachedCover(filePath: string): string | null | undefined {
  return covers.get(filePath)?.url;
}

/**
 * The cover for one file, re-encoded to no more than `maxPx`.
 *
 * Two askers want the same file at different sizes: a list tile is 36 CSS px and is
 * happy with 256, while the record behind the mini card and the backdrop want 512.
 * The answer is keyed on the file, so it remembers the size it stored and only goes
 * back to the disk when an asker wants *more* — otherwise the row that was looked at
 * first would leave the playing record painted with a thumbnail, and a disc that is
 * the soft, blocky one is exactly what the 512 cap above was written to keep out.
 */
export function coverFor(filePath: string, maxPx = COVER_THUMB_PX): Promise<string | null> {
  const known = covers.get(filePath);
  if (known && known.px >= maxPx) return Promise.resolve(known.url);
  const running = coverJobs.get(filePath);
  if (running && running.px >= maxPx) return running.promise;

  let settle: (url: string | null) => void = () => {};
  const promise = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  // Registered before the first await, so a second asker in the same tick finds it.
  coverJobs.set(filePath, { px: maxPx, promise });

  void (async () => {
    await acquireReader();
    let url: string | null = null;
    try {
      const streamed = await window.electronAPI?.readTags?.(filePath).catch(() => null);
      const picture = streamed?.picture;
      url = picture ? await pictureToDataUrl(picture.data, picture.mime, maxPx) : null;
    } finally {
      releaseReader();
    }
    /*
     * A read asked for 256 that finishes after the 512 the record wanted must not
     * put the smaller picture back on the shelf and call it the answer, and it must
     * not retire the job that is still running either — so both writes check that
     * they are the largest and the current thing to write.
     */
    const stored = covers.get(filePath);
    if (!stored || stored.px < maxPx) covers.set(filePath, { url, px: maxPx });
    if (coverJobs.get(filePath)?.promise === promise) coverJobs.delete(filePath);
    // Oldest first: a Map iterates in insertion order, so the first key that is not
    // this one is the stalest tile still being held.
    if (covers.size > COVER_KEEP) {
      for (const key of covers.keys()) {
        if (key === filePath) continue;
        covers.delete(key);
        break;
      }
    }
    settle(url);
  })();
  return promise;
}

/** A cover resampled down for one particular consumer, and the box it fills. */
export interface ShrunkCover {
  /**
   * What to hand to `drawImage`.
   *
   * Always an `HTMLCanvasElement` or an `HTMLImageElement`, never the
   * `ImageBitmap` that did the resampling. That is a measured rule, not tidiness:
   * the same 1903x982 blurred draw measured 79-97 ms from a canvas source and
   * 380-640 ms from an `ImageBitmap` source, because a bitmap under a canvas filter
   * loses Chromium's fast path and the whole surface comes back through software.
   * The bitmap is closed the instant it has been blitted, so it is a transient here
   * and never a resident one.
   */
  el: HTMLCanvasElement | HTMLImageElement;
  w: number;
  h: number;
}

/**
 * The cover in `art`, resampled to no more than `maxPx` on its longest edge.
 *
 * The wallpaper is the consumer that needed this. A cover is stored at 512 because a
 * disc and a now-playing card resolve that detail; the same bytes stretched across a
 * 1668 CSS px window behind an 18 px Gaussian are not, and every pixel between the
 * blur's own reach and the source's Nyquist limit is paid for twice — once decoded,
 * once as the destination the blur has to walk. Measured against the 512 source at
 * the app's own settings, a 430x512 cover costs the wallpaper 880 KB of decoded
 * bitmap and 129 KB of string to hold detail that the blur throws away.
 *
 * Shrinking is not free in the other direction either, and the number that decides
 * how far it may go is the *ratio* of one source texel, as painted, to the blur
 * radius — not a fixed size. Sweeping both across the range the settings actually
 * offer (0-64 px of blur on a 1668x861 CSS window) against the untouched 512 source,
 * and reporting the worst channel error over the middle of the frame:
 *
 *   texel/radius   mean |d|   max |d|   share of pixels over 6
 *      0.18          0.85        2          0%      <- 512 against 512: the floor
 *      0.31          0.88        3          0%      <- 298 px
 *      0.36          0.88        3          0%      <- 257 px
 *      0.44          1.26        7       0.056%     <- 209 px
 *      0.70          1.92       19        3.5%      <- 132 px
 *      0.97          2.77       18        9.5%      <-  96 px
 *
 * The floor is the first row: resampling 512 to 512 through the same Lanczos pass and
 * painting it twice already leaves a mean of 0.85, so 0.88 is not a difference, it is
 * the measurement looking at itself. From 0.36 down there is nothing left to see.
 * Above it the error climbs with the blur's failure to hide the texel grid, and by
 * 0.70 a 13 px texel is standing through an 18 px blur as a softness difference a
 * viewer can point at. So 0.3 is the constant: the last ratio that is measurably
 * indistinguishable from the source it replaced, at every blur the UI can be set to,
 * on the smallest source that achieves it.
 *
 * Which is also why this takes a size rather than picking one. The obvious 64-128 px
 * is right about the *bytes* and wrong about the *picture*: 128 px across 1668 CSS px
 * is a 13 px texel, and an 18 px blur only just covers it. Ask the same window for 4
 * px of blur and 128 px is a mosaic. The caller therefore derives `maxPx` from the
 * destination and the blur in force, and this clamps it at what was ever stored.
 *
 * A cover that already fits needs no resample, and gets none: returning the decoded
 * `<img>` keeps a 300px sleeve exactly as sharp as it arrived.
 *
 * `ceiling` lifts the 512 for callers that are not reading the cover cache. A
 * wallpaper the user picked is not bounded by what a sleeve needs, and behind a
 * zero blur the cap is the only thing softening it.
 */
export async function shrinkCoverTo(
  art: string,
  maxPx: number,
  ceiling: number = ART_MAX_PX,
): Promise<ShrunkCover | null> {
  const cap = Math.max(1, Math.min(maxPx, ceiling));
  const image = new Image();
  image.src = art;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('cover decode failed'));
    });
  } catch {
    return null;
  }
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (w <= 0 || h <= 0) return null;
  if (Math.max(w, h) <= cap) return { el: image, w, h };

  const scale = cap / Math.max(w, h);
  const to = { resizeWidth: Math.max(1, Math.round(w * scale)), resizeHeight: Math.max(1, Math.round(h * scale)) };
  try {
    // Resizing through createImageBitmap rather than drawImage puts the work on
    // Chromium's highest-quality resampler (a Lanczos-family filter), which is what
    // makes the result survive being blown back up to the window: a box downsample
    // here aliases, and behind a blur an alias is not noise, it is a colour that
    // was never in the artwork.
    const bitmap = await createImageBitmap(image, { ...to, resizeQuality: 'high' });
    const bw = bitmap.width;
    const bh = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = bw;
    canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { el: image, w, h };
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { el: canvas, w: bw, h: bh };
  } catch {
    // A resize the platform refused is not worth losing the backdrop over.
    return { el: image, w, h };
  }
}
