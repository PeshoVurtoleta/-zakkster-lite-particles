# 0010 -- the SoA rewrite is gated on a falsifiable perf comparison, and the fail-action is decided in advance

- **Status:** accepted (gate authored BEFORE the P4 code, per roadmap sec 6.4)
- **Date:** 2026-07-29
- **Session:** P4 (v2.0.0)
- **Findings:** LP-14 (the v2 payoff), and the roadmap's "P4's gate before P4's code" rule.

## Context

P4 replaces the pooled particle **objects** with parallel typed-array **columns** (SoA).
The justification for the major is the GPU handoff (`packTo`), but the *risk* is that a
column store, while it wins at 100k particles, could LOSE at the small counts most callers
actually run (a few hundred sparks). A rewrite whose decision rule is written AFTER the
benchmark is a rewrite that ships regardless of the number -- the sunk cost of the rewrite
argues for it. So the pass condition and the fail-action are fixed here, before a single
column exists, and the number decides.

This mirrors lite-aabb's A-01 lesson (measure the assumption, do not assume the measurement)
and the roadmap's explicit instruction: "Write the fail action down first."

## Decision

**The gate compares `update()` throughput of the SoA core against the frozen v1.4.0 object
core**, on the same machine and Node, across the particle-count range that matters at both
ends.

- **Baseline:** `test/baseline/EmitterObject.mjs` -- a byte-frozen copy of the shipped
  v1.4.0 `Emitter.js` (object pool), kept under `test/` (never published). It must survive
  the whole session anyway, because the fail-action below can require it.
- **Harness:** `test/bench-soa.mjs`. `captureFingerprint()` stamps machine/runtime provenance
  into the printed table. For each N in **{100, 500, 1000, 10000, 100000}**, pre-fill a steady
  long-lived population OUTSIDE the timed window (so `update()` integrates every frame and
  never releases -- the steady hot loop), then `measureOps(() => e.update(dt))`. Take the
  **median `opsPerSec` over >= 5 reps** per core per N (throughput noise is two-sided; the
  median is the honest centre).

**Pass condition (both must hold):**
1. **No regression beyond noise at 100 / 500 / 1000:** SoA median opsPerSec
   `>= 0.95 x` object median (a 5% two-sided noise band).
2. **A clear win at 10000 and 100000:** SoA median opsPerSec `>= 1.10 x` object median.

**Secondary (allocation parity, not the gate):** `assertCompareOps(objectFn, soaFn, {
maxExtraBytesPerOp: 0 }, opts)` -- the SoA `update()` must not allocate MORE per op than the
object core. (In this profiler version `compareOps` compares allocation/GC budgets, not
throughput, so it corroborates the zero-GC promise; the throughput comparison above is done
directly on `opsPerSec`.)

## Fail-action (decided in advance -- NOT re-litigated after the number)

If condition (1) fails -- SoA regresses `update()` at 100, 500, or 1000 beyond the 5% band --
then **the SoA core does NOT ship as the default `Emitter`.** One of:

- **A. Ship it as a second export `EmitterSoA`**, and keep the object core as the default
  `Emitter`. Callers who want the GPU handoff / 100k scale opt in by name; the common
  few-hundred-particle caller keeps the faster object core. `packTo` lives on `EmitterSoA`.
- **B. Do not ship the SoA core at all** this version, if the regression is large enough that
  a second export is not worth the maintenance of two cores.

The choice between A and B is made when the number is known, but the rule "a small-count
regression forbids SoA-as-default" is fixed here, before the code, so it cannot be argued away
by the effort already spent.

If condition (2) fails -- no clear win at 100k -- the rewrite has no payoff and does not ship;
`packTo` on the object core is a separate, smaller question left to a later version.

## Consequence

`test/bench-soa.mjs` is written and committed before the SoA rewrite; until the SoA core
exists it compares the object core against itself and reports "no win" (expected). Once the
rewrite lands, the printed, fingerprint-stamped table goes verbatim into the CHANGELOG, and
the pass/fail verdict -- not the sunk cost -- decides whether SoA is the default `Emitter`,
a second `EmitterSoA` export, or shelved.

## Result -- the gate FIRED (2026-07-30)

The SoA core was built and measured (Apple M4 Pro, node 26.3.1, reps=5, median opsPerSec):

```
   N     object Mops/s   SoA Mops/s   ratio   verdict
    100         3.771        2.279    0.604    FAIL
    500         0.695        0.457    0.658    FAIL
   1000         0.264        0.226    0.856    FAIL
  10000         0.027        0.020    0.760    FAIL
 100000         0.003        0.002    0.755    FAIL
```

SoA regressed `update()` at **every** count, small AND large -- condition (1) failed hard.
Per the fail-action above, SoA does not ship as the default. The follow-on decision (ship a
second `EmitterSoA` export vs shelve entirely, plus a third option that emerged from the
data -- add `packTo` to the object core, which a hand-written AoS pack showed *ties* SoA) is
recorded in `decisions/0011`. The number decided, exactly as this record required, and the
SoA core is retained as reproducible evidence in `test/baseline/EmitterSoA.mjs` (the bench
still runs against it), never shipped.

## References

- `test/bench-soa.mjs` -- the harness.
- `test/baseline/EmitterObject.mjs` -- the frozen v1.4.0 object core.
- `ROADMAP.md` -- P4 "PACKAGE GATE" and sec 6 "If you only do a subset" #4.
- lite-aabb A-01 -- the cautionary tale on assuming f32/perf without measuring.
