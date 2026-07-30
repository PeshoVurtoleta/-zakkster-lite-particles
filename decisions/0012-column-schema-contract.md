# 0012 -- the particle column contract (X-SCHEMA), settled after P4, not before

- **Status:** accepted
- **Date:** 2026-07-31
- **Session:** X-SCHEMA (decision + `FORMAT.md`, no version bump, no engine code)
- **Owner artifact:** `FORMAT.md` in this package
- **Packages in scope:** lite-particles, lite-confetti, lite-gl, lite-worker, lite-ambient-fx

## Context, and why the premise changed

The roadmap scheduled X-SCHEMA **before** P4 so that four packages could plan
against a settled column layout instead of P4's unshipped code. By the time this
session ran, that premise was overtaken: P4 already shipped (as v1.5.0, decisions
`0010`/`0011`), and it **shelved the SoA core** -- the perf gate fired, SoA
regressed `update()` 25-40% at every count, so the object core was kept and the
GPU payoff (`packTo` + `r,g,b,a` + `userData`) was added to it instead.

That resolved two of X-SCHEMA's three downstream dependents on its own:

- **W1 (lite-worker SAB)** is already free: `frameChannel` is stride-agnostic
  (`{ stride, capacity }`, `i*stride` on both sides), so it carries a POINT or
  QUAD field byte-identical with nothing to decide.
- **A1 (lite-ambient-fx)** vendors a layout by design and never depended on P4's
  code -- it needs names, which this document supplies.

So this session is **not** "unblock the long pole." It is drift-cleanup: P4
shipped a POINT contract (`LAYOUT_VERSION` / `POINT_STRIDE` / `POINT_OFFSETS`)
**unilaterally, with no cross-package document and no QUAD half**, while
lite-confetti carries a parallel, incompatible 14-column pool (different names,
CSS-string colours). Left alone, the fork (F3) would invent a second QUAD
layout. This document ratifies the shipped POINT half, specifies the missing
QUAD half, and pins confetti's relationship to both -- the one remaining consumer
that genuinely needs it.

## The six decisions

1. **Element type: Float32.** Settled empirically and already shipped -- confetti
   f32 pool, lite-gl f32 attributes, lite-worker f32 stride, particles `packTo`
   into a `Float32Array`. Screen-pixel and [0,1] colour values sit far inside the
   f32 mantissa, so no column needs f64 and there is no narrowing cost. The only
   non-f32 producer column (confetti `shape`, Uint8) is sim-private and never
   packs.

2. **Canonical names = lite-particles' spelling** (`gravity`, `maxLife`), because
   it owns `LAYOUT_VERSION` and its names are unabbreviated. Confetti's `grav`
   and `maxL` are **sim-only** columns that never enter a packed layout, so the
   rename is a pure internal diff and is therefore **optional**, deferred to F3.
   Conformance does not require it. (Rejected: forcing a confetti rename now --
   it changes no wire bytes, so mandating it buys nothing.)

3. **`size` vs `w`/`h`: carry both -- they are two primitives.** POINT has scalar
   `size`; QUAD has `w`/`h`/`rot`. A point producer fills one, a quad producer
   the other; documented optional bridges (`w=h=size`; `size=max(w,h)`) exist for
   cross-targeting. Consequence: `packTo` is two entry points, not one walk with
   a flag. (Rejected: a single derived column -- it would force points to invent
   an aspect or quads to lose rotation.)

4. **Colour columns: numeric `r,g,b,a` in [0,1] sRGB, written via
   `lite-color.toRgbTo`.** Already shipped on particles. Confetti still holds CSS
   strings in a parallel array and thus cannot fill a QUAD instance today -- that
   wiring is F3's adoption work, not a change to the finished particles package.
   `a` is the instantaneous alpha; any life-fade is the **producer's** job at
   pack time (the column meaning does not bake in a curve). (Rejected: keeping
   CSS strings -- they cannot cross to a GPU attribute.)

5. **`packTo` is two entry points.** POINT shipped. QUAD specified in `FORMAT.md`
   as `QUAD_OFFSETS = { x:0, y:1, w:2, h:3, rot:4, r:5, g:6, b:7, a:8 }`, stride
   9, no `_pad`, `rot` from the producer's rotation column (confetti `spin`).
   POINT's `_pad` (offset 7) is producer-zeroed and reserved. lite-gl grows no
   `packTo`; producers own packing and feed `upload(...)`.

6. **Owner: lite-particles owns `FORMAT.md` and `LAYOUT_VERSION` (= 1).** Its
   shipped `POINT_*` exports are the ratified POINT half. The QUAD constants live
   in `FORMAT.md` as the contract and are realized by lite-confetti in F3 --
   **the finished, published particles package is not modified** to add QUAD
   exports it never uses. `LAYOUT_VERSION` bumps only when an existing packed
   layout's order/stride changes; adding QUAD is additive and keeps it at 1.

## Deliverables (and what was deliberately dropped)

- `FORMAT.md` -- the contract, POINT ratified from shipped code + QUAD specified.
- This record.
- Roadmap re-point: particles P0-P4 marked shipped (SoA shelved); F3 re-scoped to
  Option B against the QUAD spec here; W1/A1 marked already free.

Deliberately **not** done, because the re-scope removed their value:

- The five-way `llms.txt` cross-reference sprinkle and per-consumer conformance
  **stubs** the original brief listed. With the long pole shipped and W1/A1 free,
  the only package that will consume this contract is F3, and it will assert the
  QUAD constants when it lands. Sprinkling pointers into four finished/published
  packages (particles, gl, worker) now would restage releases for no consumer.
  The conformance table lives in `FORMAT.md` section 6 instead, ready for F3.

## References

- `FORMAT.md` -- the contract this record decides.
- `decisions/0010`, `0011` -- the P4 perf gate and the SoA-shelved outcome that
  changed this session's premise.
- `Emitter.js` -- shipped `POINT_*` exports and `packTo`.
- `../LiteConfetti/Confetti.js` (~L298) -- the 14-column pool reconciled here.
- `../LiteGL/llms.txt` -- `LAYOUT = { POINT: 8, QUAD: 9, LINE: 9 }`.
- `ROADMAP.md` -- the X-SCHEMA brief and the F3 fork it feeds.
