# 0003 -- Where the allocation fix lives: an inline dense free-list

- **Status:** accepted (implemented in v1.2.0)
- **Date:** 2026-07-29
- **Session:** P1 (v1.2.0)
- **Findings:** LP-02 (S1), LP-03 (S2), LP-11 (S3)
- **Depends on:** decisions/0001 (the closure), decisions/0002 (the dependencies)

## Context

P0 registered the LP-02 allocation as an executable failure: `update()` ~331
B/call and `draw()` ~243 B/call on an emitter with **zero particles**. Three
sources (decisions/0001):

1. a per-call `const dead = []` in `update()`,
2. a per-call arrow closure handed to `pool.forEachActive(...)` in `update()` and `draw()`,
3. inside `lite-object-pool`, a fresh `Set` iterator per `forEachActive` (LP-03).

The `dead[]` buffer exists **only** because you cannot delete from a `Set` while
iterating it. So all three sources trace back to one data-structure choice: the
pool tracks its active set in a `Set`. Fix the structure and all three go at once.

## Options considered

**A -- Fix `lite-object-pool`.** Make `_out` a dense array with swap-remove and
add an index-based iteration entry point that permits release mid-iteration. Helps
every consumer of the pool. But it is a cross-package change to a package **P4
(v2.0.0) deletes outright** (the SoA rewrite drops the pool), so the effort lands
on something already scheduled for removal, and it still leaves lite-particles
importing an external pool.

**B -- Inline a dense free-list into `Emitter.js` and drop the pool dep.** ~35
lines: a pre-allocated `slots` array partitioned into active `[0, active)` and
free `[active, size)` regions, `acquire()` takes the boundary, `releaseAt(i)`
swap-removes. `update()`/`draw()` read `slots`/`active` directly and iterate with
no callback. Fixes LP-02, LP-03, and the pool half of LP-11 in one move, and it is
the exact shape P4's SoA core builds on.

**C -- Keep the pool for `acquire`/`release`, maintain the active list locally in
an `Int32Array`.** Splits ownership of the active set between the pool and the
Emitter -- two structures to keep coherent -- for no benefit over B, and still
ships the pool dependency.

## Decision

**Option B.** decisions/0002 already recommended it: P4 removes the pool
regardless, so the migration is owed, and doing it in P1 buys three findings for
the price of one small structure. The inline pool is `ParticlePool` at the top of
`Emitter.js`; the hot loops became a reverse `while (i-- > 0)` with in-place
`releaseAt` (`update()`) and a forward index loop (`draw()`).

`lite-object-pool` is removed from `dependencies`. `@zakkster/lite-random` stays
-- see decisions/0002 for why (the public `random` getter re-exposes its whole API).

## Why reverse iteration + swap-remove is correct

`releaseAt(i)` moves the last active particle (`slots[active-1]`) into slot `i` and
decrements `active`. Iterating **downward** (`i` from `active-1` to `0`), the
swapped-in element always sits at an index `>= i` that has **already been
visited**, so nothing is skipped or processed twice -- including the worst case
where every particle dies in a single frame. This is proven executably by torture
Phase A (4096 emit/expire cycles leave the pool pristine) and Phase B's
all-expire window (2000 frames that each kill the full population, `major=0`).

## Result (measured, `--expose-gc`, forced settle, min of 3 reps)

| Call | Before (1.1.0) | After (1.2.0) |
| --- | --- | --- |
| `update()` @ 0 particles | ~331 B/call | **~0 B/call** (0.07, noise) |
| `draw()` @ 0 particles | ~243 B/call | **0 B/call** |
| `update()` @ 1000 alive | ~251 B/call | **0 B/call** |

A 200k-op `update()` window is now clean at **major=0, minor=0** -- the loop
triggers no garbage collection of any kind. See decisions/0001 for the throughput
cost of this option against the two the original ledger weighed (spoiler: none).

## References

- `Emitter.js` -- `ParticlePool`, `update()`, `draw()`.
- `test/torture.mjs` -- Phases A, B (hard gate now), D.
- `decisions/0001-hot-path-closure.md` -- the three options for the closure itself.
- `decisions/0002-runtime-dependencies.md` -- why the pool goes and lite-random stays.
- `ROADMAP.md` -- findings LP-02, LP-03, LP-11; brief P1.
