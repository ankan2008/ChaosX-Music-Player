<p align="center">
  <img src="public/brand/wordmark.png" alt="ChaosX" height="72">
</p>

<h1 align="center">ChaosX — Mark x1.0</h1>

<p align="center">
  A liquid-glass music and video player built for the laptops nobody builds for.
</p>

<!-- ============================================================
     ADD YOUR SCREENSHOTS HERE
     Drop images into docs/screenshots/ and swap the lines below.
     Four that carry this app: the library, the fullscreen record,
     the pill docked to a screen edge, and the mini player.
     ============================================================ -->

<p align="center">
  <em>[ screenshot: the library, maximised ]</em>
</p>

---

## What it is

ChaosX plays the music and films already on your disk. There is no account, no store, no
streaming service and no telemetry — you pin a folder, it reads the tags off what is
inside, and that is the library.

It was written against a two-core, 6 GB machine, which is the reason it looks the way it
does and the reason it does not look like the rest of them. Every refracting surface is
drawn in a WebGL scene pass that is fed by a single blurred copy of the wallpaper, so the
glass bends what is actually behind it rather than a colour swatch standing in for it.
The whole interface is one renderer, and the memory it holds is measured rather than
hoped for.

## Five ways to wear it

| Mode | What it is |
| --- | --- |
| **Library** | the normal window — folders, playlists, search, statistics |
| **Fullscreen music** | the record filling the monitor, taskbar included, with the lyrics and the clock over it |
| **Mini** | a 250px floating card that sits above everything else you are doing |
| **Pill** | the transport as a capsule docked to a screen edge, expanding from the side it lives on |
| **Video** | films played through the page, so the glass bends the picture |

## What is in it

- **Library from pinned folders** — folders are directories, so they are never editable;
  playlists are the thing you build, and removing a song from one never touches your disk.
- **Two queues** — what is playing now, and what you are adding next, with drag reorder
  and autoscroll while you drag near an edge.
- **Lyrics** with per-line timing, line-by-line or all at once, and a way to stop
  highlighting a sheet that is out of sync. Fetched once per song and cached.
- **Video** through an embedded mpv surface, with pitch and speed control that hold up on
  a slow machine, and a film that takes the slot the lyric sheet was using.
- **Widgets** you can switch on and off independently in normal mode and in fullscreen: a
  clock, motivational quotes, a pomodoro hourglass, battery and system meters.
- **Statistics** — most played, last played, play counts that survive a restart, and a
  read of the app's own memory from the same counter Task Manager shows you.
- **Hardware media keys and SMTC**, claimed for the life of the app, so a touchpad gesture
  pauses a track even when the window is hidden or covered.
- **An equalizer, a waveform scrubber, shuffle that keeps a session order the queue can
  edit, and a repair button** that restarts the process with Chromium's cache cleared.

## Requirements

Windows 10 or 11, x64. The liquid glass needs WebGL 2, which every machine this targets
has; the acrylic backdrop needs Windows 11 and is skipped quietly where it is not there.

## Install

Grab the latest from [Releases](../../releases):

- **`ChaosX-1.0.0-Setup.exe`** — the installer. It asks where to put it, and adds a
  Start Menu and desktop shortcut.
- **`ChaosX-1.0.0-portable.exe`** — one file, no install. Run it from wherever you like;
  it keeps its settings and its library cache in your user profile, not next to itself.

Nothing is installed machine-wide and no administrator rights are asked for.

<!-- Optional: a line or two about what first run looks like, and a GIF of the
     setup wizard picking its first folder. -->

## Building from source

```bash
npm install
npm run dev      # the app, hot-reloading
npm run build    # typecheck, bundle, then package into release/
```

`npm run build` needs two things that are deliberately **not** in this repository:

**The player binaries.** `resources/mpv/mpv.exe` and `resources/ffmpeg/{ffmpeg,ffprobe}.exe`
are each larger than GitHub's 100 MB per-file limit, so they are fetched rather than
committed. Drop your own builds into those folders and the packager picks them up as
`extraResources`. Without them the app still runs and plays audio; video and the audio
filters that need ffmpeg are unavailable.

**The fonts.** See [`src/assets/fonts/README.md`](src/assets/fonts/README.md) — both faces
are licensed to whoever bought them. Without them the interface falls through to
`system-ui` and loses the look it was designed around.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` `→` | seek back / forward five seconds |
| `Ctrl+←` `Ctrl+→` | previous / next track |
| `↑` `↓` | volume |
| `M` | mute |
| `Shift+F` | fullscreen music — `Esc` leaves it |
| `Shift+P` | pill mode, again to close |
| `Shift+M` | mini player, again to close |
| `Esc` | close the open panel, or leave fullscreen |
| `Ctrl++` `Ctrl+-` | zoom the interface |

Every one of them is listed and rebindable on the Settings page.

## Privacy

ChaosX has no account and sends no analytics. The only network traffic it makes is a
lyrics lookup for the track you are playing, and the result is cached on disk. Your
library is a list of paths on your own machine.

## Credits

Built by [Ankan](https://github.com/ankan2008) ·
[@silentchaos_2008](https://www.instagram.com/silentchaos_2008/)

Runs on [Electron](https://www.electronjs.org/), [React](https://react.dev/),
[Vite](https://vite.dev/), [zustand](https://github.com/pmndrs/zustand),
[Tone.js](https://tonejs.github.io/), [music-metadata](https://github.com/Borewit/music-metadata),
[koffi](https://koffi.dev/) and [mpv](https://mpv.io/). The refracting glass is a port of
a liquid-glass shader.

## License

[MIT](LICENSE). The mpv and ffmpeg binaries, and the two typefaces, carry their own terms
and are not covered by it.
