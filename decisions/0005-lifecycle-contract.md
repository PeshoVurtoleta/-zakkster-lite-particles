# 0005 -- the lifecycle contract: valid life or no particle, normalizedLife in [0,1]

- **Status:** accepted (implemented in v1.3.0)
- **Date:** 2026-07-29
- **Session:** P2 (v1.3.0)
- **Findings:** LP-04 (S1), LP-05 (S2), LP-10 (S3)

## Context

Two silent wrong answers and one unstated invariant lived in the lifecycle:

- **LP-04.** `draw()` computed `normalizedLife` as `Math.max(0, life / maxLife)` --
  floored, never capped. `life:2, maxLife:1` handed the callback **2**;
  `maxLife:0` handed it **Infinity**. Any easing LUT indexed by it read out of range.
- **LP-05.** `reset()` leaves `life: 0`. `emit({ x, y })` with no `life` therefore
  produced a particle that `update()` released on its very first frame (`life <= 0`
  is tested before integration) having never moved -- and it incremented
  `recycledThisFrame`, so the churn metric reported work that never happened.
- **LP-10.** `update()` culls out-of-bounds particles *before* calling `onUpdate`.
  Defensible, but unstated and unpinned.

## Decision

### Lifecycle validated at `emit()`, clamp enforced at `draw()`

`emit()` resolves and validates the lifecycle **before acquiring a slot**:

- **Couple the fields.** Give `life` and `maxLife` mirrors it; give `maxLife` and
  `life` mirrors it. So the documented "1.0 at birth -> 0.0 at death" ramp is real
  even for `emit({ life: 5 })` (which previously left `maxLife` at 1 and pinned
  normalizedLife at 1.0 for the first four seconds).
- **Fail closed to `null`.** An effective `life <= 0`, `maxLife <= 0`, or non-finite
  value is an invalid emission and returns `null` -- the same signal a full pool
  gives. It takes no slot and burns no rng draw, so it cannot inflate
  `recycledThisFrame`. Immortal effects use a large finite `life` (non-finite is
  rejected on purpose: `Infinity / Infinity` is `NaN`, not a life).

We chose **return `null`** over **throw** for a bad lifespan (unlike LP-01's unknown
key, which throws): a non-positive `life` is often runtime data, not a typo, and
`null` already means "no particle here" on the `emit` surface. A missing key is a
programmer error; an out-of-range number is a data condition. Different failure
modes, different signals.

`draw()` additionally clamps, as belt-and-suspenders for any value a hook or
`emitEach` `initFn` writes directly (those bypass `emit`'s validation):

```js
const t = p.life / p.maxLife;
const normalizedLife = (p.maxLife > 0 && t > 0) ? (t < 1 ? t : 1) : 0;
```

This is `[0,1]` **and NaN-safe**: `t > 0` is false for `NaN`, so a `NaN` life or
`maxLife` maps to `0` -- no `NaN` ever reaches the render callback. Cost is one
divide and two compares; torture Phase B confirms it stays 0 B/call and the
throughput note records `draw()@1k`.

### `emitEach` is the raw path

`emit` validates; `emitEach` does not. `emitEach`'s contract is direct field writes
onto a sealed particle -- the caller owns the lifecycle. A particle left with
`life <= 0` there simply expires next frame; use `emit` when you want the check.
The `draw()` clamp still protects normalizedLife on both paths. This keeps
`emitEach` allocation-free and branch-free (finding LP-08's whole point).

### LP-10 pinned, not changed

The `update()` phase order -- decrement life, early-death, integrate (gravity,
drag, move), bounds cull, `onUpdate` hook -- is now documented in the method header
and pinned by a named test (`describe('update() phase order (LP-10)')`). Culling
precedes the hook deliberately: a particle culled this frame does not see its hook,
and a hook cannot pull a culled particle back in bounds. No code moved; a refactor
now trips a test if it reorders.

## Consequence

`emit({ x, y })` with no life returned a doomed particle before and returns `null`
now. `normalizedLife` could exceed 1 (or be Infinity/NaN) before and is always a
finite `[0,1]` now. Both are the LP-04/LP-05 fixes, not regressions. Every existing
test passed unchanged because they all emit an explicit positive `life`.

## References

- `Emitter.js` -- `emit()`, `draw()` clamp, `update()` phase-order header.
- `test/Emitter.test.js` -- `lifecycle contract (LP-04 / LP-05)`, `update() phase order (LP-10)`.
- `test/torture.mjs` -- Phase F (degenerate matrix).
- `ROADMAP.md` -- findings LP-04, LP-05, LP-10; brief P2.
- `decisions/0004-emit-schema-masking.md` -- the key-whitelist half of `emit()`.
