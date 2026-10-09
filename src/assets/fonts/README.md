# Fonts

ChaosX sets its words in **Cocon** and its numerals in **Google Sans Round Bold**,
declared in `src/styles/globals.css`:

```css
font-family: 'Cocon';
src: url('../assets/fonts/Cocon-Regular.otf') format('opentype');
```

Neither file is committed. Both faces are licensed to whoever bought them, not to this
project, and redistributing them in a public repository would be handing out someone
else's product.

Drop your own copies in this folder under these exact names and the app picks them up:

| File | Used for |
| --- | --- |
| `Cocon-Regular.otf` | every word in the interface |
| `GS-Round-Bold.ttf` | numerals only — the clock, durations, play counts, bitrates |

Without them the stack falls through to `system-ui`, which is legible but is not the
look: the whole interface is built around a rounded text face, and the clock in
particular is sized against Google Sans Round's digits.

## Why the digits are a second file

Cocon's `7` has a broken advance of about `0.2em`, so a time like `2:57` renders with
the digits colliding. `globals.css` hands the numeral range over to Google Sans Round
with a `unicode-range` and keeps the letters on Cocon, which fixes the time readouts
without touching the word shapes anywhere else.
