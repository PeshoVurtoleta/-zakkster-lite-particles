# 0009 -- follow(target) is world-space: it moves the zone origin, not the particles

- **Status:** accepted (implemented in v1.4.0)
- **Date:** 2026-07-29
- **Session:** P3 (v1.4.0)
- **Findings:** none (roadmap feature)

## Context

`follow(target)` makes an emitter track a moving object (a rocket trailing exhaust, a
cursor trailing sparks). The roadmap fixes the budget: "two property reads per update,
not per particle." The open decision is whether already-emitted particles move WITH
the target (local-space) or stay where they were born (world-space), and how a
null / detached target behaves.

## Options considered

**World-space -- move the zone origin.** Each `update()` reads `target.x`/`target.y`
and writes the zone origin there. New particles spawn at the moved origin; existing
particles are untouched. Cost: two reads and a couple of writes per frame, O(1).

**Local-space -- rigid attach.** Every live particle is re-offset by the target's
per-frame delta, so the whole system rigidly follows (an aura welded to the object).
Cost: per-particle work every frame.

## Decision

**World-space**, chosen with the user. This is the trail effect (a comet's sparks stay
in the world behind it), it matches the roadmap's "two reads, not per particle"
budget, and it reuses the fact -- established in 0006 -- that a zone's **position** is
already live-mutable (only its dimensions are `setZone`-only). Local-space is a
different effect and inherently per-particle, which breaks the very budget this session
exists to protect; it is deliberately not offered.

`follow(target)` stores the target; `follow(null)` stops tracking. It **throws** if
called with no zone to move -- following nothing would otherwise be a silent no-op, and
this library fails loud. At the top of `update()`, before the particle loop:

- point / ring / rect zones: write `zone.x = target.x`, `zone.y = target.y`.
- line zones: translate all four endpoints by the delta from the last tracked origin,
  preserving the segment's shape.

**Fail-closed on a bad target.** If the target is missing or its `x`/`y` are
non-finite (detached, or cleared mid-flight), the move is skipped that frame -- the
zone stays at its last good origin and no `NaN` is ever written. We cannot detect a
GC'd target, so the contract is: set it to `null` (or let its coords go non-finite)
and the zone simply stops moving.

## Consequence

`update()` under an active follow is **0 B/call** (torture Phase G), and world-space
is proven by a test that moves the target 500px and asserts an already-born particle
does not move while a subsequent emit spawns at the new origin. The line-zone delta,
the null/non-finite no-op, and the no-zone throw are each pinned.

## References

- `Emitter.js` -- `follow`, `_trackFollow`, `update()` phase 0.
- `test/Emitter.test.js` -- `follow(target)`.
- `test/torture.mjs` -- Phase G (follow update 0 B/call).
- `ROADMAP.md` -- brief P3.
