# Changelog

All notable changes to `@zakkster/lite-particles` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-07-29

Hygiene only. This release brings lite-particles onto the same footing as the
rest of the suite: the `node:test` law, a torture gate, and the decision records
that later sessions need. **No runtime behaviour changed** -- `Emitter.js`
gained only an exported `VERSION` constant. Every 1.1.0 emission, physics,
zone, determinism, and lifecycle guarantee is byte-for-byte unchanged.

### Added

- **`VERSION`** -- exported from `Emitter.js`, in three-place sync with
  `package.json` and this changelog.
- **`test/torture.mjs`** -- the suite gate, run with
  `node --expose-gc test/torture.mjs` (prints `ok`, exits 0). Three phases in
  the lite-arena vocabulary:
  - **Phase A -- retention.** 4096 emit/expire cycles; asserts `activeCount`
    returns to 0 and `pool.free` returns to `pool.size`. Passes.
  - **Phase B -- GC budget.** Pre-fills the pool outside the loop, measures
    `update()`'s gross allocation per call the LP-02 way (force-settle, then
    `heapUsed` delta over 1000 calls with no GC between), then runs a 200k-op
    `update()` window under lite-gc-profiler for the `maxMajor: 0` reading.
    **This is a registered, expected FAILURE on 1.1.0** and stays green as an
    XFAIL: `update()` allocates a per-call arrow closure and a per-call
    `dead = []` (finding LP-02, ~250-320 B/call). The phase prints the measured
    bytes/call and asserts the allocation is *still present*. P1 (v1.2.0)
    removes the allocation, drives it to 0 B/call, and flips the XFAIL into a
    hard gate. Do not tune the budget until it passes for real.
  - **Phase C -- controls.** `TORTURE_CONTROL=alloc node --expose-gc
    test/torture.mjs` retains garbage every iteration, turns the gate red, and
    MUST exit non-zero -- the executable proof the gate can fail.
- **`decisions/0001-hot-path-closure.md`** -- transcribes the source header's
  rejection of hoisting the `update()` closure state onto `this` (a measured
  7-8% throughput regression) and adds the LP-02 allocation measurement the
  header's "~0 B/frame" claim omitted.
- **`decisions/0002-runtime-dependencies.md`** -- records the two-runtime-deps
  question (options A/B/C) and its recommendation. **No dependency is changed
  in this release**; the decision is written, not acted on.

### Changed

- **Tests ported from `vitest` to `node:test`.** `Emitter.test.js` moved from
  the repo root to `test/Emitter.test.js`; `vitest` removed as a devDependency.
  `"test": "node --expose-gc --test test/*.test.js"`.
- **`engines.node` raised `>=16` -> `>=18`.** `node --test` does not exist on
  16, so the old floor was a lie.
- **`package.json` `files[]`** now includes `CHANGELOG.md` and `LICENSE`.

### Notes

- Two runtime dependencies (`@zakkster/lite-random`, unscoped
  `lite-object-pool`) remain in place. See
  `decisions/0002-runtime-dependencies.md`; resolution is deferred to a later
  session (the object pool is scheduled for removal entirely in v2.0.0).

## [1.1.0]

Emission zones (`point` / `line` / `rect` / `ring`) resolved at emit time,
seeded determinism via an owned `@zakkster/lite-random` instance with
lite-confetti parity, and the `recycledThisFrame` churn metric alongside
`activeCount`. (Released before this changelog existed; summarized here for
continuity.)
