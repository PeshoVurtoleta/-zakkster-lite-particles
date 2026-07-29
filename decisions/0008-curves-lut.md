# 0008 -- curves are a baked-LUT sampler accessor, not an auto-applied field

- **Status:** accepted (implemented in v1.4.0)
- **Date:** 2026-07-29
- **Session:** P3 (v1.4.0)
- **Findings:** none (roadmap feature)

## Context

Easing a value over a particle's life (fade alpha, grow/shrink size) is normally done
in the render callback with a `Math`-heavy easing call per particle per frame
(`easeOutCubic`, which under the hood is a `pow`). The roadmap wants that call to
disappear from the per-particle path -- pre-resolve each curve into a table and read
it. `@zakkster/lite-ease` supplies the curves and `@zakkster/lite-ease-lut` bakes
them, but the roadmap is explicit: those are **dev-time** tools; the runtime reads a
table and gains no dependency.

## Options considered

**A -- sampler accessor.** `curves: { size: fn }` bakes each `(t)=>number` into a
`Float32Array` LUT at construction; `emitter.curve('size')` returns a pre-built
sampler closure the caller uses inside its own render callback. Non-invasive: no new
particle field, no change to `draw()`'s `(ctx, p, normalizedLife)` signature.

**B -- auto-apply to `size`.** Store each particle's birth size and have `draw()`
overwrite `p.size` from the size LUT every frame; the renderer reads `p.size`
unchanged. Zero user code, but opinionated and size-only, and it adds a birth-size
field plus a per-particle write inside the hot `draw()` loop.

## Decision

**A**, chosen with the user. Auto-apply (B) bakes a policy into a headless engine
(which value the curve drives, and that it is multiplicative) and touches the hot loop
for a feature many users will not enable; the signature change it implies also belongs
to P4, not here. The sampler accessor keeps the engine unopinionated and the hot path
untouched -- the user opts a curve in exactly where they want it.

Baking (cold, once, at construction):

```js
const lut = new Float32Array(segments);          // curveSegments, default 256
for (let j = 0; j < segments; j++) lut[j] = fn(j / (segments - 1));
```

The sampler is built **once** and returned by `curve(name)` on every call (a stable
closure -- hoist it out of the render loop). It clamps the ends and linearly
interpolates between the two nearest samples, so it evaluates no easing `Math`, only a
table read plus a lerp:

```js
(t) => {
    if (t <= 0) return lut[0];
    if (t >= 1) return lut[segments - 1];
    const x = t * (segments - 1), i = x | 0;
    return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
};
```

`curveTable(name)` exposes the raw `Float32Array` for a caller who wants a bare index
instead of the interpolating closure. An unknown name throws (fail closed). A
malformed `curves` config (a non-function entry, `curveSegments < 2`) throws at
construction.

## Consequence

`draw()` with a hoisted sampler is **0 B/call** (torture Phase G), and the baked LUT
matches the source easing within `< 1e-3` across 256 samples (Phase G measured
~7e-6 for a cubic). `@zakkster/lite-ease` and `@zakkster/lite-lerp` are added as
**devDependencies** (used by the tests to supply and cross-check curves); the runtime
`dependencies` stay exactly `@zakkster/lite-random`. `@zakkster/lite-ease-lut` was
evaluated as a cross-check but its 1.0.1 `exports` field is malformed
(`"EaseLut.js"`, missing the `./`) and unimportable under modern Node ESM, so the
tests cross-check the LUT against the easing function directly instead.

## References

- `Emitter.js` -- `_bakeCurves`, `curve`, `curveTable`, constructor `curves` /
  `curveSegments`.
- `test/Emitter.test.js` -- `curves`.
- `test/torture.mjs` -- Phase G (curve draw 0 B/call, LUT tolerance).
- `ROADMAP.md` -- brief P3.
