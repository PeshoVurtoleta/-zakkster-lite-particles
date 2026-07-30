# 0011 -- SoA is shelved; the GPU handoff (packTo + colour) is added to the object core instead

- **Status:** accepted (implemented in v1.5.0)
- **Date:** 2026-07-30
- **Session:** P4 (shipped as v1.5.0, not the planned 2.0.0)
- **Findings:** LP-14 (the v2 GPU payoff)
- **Supersedes:** the P4 plan's "SoA core replaces the object core as a breaking 2.0.0".

## Context

P4's goal was the GPU handoff: `packTo` streams particles into a `@zakkster/lite-gl`
`LAYOUT.POINT` buffer so a Canvas2D particle system renders 100k instances in one instanced
draw. The plan assumed this required a Structure-of-Arrays (column) core and would ship as a
breaking 2.0.0. `decisions/0010` fixed a falsifiable perf gate and fail-action BEFORE the
code: SoA ships as the default only if `update()` does not regress at small counts and
clearly wins at large ones.

The gate fired (numbers in `0010`): the SoA core regressed `update()` **25-40% at every
size**, small and large. Two facts explain it and drive this decision:

1. **A physics `update()` touches most per-particle fields** (life, vx, vy, gravity, x, y --
   6 of ~9). That is the access pattern that favours arrays-of-structs: an object's fields
   are contiguous, so touching many of them streams one cache region, whereas SoA scatters
   them across as many typed arrays as fields touched. The regression held even at N=100
   (fully L1-resident), so it is per-access instruction cost -- V8's monomorphic sealed-
   object field access beats N separate typed-array reads -- not a cache-footprint artifact.
2. **SoA's one edge, streaming `packTo`, does not need an SoA core.** A hand-written pack
   that reads the object fields into a `Float32Array` measured *equal* to the SoA `packTo`
   at 100k (246 vs 248 us). So the GPU payoff is available on the object core at the same
   cost -- the column store buys nothing here that the object core cannot match.

## Options considered (the fail-action, now that the number is known)

- **A. Ship SoA as a second `EmitterSoA` export**, object core default. Rejected: given (2),
  `EmitterSoA` would be *strictly inferior* -- slower `update()`, only-tied `packTo` -- so no
  caller would have a reason to choose it. It would be a second core to maintain for nothing.
- **B. Shelve the GPU handoff entirely.** Rejected: `packTo` is real, working, and the whole
  point of the session; throwing it away wastes the payoff.
- **C. Shelve the SoA CORE, add `packTo` + colour to the object core.** Chosen. The object
  core won the gate; give it the GPU handoff. This needs colour storage (POINT carries
  `r,g,b,a`), which the object particle lacked, so add `r,g,b,a` fields plus a numeric
  `userData` handle. Additive -- nothing breaks -- so it is a **minor (1.5.0), not 2.0.0**.

## Decision

**Option C.** The object core stays the one and only `Emitter`. It gains:

- first-class `r,g,b,a` colour fields (`[0,1]`, default opaque white, reset on recycle),
- a numeric `userData` handle (the typed sibling of the `data` object, which is unchanged),
- `packTo(out, offset) -> count` writing `LAYOUT.POINT` (8 floats: x, y, size, r, g, b, a,
  _pad; screen pixels; 0 alloc; `RangeError`/`TypeError` guards),
- exported `LAYOUT_VERSION` / `POINT_STRIDE` / `POINT_OFFSETS` as the packed contract.

The SoA implementation is kept as **reproducible evidence** in
`test/baseline/EmitterSoA.mjs`; `test/bench-soa.mjs` still runs the comparison so the verdict
can be re-derived at any time. Neither is published (`test/` is excluded from the package).

Version is **1.5.0** -- additive, non-breaking. `draw`/`onDeath`/`onUpdate`/`emit`/`emitEach`
signatures are all unchanged; the only observable difference is 5 new enumerable fields on
the particle.

## Consequence

The GPU payoff ships on the faster core, every existing call site keeps working, and the
package carries one core, not two. The user-facing lesson is recorded loudly (CHANGELOG "A
shelved rewrite"): SoA is not a free win -- it costs you the hot `update()` when that update
touches most fields, and it earns its keep only when you stream a narrow column subset over a
very large set. Particles are the former case; `packTo` alone is the latter, and it does not
need the whole core to be SoA.

If a future workload genuinely wants columns (e.g. a GPU-only pipeline that never runs the JS
physics `update()`), `EmitterSoA` can be revived from the evidence file behind the same gate.

## References

- `decisions/0010` -- the perf gate and the fired result.
- `Emitter.js` -- the `r,g,b,a`/`userData` schema, `packTo`, `LAYOUT_*` exports.
- `test/baseline/EmitterSoA.mjs` -- the shelved SoA core (evidence).
- `test/bench-soa.mjs` -- the reproducible gate.
- `test/torture.mjs` -- Phase H (packTo round-trip, 0 B/call @100k, lite-gl byte-verify).
- `ROADMAP.md` -- P4 brief and its "gate before code / fail action first" rule.
