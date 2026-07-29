# Changelog

All notable changes to `@zakkster/lite-particles` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-07-29

Make "GC-free" true. On 1.1.x, `update()` allocated ~331 B/call and `draw()`
~243 B/call on an emitter with **zero particles** (finding LP-02) -- roughly
35 KB/s of garbage at 60 fps before the simulation did anything. Both are now
**0 B/call at every particle count**, and torture Phase B enforces it as a hard
gate. The fix was structural: the active set is no longer a `Set` (LP-03).

### Changed

- **`update()` and `draw()` allocate 0 B/call** (was ~331 / ~243 on an empty
  emitter; `update()` on 1000 live particles was ~251). A 200k-op `update()`
  window now triggers **zero** garbage collections (`major=0, minor=0`). The hot
  loops no longer build a per-call `dead[]` array, pass a per-call closure, or
  spin up a per-call `Set` iterator -- `update()` is a reverse `while` loop that
  releases in place via swap-remove; `draw()` is a forward index loop.
- **Throughput is unaffected** by the rewrite: `update()` at 1000 particles
  measured 100-110% of the 1.1.0 baseline across reps (neutral-to-slightly-faster,
  never slower) while allocation went to zero. See
  `decisions/0001-hot-path-closure.md` for the full comparison, including why the
  obvious "hoist state onto `this`" fix was *not* the one taken.
- **Iteration order note (not a behaviour guarantee).** Because the active set is
  now a dense array with swap-remove, the order `update()`/`draw()` visit
  particles differs from 1.1.0's `Set`-insertion order after any churn. Physics is
  per-particle independent, so simulation results are identical; only render
  z-order *among simultaneously-live particles* can differ. **The emission stream
  is unchanged** -- same seed still produces the same rng draws and the same
  positions.

### Added

- **`emitEach(count, initFn)`** -- an allocation-free burst path. `initFn(p, i)`
  writes fields directly onto the pooled particle instead of returning a config
  object (finding LP-08), so a 5000-particle burst allocates nothing. Pool
  capacity is checked **before** `initFn` runs, so a saturated pool consumes no
  rng draw for a particle it cannot emit (finding LP-09) -- matching `emit`'s
  acquire-then-sample discipline. Torture Phase D asserts both, the second by
  stream position rather than particle count.
- **`decisions/0003-allocation-fix-location.md`** -- records choosing the inline
  dense free-list (option B) over patching or splitting the pool.

### Removed

- **`lite-object-pool` runtime dependency.** Replaced by a ~35-line inline dense
  free-list (`ParticlePool` in `Emitter.js`). This is the same structure the
  planned v2.0.0 SoA core builds on. Resolves the substantive and cosmetic halves
  of LP-11 (a runtime dependency at all, and an unscoped one).

### Deprecated

- **`emitBurst(count, configFn)`** -- superseded by `emitEach`. The
  config-returning form allocates one object literal per particle; it still works
  and is documented, but is removed in **v2.0.0**. Migrate:
  `emitBurst(n, i => ({vx: i}))` -> `emitEach(n, (p, i) => { p.vx = i; })`.

### Notes

- **`@zakkster/lite-random` is kept** as the one runtime dependency. Its full API
  is re-exposed via the public `emitter.random` getter (documented for sharing the
  stream with a config callback), so it cannot be inlined without either breaking
  that surface or duplicating the whole package. The README and llms.txt now say
  "one dependency" rather than "zero dependencies." See
  `decisions/0002-runtime-dependencies.md`.
- Torture Phase B, registered as an XFAIL in 1.1.1, is now a **hard gate**
  (`STRICT_PHASE_B = true`). Phases D (burst) and E (200k-op mixed loop,
  `maxArrayBuffersGrowth: 0`) were added.

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
