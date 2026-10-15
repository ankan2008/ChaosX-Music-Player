/**
 * Asking Windows to pin ChaosX to the taskbar, using the API Windows provides
 * for exactly that.
 *
 * The route this replaced — writing a `ChaosX.lnk` into
 * `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar` — is a
 * Windows 10 era trick. Windows 11 reads its pinned items from a serialized blob
 * under `HKCU\...\Explorer\Taskband`, not from that folder, so the shortcut sat
 * there uncounted and the button never arrived. Nothing the app could report was
 * true: the file existed, so the switch said "On", and the taskbar said nothing.
 *
 * `Windows.UI.Shell.TaskbarManager` is the documented way. `RequestPinCurrentAppAsync`
 * raises the shell's own consent dialog and, if the user accepts, the button is
 * there immediately — no sign-out, no reboot, no lie. It is also the only way that
 * answers honestly, because `IsCurrentAppPinnedAsync` reads the real taskbar
 * instead of a folder.
 *
 * Three constraints come with it, all from the same page in the Microsoft docs:
 * the app must be in the foreground when the request is made, it must have a Start
 * menu entry, and the call must come from a UI thread. Electron's main process is
 * the UI thread that owns the window, and the NSIS install writes the Start menu
 * shortcut, so `main.ts` focuses the window first and this file only does the call.
 *
 * There is no matching unpin. Windows deliberately gives an app no right to remove
 * its own taskbar button, so `requestTaskbarPin` is one-directional by design and
 * the caller has to say so rather than pretend the switch can go back.
 *
 * Everything here is koffi over the raw COM/WinRT ABI, in the same shape as
 * `taskbar-buttons.ts`: pointers as plain integers, vtable slots through
 * `koffi.call`, and unique prototype names because `koffi.proto` registers the name
 * it parses globally. The interface IIDs are the ones in the Windows SDK's own
 * `windows.ui.shell.h`; the closed `IAsyncOperation<bool>` IID is not spelled out in
 * any header, so it was read off a live operation with `GetIids` and confirmed by a
 * successful `QueryInterface` plus a `GetResults` that returned a sane bool.
 */

/** Windows.UI.Shell — see windows.ui.shell.h. */
const IID_INSPECTABLE = 'af86e2e0-b12d-4c6a-9c5a-d7aa65101e90';
const IID_TASKBAR_MANAGER_STATICS = 'db32ab74-de52-4fe6-b7b6-95ff9f8395df';
/** Present only on builds that let an unpackaged desktop app pin at all. */
const IID_DESKTOP_APP_SUPPORT = 'cdfefd63-e879-4134-b9a7-8283f05f9480';
/** Windows.Foundation, both measured off the operation rather than guessed. */
const IID_ASYNC_INFO = '00000036-0000-0000-c000-000000000046';
const IID_ASYNC_OPERATION_BOOL = 'cdb5efb3-5788-509d-9be1-71ccb8a3362a';

/** IUnknown's three, then IInspectable's three, sit under every method below. */
const SLOT_QI = 0;
const SLOT_GET_DEFAULT = 6;
const SLOT_IS_SUPPORTED = 6;
const SLOT_IS_PINNING_ALLOWED = 7;
const SLOT_IS_PINNED_ASYNC = 8;
const SLOT_REQUEST_PIN_ASYNC = 10;
const SLOT_ASYNC_STATUS = 7;
const SLOT_ASYNC_RESULTS = 8;

/** `AsyncStatus`: 0 is Started, and anything else means the dialog is answered. */
const STATUS_STARTED = 0;
/** A person reads a permission prompt at their own pace. */
const PIN_ANSWER_TIMEOUT_MS = 5 * 60_000;

export interface PinOutcome {
  /**
   * - `pinned` — Windows asked, the user accepted, the button is on the bar.
   * - `declined` — the dialog was raised and answered no. Nothing else may write a
   *   pin: the user has just refused one.
   * - `not-allowed` — the shell will not even offer. Its own page lists the reasons
   *   as a group policy, a window that is not in the foreground, and an app with no
   *   Start menu entry, and the three are indistinguishable from here.
   * - `unsupported` — this Windows build does not answer a desktop app at all.
   */
  outcome: 'pinned' | 'declined' | 'not-allowed' | 'unsupported';
  /** Why, in the shell's terms. */
  error?: string;
}

type Koffi = any;

interface Bindings {
  koffi: Koffi;
  RoGetActivationFactory: (classId: number, iid: number, factory: number) => number;
  WindowsCreateString: (text: string, length: number, out: number) => number;
  /** Every out-parameter is a Buffer, passed as its address. */
  guid: (hex: string) => Buffer;
  proto: Record<'qi' | 'one' | 'boolProp' | 'asyncOp' | 'status' | 'results', unknown>;
  call: (self: unknown, index: number, proto: unknown, ...args: number[]) => number;
}

let bindings: Bindings | null = null;
let tried = false;
/** The `ITaskbarManager` factory object, kept for the life of the process. */
let manager: unknown = null;
/** Remembered so a build without the API is not re-probed every time Settings opens. */
let managerTried = false;

function loadBindings(): Bindings | null {
  if (tried) return bindings;
  tried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const combase = koffi.load('combase.dll');
    const RoGetActivationFactory = combase.func(
      'long RoGetActivationFactory(uint64 classId, uint64 iid, uint64 factory)',
    );
    const WindowsCreateString = combase.func(
      'long WindowsCreateString(char16_t* source, uint32_t length, uint64 out)',
    );
    /*
     * `RoInitialize` on Electron's main thread answers RPC_E_CHANGED_MODE, because
     * the thread is already initialized as an STA by Chromium. That is the accepted
     * state for this API, not a fault, so the answer is dropped.
     */
    try {
      combase.func('long RoInitialize(uint32_t initType)')(1);
    } catch {
      /* A build without the entry point simply has no WinRT to reach. */
    }

    const proto = {
      qi: koffi.proto('long PinQI(uint64 self, uint64 riid, uint64 ppv)'),
      one: koffi.proto('long PinGetDefault(uint64 self, uint64 out)'),
      boolProp: koffi.proto('long PinBoolProp(uint64 self, uint64 out)'),
      asyncOp: koffi.proto('long PinAsyncOp(uint64 self, uint64 out)'),
      status: koffi.proto('long PinAsyncStatus(uint64 self, uint64 out)'),
      results: koffi.proto('long PinGetResults(uint64 self, uint64 out)'),
    };

    bindings = {
      koffi,
      RoGetActivationFactory: (a, b, c) => RoGetActivationFactory(a, b, c) >>> 0,
      WindowsCreateString: (t, n, o) => WindowsCreateString(t, n, o) >>> 0,
      guid: (hex) => {
        const s = hex.replace(/-/g, '');
        const b = Buffer.alloc(16);
        b.writeUInt32LE(parseInt(s.slice(0, 8), 16), 0);
        b.writeUInt16LE(parseInt(s.slice(8, 12), 16), 4);
        b.writeUInt16LE(parseInt(s.slice(12, 16), 16), 6);
        Buffer.from(s.slice(16, 32), 'hex').copy(b, 8);
        return b;
      },
      proto,
      call: (self, index, p, ...args) => {
        const address = koffi.address(self);
        const vtable = koffi.decode(self, 'void*');
        const slots = koffi.decode(vtable, 'uint64[16]');
        return koffi.call(Number(slots[index]), p, address, ...args) >>> 0;
      },
    };
    return bindings;
  } catch (e) {
    console.warn('[taskbar-pin] koffi unavailable:', (e as Error).message);
    bindings = null;
    return null;
  }
}

function outBytes(bytes = 8) {
  const buf = Buffer.alloc(bytes);
  return { buf, addr: bindings!.koffi.address(buf) };
}

function queryInterface(obj: unknown, iidHex: string): { hr: number; ptr: unknown } {
  const b = bindings!;
  const guid = b.guid(iidHex);
  const slot = outBytes();
  const hr = b.call(obj, SLOT_QI, b.proto.qi, b.koffi.address(guid), slot.addr);
  return { hr, ptr: hr === 0 ? b.koffi.decode(slot.buf, 'void*') : null };
}

function getManager(): unknown {
  if (manager) return manager;
  if (managerTried) return null;
  managerTried = true;
  const b = bindings;
  if (!b) return null;

  const className = 'Windows.UI.Shell.TaskbarManager';
  const h = outBytes();
  if (b.WindowsCreateString(className, className.length, h.addr) !== 0) return null;
  const classId = Number(h.buf.readBigUInt64LE(0));

  const fo = outBytes();
  if (b.RoGetActivationFactory(classId, b.koffi.address(b.guid(IID_INSPECTABLE)), fo.addr) !== 0) {
    return null;
  }
  const factory = b.koffi.decode(fo.buf, 'void*');

  /*
   * The marker interface is the documented test for whether this build will let a
   * desktop app pin at all. Older Windows 11 answers E_NOINTERFACE here, and every
   * call below would then be noise, so the whole route switches itself off and the
   * caller falls back to writing the shortcut.
   */
  if (queryInterface(factory, IID_DESKTOP_APP_SUPPORT).hr !== 0) return null;

  const statics = queryInterface(factory, IID_TASKBAR_MANAGER_STATICS);
  if (!statics.ptr) return null;

  const doff = outBytes();
  if (b.call(statics.ptr, SLOT_GET_DEFAULT, b.proto.one, doff.addr) !== 0) return null;
  manager = b.koffi.decode(doff.buf, 'void*');
  return manager;
}

/** Drives an `IAsyncOperation<bool>` to completion and reads its answer. */
async function awaitBool(op: unknown): Promise<boolean | null> {
  const b = bindings!;
  const info = queryInterface(op, IID_ASYNC_INFO);
  const typed = queryInterface(op, IID_ASYNC_OPERATION_BOOL);
  if (!typed.ptr) return null;

  if (info.ptr) {
    const deadline = Date.now() + PIN_ANSWER_TIMEOUT_MS;
    for (;;) {
      const status = outBytes(4);
      if (b.call(info.ptr, SLOT_ASYNC_STATUS, b.proto.status, status.addr) !== 0) break;
      if (status.buf.readUInt32LE(0) !== STATUS_STARTED) break;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  const res = outBytes(4);
  if (b.call(typed.ptr, SLOT_ASYNC_RESULTS, b.proto.results, res.addr) !== 0) return null;
  return res.buf[0] !== 0;
}

function boolProp(index: number): boolean | null {
  const b = bindings!;
  const out = outBytes(4);
  if (b.call(getManager(), index, b.proto.boolProp, out.addr) !== 0) return null;
  return out.buf[0] !== 0;
}

/**
 * Whether Windows will let this app ask, and whether it is already on the bar.
 *
 * `allowed` is the answer to "would the prompt appear", and it is false for a
 * group policy that bans pinning as readily as for a window that is not in the
 * foreground — so it gates the offer, and never explains more than it knows.
 */
export async function taskbarPinState(): Promise<{
  available: boolean;
  allowed: boolean;
  pinned: boolean | null;
}> {
  if (process.platform !== 'win32' || !loadBindings()) {
    return { available: false, allowed: false, pinned: null };
  }
  try {
    if (!getManager()) return { available: false, allowed: false, pinned: null };
    const allowed = boolProp(SLOT_IS_PINNING_ALLOWED) === true;
    const supported = boolProp(SLOT_IS_SUPPORTED) === true;
    if (!supported) return { available: false, allowed: false, pinned: null };
    const b = bindings!;
    const ao = outBytes();
    if (b.call(manager, SLOT_IS_PINNED_ASYNC, b.proto.asyncOp, ao.addr) !== 0) {
      return { available: true, allowed, pinned: null };
    }
    const op = b.koffi.decode(ao.buf, 'void*');
    const pinned = op ? await awaitBool(op) : null;
    /*
     * Once per session, and only in the log. Whether the shell will let an app pin
     * is a property of the build, the group policy and the window's focus, and a
     * report that says "the pin did not take" cannot be read without knowing all
     * three.
     */
    console.log(
      `[taskbar-pin] allowed=${allowed} pinned=${pinned === null ? 'unknown' : pinned}`,
    );
    return { available: true, allowed, pinned };
  } catch (e) {
    console.warn('[taskbar-pin] state failed:', (e as Error).message);
    return { available: false, allowed: false, pinned: null };
  }
}

/**
 * Raise the shell's prompt and wait for the answer.
 *
 * Call this only while the window is in the foreground: the shell checks, and a
 * denied request is indistinguishable from a dismissed dialog.
 */
export async function requestTaskbarPin(): Promise<PinOutcome> {
  if (process.platform !== 'win32') return { outcome: 'unsupported', error: 'not windows' };
  if (!loadBindings()) return { outcome: 'unsupported', error: 'koffi is not installed' };
  try {
    if (!getManager()) {
      return { outcome: 'unsupported', error: 'this Windows build does not let apps pin themselves' };
    }
    if (boolProp(SLOT_IS_PINNING_ALLOWED) !== true) {
      return { outcome: 'not-allowed', error: 'taskbar pinning is turned off on this PC' };
    }
    const b = bindings!;
    const ao = outBytes();
    const hr = b.call(manager, SLOT_REQUEST_PIN_ASYNC, b.proto.asyncOp, ao.addr);
    if (hr !== 0) {
      return { outcome: 'not-allowed', error: 'the shell refused the request (0x' + hr.toString(16) + ')' };
    }
    const op = b.koffi.decode(ao.buf, 'void*');
    if (!op) return { outcome: 'not-allowed', error: 'the shell returned no request' };
    const answer = await awaitBool(op);
    if (answer === null) {
      return { outcome: 'declined', error: 'the request was not answered' };
    }
    return answer
      ? { outcome: 'pinned' }
      : { outcome: 'declined', error: 'the pin was declined in the Windows dialog' };
  } catch (e) {
    return { outcome: 'not-allowed', error: String(e) };
  }
}
