# 0004 -- emit() is a whitelist that throws; particles are sealed

- **Status:** accepted (implemented in v1.3.0)
- **Date:** 2026-07-29
- **Session:** P2 (v1.3.0)
- **Findings:** LP-01 (S1)

## Context

`emit(config)` was `Object.assign(p, config)` onto a pooled particle. `reset()`
clears only the schema fields (`x, y, vx, vy, gravity, drag, life, maxLife, size,
data`), so any other key the caller passed -- `emit({ color: 'red', sprite: 'boom' })`
-- was **welded onto the pooled object permanently**. `clear()`, emit again, and
the recycled particle still carried `color === 'red'`: a fresh spark silently
wearing a dead one's appearance. It also mutated the object's hidden class on first
use, the exact deopt the pool exists to prevent.

`data: null` is in the schema precisely as the escape hatch for custom colours,
sprites, and metadata. The bug is that nothing pushed callers to use it.

## Options considered

**A -- Whitelist + throw.** `emit()` iterates the config keys and throws a
`TypeError` naming the first non-schema key and pointing at `.data`. Loud.

**B -- Track added keys, delete them in `reset()`.** Keeps `emit({ color })`
working and strips the key on recycle. But `delete` is a V8 deopt, and re-adding
the key on the next emit churns the hidden class every particle -- it repairs the
correctness bug while *keeping* the performance bug the pool exists to avoid.

**C -- Silently drop unknown keys.** Copy only schema keys; ignore the rest, no
error. Fixes the ghost-state leak, but a developer's `color` now vanishes with **no
signal** -- the same class of silent wrong answer P2 exists to kill, relocated from
the recycle path to the emit path.

## Decision

**Option A**, chosen with the user. `emit()` rejects any non-schema key with a
`TypeError` that names the key and points at `data`, and does so **before**
touching the pool (a rejected emit consumes no slot and no rng draw). This matches
the package's house style: `normalizeZone` already throws on a malformed zone
rather than silently emitting at (0, 0).

We also **`Object.seal` every particle** at construction (in the pool factory).
Sealing:
- makes the whitelist structural -- an `onUpdate` / `onDeath` hook or an `emitEach`
  `initFn` that writes a stray key throws too, not just `emit`;
- pins the hidden class, which is a V8 *win* on the hot path (writes to existing
  keys on a sealed object stay monomorphic), so torture Phase B still measures
  0 B/call and no throughput loss.

Rejected C explicitly: dropping `color` on the floor is not a fix, it is the bug
wearing a different hat. Rejected B because it pays the deopt to preserve a usage
the schema never sanctioned.

## Consequence (breaking, minor-appropriate)

`emit({ color: 'red' })` threw nothing before and throws now. This is a behaviour
change, but the prior behaviour was the silent corruption in LP-01; converting a
silent wrong answer into a named error is the point of the "pin the contract"
release. Migration is one line: `emit({ color })` -> `emit({ data: { color } })`.
`emitEach`'s raw writes follow the same rule via the seal.

## References

- `Emitter.js` -- `SCHEMA_KEYS`, the sealed pool factory, `emit()`.
- `test/Emitter.test.js` -- `describe('emit() schema contract (LP-01)')`.
- `ROADMAP.md` -- finding LP-01; brief P2.
- `decisions/0005-lifecycle-contract.md` -- the other half of `emit()`'s new contract.
