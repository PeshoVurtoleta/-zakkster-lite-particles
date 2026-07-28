# 0002 -- The two runtime dependencies

- **Status:** accepted (records the question and a recommendation; **no
  dependency changed in P0**)
- **Date:** 2026-07-29
- **Session:** P0 (v1.1.1)
- **Findings:** LP-11 (S3)
- **Blocks on for action:** P1 (v1.2.0)

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

## References

- `package.json` -- `dependencies`.
- `ROADMAP.md` -- findings LP-11, LP-03; briefs P1 and P4.
- `decisions/0001-hot-path-closure.md` -- LP-02/LP-03, the fix P1 owns.
