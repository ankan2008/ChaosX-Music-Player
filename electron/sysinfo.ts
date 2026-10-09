import { app, BrowserWindow, ipcMain } from 'electron';
import { execFile } from 'child_process';
import os from 'os';

/**
 * Machine telemetry for the Statistics page: battery, memory, processor.
 *
 * All of it is read in the main process because none of it is available in a
 * renderer — `os.cpus()` and `os.totalmem()` are Node APIs, and the battery is a
 * Windows call. The renderer gets one object on a one-second pump.
 *
 * The CPU figure is a *delta* between two `os.cpus()` samples. A single sample
 * reports counters since boot, so the percentage it implies is the average since
 * the machine started — which on a laptop that has not slept in a week is a
 * nearly flat line, and a flat line on a live meter reads as a broken meter.
 */

export interface SysInfo {
  /** Bytes. */
  ramTotal: number;
  ramUsed: number;
  /** Logical processors, from `os.cpus()`. */
  threads: number;
  /** Physical cores. Falls back to `threads` when the query fails. */
  cores: number;
  /** Threads that did measurable work in the last sample. */
  busyThreads: number;
  /** 0..1 across all threads. */
  load: number;
  /**
   * ChaosX itself, summed over every process it owns — main, the GPU process,
   * each window's renderer and the utility processes — as the private working set,
   * which is the same figure Task Manager prints for the app's group.
   *
   * The mpv processes are deliberately not in it. They are separate executables,
   * they appear as their own row in Task Manager, and folding them in would put
   * this number back out of step with the one the user is comparing it against.
   */
  appRam: number;
  /** 0..1 of the whole machine, so it can be read against `load` directly. */
  appLoad: number;
  battery: {
    present: boolean;
    /** 0..1, or null when Windows reports "unknown". */
    level: number | null;
    charging: boolean;
    /** Seconds of runtime left, when the OS volunteers it. */
    lifeSeconds: number | null;
  };
}

let api: {
  power: ((struct: unknown) => boolean) | null;
  alloc: (() => unknown) | null;
  decode: ((p: unknown) => { ACLineStatus: number; BatteryFlag: number; BatteryLifePercent: number; BatteryLifeTime: number }) | null;
} = { power: null, alloc: null, decode: null };

let triedKoffi = false;

function loadBattery(): void {
  if (triedKoffi) return;
  triedKoffi = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    koffi.struct('SYS_POWER_STATUS', {
      ACLineStatus: 'uint8',
      BatteryFlag: 'uint8',
      BatteryLifePercent: 'uint8',
      SystemStatusFlag: 'uint8',
      BatteryLifeTime: 'uint32',
      BatteryFullLifeTime: 'uint32',
    });
    const GetSystemPowerStatus = kernel32.func(
      'bool __stdcall GetSystemPowerStatus(SYS_POWER_STATUS*)',
    );
    api = {
      power: (s) => GetSystemPowerStatus(s),
      alloc: () => koffi.alloc('SYS_POWER_STATUS', 1),
      decode: (s) => koffi.decode(s, 'SYS_POWER_STATUS'),
    };
  } catch {
    // No battery call: the widget says so rather than inventing a number.
    api = { power: null, alloc: null, decode: null };
  }
}

let prev: Array<[number, number]> = [];

function sampleCpu(): { load: number; busyThreads: number } {
  const cpus = os.cpus();
  const now: Array<[number, number]> = cpus.map((c) => {
    const total = c.times.idle + c.times.user + c.times.sys + c.times.nice + c.times.irq;
    return [total - c.times.idle, total];
  });
  let busy = 0;
  let total = 0;
  let busyThreads = 0;
  if (prev.length === cpus.length) {
    for (let i = 0; i < cpus.length; i++) {
      const dt = now[i][1] - prev[i][1];
      const db = now[i][0] - prev[i][0];
      if (dt <= 0) continue;
      busy += db;
      total += dt;
      if (db / dt > 0.05) busyThreads++;
    }
  }
  prev = now;
  return { load: total > 0 ? Math.min(1, busy / total) : 0, busyThreads };
}

/**
 * Physical cores, asked of WMI once.
 *
 * `os.cpus()` lists logical processors, so on an eight-core machine with SMT it
 * says sixteen and the "cores" figure has nowhere to come from. The alternative
 * is `GetLogicalProcessorInformation` and hand-parsing a variable-length record
 * array over FFI, which is a lot of surface to get subtly wrong for one number
 * that never changes — so this asks the OS once, off the critical path, and
 * falls back to the thread count if the answer does not arrive.
 */
let cores: number | null = null;

function askCores(): void {
  if (cores !== null) return;
  const script =
    '(Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum';
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 6000 },
    (err, out) => {
      const n = Number(String(out).trim());
      cores = !err && Number.isFinite(n) && n > 0 ? n : os.cpus().length;
    },
  );
}

/**
 * What ChaosX itself costs, summed over every process it owns.
 *
 * The machine figure alone answers "is this laptop busy" and not the question the
 * page is actually for — "is *this app* doing it".
 *
 * The number has to be the *private* working set, which is what Task Manager
 * prints in its Memory column, and `getAppMetrics` does not carry it. Its
 * `workingSetSize` is the total working set, so every process's mapping of the
 * shared Electron image is counted once per process: measured on a five-process
 * session it reported 862 MB against Task Manager's 471 MB for the same group,
 * and the page therefore looked like a different app. `privateBytes` is no better —
 * that is private *commit*, which includes everything paged out, and it came to
 * 854 MB. Neither field is the one the user is reading in Task Manager.
 *
 * `K32GetProcessMemoryInfo` will give it, though not through the documented
 * struct: asked for 96 bytes rather than the published 80, it fills the extended
 * form and the `SIZE_T` at offset 80 is the private working set. Verified against
 * the `\\Process(*)\\Working Set - Private` performance counter over the same
 * seven processes — 508.0 MB from this call against 507.3 MB from the counter.
 * koffi is already loaded here for the battery, so this costs no new dependency.
 */
const QUERY_LIMITED = 0x1000 | 0x0400;
const PMC_EX2_BYTES = 96;
const PRIVATE_WS_OFFSET = 80;

let wsApi: {
  open: ((access: number, inherit: boolean, pid: number) => unknown) | null;
  read: ((handle: unknown, buffer: Buffer, size: number) => boolean) | null;
  close: ((handle: unknown) => boolean) | null;
  buffer: Buffer | null;
} = { open: null, read: null, close: null, buffer: null };

let triedWs = false;

function loadWorkingSetApi(): void {
  if (triedWs) return;
  triedWs = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    wsApi = {
      open: kernel32.func('void* __stdcall OpenProcess(uint32, bool, uint32)'),
      read: kernel32.func('bool __stdcall K32GetProcessMemoryInfo(void*, void*, uint32)'),
      close: kernel32.func('bool __stdcall CloseHandle(void*)'),
      buffer: Buffer.alloc(PMC_EX2_BYTES),
    };
  } catch {
    wsApi = { open: null, read: null, close: null, buffer: null };
  }
}

/** Private working set in bytes, or null when the call is unavailable. */
function privateWorkingSet(pid: number): number | null {
  const api = wsApi;
  if (!api.open || !api.read || !api.close || !api.buffer) return null;
  const handle = api.open(QUERY_LIMITED, false, pid);
  if (!handle) return null;
  try {
    api.buffer.writeUInt32LE(PMC_EX2_BYTES, 0);
    if (!api.read(handle, api.buffer, PMC_EX2_BYTES)) return null;
    const bytes = Number(api.buffer.readBigUInt64LE(PRIVATE_WS_OFFSET));
    return bytes > 0 ? bytes : null;
  } finally {
    api.close(handle);
  }
}

function sampleApp(threads: number): { ram: number; load: number } {
  let ram = 0;
  let cores = 0;
  try {
    loadWorkingSetApi();
    for (const m of app.getAppMetrics()) {
      // `percentCPUUsage` is of one core.
      cores += m.cpu?.percentCPUUsage ?? 0;
      const priv = privateWorkingSet(m.pid);
      // `workingSetSize` is what the shipped binary reports; the bundled d.ts is
      // stale and calls the same object `residentSet`.
      const shared = (m.memory as { workingSetSize?: number } | undefined)?.workingSetSize ?? 0;
      ram += priv !== null ? priv : shared * 1024;
    }
  } catch {
    return { ram: 0, load: 0 };
  }
  return { ram, load: Math.max(0, cores) / (100 * Math.max(1, threads)) };
}

function read(): SysInfo {
  const total = os.totalmem();
  const free = os.freemem();
  const threads = os.cpus().length;
  const { load, busyThreads } = sampleCpu();
  const mine = sampleApp(threads);
  askCores();

  let battery: SysInfo['battery'] = {
    present: false,
    level: null,
    charging: false,
    lifeSeconds: null,
  };
  loadBattery();
  if (api.power && api.alloc && api.decode) {
    try {
      const s = api.alloc();
      if (api.power(s)) {
        const st = api.decode(s);
        // 128 means "no system battery", and 255 in the percent field means unknown.
        const present = st.BatteryFlag !== 128;
        battery = {
          present,
          level: st.BatteryLifePercent <= 100 ? st.BatteryLifePercent / 100 : null,
          charging: st.ACLineStatus === 1,
          lifeSeconds: st.BatteryLifeTime !== 0xffffffff ? st.BatteryLifeTime : null,
        };
      }
    } catch {
      // Leave the reading absent rather than guess.
    }
  }

  return {
    ramTotal: total,
    ramUsed: total - free,
    threads,
    cores: cores ?? threads,
    busyThreads,
    load,
    appRam: mine.ram,
    appLoad: mine.load,
    battery,
  };
}

let pump: NodeJS.Timeout | null = null;

function broadcast(info: SysInfo): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('sysinfo:update', info);
  }
}

/** Register the IPC surface. Safe to call once, from `whenReady`. */
export function registerSysInfo(): void {
  askCores();
  ipcMain.handle('sysinfo:get', () => read());
  if (!pump) {
    pump = setInterval(() => {
      try {
        broadcast(read());
      } catch {
        // A failed sample leaves the last reading on screen.
      }
    }, 1000);
    // The meter should be live the moment the page opens, not one second later.
    broadcast(read());
  }
}
