# Vendored: liquidglass

This folder is **not original ChaosX code**.

| | |
| --- | --- |
| Upstream | [`@ybouane/liquidglass`](https://github.com/ybouane/liquidglass) — "A liquid glass effect library for the web. Apply realistic glass refraction, blur, chromatic aberration, and lighting to any HTML element using WebGL shaders." |
| Author | **ybouane** — [github.com/ybouane/liquidglass](https://github.com/ybouane/liquidglass) · [liquid-glass.ybouane.com](https://liquid-glass.ybouane.com/) · [x.com/ybouane](https://x.com/ybouane) |
| Stated licence | MIT — but see the warning below |
| Vendored at | Mark x1.0, from the upstream `main` branch |
| Used by | `src/glass/liquidglass.ts` → `createLiquidGlassEngine()` |

## Modified

The copy here is edited, not pristine. Notably:

- a `restWhenIdle` option that parks the render loop instead of spinning it, and
- render-scale handling (`GLASS_RENDER_SCALE`) tuned for two-core machines.

See the comment block in `src/glass/liquidglass.ts` for what was changed and why. Any
further edits to these files should keep that list honest.

## Licence status

Upstream's README says MIT, but the repository **publishes no `LICENSE` file** — its
GitHub API record is `license: null`, and `raw.githubusercontent.com/.../main/LICENSE`
returns 404. There is therefore no copyright line that could be reproduced here even in
intention.

Attribution for this port lives in [`THIRD-PARTY-NOTICES.md`](../../../THIRD-PARTY-NOTICES.md)
section 3 and in the README's credits, which name the author and link the upstream
repository. If upstream ever adds the file, copy it in here verbatim.
