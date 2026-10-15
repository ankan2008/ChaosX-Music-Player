# Screenshots

Nine images, all 1600×838, ~1.5 MB total. The README references these exact names, so a
file dropped in here with the right name appears without any further edits.

| File | Shows |
| --- | --- |
| `01-home.webp` | Home — continue listening, most played, last played |
| `02-library.webp` | Library — pinned folders, playlists, now-playing card, lyrics |
| `03-statistics.webp` | Statistics — listening totals plus live memory/CPU/battery |
| `04-settings.webp` | Settings — wallpaper picker and widget switches |
| `05-fullscreen.webp` | Fullscreen music — the record filling the monitor |
| `06-mini.webp` | Mini player, collapsed |
| `07-mini-expanded.webp` | Mini player, expanded |
| `08-pill.webp` | Pill mode docked to the right screen edge |
| `09-album-art-theme.webp` | The album-art backdrop theme instead of a wallpaper |

## Why WebP and not PNG

UI text survives WebP at `-quality 92` and each frame lands near 150 KB instead of the
2 MB a PNG of the same shot costs. Nine PNGs would be ~18 MB committed permanently, and
git never forgets it even after you delete them.

## Re-capturing and cropping

Capture the real window, not a browser tab — the glass only bends what is genuinely
behind it, and a shot of the dev server shows a flat panel where the refraction should
be. `Win+Shift+S` in window mode keeps the rounded glass corners.

The Windows taskbar is cropped out of every frame. The bundled ffmpeg does it, using the
same binary the app ships:

```bash
resources/ffmpeg/ffmpeg.exe -i in.webp -vf "crop=1600:838:0:0" \
  -c:v libwebp -quality 92 -pix_fmt yuv420p out.webp
```

`838` is the row the taskbar starts under on a 1600×900 frame. It is not a universal
number: on a 2560×1440 capture the band starts lower, and if the display is scaled to
125% it moves again. Measure before trusting it — extract the bottom strip and look:

```bash
resources/ffmpeg/ffmpeg.exe -i in.webp -vf "crop=1600:80:0:820,scale=1600:160" strip.png
```

Getting this wrong cuts the player's own transport bar, which is worse than the taskbar
it replaced. The pill and mini shots are the ones to check: their panels run close to the
bottom edge, and `08-pill.webp` ends within a pixel of the crop line.

## Before publishing a new screenshot

These frames carry more than the interface. Check every one of them:

- **Your name.** The sidebar greeting card and the window title both show it.
- **Playlist names.** A tab labelled after you, or after another app on your machine, is
  readable at full size.
- **Track names and play counts.** The library and statistics panes list what you actually
  listen to.
- **Album art.** Third-party copyrighted images, however small.
- **Hardware details.** The statistics page names the machine, its RAM and its core count.
- **The wallpaper behind everything.** The sample wallpapers ship with the repository, so a
  screenshot of one is not a leak. A background you set yourself might be — check which
  image is actually loaded before capturing.

The album art in these frames is read from the user's own file tags at runtime, so it is
not content the repository ships.

Rename a couple of playlists before capturing if they are named after you or after another
app on your machine. Retouching a published image is not really possible — GitHub and every
CDN in front of it will keep serving the old one long after the commit is gone.
