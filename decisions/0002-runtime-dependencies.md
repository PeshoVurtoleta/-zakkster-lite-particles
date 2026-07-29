# 0002 -- The two runtime dependencies

- **Status:** accepted; **option B executed in P1 (v1.2.0)** for the object pool.
  `lite-object-pool` is removed; `@zakkster/lite-random` is kept, deliberately.
  Originally written in P0 with no dependency changed.
- **Date:** 2026-07-29 (P0); updated 2026-07-29 (P1 -- executed)
- **Sessions:** P0 (v1.1.1) recorded the question; P1 (v1.2.0) acted
- **Findings:** LP-11 (S3)
- **See also:** decisions/0003 (the inline free-list that replaced the pool)

## Context

The suite's first law is zero runtime dependencies. Every other package in the
family leads its README with a zero-dependencies badge. lite-particles has two:

```json
"dependencies": {
  "@zakkster/lite-random": "^1.1.0",
  "lite-object-pool": "^1.0.0"
}
```

`lite-object-pool` is **unscoped**. It is the maintainer's own package
(`zakkster`, 1.0.2), so this is not a supply-chain problem -- but it is the only
dependency in the ecosystem living outside `@zakkster/`, and it is a hard
runtime dep in a family whose founding law says there are none.

Both dependency APIs were verified against the installed packages, not assumed.
`ObjectPool` exposes `acquire / release / releaseAll / forEachActive / used /
free / size / destroy`; `Random` exposes `next / reset / getState / setState /
range / int / ...`. No hallucinated calls in the source.

## The forcing fact

**P4 (v2.0.0) deletes the object pool entirely.** The SoA rewrite replaces
pooled objects with column typed arrays and a dense alive index, and drops
`lite-object-pool` as part of the major. Any effort spent *improving* the pool
(scoping it, republishing it, tuning its internals) is effort spent on
something already scheduled for removal. This bears directly on P1, which must
decide *where* the LP-02/LP-03 allocation fix lives.

## Options

**A -- Keep both, drop the claim.** Leave the dependencies in place and remove
the "zero dependencies" language from the README so the package stops
advertising something untrue. Cheapest; concedes the law for this package.

**B -- Inline and drop.** Replace `lite-object-pool` with a minimal dense
free-list inside `Emitter.js` (~40 lines), and either keep `lite-random` as a
dep or inline the single PRNG actually used. Restores the law. This is also the
exact shape P4 wants, so the migration is owed regardless -- doing it in P1
resolves LP-02, LP-03, and LP-11 in one move.

**C -- Republish scoped.** Keep both deps; republish `lite-object-pool` as
`@zakkster/lite-object-pool` so nothing lives outside the scope. Fixes the
cosmetic half of LP-11 (the unscoped name) but not the substantive half (a
runtime dep at all), and spends that effort on a package P4 deletes.

## Recommendation

**Option B, executed in P1 -- not here.** It is the only option that makes the
law true again rather than walking it back (A) or polishing a doomed dep (C),
and P1 already has to touch the pool's data structure to fix LP-02/LP-03. The
dense free-list P1 needs *is* the pool replacement, so B costs P1 almost nothing
beyond work it was doing anyway, and it is the structure P4 builds the SoA core
on top of.

`lite-random` is a smaller question: a single small PRNG, in-scope, and the
seeded-determinism / lite-confetti parity story leans on it. Keep it a dep or
inline the one generator used; decide that in P1 alongside B, and if it stays,
say so plainly in the README rather than printing "zero dependencies".

## Decision for P0

**Change nothing.** P0 is hygiene only -- no dependency is added, removed, or
rescoped. This record fixes the question in writing and hands P1 a
recommendation with its reasoning, so the dependency move is made deliberately
inside the allocation session, not as an untracked side effect.

## What P1 (v1.2.0) actually did

**The pool: option B, executed.** `lite-object-pool` is gone. Its `acquire`/
`release`/`forEachActive` were replaced by an inline `ParticlePool` dense
free-list in `Emitter.js` (decisions/0003) -- which was the LP-02/LP-03
allocation fix anyway, so B cost P1 nothing beyond work it was already doing, and
it is the structure P4's SoA core builds on. LP-11's substantive half (a runtime
pool dependency at all) and cosmetic half (an unscoped name) both resolve.

**lite-random: kept, deliberately.** The smaller question resolved toward keeping
the dep, for a reason that only surfaced under scrutiny: the emitter's public
`random` getter **re-exposes the entire `Random` API** (`.gaussian`, `.int`,
`.range`, `.weighted`, ...), documented "so a configFn can share the stream."
Inlining only the `next()`/`reset()` the emitter itself calls would silently break
every caller reaching through that getter -- a public API break outside P1's
non-goals. Inlining the *whole* class would duplicate a maintained, in-scope,
zero-dependency package and take on a keep-in-sync burden for no user benefit. So
`@zakkster/lite-random` stays a dependency.

Because the package is therefore not dependency-free, the README and llms.txt were
reworded to say so honestly -- "one dependency (`@zakkster/lite-random`)" rather
than "zero dependencies" -- exactly the path ROADMAP P4 sanctions ("lite-random
remains, and the README says so"). P4 revisits this only if the SoA rewrite stops
needing the full PRNG surface.

## References

- `package.json` -- `dependencies` (now only `@zakkster/lite-random`).
- `Emitter.js` -- `ParticlePool` (the inlined pool); the `random` getter.
- `ROADMAP.md` -- findings LP-11, LP-03; briefs P1 and P4.
- `decisions/0001-hot-path-closure.md` -- LP-02/LP-03, resolved in P1.
- `decisions/0003-allocation-fix-location.md` -- the inline free-list decision.
