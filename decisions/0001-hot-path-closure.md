# 0001 -- The update() hot-path closure and the "GC-free" claim

- **Status:** accepted (records existing behaviour; no code change)
- **Date:** 2026-07-29
- **Session:** P0 (v1.1.1)
- **Findings:** LP-02 (S1)
- **Supersedes:** the informal justification carried in the `Emitter.js` header

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

That is not this session's work. **P0 changes no behaviour and no allocation.**
This record exists so that P1 (v1.2.0) starts from a written baseline instead of
a source comment, and so the throughput number the ledger got right is not lost
when the allocation number it got wrong is corrected.

## Decision

Record both halves; change nothing in P0. The torture gate's **Phase B** is
registered as an XFAIL carrying the measured allocation, so the failure is on
the record and executable rather than prose in a header. P1 owns the fix and
will re-run these numbers and update this record with the third option's
measured throughput cost against the two the ledger already weighed.

## References

- `Emitter.js` -- `update()`, `draw()`, and the header ledger.
- `ROADMAP.md` -- findings LP-02, LP-03; section "On LP-02, fairly".
- `test/torture.mjs` -- Phase B.
- `decisions/0002-runtime-dependencies.md` -- where LP-03's fix would live.
