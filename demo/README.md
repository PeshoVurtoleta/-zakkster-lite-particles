# lite-particles · playground

An A+ interactive demo of [`@zakkster/lite-particles`](../) — one self-contained page,
**no build step**.

![100k particles via packTo → lite-gl](screenshot.png)

## Run it

The page loads the engine and the lite-gl GPU stack from **source** via an
`<script type="importmap">`, so it must be served over HTTP from the **monorepo root**
(the directory that contains `LiteParticles/`, `LiteGL/`, `LiteSignal/`, `LiteRaf/`) so the
`../../LiteGL/...` specifiers resolve:

```bash
# from LiteLibrariesSuite/ (the parent of LiteParticles/)
python3 -m http.server 8099
# open:
#   http://localhost:8099/LiteParticles/demo/
```

Any static server works (`npx serve`, etc.) as long as its root is the monorepo root.

## What it shows

- **Five scenes** — fountain (point zone + gravity), fireworks (an `onDeath` cascade:
  rocket → radial burst → sparkles, bounded by `maxCascadeDepth`), shockwave (`ring` zone),
  snow (`line` zone + drag + `onUpdate` sway), vortex (`onUpdate` swirl).
- **`follow(target)`** — the emission origin trails the cursor / touch (world-space).
- **Per-particle colour** — the v1.5.0 `r,g,b,a` fields, plus `userData` used as a palette
  handle (an integer index resolved to a cached fill style — exactly what `userData` is for).
- **Baked `curves`** — a hoisted sampler eases alpha over life with no `Math` on the hot path.
- **Seeded replay** — the *replay ▸ seed* button resets the seed and runs a fixed-step,
  pointer-free volley: identical every press.
- **Canvas2D ⇄ GPU** — the toggle flips rendering from the `draw()` callback to
  `packTo()` → `@zakkster/lite-gl` `createPointSink`, one instanced draw for 100,000+
  instances. A live HUD shows FPS, active count, `recycledThisFrame`, and the 0 B/frame budget.

## Notes

- Not part of the published npm package (`demo/` is excluded from `files[]`).
- `?rig` exposes a small `window.__lp` hook (deterministic frame pumping) used only for
  capturing screenshots; it is inert in normal use.
- lite-gl is loaded from the monorepo sibling, not as an npm dependency — the runtime
  package still has exactly one dependency, `@zakkster/lite-random`.
