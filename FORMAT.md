# Particle column format -- the cross-package contract (LAYOUT_VERSION 1)

Owner: `@zakkster/lite-particles`. This document is the source of truth for the
packed instance layouts that particle producers write and GPU/worker consumers
read. It is **format agreement, not a dependency**: no package gains a runtime
dependency by conforming to it. Each package asserts only the constants it uses.

Status: POINT is **shipped and frozen** (lite-particles v1.5.0 exports
`LAYOUT_VERSION` / `POINT_STRIDE` / `POINT_OFFSETS`). QUAD is **specified here**
for lite-confetti's fork (roadmap F3) to implement against; no shipped package
packs a QUAD yet. See `decisions/0012-column-schema-contract.md` for the six
decisions and their rejected alternatives, and for why this contract was written
*after* P4 rather than before it.

---

## 1. The hard contract: packed float layouts

These are the only shapes that cross a process/GPU boundary, so these are the
only shapes that are frozen. All values are **Float32**, positions are in
**screen pixels** (do any world->screen projection before packing -- lite-gl's
`project` expects screen space), and colour channels are **normalized sRGB in
[0,1]**.

### POINT -- stride 8 (shipped, lite-gl `LAYOUT.POINT`)

| offset | field | meaning |
| --- | --- | --- |
| 0 | x | screen x |
| 1 | y | screen y |
| 2 | size | point diameter, px |
| 3 | r | red, [0,1] sRGB |
| 4 | g | green, [0,1] sRGB |
| 5 | b | blue, [0,1] sRGB |
| 6 | a | alpha, [0,1] |
| 7 | _pad | producer-zeroed; reserved |

`POINT_OFFSETS = { x:0, y:1, size:2, r:3, g:4, b:5, a:6, _pad:7 }` (frozen).
Producer today: `lite-particles` `Emitter.packTo(out, offset) -> count`.
Consumer: a lite-gl POINT sink via
`sink.upload(out, 0, count*POINT_STRIDE, 0, POINT_STRIDE)`.

### QUAD -- stride 9 (specified, lite-gl `LAYOUT.QUAD`)

| offset | field | meaning |
| --- | --- | --- |
| 0 | x | screen x (quad center) |
| 1 | y | screen y (quad center) |
| 2 | w | width, px |
| 3 | h | height, px |
| 4 | rot | rotation, radians |
| 5 | r | red, [0,1] sRGB |
| 6 | g | green, [0,1] sRGB |
| 7 | b | blue, [0,1] sRGB |
| 8 | a | alpha, [0,1] |

`QUAD_OFFSETS = { x:0, y:1, w:2, h:3, rot:4, r:5, g:6, b:7, a:8 }` (stride 9).
QUAD has **no `_pad`**. `rot` reads from a producer's rotation column (confetti's
`spin`). No package exports these constants yet; F3 introduces
`packTo(out, LAYOUT.QUAD)` on lite-confetti and asserts them against this table.

Colour semantics (both layouts): the four channels are written once at emit via
`@zakkster/lite-color` `toRgbTo(color, out, offset)` (normalized sRGB, already
shipped). `a` is the particle's **instantaneous** alpha. Any life-curve fade is
the **producer's** responsibility at or before pack time -- the column carries
whatever alpha the producer put in it; lite-particles packs `a` straight.

---

## 2. The soft contract: simulation columns (never packed)

These live inside a producer and never cross a boundary, so their storage,
element type, and even their spelling are the producer's business. This table
records the **canonical name** for each so two engines describe the same
quantity the same way; a producer may keep an alias without breaking anything,
because these bytes are never read by another package.

| canonical | meaning | lite-particles | lite-confetti |
| --- | --- | --- | --- |
| vx, vy | velocity, px/s | vx, vy | vx, vy |
| gravity | downward accel | gravity | **grav** (alias) |
| drag | per-frame drag | drag | drag |
| life | remaining seconds | life | life |
| maxLife | lifespan seconds | maxLife | **maxL** (alias) |

Canonical spelling = lite-particles', because it owns `LAYOUT_VERSION` and its
names are unabbreviated. The confetti aliases (`grav`, `maxL`) are **sim-only**
-- they never enter POINT or QUAD -- so a rename is a pure internal diff with
zero wire/GPU impact, and is therefore optional, deferred to F3 if confetti ever
wants alignment. It is not required for conformance.

Producer-private columns, not part of any contract: confetti's `spinV`, `tilt`,
`tiltV` (wobble), `shape` (Uint8 enum: 0=rect 1=circle 2=star 3=triangle
4=emoji), `colors` (CSS strings, AoS), `emojis`; lite-particles' `userData`
(numeric handle) and `data` (object escape hatch). None are float columns that
pack, and none appear above.

---

## 3. `size` versus `w`/`h` -- two primitives, not a conflict

POINT carries a scalar `size`; QUAD carries `w`, `h`, `rot`. A point producer
(lite-particles) fills `size`; a quad producer (lite-confetti) fills `w`/`h`.
Neither derivation is forced. Documented optional bridges when a producer must
target the other primitive:

- point -> quad: `w = h = size`, `rot = 0`.
- quad -> point: `size = max(w, h)` (loses rotation and non-square aspect).

`packTo` is therefore **two entry points**, `packTo(out, LAYOUT.POINT)` and
`packTo(out, LAYOUT.QUAD)`, not one buffer walk with a mode flag.

---

## 4. Element type -- Float32, everywhere that packs

Every packed column is Float32. lite-gl instance attributes are f32; lite-worker
`frameChannel` takes an f32 stride and crosses the boundary unmodified
(`i*stride` indexing on both sides); lite-confetti already chose f32 for its
shipped pool. Screen-pixel coordinates and [0,1] colours sit far inside the f32
mantissa (a canvas never approaches 2^23 px), so there is no narrowing cost and
no column needs f64. The one non-f32 producer column, confetti's `shape`
(Uint8), is sim-private and never packs.

---

## 5. Ownership and versioning

- `LAYOUT_VERSION` is owned and exported by lite-particles; it is **1**.
- `LAYOUT_VERSION` bumps **only** when an existing packed layout's field order or
  stride changes. Adding a new layout (QUAD alongside POINT) is additive and
  does **not** bump it -- QUAD is introduced at version 1 as a second layout.
- A consumer asserts the constants it reads (`POINT_STRIDE === 8`,
  `POINT_OFFSETS.a === 6`, etc.) and fails closed on a mismatch, rather than
  trusting the number it compiled against.

---

## 6. Per-package conformance

What each package must assert to claim it honours this contract. Stubs, not
full implementations -- they go green as each package wires the layout.

- **lite-particles** (producer, POINT): shipped. `POINT_STRIDE`/`POINT_OFFSETS`
  match section 1; `packTo` writes `_pad = 0`; round-trip reads back every
  instance's 8 floats. (torture Phase H already does this.)
- **lite-confetti** (producer, QUAD -- F3): once F3 lands, `QUAD_OFFSETS` match
  section 1; `spin -> rot`, `w`/`h` direct; colour written via `toRgbTo` into
  channels 5-8; a QUAD round-trip verifies against a lite-gl QUAD sink.
- **lite-gl** (consumer): `LAYOUT.POINT === 8`, `LAYOUT.QUAD === 9`, field order
  matches sections 1. lite-gl grows **no** `packTo`; producers own packing and
  feed `upload(data, floatOffset, floatCount, instanceOffset, stride)`.
- **lite-worker** (transport): `frameChannel({ stride: 8 })` and `{ stride: 9 }`
  carry a POINT/QUAD field byte-identical across the boundary. Already true --
  the channel is stride-agnostic; nothing to change.
- **lite-ambient-fx** (vendor): if A1 vendors a layout, it vendors these names
  and offsets rather than inventing its own; it never depends on this package.

---

## 7. Mapping ledger -- every shipped column accounted for

lite-confetti v1.2.1 pool (read from `Confetti.js`) against this contract:

| confetti column | contract |
| --- | --- |
| x, y | POINT/QUAD x, y |
| vx, vy | sim: vx, vy |
| spin | QUAD rot (packed) |
| spinV | producer-private (wobble) |
| tilt, tiltV | producer-private (wobble) |
| w, h | QUAD w, h |
| life | sim: life |
| maxL | sim: maxLife (alias) |
| grav | sim: gravity (alias) |
| drag | sim: drag |
| shape (u8) | producer-private enum |
| colors (Array) | must become r,g,b,a to pack QUAD (F3, via toRgbTo) |
| emojis (Array) | producer-private, never packs |

lite-particles v1.5.0 schema against this contract:

| particles field | contract |
| --- | --- |
| x, y | POINT x, y |
| vx, vy, gravity, drag, life, maxLife | sim (canonical speller) |
| size | POINT size |
| r, g, b, a | POINT r, g, b, a (shipped) |
| userData | producer-private numeric handle |
| data | producer-private object escape hatch |

Every packed column above exists in a shipped package or is one of the four
colour channels with its writer named (`toRgbTo`). No package gains a runtime
dependency from this document.
