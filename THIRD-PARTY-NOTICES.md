# Third-Party Notices & Dependencies

ChaosX **Mark x1.0** is original work, but it stands on a lot of other people's software.
This file records every third-party component the application actually uses at runtime,
the tools that build it, and the assets shipped inside it — with author names and links,
so credit goes where credit is due.

The project's own [MIT licence](LICENSE) covers only ChaosX's source. It does **not**
relicense any component below; each keeps its own terms.

Versions are those installed for, or bundled with, Mark x1.0.

---

## 1. Runtime dependencies

These ship inside the application.

| Library | Version | Licence | Author / maintainer | Link |
| --- | --- | --- | --- | --- |
| React | 18.3.1 | MIT | Meta Open Source | [react.dev](https://react.dev/) · [facebook/react](https://github.com/facebook/react) |
| React DOM | 18.3.1 | MIT | Meta Open Source | [react.dev](https://react.dev/) · [facebook/react](https://github.com/facebook/react) |
| zustand | 4.5.7 | MIT | Paul Henschel · [pmndrs](https://pmndrs.com/) | [github.com/pmndrs/zustand](https://github.com/pmndrs/zustand) |
| Tone.js | 15.1.22 | MIT | Yotam Mann | [tonejs.github.io](https://tonejs.github.io/) · [yotammann.info](https://yotammann.info/) |
| music-metadata | 10.9.1 | MIT | Borewit | [github.com/Borewit/music-metadata](https://github.com/Borewit/music-metadata) |
| koffi | 3.3.1 | MIT | Niels Martignène | [koffi.dev](https://koffi.dev/) · [koromix.dev](https://koromix.dev/) |
| SoundTouchJS (`@soundtouchjs/audio-worklet`) | 2.1.1 | MPL-2.0 | Steve 'Cutter' Blades | [github.com/cutterbl/SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) |
| html-to-image | 1.11.13 | MIT | bubkoo | [github.com/bubkoo/html-to-image](https://github.com/bubkoo/html-to-image) |

- **SoundTouchJS** is a JavaScript port of **SoundTouch**, the C++ audio time-and-pitch
  stretching library by **Olli Parviainen** (LGPL-2.1-or-later) — the engine behind
  ChaosX's speed and pitch controls. [sndpth.com](https://www.sndpth.com/) ·
  [github.com/cutterbl/SoundTouchJS](https://github.com/cutterbl/SoundTouchJS)
- **koffi** is what lets ChaosX call Win32 APIs directly (window styles, taskbar,
  memory counters) without a compiled native addon.

### 1.1 Transitive runtime packages

Pulled in by the libraries above; each is redistributed inside the app bundle.

| Package | Licence | Author |
| --- | --- | --- |
| `@babel/runtime` 7.29.7 | MIT | The Babel Team — [babel.dev](https://babel.dev/) |
| `@sec-ant/readable-stream` 0.4.1 | MIT | Ze-Zheng Wu — [github.com/Sec-ant](https://github.com/Sec-ant) |
| `automation-events` 7.1.19 | MIT | Christoph Guttandin — [github.com/chrisguttandin](https://github.com/chrisguttandin) |
| `standardized-audio-context` 25.3.77 | MIT | Christoph Guttandin |
| `content-type` 1.0.5 · `media-typer` 1.1.1 | MIT | Douglas Christopher Wilson — [jshttp](https://github.com/jshttp) |
| `csstype` 3.2.3 | MIT | Fredrik Nicol — [github.com/frenic](https://github.com/frenic) |
| `debug` 4.4.3 | MIT | Josh Junon — [github.com/qix-](https://github.com/qix-) |
| `ms` 2.1.3 | MIT | Tj Holowaychuk / Vercel — [github.com/vercel/ms](https://github.com/vercel/ms) |
| `file-type` 19.6.0 | MIT | Sindre Sorhus — [sindresorhus.com](https://sindresorhus.com) |
| `is-stream` 4.0.1 | MIT | Sindre Sorhus |
| `uint8array-extras` 1.5.0 | MIT | Sindre Sorhus |
| `ieee754` 1.2.1 | BSD-3-Clause | Feross Aboukhadijeh — [feross.org](https://feross.org) |
| `js-tokens` 4.0.0 | MIT | Simon Lydell — [github.com/lydell](https://github.com/lydell) |
| `link` 2.1.2 | MIT | Hiroki Osame — [privatenumber.dev](https://privatenumber.dev) |
| `loose-envify` 1.4.0 | MIT | Andres Suarez — [github.com/zertosh](https://github.com/zertosh) |
| `peek-readable` 5.4.2 · `strtok3` 10.3.5 · `token-types` 6.1.2 · `@tokenizer/token` 0.3.0 · `@borewit/text-codec` 0.2.2 | MIT | Borewit |
| `@soundtouchjs/core` · `@soundtouchjs/worklet-base` · `@soundtouchjs/interpolation-strategy-lanczos` 2.1.1 | MPL-2.0 | Steve 'Cutter' Blades |
| `scheduler` 0.23.2 · `use-sync-external-store` 1.7.0 | MIT | Meta Open Source |
| `tslib` 2.8.1 | 0BSD | Microsoft Corporation |
| `@koromix/koffi-win32-x64` 3.3.1 | MIT | Niels Martignène — the only one of 21 published platform builds that ChaosX ships |

Type declarations (build-time only): `@types/react` 18.3.31, `@types/react-dom` 18.3.7,
`@types/prop-types` 15.7.15 — all MIT, written and maintained by the contributors of
[DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped), administered by
[TypeStrong](https://github.com/TypeStrong).

---

## 2. Build tooling

Not redistributed; listed because the project would not exist without them.

| Tool | Version | Licence | Author | Link |
| --- | --- | --- | --- | --- |
| Electron | 30.5.1 | MIT | Electron Community / OpenJS Foundation | [electronjs.org](https://www.electronjs.org/) |
| electron-builder | 25.1.8 | MIT | Vladimir Krivosheev (develar) | [github.com/electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) |
| Vite | 5.4.21 | MIT | Evan You | [vite.dev](https://vite.dev/) |
| `@vitejs/plugin-react` | 4.7.0 | MIT | Evan You / Vite team | [github.com/vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) |
| `vite-plugin-electron` · `vite-plugin-electron-renderer` | 0.29.1 · 0.14.7 | MIT | Leo Wang (草鞋没号) | [electron-vite](https://github.com/electron-vite/vite-plugin-electron) |
| TypeScript | 5.9.3 | Apache-2.0 | Microsoft Corporation | [typescriptlang.org](https://www.typescriptlang.org/) |
| Tailwind CSS | 3.4.19 | MIT | Adam Wathan & the Tailwind Labs team | [tailwindcss.com](https://tailwindcss.com/) |
| PostCSS | 8.5.28 | MIT | Andrey Sitnik | [postcss.org](https://postcss.org/) |
| Autoprefixer | 10.6.1 | MIT | Andrey Sitnik | [github.com/postcss/autoprefixer](https://github.com/postcss/autoprefixer) |
| cross-env | 7.0.3 | MIT | Kent C. Dodds | [github.com/kentcdodds/cross-env](https://github.com/kentcdodds/cross-env) |

**Electron itself is a stack of stacks**, and it is worth naming the layers under it:
[Chromium](https://www.chromium.org/) (BSD-3-Clause, Google and contributors),
[Node.js](https://nodejs.org/) (MIT, OpenJS Foundation), and
[V8](https://v8.dev/) (BSD-3-Clause). The Windows installer is built with
[NSIS](https://nsis.sourceforge.io/) (zlib-Libre).

---

## 3. Vendored source — the liquid glass engine

The refracting glass is not written from scratch. `src/vendor/liquidglass/` is a copy of:

> **liquidglass** — *A liquid glass effect library for the web.*
> by **ybouane** · MIT (as stated) · [github.com/ybouane/liquidglass](https://github.com/ybouane/liquidglass) ·
> [liquid-glass.ybouane.com](https://liquid-glass.ybouane.com/) · [x.com/ybouane](https://x.com/ybouane)

ChaosX imports it through `src/glass/liquidglass.ts` and **modifies it** — notably a
`restWhenIdle` behaviour and render-scale handling that do not exist upstream. Modified
copies are marked in the source.

> ⚠️ **Open item before any public release.** The upstream repository announces MIT in its
> README but publishes **no `LICENSE` file** (its GitHub API record reports `license:
> null`), so there is no copyright line to reproduce verbatim. Publishing a modified copy
> of code that carries no licence text is a real risk, not a formality. Two options: ask
> `@ybouane` to add the MIT file upstream, or get written permission for this port. Until
> that is settled, this section is the attribution on record.

The glass also leans on browser-native tech whose specifications are worth crediting:
**WebGL 2** ([Khronos Group](https://www.khronos.org/WebGL/)), **CSS `backdrop-filter`**
and the [W3C filter effects model](https://drafts.fxtf.org/filter-effects-1/).

---

## 4. Bundled binaries

Shipped inside the installer as `extraResources`. **These are copyleft**, so they are not
covered by this project's MIT licence and they carry source-offer obligations.

| Component | Version in this build | Licence | Author / project | Link |
| --- | --- | --- | --- | --- |
| mpv | v0.41.0-1072-g2a4eb8067 (built 2026-09-25) | GPL-2.0-or-later (libmpv: LGPL-2.1-or-later) | mpv / MPlayer / mplayer2 projects | [mpv.io](https://mpv.io/) |
| FFmpeg (`ffmpeg.exe`, `ffprobe.exe`) | 9.0.2-essentials_build | GPL-3.0-or-later — this build is configured `--enable-gpl --enable-version3` | The FFmpeg developers | [ffmpeg.org](https://ffmpeg.org/) |
| FFmpeg Windows build provider | essentials build | — | **Gyan Doshi**, who compiles and hosts the official Windows builds | [gyan.dev](https://www.gyan.dev/ffmpeg/) |
| `d3dcompiler_43.dll` | 4.48 MB, bundled with the mpv build | Microsoft redistributable terms | Microsoft Corporation | [learn.microsoft.com](https://learn.microsoft.com/en-us/windows/win32/direct3dtools/) |

mpv's own build statically links a long list of libraries, all visible in
`mpv --version` and each with its own maintainers — **libplacebo** (video-labs),
**libass**, **HarfBuzz**, **FreeType**, **Fontconfig**, **Fribidi**, **librubberband**,
**libvorbis / libogg**, **Opus**, **LAME**, **x264**, **x265**, **libaom**, **libvpx**,
**SVT-AV1**, **Zimg**, **SDL2**, **GnuTLS**, **libsrt**, **libssh**, **zeromq**,
**OpenMPT**, **GME** — plus **GCC 16.2.0** via the MSYS2 project. The FFmpeg build
similarly embeds the encoders and filters it lists in its configuration line.

Licence text kept in-repo: [`resources/ffmpeg/FFMPEG-LICENSE.txt`](resources/ffmpeg/FFMPEG-LICENSE.txt)
(GPLv3, verbatim). The binaries themselves exceed GitHub's 100 MB per-file limit and are
therefore fetched rather than committed.

---

## 5. Typefaces

Both faces are **licensed to whoever purchased them**, are **not in this repository**, and
are **not covered by its MIT licence**. They are baked into the packaged application, not
redistributed as source. See [`src/assets/fonts/README.md`](src/assets/fonts/README.md).

| Face | Used for | Designer / owner | Where |
| --- | --- | --- | --- |
| **Cocon** (`Cocon-Regular.otf`) | every word in the interface | Evert Bloemsma — *FF Cocon*, licensed through Linotype / Monotype | [myfonts.com/pages/linotype-ff-cocon](https://www.myfonts.com/pages/linotype-ff-cocon/) · [bloemsma.nl](https://www.bloemsma.nl/) |
| **Google Sans Round Bold** (`GS-Round-Bold.ttf`) | numerals only — clock, durations, play counts, bitrates | Google — proprietary, not publicly licensed for redistribution | [fonts.google.com](https://fonts.google.com/) |

Confirm both against your own purchase records before naming them anywhere public; the
Cocon attribution above is inferred from the filename and metrics, not from a licence
certificate held by this repository.

The digit range is handed to Google Sans Round through a CSS `unicode-range` because
Cocon's `7` has a broken advance — a workaround for a shipped font's defect, not a
styling choice.

---

## 6. Interface icons

The 30 icons under `src/assets/icons/` are drawn from the **Plumpy** icon set:

> **[Icons8](https://icons8.com/)** — Plumpy set, [icons8.com/icons/set/plumpy](https://icons8.com/icons/set/plumpy)
> Rendered as recolourable CSS masks (`.plumpy`, see `src/styles/globals.css`) so they
> inherit the theme.

Icons8's free tier is conditional on a visible link back to their site. That link lives
here and in the README's credits section. If the set is ever replaced, remove this entry
and the README line with it.

`src/assets/digits/` (11 PNGs) and `src/assets/default-album.svg` are generated or drawn
for this project.

---

## 7. Online service

| Service | Purpose | Provider |
| --- | --- | --- |
| **LRCLIB** — `https://lrclib.net/api` | The only network request ChaosX makes: synchronised and plain lyrics, cached to disk | The LRCLIB project — [lrclib.net](https://lrclib.net/) |

Lyrics accuracy and availability depend entirely on LRCLIB's database and on your track
metadata, and no lyrics are bundled with this app.

---

## 8. Content that is deliberately not in this repository

- **Wallpapers and video** (`resources/wallpapers/`) — the sample static and live
  wallpapers shipped in the installer are third-party artwork and footage. They are
  ignored by git and are **not licensed for redistribution**; a fresh clone ships without
  them, and users add their own.
- **The player binaries** — see section 4.
- **The fonts** — see section 5.

---

## 9. Attribution obligations, as tracked here

| Obligation | Status |
| --- | --- |
| MIT / BSD / 0BSD packages keep their notices in the bundle | ✅ Satisfied by `node_modules` licence files carried into the build |
| MPL-2.0 (SoundTouchJS) — file-level copyleft | ✅ Named here; source stays at the linked upstream |
| GPL / LGPL (mpv, FFmpeg) — licence text travels with the binary, source available | ⚠️ `FFMPEG-LICENSE.txt` is bundled; keep a matching mpv licence file in `resources/mpv/` and be ready to point users at upstream source |
| Icons8 free tier — visible attribution link | ✅ Sections 6 here and the README |
| Vendored liquidglass — MIT notice reproduction | ⚠️ Blocked: upstream publishes no `LICENSE` file (section 3) |
| Fonts | ✅ Excluded from the repository entirely |

*This document describes the state of the components ChaosX Mark x1.0 uses. It is an
attribution record, not legal advice.*
