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
    /**
     * The ONE escape hatch for custom state (colours, sprites, metadata). Any field
     * outside this schema must live here: `emit()` throws on an unknown top-level key,
     * and particles are sealed, so a stray property cannot be welded on elsewhere.
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
    /** Off-screen culling rectangle. */
    bounds?: Bounds | null;
    /** Emission shape, sampled at emit time. Config `x`/`y` still override it. */
    zone?: EmissionZone | null;
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

/** Validate + normalize a zone. Throws on a malformed one. Returns a fresh, mutable object. */
export declare function normalizeZone(zone: EmissionZone | null | undefined): EmissionZone | null;

export declare class Emitter {
    constructor(options?: EmitterOptions);

    onUpdate: ((particle: Particle, dt: number) => void) | null;
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
     * Spawn one particle. Returns it, or `null` when it cannot be spawned.
     *
     * Config keys must be particle fields — an unknown key **throws** a `TypeError`
     * (put custom colours/sprites/metadata on `data`). `life`/`maxLife` are coupled
     * (give either and the other mirrors it); an effective non-positive or non-finite
     * lifespan returns `null` rather than a dead-on-arrival particle. Returns `null`
     * when the pool is full.
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

    /** Kill all particles instantly. */
    clear(): void;

    /** Destroy the emitter and its pool. Idempotent. */
    destroy(): void;
}

export default Emitter;
