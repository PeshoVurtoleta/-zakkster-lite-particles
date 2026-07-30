/**
 * @zakkster/lite-particles — Headless Particle Engine
 * (c) Zahary Shinikchiev. MIT.
 */

export interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    gravity: number;
    drag: number;
    /** Remaining life in seconds. */
    life: number;
    /** Life at birth. `life / maxLife` is the normalized life passed to draw(). */
    maxLife: number;
    size: number;
    /** Red channel, [0,1]. Default 1 (opaque white). Fed to the GPU by {@link Emitter.packTo}. */
    r: number;
    /** Green channel, [0,1]. Default 1. */
    g: number;
    /** Blue channel, [0,1]. Default 1. */
    b: number;
    /** Alpha channel, [0,1]. Default 1. */
    a: number;
    /**
     * A numeric handle (v1.5.0) — an integer id into your own registry (sprite table,
     * ECS entity). The GPU/typed-array-friendly sibling of `data`. Default 0.
     */
    userData: number;
    /**
     * The object escape hatch for arbitrary custom state (sprites, closures, metadata).
     * Any field outside this schema must live here (or, if numeric, on `userData`):
     * `emit()` throws on an unknown top-level key, and particles are sealed.
     */
    data: unknown;
}

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Single origin. Consumes 0 rng draws. */
export interface PointZone {
    type: 'point';
    x: number;
    y: number;
}

/** Segment from (x1,y1) to (x2,y2). Rain, waterfalls, top-of-screen spawns. Consumes 1 rng draw. */
export interface LineZone {
    type: 'line';
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * Radial. With no `innerRadius` (the default), particles spawn exactly ON the
 * perimeter — the shockwave / explosion case, 1 rng draw.
 *
 * Give it a smaller `innerRadius` and it becomes a filled annulus, sampled
 * uniformly BY AREA (2 rng draws). Area-uniform matters: the naive
 * `innerRadius + u * (radius - innerRadius)` is uniform in *radius*, which piles
 * particles toward the centre and leaves the rim looking thin.
 */
export interface RingZone {
    type: 'ring';
    x: number;
    y: number;
    radius: number;
    /** Defaults to `radius` (perimeter). Must be in [0, radius]. */
    innerRadius?: number;
}

/** Area emitter — ground smoke, magic circles, crowds. Consumes 2 rng draws. */
export interface RectZone {
    type: 'rect';
    x: number;
    y: number;
    width: number;
    height: number;
}

export type EmissionZone = PointZone | LineZone | RingZone | RectZone;

/** Anything that can produce a float in [0, 1). @zakkster/lite-random's `Random` satisfies this. */
export interface PRNG {
    next(): number;
    reset?(seed: number): unknown;
}

export interface EmitterOptions {
    /** Hard memory limit. The pool does not expand. @default 1000 */
    maxParticles?: number;
    /** Custom per-particle physics hook. */
    onUpdate?: ((particle: Particle, dt: number) => void) | null;
    /**
     * Sub-emitter hook, fired when a particle is released by LIFE EXPIRY (not a bounds
     * cull, not `clear()`/`destroy()`). The particle still holds its death position, so
     * the hook can `emit()` more particles from it (a dying spark spawning embers). A
     * particle emitted here is integrated on the NEXT frame, not this one.
     */
    onDeath?: ((particle: Particle) => void) | null;
    /**
     * Cap on `onDeath` cascade depth (sparks emitting sparks). Generations are tracked
     * per particle; an `emit()` that would exceed this THROWS a `RangeError`. @default 8
     */
    maxCascadeDepth?: number;
    /** Off-screen culling rectangle. */
    bounds?: Bounds | null;
    /** Emission shape, sampled at emit time. Config `x`/`y` still override it. */
    zone?: EmissionZone | null;
    /**
     * Easing curves baked into `Float32Array` LUTs at construction and read on the hot
     * path via {@link Emitter.curve} / {@link Emitter.curveTable} — no `Math.*` per
     * frame. Each entry is any `(t: number) => number` (e.g. from `@zakkster/lite-ease`).
     */
    curves?: Record<string, (t: number) => number> | null;
    /** LUT resolution per curve. @default 256 */
    curveSegments?: number;
    /**
     * RNG seed. Same seed => same emission sequence. Mirrors
     * `createConfetti(canvas, { seed })` exactly: the emitter builds and owns its
     * own `Random` internally.
     *
     * Replay parity across libraries comes from SEED parity, not from sharing one
     * `Random` instance — a shared stream couples the consumers, so their draw
     * order (and output) starts depending on frame timing.
     */
    seed?: number;
    /** Bring your own PRNG. Wins over `seed`. Disables `.seed()`. */
    random?: PRNG | null;
}

/** Package version. In three-place sync with package.json and CHANGELOG.md. */
export declare const VERSION: string;

/**
 * The determinism contract: rng.next() draws consumed per particle by each zone
 * kind. Invariant for a zone's whole life -- a `ring` always draws 2 (perimeter and
 * annulus alike), so mutating `innerRadius` cannot desync a seeded replay. A seeded
 * stream advances by exactly `ZONE_DRAWS[zone.type]` per emitted particle. Frozen.
 */
export declare const ZONE_DRAWS: Readonly<{ point: 0; line: 1; rect: 2; ring: 2 }>;

/**
 * The GPU handoff contract (v1.5.0). {@link Emitter.packTo} writes @zakkster/lite-gl
 * LAYOUT.POINT instances: `POINT_STRIDE` (8) floats per particle, laid out by
 * `POINT_OFFSETS` — (x, y, size, r, g, b, a, _pad), in SCREEN PIXELS. Bump `LAYOUT_VERSION`
 * if the packed shape ever changes.
 */
export declare const LAYOUT_VERSION: number;
export declare const POINT_STRIDE: 8;
export declare const POINT_OFFSETS: Readonly<{ x: 0; y: 1; size: 2; r: 3; g: 4; b: 5; a: 6; _pad: 7 }>;

/** Validate + normalize a zone. Throws on a malformed one. Returns a fresh, mutable object. */
export declare function normalizeZone(zone: EmissionZone | null | undefined): EmissionZone | null;

export declare class Emitter {
    constructor(options?: EmitterOptions);

    onUpdate: ((particle: Particle, dt: number) => void) | null;
    /** Sub-emitter hook fired on life-expiry. See {@link EmitterOptions.onDeath}. */
    onDeath: ((particle: Particle) => void) | null;
    bounds: Bounds | null;
    /** Mutable — move a `point` zone by writing `emitter.zone.x`. Use setZone() to change shape. */
    zone: EmissionZone | null;

    /** Particles currently alive. */
    readonly activeCount: number;

    /**
     * Particles returned to the pool by the most recent `update()` — life expiry
     * plus bounds culling. Resets at the top of every update(). `clear()` and
     * `destroy()` do not touch it: a scene reset is not churn.
     *
     * Pair with `activeCount` and feed both to lite-profiler's `count()`.
     */
    readonly recycledThisFrame: number;

    /** The PRNG driving zone sampling. Share it with your configFn for full determinism. */
    readonly random: PRNG;

    /** Re-seed. Parity with lite-confetti's `.seed(s)`. No-op if you injected `random`. */
    seed(s: number): void;

    /** Swap the emission zone at runtime. `null` restores raw config x/y. */
    setZone(zone: EmissionZone | null): void;

    /**
     * Make the emission zone track a moving target (WORLD-SPACE): each `update()` moves
     * the zone ORIGIN to `target.x`/`target.y` — two reads, O(1), never per-particle.
     * Already-emitted particles stay where they were born (a comet trail). Pass `null`
     * to stop. Throws if no zone is set. A `null`/non-finite target is a per-frame no-op
     * (the zone stays put, no `NaN`).
     */
    follow(target: { x: number; y: number } | null): void;

    /**
     * The baked sampler for a configured curve: `emitter.curve('size')(normalizedLife)`
     * returns the eased value with no easing math on the hot path (a table read + lerp).
     * Hoist it out of your render loop — it is a stable closure. Throws if the name was
     * not configured via `curves`.
     */
    curve(name: string): (t: number) => number;

    /**
     * The raw `Float32Array` LUT behind a configured curve, for a bare index instead of
     * the interpolating sampler. Throws if the name was not configured.
     */
    curveTable(name: string): Float32Array;

    /**
     * Spawn one particle. Returns it, or `null` when it cannot be spawned.
     *
     * Config keys must be particle fields — an unknown key **throws** a `TypeError`
     * (put custom colours/sprites/metadata on `data`). `life`/`maxLife` are coupled
     * (give either and the other mirrors it); an effective non-positive or non-finite
     * lifespan returns `null` rather than a dead-on-arrival particle. Returns `null`
     * when the pool is full.
     *
     * Called from inside `onDeath`, it tags the newborn one cascade generation deeper
     * and **throws** a `RangeError` past `maxCascadeDepth`.
     */
    emit(config?: Partial<Particle>): Particle | null;

    /**
     * Spawn many, writing fields directly onto each particle. Allocation-free:
     * `initFn(p, i)` mutates the pooled particle in place instead of returning a
     * config object. Pool capacity is checked BEFORE `initFn` runs, so a saturated
     * pool consumes no rng draw for a particle it cannot emit. A set zone supplies
     * the base x/y first; `initFn` runs after and can override.
     *
     * The RAW path: `initFn` writes onto a sealed particle (a stray key throws — use
     * `data`), and the lifecycle is yours to set (`life > 0`); unlike `emit` it does
     * not validate. `draw()` still clamps normalizedLife regardless.
     * Returns how many actually spawned (< count when the pool saturates).
     */
    emitEach(count: number, initFn: (particle: Particle, i: number) => void): number;

    /**
     * Spawn many via a config-returning callback.
     *
     * @deprecated Since v1.2.0. Use {@link Emitter.emitEach}, which writes onto the
     * particle directly and allocates nothing. This form allocates one object literal
     * per particle and is removed in v2.0.0.
     * Migrate: `emitBurst(n, i => ({vx: i}))` → `emitEach(n, (p, i) => { p.vx = i; })`.
     *
     * Returns how many actually spawned (< count when the pool saturates).
     */
    emitBurst(count: number, configFn: (i: number) => Partial<Particle>): number;

    /** dt is in SECONDS. From rAF: `update((now - last) / 1000)`. */
    update(dt: number): void;

    /** normalizedLife is 1.0 at birth, 0.0 at death — always clamped to [0,1], never NaN. */
    draw<C>(ctx: C, renderCallback: (ctx: C, particle: Particle, normalizedLife: number) => void): void;

    /**
     * Pack the active particles into a @zakkster/lite-gl `LAYOUT.POINT` buffer and return
     * the count. Each particle writes `POINT_STRIDE` (8) floats — (x, y, size, r, g, b, a,
     * _pad) — read straight from its fields, zero allocation. The GPU handoff (v1.5.0): a
     * Canvas2D system reaches 100k instances in one instanced draw. POINT is SCREEN PIXELS.
     * `out` must hold `offset + activeCount*8` floats or a `RangeError` is thrown (and a
     * non-`Float32Array` `out` throws a `TypeError`).
     *
     *     const buf = new Float32Array(emitter.pool.size * POINT_STRIDE);
     *     const n = emitter.packTo(buf);
     *     sink.upload(buf, 0, n * POINT_STRIDE, 0, POINT_STRIDE);
     */
    packTo(out: Float32Array, offset?: number): number;

    /** Kill all particles instantly. */
    clear(): void;

    /** Destroy the emitter and its pool. Idempotent. */
    destroy(): void;
}

export default Emitter;
