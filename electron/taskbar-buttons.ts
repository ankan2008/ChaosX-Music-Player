/**
 * Transport buttons on the app's own taskbar thumbnail — the buttons you get by
 * hovering the taskbar icon, the same surface Spotify and the Windows media
 * player use.
 *
 * Everything here is the route that a throwaway spike had to prove first,
 * because a koffi argument-marshalling failure calls `napi_fatal_error`, which is
 * a native abort that no try/catch in the app can intercept. The spike is at
 * `%TEMP%\sc-pill\spike70app`; what it settled, in order:
 *
 * - `CoCreateInstance` succeeds when every pointer is passed as a plain 64-bit
 *   integer. Passing koffi allocations or Buffers through `void*`/`void**`
 *   parameters is what aborted the earlier attempt.
 * - A vtable slot is called with `koffi.call(address, koffi.proto(decl), ...)`.
 *   There is no module-level `koffi.func`, and a number handed to `lib.func()` is
 *   a PE *ordinal*, not an address.
 * - `ThumbBarAddButtons(HWND, UINT, THUMBBUTTON*)` takes the window as its first
 *   real parameter. Leaving it out answers `0x80070057` (E_INVALIDARG).
 * - `HrInit` is called first; the interface is documented as needing it.
 *
 * The glyphs are drawn here rather than shipped as assets: a thumbnail button
 * wants a flat monochrome mark at 24 px, and hand-rolling a 32-bit ICO keeps the
 * whole feature in one file with nothing to build.
 */
import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';

const WM_COMMAND = 0x0111;
const THB_ICON = 0x0002;
const THB_TOOLTIP = 0x0004;
const THB_FLAGS = 0x0008;
const THBF_ENABLED = 0x0000;
const THBF_DISMISSONCLICK = 0x0002;

/**
 * Button ids. The low word of `wParam` on the WM_COMMAND the shell sends back.
 * Windows caps the thumbnail at seven buttons; five leaves room to grow.
 */
export const THUMB = {
  previous: 4100,
  playPause: 4101,
  next: 4102,
  back5: 4103,
  forward5: 4104,
} as const;

/** Icon side in pixels, and the record stride the shell expects on x64. */
const SIDE = 24;
/** The vtable slot's signature: `this`, then (HWND, count, THUMBBUTTON*). */
const THUMB_OP = 'long __stdcall ThumbOp(uint64 self, uint64 hwnd, uint32_t count, uint64 buttons)';
/*
 * THUMBBUTTON, exactly as commctrl.h declares it:
 *   DWORD dwMask; UINT iId; UINT iBitmap; HICON hIcon; WCHAR szTip[260]; DWORD dwFlags;
 *
 * The tip is **260** WCHARs, not 264 — the number that circulates online. On x64
 * the HICON after three 4-byte fields forces 8-byte alignment, so the tip starts
 * at 24, dwFlags sits at 544, and the record is 552 bytes.
 *
 * Getting this wrong is invisible on the first button and fatal on the rest: the
 * shell walks the array at its stride while the caller walks it at theirs, so
 * record 0 lines up perfectly and every record after it is read 8 bytes off —
 * garbage `hIcon`, garbage tooltip. That is exactly the "only the leftmost button
 * has a glyph" symptom this comment exists to prevent a second time.
 */
const TIP_CHARS = 260;
const OFF = { mask: 0, id: 4, bitmap: 8, icon: 16, tip: 24, flags: 24 + TIP_CHARS * 2 };
const STRIDE = Math.ceil((OFF.flags + 4) / 8) * 8;

type Glyph = 'previous' | 'play' | 'pause' | 'next' | 'back5' | 'forward5';

/**
 * A triangle with its apex at `apexX` on the centre line and its flat base at
 * `baseX`, `half` tall at the base.
 *
 * The span is signed on purpose. Taking `min`/`max` of the two ends and growing
 * left to right makes every mark point the same way regardless of which end was
 * meant to be the apex — which is exactly the bug the first version of this
 * helper had, and it only showed up when the glyphs were rendered and looked at.
 */
function triangle(cx: number, cy: number, apexX: number, baseX: number, half: number): boolean {
  const span = baseX - apexX;
  if (span === 0) return false;
  const t = (cx - apexX) / span;
  if (t < 0 || t > 1) return false;
  return Math.abs(cy) <= half * t;
}

/**
 * Whether (x, y) is inked in a 24 px glyph, y measured from the top.
 *
 * Drawn as predicates rather than bitmaps so the shapes stay crisp at the size
 * they are actually used at, and so adding one is one line instead of an asset.
 */
function inked(glyph: Glyph, x: number, y: number): boolean {
  const cy = y - (SIDE - 1) / 2;
  const cx = x - (SIDE - 1) / 2;
  switch (glyph) {
    // ▶ — apex on the right, base on the left.
    case 'play':
      return triangle(cx, cy, 6, -5, 6.5);
    case 'pause':
      return (Math.abs(cx - 3.5) <= 1.8 || Math.abs(cx + 3.5) <= 1.8) && Math.abs(cy) <= 6.5;
    // ◀ with a bar on the left: "go to the start of the previous track".
    case 'previous':
      return Math.abs(cx + 6.5) <= 1.4 || triangle(cx, cy, -3, 5, 6.5);
    case 'next':
      return Math.abs(cx - 6.5) <= 1.4 || triangle(cx, cy, 3, -5, 6.5);
    case 'back5':
      return triangle(cx, cy, -8, 0, 5) || triangle(cx, cy, 0, 8, 5);
    case 'forward5':
      return triangle(cx, cy, 0, -8, 5) || triangle(cx, cy, 8, 0, 5);
  }
}

/**
 * A single-image ICO: ICONDIR, one directory entry, a BITMAPINFOHEADER whose
 * height is doubled (the second half is the AND mask), the BGRA pixels bottom-up,
 * then a fully transparent AND mask.
 */
function icoFor(glyph: Glyph): Buffer {
  const pixels = Buffer.alloc(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y++) {
    for (let x = 0; x < SIDE; x++) {
      const on = inked(glyph, x, y);
      /*
       * Bottom-up rows, BGRA. A DIB icon's colour is premultiplied by its alpha, so
       * an uninked pixel has to be black-transparent rather than white-transparent:
       * leaving colour in a pixel nobody should see is exactly how a button ends up
       * painted as a blank light square instead of a glyph.
       */
      const o = ((SIDE - 1 - y) * SIDE + x) * 4;
      pixels.writeUInt8(on ? 245 : 0, o);
      pixels.writeUInt8(on ? 245 : 0, o + 1);
      pixels.writeUInt8(on ? 248 : 0, o + 2);
      pixels.writeUInt8(on ? 255 : 0, o + 3);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(SIDE, 4);
  header.writeInt32LE(SIDE * 2, 8); // XOR image plus AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const mask = Buffer.alloc(SIDE * 4); // 24 bits per row, padded to 32
  const image = Buffer.concat([header, pixels, mask]);
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry.writeUInt8(SIDE, 0);
  entry.writeUInt8(SIDE, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([dir, entry, image]);
}

interface ThumbButton {
  glyph: Glyph;
  id: number;
  tip: string;
}

let koffiRef: any = null;
let loaded = false;
let api: {
  koffi: any;
  CoCreateInstance: any;
  CoInitializeEx: any;
  loadIcon: any;
  call: any;
  proto: any;
  decode: any;
  address: any;
  alloc: any;
} | null = null;
let taskbar: unknown = null;
let icons = new Map<Glyph, number>();
let hwndValue = 0;
let window: BrowserWindow | null = null;
let lastPlaying: boolean | null = null;

function loadApi(): boolean {
  if (loaded) return api !== null;
  loaded = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const ole32 = koffi.load('ole32.dll');
    const user32 = koffi.load('user32.dll');
    koffiRef = koffi;
    api = {
      koffi,
      // Every pointer is an integer: see the header comment.
      CoInitializeEx: ole32.func('long CoInitializeEx(uint64 reserved, uint32_t model)'),
      CoCreateInstance: ole32.func(
        'long CoCreateInstance(uint64 rclsid, uint64 outer, uint32_t ctx, uint64 iid, uint64 ppv)',
      ),
      /*
       * `char16_t*` is the type koffi accepts a JS string for; `uint16_t*` answers
       * "Unexpected String value", and a plain number is only right for
       * MAKEINTRESOURCE, which would make LR_LOADFROMFILE read a garbage path.
       */
      loadIcon: user32.func(
        'void* LoadImageW(uint64 hInst, char16_t* name, uint32_t type, uint32_t cx, uint32_t cy, uint32_t flags)',
      ),
      call: koffi.call,
      proto: koffi.proto,
      decode: koffi.decode,
      address: koffi.address,
      alloc: koffi.alloc,
    };
    return true;
  } catch (e) {
    console.warn('[thumbbar] koffi unavailable:', (e as Error).message);
    api = null;
    return false;
  }
}

/** GUIDs as the 16 bytes COM reads, first three fields little-endian. */
function guidBytes(hex: string): Buffer {
  const s = hex.replace(/-/g, '');
  const out = Buffer.alloc(16);
  out.writeUInt32LE(parseInt(s.slice(0, 8), 16), 0);
  out.writeUInt16LE(parseInt(s.slice(8, 12), 16), 4);
  out.writeUInt16LE(parseInt(s.slice(12, 16), 16), 6);
  Buffer.from(s.slice(16, 32), 'hex').copy(out, 8);
  return out;
}

const CLSID_TASKBARLIST = guidBytes('56fdf344-fd6d-11d0-958a-006097c9a090');
const IID_ITASKBARLIST3 = guidBytes('ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf');

/** IUnknown 3, ITaskbarList 5, ITaskbarList2 1, then ITaskbarList3's own order. */
const SLOT = { hrInit: 3, addButtons: 3 + 5 + 1 + 6, updateButtons: 3 + 5 + 1 + 7 };

function loadIcons(): Map<Glyph, number> {
  if (!api) return icons;
  if (icons.size) return icons;
  const dir = path.join(app.getPath('temp'), 'silent-chaos-thumbbar');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return icons;
  }
  const IMAGE_ICON = 1;
  const LR_LOADFROMFILE = 0x10;
  const LR_SHARED = 0x8000;
  const glyphs: Glyph[] = ['previous', 'play', 'pause', 'next', 'back5', 'forward5'];
  for (const glyph of glyphs) {
    const file = path.join(dir, `${glyph}.ico`);
    try {
      // LoadImageW reads from the filesystem, so an asar path is not enough.
      fs.writeFileSync(file, icoFor(glyph));
      const h = api.address(
        api.loadIcon(0, file, IMAGE_ICON, SIDE, SIDE, LR_LOADFROMFILE | LR_SHARED),
      );
      if (h) icons.set(glyph, h);
      else console.warn('[thumbbar] LoadImageW returned no icon for', glyph);
    } catch (e) {
      console.warn('[thumbbar] icon', glyph, 'failed:', (e as Error).message);
    }
  }
  /*
   * One line per load, with the handle values. Three of the first four buttons
   * came back blank in the shell while the icon files themselves decoded
   * correctly, so the handles are the only place left to look — and a repeated or
   * zero handle is the answer.
   */
  console.log('[thumbbar] icons', glyphs.map((g) => `${g}=${icons.get(g) ?? 'NONE'}`).join(' '));
  return icons;
}

/**
 * Left to right, the same order the in-app transport row uses, so the thumbnail
 * reads as the same control set rather than a rearranged one.
 */
function buttons(playing: boolean): ThumbButton[] {
  return [
    { glyph: 'previous', id: THUMB.previous, tip: 'Previous track' },
    { glyph: 'back5', id: THUMB.back5, tip: 'Back 5 seconds' },
    { glyph: playing ? 'pause' : 'play', id: THUMB.playPause, tip: playing ? 'Pause' : 'Play' },
    { glyph: 'forward5', id: THUMB.forward5, tip: 'Forward 5 seconds' },
    { glyph: 'next', id: THUMB.next, tip: 'Next track' },
  ];
}

function write(buttons: ThumbButton[]): { buf: Buffer; addr: number } | null {
  if (!api) return null;
  const map = loadIcons();
  const buf = Buffer.alloc(STRIDE * buttons.length);
  buttons.forEach((b, i) => {
    const o = i * STRIDE;
    buf.writeUInt32LE(THB_ICON | THB_TOOLTIP | THB_FLAGS, o + OFF.mask);
    buf.writeUInt32LE(b.id, o + OFF.id);
    buf.writeUInt32LE(0, o + OFF.bitmap);
    buf.writeBigUInt64LE(BigInt(map.get(b.glyph) ?? 0), o + OFF.icon);
    buf.writeUInt32LE(THBF_ENABLED | THBF_DISMISSONCLICK, o + OFF.flags);
    for (let c = 0; c < b.tip.length; c++) {
      buf.writeUInt16LE(b.tip.charCodeAt(c), o + OFF.tip + c * 2);
    }
  });
  return { buf, addr: api.address(buf) };
}

/**
 * Built once and reused. `koffi.proto` registers the name it parses globally, so
 * a second call with the same declaration throws "Duplicate type name" — which it
 * did, on the second button call of the first run.
 */
let thumbProto: unknown = null;
function proto(a: NonNullable<typeof api>) {
  if (!thumbProto) thumbProto = a.proto(THUMB_OP);
  return thumbProto;
}

function invoke(slot: number, count: number, addr: number): number {
  if (!api || !taskbar) return 1;
  const fnProto = proto(api);
  const self = api.address(taskbar as object);
  const vtable = api.decode(taskbar as object, 'void*');
  const slots = api.decode(vtable, 'uint64[24]');
  return api.call(Number(slots[slot]), fnProto, self, hwndValue, count, addr) >>> 0;
}

/** Push the current transport state into the thumbnail. Safe to call often. */
export function setThumbPlaying(playing: boolean): void {
  if (!api || !taskbar || !hwndValue) return;
  currentPlaying = playing;
  if (lastPlaying === playing) return;
  lastPlaying = playing;
  const written = write(buttons(playing));
  if (!written) return;
  const hr = invoke(SLOT.updateButtons, buttons(playing).length, written.addr);
  if (hr !== 0) console.warn('[thumbbar] update -> 0x' + hr.toString(16));
}

let currentPlaying = false;

/**
 * A PNG wrapped in the single-image ICO container the shell will accept from
 * `LoadImageW`. Vista onwards an ICO entry may hold a whole PNG rather than a
 * DIB, which means the page's rasterised glyph can be handed over untouched —
 * no re-encoding, no 32-bit DIB assembly, no palette.
 */
function pngIco(png: Buffer): Buffer {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(32, 0);
  entry.writeUInt8(32, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([dir, entry, png]);
}

const GLYPHS: Glyph[] = ['previous', 'play', 'pause', 'next', 'back5', 'forward5'];

/**
 * Take the app's own icons, rasterised in the page, and put them on the buttons.
 *
 * The hand-drawn glyphs in `inked()` are only a fallback: they rhymed with the
 * app's marks without matching them, and the skip icons are a 270° ring with an
 * arrowhead and a literal "5", which is not a shape worth drawing twice. The
 * renderer already has the real art and a correct rasteriser, so it draws them
 * and this only has to wrap the PNG in an ICO and load it.
 */
export function applyThumbIcons(received: Record<string, string>): void {
  if (!api) return;
  const dir = path.join(app.getPath('temp'), 'silent-chaos-thumbbar');
  const IMAGE_ICON = 1;
  const LR_LOADFROMFILE = 0x10;
  const LR_SHARED = 0x8000;
  let changed = 0;
  for (const glyph of GLYPHS) {
    const b64 = received[glyph];
    if (!b64) continue;
    try {
      const file = path.join(dir, `${glyph}.ico`);
      fs.writeFileSync(file, pngIco(Buffer.from(b64, 'base64')));
      const h = api.address(api.loadIcon(0, file, IMAGE_ICON, 32, 32, LR_LOADFROMFILE | LR_SHARED));
      if (h) {
        icons.set(glyph, h);
        changed++;
      }
    } catch (e) {
      console.warn('[thumbbar] apply', glyph, 'failed:', (e as Error).message);
    }
  }
  if (!changed) return;
  // Force a re-push even if the transport state itself has not moved.
  lastPlaying = null;
  setThumbPlaying(currentPlaying);
  console.log(`[thumbbar] ${changed} app icons on the thumbnail`);
}

/**
 * Add the three buttons and start listening for their clicks.
 *
 * The click arrives as a plain `WM_COMMAND` on the window, so Electron's own
 * `hookWindowMessage` is enough to receive it — no subclassing, and no second
 * koffi callback that could abort the process. The command is forwarded to the
 * renderer, because the queue lives there and this window is only one of four
 * faces of the same player.
 */
export function initThumbButtons(win: BrowserWindow): void {
  if (!loadApi() || !api) return;
  window = win;
  try {
    hwndValue = api.address(api.decode(win.getNativeWindowHandle(), 'void*'));
    // Electron's main thread is already in an STA; S_FALSE (1) means exactly that.
    api.CoInitializeEx(0, 2);
    const ppv = api.alloc('void*', 1);
    const hr = api.CoCreateInstance(
      api.address(CLSID_TASKBARLIST), 0, 1 | 4, api.address(IID_ITASKBARLIST3), api.address(ppv),
    );
    if (hr !== 0) {
      console.warn('[thumbbar] CoCreateInstance -> 0x' + (hr >>> 0).toString(16));
      return;
    }
    taskbar = api.decode(ppv, 'void*');
    const init = invoke(SLOT.hrInit, 0, 0);
    if (init !== 0) {
      console.warn('[thumbbar] HrInit -> 0x' + init.toString(16));
      return;
    }
    const written = write(buttons(false));
    if (!written) return;
    const count = buttons(false).length;
    const added = invoke(SLOT.addButtons, count, written.addr);
    if (added !== 0) {
      console.warn('[thumbbar] ThumbBarAddButtons -> 0x' + added.toString(16));
      return;
    }
    lastPlaying = false;
    currentPlaying = false;

    win.hookWindowMessage(WM_COMMAND, (wParam: unknown) => {
      const id = lowWord(wParam);
      const action = ACTIONS[id];
      if (!action) return;
      win.webContents?.send('thumb:command', action);
    });
    console.log(`[thumbbar] ${count} transport buttons on the thumbnail`);
  } catch (e) {
    console.warn('[thumbbar] init failed:', (e as Error).message);
  }
}

/** id → what the renderer should do. Anything not listed is not ours. */
const ACTIONS: Record<number, 'prev' | 'next' | 'toggle' | 'back' | 'forward'> = {
  [THUMB.previous]: 'prev',
  [THUMB.playPause]: 'toggle',
  [THUMB.next]: 'next',
  [THUMB.back5]: 'back',
  [THUMB.forward5]: 'forward',
};

/**
 * The button id is the low word of `wParam`. Electron hands that over as a number
 * on some builds and as a little-endian pointer buffer on others, and reading it
 * wrong is a silently dead button, so both are taken apart here.
 */
function lowWord(v: unknown): number {
  if (typeof v === 'number') return v & 0xffff;
  if (typeof v === 'bigint') return Number(v & 0xffffn);
  if (Buffer.isBuffer(v) && v.length >= 2) return v.readUInt16LE(0);
  return 0;
}

export function disposeThumbButtons(): void {
  taskbar = null;
  window = null;
  icons = new Map();
  lastPlaying = null;
  void koffiRef;
}
