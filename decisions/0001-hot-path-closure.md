# 0001 -- The update() hot-path closure and the "GC-free" claim

- **Status:** accepted; **resolved in P1 (v1.2.0)** -- the third option below was
  implemented and the allocation is now 0 B/call. Originally written in P0 to
  record the baseline.
- **Date:** 2026-07-29 (P0); updated 2026-07-29 (P1 with measured results)
- **Findings:** LP-02 (S1), LP-03 (S2)
- **Sessions:** P0 (v1.1.1) recorded it; P1 (v1.2.0) fixed it
- **Supersedes:** the informal justification carried in the `Emitter.js` header
- **See also:** decisions/0003 (where the fix landed)

## Context

`Emitter.js`'s header carries a rejection ledger that lived nowhere else in the
repo. This record transcribes it and corrects the half of it that measurement
does not support.

The header, verbatim in intent:

> `update()`'s `dead` array and its `forEachActive` closure look like per-frame
> garbage, and hoisting them onto `this` is the obvious "zero-GC" hardening. It
> was measured and rejected: V8's escape analysis already elides both
> (allocation rate is ~0 B/frame either way), and moving the state onto `this`
> traded fast context-slot reads for property loads -- a consistent 7-8%
> throughput regression. The closure stays.

Two claims are bundled there. They do not stand or fall together.

## What holds up

**The throughput finding.** Hoisting the per-call state (`dead`, and the arrow
passed to `forEachActive`) onto `this` was measured at a **7-8% throughput
regression** -- fast context-slot reads became property loads on the hot body.
This roadmap does not re-run that comparison and has no reason to doubt it.
Believe it; do not re-litigate it in P1.

## What does not

**The allocation claim.** "Allocation rate is ~0 B/frame either way" is false.
Measured on 1.1.0 (`--expose-gc`, forced settle, 1000 calls, `heapUsed` delta):

| Call | Population | Allocation |
| --- | --- | --- |
| `update()` | 0 particles | **~331 B/call** |
| `draw()` | 0 particles | **~243 B/call** |
| `update()` | 1000 alive, 0 dying | **~251 B/call** |

At 60 fps that is roughly **35 KB/s of garbage before a single particle
exists**. Escape analysis is not eliding the `dead = []` buffer and the
per-call arrow the way the header assumes. The package header advertises
"GC-free physics"; on this path it is not.

## The third option the ledger never tested

The original comparison had exactly two arms: keep the closure, or hoist its
state onto `this`. It rejected the second on throughput and stopped. There is a
third:

**Remove the `dead[]` buffer entirely.** It exists *only* because you cannot
delete from a `Set` while iterating it, and `ObjectPool._out` is a `Set`
(finding LP-03). With a dense active array iterated in reverse you release
inline -- the closure, the array, and the `for...of` iterator all disappear
together, and nothing moves onto `this`, so the 7-8% regression is not paid.

In P0 this was not yet done: P0 changed no behaviour and no allocation, and this
record existed so that P1 started from a written baseline instead of a source
comment. **P1 took the third option** -- see the result below and decisions/0003.

## P1 result (v1.2.0): the third option, measured

The `dead[]` buffer was removed by replacing `lite-object-pool`'s `Set` with an
inline dense free-list iterated in reverse with swap-remove (decisions/0003). The
closure, the array, and the Set iterator all disappeared together; nothing moved
onto `this`, so the regression the ledger feared was never in play.

**Allocation** (`--expose-gc`, forced settle, min of 3 reps):

| Call | 1.1.0 | 1.2.0 |
| --- | --- | --- |
| `update()` @ 0 particles | ~331 B/call | **~0** (0.07, noise) |
| `draw()` @ 0 particles | ~243 B/call | **0** |
| `update()` @ 1000 alive | ~251 B/call | **0** |

A 200k-op `update()` window is clean at **major=0, minor=0**.

**Throughput** -- the number the ledger cared about, `update()` on 1000 live
particles, `measureOps`, 3 reps, same machine/Node, expressed against the 1.1.0
closure+Set baseline:

| Option | Relative throughput |
| --- | --- |
| keep closure + Set (1.1.0 baseline) | 100% |
| hoist state onto `this` (the ledger's rejected arm) | ~99.7% here |
| **dense free-list, reverse swap-remove (SHIPPED)** | **100.4% - 109.5%** |

The shipped option costs **no measurable throughput** -- it is neutral-to-slightly
faster across reps, never slower -- while taking allocation to zero. Two honest
caveats: (1) the ledger's original **7-8%** regression for the hoist arm did **not**
reproduce on this Node 26 / this hardware (it measured ~neutral); per the roadmap's
instruction we do not re-litigate that historical figure -- and it does not matter,
because the shipped option is a *different arm entirely* (it removes the array
rather than relocating it). (2) These are steady-state `update()` numbers at 1k
particles; the informational `update()@1k throughput` line in torture keeps the
current machine's number on record for future comparison.

## Decision

**Take the third option.** Removing the `dead[]` buffer via a dense array with
reverse swap-remove is the one move that clears LP-02 and LP-03 at zero throughput
cost and without touching `this` -- so the ledger's throughput finding is respected
rather than tested against. Torture **Phase B** was promoted from an XFAIL to a
**hard gate** (`STRICT_PHASE_B = true`) that fails the build if `update()`/`draw()`
allocate again. The header's "GC-free physics" claim is now true and enforced.

## References

- `Emitter.js` -- `update()`, `draw()`, and the header ledger.
- `ROADMAP.md` -- findings LP-02, LP-03; section "On LP-02, fairly".
- `test/torture.mjs` -- Phase B.
- `decisions/0002-runtime-dependencies.md` -- where LP-03's fix would live.
