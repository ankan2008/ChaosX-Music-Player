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

## ⚠️ Licence not yet secured

Upstream's README says MIT, but the repository **publishes no `LICENSE` file** — its
GitHub API record is `license: null`, and `raw.githubusercontent.com/.../main/LICENSE`
returns 404. There is therefore no copyright line that can be reproduced verbatim here.

MIT text without a copyright holder is not a grant. Before this folder goes anywhere
public:

1. ask `@ybouane` to add the `LICENSE` file upstream, or
2. get written permission for this modified port,

and then paste the resulting notice into this folder as `LICENSE` and update
[`../../../THIRD-PARTY-NOTICES.md`](../../../THIRD-PARTY-NOTICES.md) section 3.
