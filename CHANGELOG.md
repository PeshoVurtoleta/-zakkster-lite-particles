# Changelog

All notable changes to `@zakkster/lite-particles` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/); this project
adheres to [Semantic Versioning](https://semver.org/).

## [1.4.0] - 2026-07-29

Lifecycle hooks. Three features the loop was cleaned (P1) and pinned (P2) to make
room for, all allocation-free: a dying particle can spawn more (`onDeath`), an easing
curve can be read from a baked table instead of recomputed every frame (`curves`), and
the emission origin can track a moving object (`follow`). Every P1/P2 allocation gate
stays green.

### Added

- **`onDeath(particle)` sub-emitter hook.** Fires when a particle is released by
  **life expiry** -- not on a bounds cull (no sparks spawned off-screen), not on
  `clear()`/`destroy()` (a scene reset is not death). The particle still holds its
  death position, so the hook can `emit()` embers from it. A particle emitted by the
  hook is integrated on the **next** frame, never the frame it was born. Constructor
  option and settable `emitter.onDeath`, mirroring `onUpdate`. See `decisions/0007`.
- **`maxCascadeDepth` (default 8).** Sub-emitters can cascade (sparks emitting sparks).
  Generations are tracked per particle; an `emit()` that would exceed the cap **throws
  a `RangeError`** naming the depth -- an unbounded self-emitting effect is a bug,
  surfaced loud like `emit()`'s unknown-key throw, not a silent frame-time cliff.
- **`curves` + `curve(name)` / `curveTable(name)`.** `new Emitter({ curves: { size:
  fn, ... } })` bakes each `(t)=>number` easing into a `Float32Array` LUT at
  construction (resolution `curveSegments`, default 256). `curve('size')` returns a
  pre-built, interpolating sampler closure -- hoist it out of your render loop and it
  reads the table with no easing `Math` on the hot path; `curveTable('size')` exposes
  the raw array. `@zakkster/lite-ease` supplies the curves in userland; the runtime
  reads a table and gains no dependency. See `decisions/0008`.
- **`follow(target)`.** The emission zone tracks `target.x`/`target.y` world-space --
  each `update()` moves the zone ORIGIN (two reads, O(1), never per-particle), leaving
  already-emitted particles where they were born (a comet trail). `follow(null)` stops;
  following with no zone throws; a null/non-finite target is a per-frame no-op that
  writes no `NaN`. See `decisions/0009`.
- **Torture Phase G** -- the onDeath dispatch triggers no full GC across millions of
  fires, a hoisted curve sampler in `draw()` and `update()` under an active `follow()`
  are both 0 B/call, the cascade cap throws (generation cap+1 is never born), and 20k
  steps of randomized sub-emitting churn hold the pool invariants.
- **`decisions/0007-ondeath-subemitter.md`**, **`0008-curves-lut.md`**,
  **`0009-follow.md`** -- the three P3 records.

### Changed

- **The particle pool is now reset-on-acquire.** `releaseAt()` only swap-removes;
  `acquire()` resets on the way out. This lets `update()` release a dying particle
  **before** firing `onDeath` (so the hook reads its death position, a 1:1 sub-emitter
  reuses the just-freed slot, and a cap-exceeded throw leaves the pool consistent).
  Net allocation is unchanged -- the reset moved from release-time to acquire-time,
  both writes to existing sealed keys -- and torture Phase B stays 0 B/call. A
  consequence: `clear()` is now a pure pointer move (freed particles reset lazily on
  reacquire). See `decisions/0007`.

### Notes

- **`emitEach` stays the raw path.** It stamps the cascade generation like `emit` (so
  a cascade driven through it still climbs into the cap), but the cap's throw lives in
  `emit`; spawn from `onDeath` via `emit` for the checked path.
- Particles gain a private, **non-enumerable** `_gen` field (the cascade generation),
  so the public particle shape is exactly the v1.3.0 schema -- `Object.keys(p)` and
  `{...p}` are unchanged.
- `@zakkster/lite-ease` and `@zakkster/lite-lerp` are added as **devDependencies**
  (they build and cross-check the curve LUTs in the tests). The runtime `dependencies`
  remain only `@zakkster/lite-random`.
- Every v1.2.0 / v1.3.0 allocation gate (torture Phase B / E / F) stays green with all
  three features in place.

## [1.3.0] - 2026-07-29

Pin the contract. Four behaviours that neither threw nor were pinned -- a recycled
particle inheriting a dead one's colour, `normalizedLife` returning 2 and Infinity,
a life-less particle dying before it moved, and a ring's `innerRadius` silently
desyncing a seeded replay -- are now each either a thrown error, a `null` return, or
a named test. No behaviour stays silent. The P1 allocation gates stay green: none of
the new guards leaked into a hot body.

### Changed

- **`emit()` rejects an unknown config field (LP-01).** Passing a key outside the
  particle schema (`{ x, y, vx, vy, gravity, drag, life, maxLife, size, data }`) now
  throws a `TypeError` naming the key and pointing at `data`. Previously
  `Object.assign(p, config)` welded arbitrary keys onto the pooled object
  permanently -- `reset()` never cleared them, so a recycled particle silently
  inherited a dead one's `color`/`sprite`. **Custom state goes on `data`.** Migrate:
  `emit({ color: 'red' })` -> `emit({ data: { color: 'red' } })`. Particles are now
  `Object.seal`'d, so a hook or `initFn` that writes a stray key throws too (and the
  fixed hidden class is a V8 win, not a cost -- torture Phase B still measures
  0 B/call).
- **`emit()` requires a valid lifecycle (LP-04, LP-05).** `life` and `maxLife` are
  coupled -- give either and the other mirrors it, so the documented "1.0 at birth
  -> 0.0 at death" ramp is real. An effective `life <= 0`, `maxLife <= 0`, or
  non-finite value returns `null` (like a full pool) instead of spawning a
  dead-on-arrival particle that expired on frame one and inflated
  `recycledThisFrame`. `emit({ x, y })` with no `life` now returns `null`. Immortal
  effects use a large finite `life`.
- **`normalizedLife` is clamped to `[0,1]` (LP-04).** `draw()` now hands the render
  callback `(maxLife > 0 && t > 0) ? min(1, t) : 0` where `t = life / maxLife` --
  was `Math.max(0, life / maxLife)`, which returned 2 for `life:2,maxLife:1` and
  Infinity for `maxLife:0`. The new form is also NaN-safe: a `NaN` life or maxLife
  (from a hook or `initFn`) maps to 0, so no `NaN` ever reaches the callback.
- **A `ring` zone always consumes 2 rng draws (LP-06).** The perimeter case
  (`innerRadius === radius`) now draws the radius sample too and discards it, so a
  ring's rng footprint is invariant and mutating `innerRadius` across the
  perimeter/annulus boundary can no longer desync a seeded replay. **One-time replay
  change:** a seed that emitted through a *perimeter* ring produces a different
  stream than in 1.2.x (it now advances 2 draws/particle, not 1). The annulus stream
  is unchanged.

### Added

- **`ZONE_DRAWS`** -- exported and frozen (LP-07). The per-zone rng-draw table
  (`{ point: 0, line: 1, rect: 2, ring: 2 }`) is now the *enforced* determinism
  contract: a seeded stream advances by exactly `ZONE_DRAWS[zone.type]` per emitted
  particle, asserted in tests. It was previously declared and never referenced.
- **`decisions/0004-emit-schema-masking.md`**, **`0005-lifecycle-contract.md`**,
  **`0006-zone-determinism.md`** -- the three P2 records.
- **Torture Phase F** -- a degenerate-value matrix (`life`/`maxLife`/`size`/`dt`/
  `gravity`/`drag`/`bounds` of 0, negative, NaN, Infinity) with a pinned answer for
  each: invalid lifecycle rejected to `null`, `normalizedLife` finite in `[0,1]`,
  and no `NaN` or throw escaping. The throughput note now records `draw()@1k` too.

### Notes

- **Zone mutation boundary.** A zone's *position* (`x`/`y`) is live-mutable -- that
  is how you make it follow the mouse. A *dimension* (`radius`, `innerRadius`,
  `width`, `height`, line endpoints) should change through `setZone()`, which
  re-validates; a raw in-place dimension write skips validation (e.g.
  `innerRadius > radius` would sample `NaN`). Documented, not hard-locked -- see
  `decisions/0006` for why a partial freeze was rejected.
- **`update()` phase order is pinned (LP-10).** Decrement life, early-death,
  integrate (gravity, drag, move), bounds cull, `onUpdate` hook -- culling precedes
  the hook deliberately. A named test now guards the order; no code moved.
- **`emitEach` is the raw path.** It writes directly onto a sealed particle and does
  not validate the lifecycle (the caller owns it), keeping it allocation-free. The
  `draw()` clamp still protects `normalizedLife` on that path.
- P1's allocation gates (torture Phase B/E, 0 B/call) remain green with the `draw()`
  clamp and the seal in place.

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
