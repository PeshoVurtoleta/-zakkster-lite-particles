# 0006 -- a ring draws 2 always; ZONE_DRAWS is the determinism contract

- **Status:** accepted (implemented in v1.3.0)
- **Date:** 2026-07-29
- **Session:** P2 (v1.3.0)
- **Findings:** LP-06 (S2), LP-07 (S3)

## Context

Zone sampling consumes a fixed number of `rng.next()` draws per particle -- that
count is what makes a seeded replay reproducible. It was constant per zone type
except for `ring`: the perimeter (`innerRadius === radius`) drew **1** value
(theta), the annulus drew **2** (theta + a radius sample). Since `normalizeZone`
returns a mutable object (so `emitter.zone.x = mouseX` can move the emitter), a
caller could also write `emitter.zone.innerRadius`. Crossing the
`=== radius` boundary at runtime changed the draw count, which **shifted every
subsequent draw** -- same seed, permanently desynced stream (LP-06).

`ZONE_DRAWS`, a module-scope table documenting those counts, was declared and
**never referenced** (LP-07).

## Options considered

**Constant draw count.** Make `ring` always draw 2: the perimeter draws the radius
sample too and discards it. Draw count is then invariant for the zone's whole life,
so `innerRadius` mutation cannot desync replay.

**Keep the branch, document + lock.** Leave perimeter=1/annulus=2; forbid live
`innerRadius` mutation via a setter or partial freeze.

We also weighed **hard-locking** the dimension fields (`Object.defineProperty` with
`writable: false`) on top of either.

## Decision

**Constant draw count**, chosen with the user. `_sampleZone`'s ring branch now
always draws both values:

```js
const theta = rng.next() * TAU;
const u = rng.next();
const r = (ri === ro) ? ro : Math.sqrt(ri * ri + u * (ro * ro - ri * ri));
```

`theta` is draw #1 and `u` is draw #2 in **both** branches, so flipping
`innerRadius` mid-flight changes the emitted *positions* but shifts no later draw
-- the stream stays in sync. `ZONE_DRAWS.ring` becomes `2`, the table is
**exported and `Object.freeze`'d**, and a test asserts a seeded stream advances by
exactly `ZONE_DRAWS[zone.type]` per emitted particle (resolving LP-07: the table is
now the enforced contract, not dead documentation).

**We did NOT hard-lock the dimension fields.** Constant draws already dissolves the
determinism desync that motivated a lock, so a lock would only guard the separate
`innerRadius > radius -> NaN` case -- and the mechanism is ugly: you cannot
`Object.freeze` the zone (it kills the `zone.x` follow-the-mouse feature), a partial
`Object.defineProperty` throws in strict callers but silently no-ops in sloppy ones,
and it has no clean analogue for a `line` zone whose whole identity is its endpoints.
Instead we **document the boundary** (position is live-mutable; dimensions go through
`setZone`, which re-validates) and pin it with tests. The residual malformed-shape
case is covered by torture Phase F's degenerate matrix.

## Consequence (one-time, documented replay change)

A ring on the **perimeter** now consumes 2 draws where it consumed 1, so any seed
that emitted through a perimeter ring produces a **different stream** in 1.3.0 than
in 1.2.x. This is a deliberate, one-time break called out in the CHANGELOG. The
annulus stream is unchanged (it already drew 2), and no existing test regressed
because every determinism test uses an annulus ring; the perimeter test asserts the
radius (`hypot === radius`), which is invariant to the extra draw.

## References

- `Emitter.js` -- `ZONE_DRAWS` (exported, frozen), `_sampleZone` ring branch,
  `normalizeZone` mutation-boundary doc.
- `test/Emitter.test.js` -- `zone determinism contract (LP-06 / LP-07)`.
- `ROADMAP.md` -- findings LP-06, LP-07; brief P2.
