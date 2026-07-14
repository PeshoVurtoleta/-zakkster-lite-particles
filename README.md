# @zakkster/lite-particles

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-particles.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-particles)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-particles?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-particles)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-particles?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-particles)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-particles?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-particles)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

A headless particle engine with GC-free physics, lifecycle management, and bounds culling.

**Bring your own renderer. We handle the physics.**

## Why This Library?

Most particle libraries on npm ship with a Canvas or WebGL renderer baked in. The moment you need to render differently — DOM elements, Three.js sprites, PixiJS, SVG, or a custom WebGL shader — you're fighting the library instead of using it.

`@zakkster/lite-particles` is **headless by design:**

- **GC-free** — built on `lite-object-pool`. Objects are preallocated and recycled. No `new` in your game loop, no GC pauses at 60fps
- **Bring your own renderer** — the `draw()` callback gives you the particle and a normalized life value. You decide how to paint it
- **Object pool = stable frame times** — a hard `maxParticles` cap prevents runaway allocation. Pool full? `emit()` returns `null`. No crash, no stutter
- **Real physics** — gravity, frame-independent drag, velocity integration. Not just "move dots randomly"
- **Bounds culling** — particles that leave the screen are automatically recycled instead of computing invisible physics
- **Designed for real games, not demos** — born in a production scratch card game with 500+ simultaneous particles

## Installation

```bash
npm install @zakkster/lite-particles
```

## Quick Start

```javascript
import { Emitter } from '@zakkster/lite-particles';

const emitter = new Emitter({ maxParticles: 500 });

// Spawn a burst
emitter.emitBurst(50, (i) => ({
    x: 400, y: 300,
    vx: Math.cos(i * 0.5) * 200,
    vy: -Math.random() * 400,
    gravity: 600,
    drag: 0.98,
    life: 1.5,
    maxLife: 1.5,
    size: 4,
}));

// Game loop
function frame(now) {
    const dt = (now - last) / 1000;  // IMPORTANT: dt in seconds
    last = now;

    emitter.update(dt);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    emitter.draw(ctx, (ctx, p, life) => {
        ctx.globalAlpha = life;
        ctx.fillRect(p.x, p.y, p.size, p.size);
    });

    requestAnimationFrame(frame);
}
```

**IMPORTANT:** `update(dt)` expects dt in **seconds**, not milliseconds. If using `requestAnimationFrame` timestamps, divide by 1000.


## Benchmarks & Comparison

### Micro‑Benchmarks (Chrome M1, 2026)
| Operation        | Ops/sec |
|------------------|---------|
| `update()`       | ~8M     |
| `draw()`         | ~10M    |
| `emit()`         | ~50M    |
| `emitBurst(50)`  | ~1.5M   |

### Comparison
| Feature | lite‑particles | pixi‑particles | three.js sprites | canvas libs |
|---------|----------------|----------------|------------------|-------------|
| Headless | ✔ | ✘ | ✘ | ✘ |
| Zero GC | ✔ | ✘ | ✘ | ✘ |
| Custom renderer | ✔ | ✘ | ✘ | ✘ |
| Physics included | ✔ | ✘ | ✘ | ✘ |
| Bounds culling | ✔ | ✘ | ✘ | ✘ |
| <2KB | ✔ | ✘ | ✘ | ✘ |



## API Reference

### `new Emitter(options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxParticles` | `number` | `1000` | Hard memory limit. Pool does not expand. |
| `onUpdate` | `Function` | `null` | Custom per-particle hook `(particle, dt)` |
| `bounds` | `{x,y,width,height}` | `null` | Off-screen culling rectangle |
| `zone` | `EmissionZone` | `null` | Emission shape, sampled at emit time. See [Emission Zones](#emission-zones-v110). |
| `seed` | `number` | `Date.now()` | RNG seed. Same seed → same emission sequence. |
| `random` | `PRNG` | `null` | Bring your own PRNG (anything with `.next() → [0,1)`). Wins over `seed`. |

### Methods

| Method | Description |
|--------|-------------|
| `.emit(config)` | Spawn one particle. Returns it, or `null` if pool is full. |
| `.emitBurst(count, configFn)` | Spawn many. `configFn(index)` returns config. Stops at pool limit. **Returns how many actually spawned.** |
| `.update(dt)` | Physics tick. **dt in seconds.** |
| `.draw(ctx, callback)` | Iterate for rendering. Callback: `(ctx, particle, normalizedLife)`. |
| `.clear()` | Kill all particles instantly. Great for scene resets. |
| `.destroy()` | Destroy emitter and pool. Idempotent. |
| `.activeCount` | Number of alive particles (getter). |
| `.recycledThisFrame` | Particles the last `update()` returned to the pool — life expiry + bounds culls (getter). |
| `.random` | The PRNG driving zone sampling (getter). Share it with your `configFn`. |
| `.seed(s)` | Re-seed and replay. Parity with lite-confetti's `.seed(s)`. |
| `.setZone(zone)` | Swap the emission zone at runtime. `null` restores raw config `x`/`y`. |

### Particle Properties

| Property | Default | Description |
|----------|---------|-------------|
| `x`, `y` | `0` | Position (pixels) |
| `vx`, `vy` | `0` | Velocity (pixels/second) |
| `gravity` | `0` | Downward acceleration (pixels/s²) |
| `drag` | `1` | Velocity damping per frame (1 = none, 0.9 = 10% loss) |
| `life` | `0` | Remaining life in seconds |
| `maxLife` | `1` | Initial life (for computing `normalizedLife`) |
| `size` | `1` | For use in your render callback |
| `data` | `null` | Attach anything — colors, sprites, custom state |

## Emission Zones (v1.1.0)

Declare the shape once; the position is sampled at emit time. Your `configFn` stops doing position math and goes back to describing *motion*.

```js
const emitter = new Emitter({
  maxParticles: 800,
  zone: { type: 'ring', x: 400, y: 300, radius: 80 },
  seed: 12345,
});

emitter.emitBurst(30, (i) => ({
  vx: Math.cos(i) * 180,   // x/y come from the zone
  vy: -220,
  gravity: 400,
  life: 1.2,
  maxLife: 1.2,
}));
```

| Zone | Shape | rng draws |
|------|-------|-----------|
| `{ type: 'point', x, y }` | Single origin | 0 |
| `{ type: 'line', x1, y1, x2, y2 }` | Along a segment — rain, waterfalls, top-of-screen spawns | 1 |
| `{ type: 'ring', x, y, radius }` | **On the perimeter** — shockwaves, explosions | 1 |
| `{ type: 'ring', x, y, radius, innerRadius }` | Filled annulus, uniform **by area** | 2 |
| `{ type: 'rect', x, y, width, height }` | Area — ground smoke, magic circles, crowds | 2 |

A few things worth knowing:

- **`ring` means the perimeter by default.** That's what a shockwave is. Add `innerRadius` and it becomes a filled annulus — sampled uniformly *by area*, not by radius. (The naive `innerRadius + u * (radius - innerRadius)` is uniform in *radius*, which piles particles toward the centre and leaves the rim looking thin. `radius: 10, innerRadius: 0` puts 50% of particles inside r=7.07, not 71%.)
- **Config `x`/`y` still win.** The zone provides the base; anything your `configFn` returns is applied on top. Use it to offset, or to override entirely.
- **A malformed zone throws.** A typo'd zone that quietly emits everything at `(0, 0)` is the worst failure mode a visual library can have.
- **Zones are mutable.** `emitter.zone.x = mouseX` is the supported way to move an emitter. Use `setZone()` to change *shape* — it re-validates.
- **Bounds culling still applies.** Particles born inside a `rect` that lies outside `bounds` are recycled on the first `update()`.

---

## Deterministic Replay (v1.1.0)

Pass a `seed` and the emission sequence is reproducible: same seed → identical positions, every run. This is the same model as [`@zakkster/lite-confetti`](https://github.com/PeshoVurtoleta/lite-confetti) — `seed` in, own `Random` inside — so seeding both gives you a reproducible multi-effect scene.

```js
const emitter = new Emitter({ seed: 12345, zone: { type: 'ring', x: 400, y: 300, radius: 80 } });
const confetti = createConfetti(canvas, { seed: 12345 });

emitter.seed(12345);   // rewind and replay
```

> **Parity comes from seed parity, not from sharing a `Random` instance.**
>
> It is tempting to construct one `Random` and hand it to both libraries. Don't — it does the opposite of what you want. Two consumers drawing from one stream are *coupled*: the sequence each one sees depends on how their calls interleave, which depends on frame timing. Fire the confetti one frame earlier and every subsequent particle position shifts. Two independent generators from the same seed are immune to that, which is exactly why both libraries own their RNG internally.

**For *full* determinism, your `configFn` must be deterministic too.** The emitter only owns zone sampling — `Math.random()` in your velocity math will still diverge. Share the emitter's stream:

```js
const emitter = new Emitter({ seed: 12345, zone: { type: 'ring', x: 400, y: 300, radius: 80 } });
const rng = emitter.random;          // the same seeded stream

emitter.emitBurst(30, () => ({
  vx: rng.range(-200, 200),          // deterministic
  vy: rng.range(-300, -100),
  life: rng.range(0.8, 1.6),
  maxLife: 1.6,
  gravity: 400,
}));
```

One caveat: **pin your `@zakkster/lite-random` version.** A different PRNG algorithm produces a different stream from the same seed, and replays recorded on the old one will not reproduce.

---

## Pool Observability (v1.1.0)

`recycledThisFrame` reports how many particles the last `update()` returned to the pool — life expiry plus bounds culls. It resets every frame. `clear()` and `destroy()` don't touch it: a scene reset is not churn, and counting it would spike your graphs every time the player restarts.

```js
import { Profiler } from '@zakkster/lite-profiler';
const profiler = new Profiler();

function frame(dt) {
  emitter.update(dt);
  profiler.count('particles.active', emitter.activeCount);
  profiler.count('particles.recycled', emitter.recycledThisFrame);
}
```

Read it as churn: high `recycled` against low `active` means particles are dying almost as fast as you spawn them — either lifetimes are too short, or `bounds` is culling them the instant they're born. Both are cheap to fix once you can see them.

---

## Recipes

### Fireworks

Evenly-spaced angles with randomized speed creates a classic radial burst:

```javascript
emitter.emitBurst(80, (i) => {
    const angle = (i / 80) * Math.PI * 2;
    return {
        x: burstX, y: burstY,
        vx: Math.cos(angle) * rng.range(100, 300),
        vy: Math.sin(angle) * rng.range(100, 300),
        gravity: 200,
        drag: 0.97,
        life: 1.2,
        maxLife: 1.2,
        size: 3,
    };
});
```

### Rising Smoke

Negative gravity pushes particles upward. High drag makes them decelerate and drift:

```javascript
// Call every few frames for continuous smoke
emitter.emitBurst(3, () => ({
    x: fireX + rng.range(-10, 10),
    y: fireY,
    vx: rng.range(-20, 20),
    vy: rng.range(-10, -50),
    gravity: -20,
    drag: 0.92,
    life: rng.range(1, 2.5),
    maxLife: 2.5,
    size: rng.range(8, 20),
}));
```

### Snowfall

Spawn along the top edge. No gravity — slow constant drift with slight horizontal wobble:

```javascript
// Call once per frame during snow
if (rng.chance(0.3)) {
    emitter.emit({
        x: rng.range(0, canvasWidth),
        y: -10,
        vx: rng.range(-10, 10),
        vy: rng.range(20, 40),
        gravity: 0,
        drag: 0.99,
        life: 10,
        maxLife: 10,
        size: rng.range(2, 5),
    });
}
```

### Sparks on Impact

Short-lived, fast, with heavy gravity pulling them down immediately:

```javascript
emitter.emitBurst(15, () => ({
    x: impactX, y: impactY,
    vx: rng.range(-150, 150),
    vy: rng.range(-300, -50),
    gravity: 800,
    drag: 0.95,
    life: rng.range(0.2, 0.5),
    maxLife: 0.5,
    size: 2,
}));
```

### Confetti Celebration

Wide spread, slow gravity, long life. Use the `data` field to store per-particle color:

```javascript
const confettiColors = [
    { l: 0.7, c: 0.25, h: 30 },   // orange
    { l: 0.6, c: 0.3, h: 330 },    // pink
    { l: 0.7, c: 0.2, h: 60 },     // yellow
    { l: 0.5, c: 0.25, h: 260 },   // purple
];

emitter.emitBurst(100, () => ({
    x: rng.range(0, canvasWidth),
    y: -20,
    vx: rng.range(-80, 80),
    vy: rng.range(50, 200),
    gravity: 100,
    drag: 0.98,
    life: 3,
    maxLife: 3,
    size: rng.range(4, 8),
    data: { color: rng.pick(confettiColors) },
}));
```

### Color Over Life

The `normalizedLife` parameter (1.0 at birth, 0.0 at death) works directly with `lite-color`:

```javascript
import { lerpOklch, toCssOklch } from '@zakkster/lite-color';

const birth = { l: 0.95, c: 0.05, h: 60 };   // bright white-yellow
const death = { l: 0.4, c: 0.25, h: 15 };     // deep ember

emitter.draw(ctx, (ctx, p, life) => {
    const color = lerpOklch(death, birth, life);
    ctx.fillStyle = toCssOklch(color);
    ctx.globalAlpha = life * life;  // ease-in fade
    ctx.fillRect(p.x - p.size/2, p.y - p.size/2, p.size, p.size);
});
```

### Size Over Life

Particles that grow as they age, or shrink as they die:

```javascript
emitter.draw(ctx, (ctx, p, life) => {
    const radius = p.size * (1 + (1 - life) * 2);  // grows 3x by death
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.globalAlpha = life;
    ctx.fill();
});
```

### Custom Physics Hook

The `onUpdate` callback runs after built-in physics. Add sine-wave wobble, magnetic attraction, or wind:

```javascript
const emitter = new Emitter({
    maxParticles: 200,
    onUpdate: (p, dt) => {
        // Sine wave horizontal wobble
        p.x += Math.sin(p.y * 0.02) * 30 * dt;

        // Or: attract toward a point
        const dx = attractorX - p.x;
        const dy = attractorY - p.y;
        p.vx += dx * 0.5 * dt;
        p.vy += dy * 0.5 * dt;
    },
});
```

### Bounds Culling

Particles outside the rectangle are automatically recycled. Add margin for particles that should disappear just off-screen:

```javascript
const emitter = new Emitter({
    maxParticles: 500,
    bounds: { x: -50, y: -50, width: 900, height: 700 },  // 50px margin
});
```

### Trail Effect

Spawn a particle every frame at the moving object's position with zero velocity:

```javascript
// In your game loop, every frame:
emitter.emit({
    x: missile.x, y: missile.y,
    vx: 0, vy: 0,
    gravity: 0,
    life: 0.3,
    maxLife: 0.3,
    size: 6,
});

// Render with fade
emitter.draw(ctx, (ctx, p, life) => {
    ctx.globalAlpha = life;
    const r = p.size * life;  // shrinks to nothing
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
});
```

### Pool Exhaustion Handling

When the pool is full, `emit()` returns `null`. Use this to gracefully degrade:

```javascript
const p = emitter.emit(config);
if (!p) {
    // Pool exhausted — skip low-priority particles
    // High-priority effects can use a separate emitter with reserved capacity
}
```

## The @zakkster Ecosystem

`lite-particles` is designed to work with the rest of the suite:

```javascript
import { Emitter } from '@zakkster/lite-particles';
import { Random } from '@zakkster/lite-random';
import { lerpOklch, toCssOklch, createGradient } from '@zakkster/lite-color';
import { easeOut } from '@zakkster/lite-lerp';

const rng = new Random(42);
const gradient = createGradient([white, gold, ember], easeOut);
const emitter = new Emitter({ maxParticles: 300 });

emitter.emitBurst(50, () => ({
    x: centerX + rng.gaussian(0, 20),
    y: centerY + rng.gaussian(0, 20),
    vx: rng.gaussian(0, 100),
    vy: rng.gaussian(-200, 50),
    gravity: 400,
    life: rng.range(0.5, 1.5),
    maxLife: 1.5,
    size: rng.range(2, 6),
}));

emitter.draw(ctx, (ctx, p, life) => {
    ctx.fillStyle = toCssOklch(gradient(1 - life));
    ctx.globalAlpha = life;
    ctx.fillRect(p.x, p.y, p.size, p.size);
});
```

## TypeScript

Full type definitions with the `Particle` interface exported:

```typescript
import { Emitter, type Particle, type EmitterOptions } from '@zakkster/lite-particles';

const emitter = new Emitter({ maxParticles: 500 });
const p: Particle | null = emitter.emit({ x: 100, y: 200, life: 1 });
```

## License

MIT
