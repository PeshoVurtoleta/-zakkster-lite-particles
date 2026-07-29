# 0007 -- onDeath sub-emitter: release-before-hook, per-particle cascade cap that throws

- **Status:** accepted (implemented in v1.4.0)
- **Date:** 2026-07-29
- **Session:** P3 (v1.4.0)
- **Findings:** none (roadmap feature)

## Context

`onDeath(p)` lets a dying particle spawn more (a spark bursting into embers). The
hook necessarily calls `emit()` **while `update()` is iterating the active list**,
which raises three questions the roadmap flagged as decide-and-record: when the hook
fires, how a re-entrant `emit()` stays iteration-safe, and how an unbounded cascade
(sparks emitting sparks emitting sparks) is bounded.

## Decisions (locked with the user)

**Fires on life-expiry ONLY.** Not on a bounds cull -- a particle leaving the screen
should not spawn sparks off-screen -- and not on `clear()`/`destroy()`, which are
scene resets, not deaths (consistent with how `recycledThisFrame` already ignores
them). One signature, `onDeath(p)`, with no `reason` argument to branch on.

**Cascade cap THROWS past `maxCascadeDepth` (default 8).** Chosen over silently
dropping. `emit()` is already a fail-loud method -- it throws a `TypeError` on an
unknown config key (0004) -- so an unbounded self-emitting cascade, which is a bug,
throws a `RangeError` naming the depth rather than degrading into a silent frame-time
cliff. Generations are tracked per particle in a private, **non-enumerable** `_gen`
field (non-enumerable so the public particle shape stays exactly the 0004 schema --
`Object.keys(p)` / `{...p}` are unchanged).

## The pool change that makes it clean: reset-on-acquire

To fire `onDeath(p)` the hook needs `p` intact at its death position, AND we want the
pool consistent if a cap-exceeded throw unwinds mid-`update()`. Both fall out of
moving the reset:

- `ParticlePool.releaseAt(i)` now swap-removes **only** -- it does not reset. The
  released particle keeps its dying values in the free region.
- `acquire()` resets on the way out.

So `update()` releases the dying particle **first**, then fires `_fireDeath(p)`:

```js
if (p.life <= 0) {
    pool.releaseAt(i);            // swap-remove; p keeps its death x/y
    deaths++;
    if (this.onDeath) this._fireDeath(p);
    continue;
}
```

This buys three things: (a) the hook reads `p`'s real death position; (b) a full
pool's just-freed slot is immediately reusable, so a 1:1 sub-emitter never drops its
spark; (c) if `emit()` throws the cap `RangeError`, the pool is already consistent
(the dead particle is out), so the frame just aborts cleanly. Net allocation is
unchanged -- the reset merely moved from release-time to acquire-time (writes to
existing sealed keys, 0 B). Torture Phase B stays 0 B/call.

`_fireDeath` is a **separate cold method** so its `try/finally` (which clears the
ambient generation even when `emit()` throws) never sits in `update()`'s hot loop:

```js
_fireDeath(p) {
    this._emitGen = p._gen + 1;
    try { this.onDeath(p); }
    finally { this._emitGen = 0; }
}
```

`emit()` guards `this._emitGen > this._maxCascadeDepth` (throw) before `acquire()`,
then stamps `p._gen = this._emitGen`.

## Iteration safety, and born-next-frame

`update()` captures its bound as a local (`let i = pool.active`) and scans downward.
A particle sub-emitted during `_fireDeath` `acquire()`s at the current boundary -- an
index the descending cursor has **already passed** -- so it is integrated on the
**next** frame, never the frame it was born. This is a defined, tested contract, and
it makes same-frame runaway recursion structurally impossible (the counter can only
climb across frames, where `_gen` caps it). `emitEach` stamps `_gen` too so a cascade
driven through the raw path still climbs into the cap; the throw itself lives in
`emit`, the checked path documented for sub-emission.

Verified by a 20k-step randomized sub-emitting fuzz (torture Phase G) asserting the
pool invariants (`used + free === size`, `activeCount === pool.active`) every step,
and by named tests for expiry-only firing, born-next-frame, full-pool slot reuse, the
cap throw, and generation `cap+1` never being born.

## Consequence

`releaseAll()` no longer resets (freed particles are reset lazily on reacquire), so a
`clear()` is now a pure pointer move -- cheaper, and still correct because
`update`/`draw` only ever read `[0, active)`.

## References

- `Emitter.js` -- `ParticlePool` (reset-on-acquire), `emit()` cap guard + `_gen`
  stamp, `_fireDeath`, `update()` expiry branch, sealed factory (`_gen`
  non-enumerable).
- `test/Emitter.test.js` -- `onDeath sub-emitter`, `onDeath cascade cap`.
- `test/torture.mjs` -- Phase G (dispatch 0 B/call, fuzz invariants, cascade throw).
- `ROADMAP.md` -- brief P3.
