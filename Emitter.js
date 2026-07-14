/**
 * @zakkster/lite-particles — Headless Particle Engine
 *
 * Handles GC-free physics, lifecycles, and bounds culling.
 * Uses lite-object-pool for O(1) acquire/release with double-release protection.
 *
 * IMPORTANT: dt is in SECONDS (not milliseconds).
 * If using requestAnimationFrame, divide by 1000: emitter.update(dt / 1000)
 *
 * v1.1.0 — emission zones, seeded determinism, recycledThisFrame.
 *
 * NOTE ON THE HOT PATH: update()'s `dead` array and its forEachActive closure look
 * like per-frame garbage, and hoisting them onto `this` is the obvious "zero-GC"
 * hardening. It was measured and rejected: V8's escape analysis already elides both
 * (allocation rate is ~0 B/frame either way), and moving the state onto `this` traded
 * fast context-slot reads for property loads — a consistent 7-8% throughput
 * regression. The closure stays.
 */

import ObjectPool from 'lite-object-pool';
import { Random } from '@zakkster/lite-random';

const TAU = Math.PI * 2;

/** Zone kinds, and how many rng.next() draws each consumes per particle. */
const ZONE_DRAWS = { point: 0, line: 1, rect: 2, ring: 1 }; // ring: 2 when it is an annulus

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate and normalize an emission zone. Throws on a malformed zone rather than
 * silently emitting at (0, 0) — a typo'd zone that quietly does nothing is the
 * worst possible failure mode for a visual library.
 *
 * Returns a fresh, mutable object. Mutating `emitter.zone.x` is supported (that is
 * how you make a zone follow the mouse); use `setZone()` to change shape or type.
 */
export function normalizeZone(zone) {
    if (zone === null || zone === undefined) return null;
    if (typeof zone !== 'object') throw new TypeError('lite-particles: zone must be an object or null');

    const t = zone.type;
    switch (t) {
        case 'point':
            if (!isNum(zone.x) || !isNum(zone.y)) throw new TypeError('lite-particles: point zone needs finite x, y');
            return { type: 'point', x: zone.x, y: zone.y };

        case 'line':
            if (!isNum(zone.x1) || !isNum(zone.y1) || !isNum(zone.x2) || !isNum(zone.y2)) {
                throw new TypeError('lite-particles: line zone needs finite x1, y1, x2, y2');
            }
            return { type: 'line', x1: zone.x1, y1: zone.y1, x2: zone.x2, y2: zone.y2 };

        case 'rect':
            if (!isNum(zone.x) || !isNum(zone.y) || !isNum(zone.width) || !isNum(zone.height)) {
                throw new TypeError('lite-particles: rect zone needs finite x, y, width, height');
            }
            return { type: 'rect', x: zone.x, y: zone.y, width: zone.width, height: zone.height };

        case 'ring': {
            if (!isNum(zone.x) || !isNum(zone.y) || !isNum(zone.radius) || zone.radius < 0) {
                throw new TypeError('lite-particles: ring zone needs finite x, y and a non-negative radius');
            }
            // Default innerRadius === radius => the perimeter. That is what "ring" means
            // for a shockwave or explosion. Give it a smaller innerRadius and it becomes
            // a filled annulus, sampled uniformly BY AREA (see _sampleZone).
            const inner = zone.innerRadius === undefined ? zone.radius : zone.innerRadius;
            if (!isNum(inner) || inner < 0 || inner > zone.radius) {
                throw new RangeError('lite-particles: ring innerRadius must be finite and in [0, radius]');
            }
            return { type: 'ring', x: zone.x, y: zone.y, radius: zone.radius, innerRadius: inner };
        }

        default:
            throw new RangeError(`lite-particles: unknown zone type "${t}" (expected point | line | ring | rect)`);
    }
}

export class Emitter {
    /**
     * @param {Object}   options
     * @param {number}   [options.maxParticles=1000] Hard memory limit
     * @param {Function} [options.onUpdate]          Custom per-particle physics hook (particle, dt)
     * @param {Object}   [options.bounds]            { x, y, width, height } for off-screen culling
     * @param {Object}   [options.zone]              Emission shape, sampled at emit time
     * @param {number}   [options.seed]              RNG seed. Same seed => same emission sequence.
     * @param {Object}   [options.random]            Inject your own PRNG. Any object with .next() -> [0,1).
     *                                               Wins over `seed`. Use this to bring a non-lite-random PRNG.
     */
    constructor({
        maxParticles = 1000,
        onUpdate = null,
        bounds = null,
        zone = null,
        seed,
        random = null,
    } = {}) {
        this.onUpdate = onUpdate;
        this.bounds = bounds;
        this.zone = normalizeZone(zone);
        this._destroyed = false;

        if (random !== null && typeof random.next !== 'function') {
            throw new TypeError('lite-particles: options.random must expose a next() -> [0,1) method');
        }
        // Mirrors @zakkster/lite-confetti exactly: seed in, own Random instance inside.
        // Replay parity comes from SEED parity, never from sharing one Random across
        // libraries — a shared stream couples the two consumers, so their draw order
        // (and therefore their output) depends on frame timing. See README.
        this._rng = random ?? new Random(seed ?? Date.now());
        this._ownsRng = random === null;

        this._recycledThisFrame = 0;

        this.pool = new ObjectPool({
            size: maxParticles,
            expand: false, // Strict memory limit prevents GC spikes
            create: () => ({
                x: 0, y: 0,
                vx: 0, vy: 0,
                gravity: 0, drag: 1,
                life: 0, maxLife: 1,
                size: 1, data: null, // attach custom colors/sprites/metadata
            }),
            reset: (p) => {
                p.x = p.y = 0;
                p.vx = p.vy = 0;
                p.gravity = 0;
                p.drag = 1;
                p.life = 0;
                p.maxLife = 1;
                p.size = 1;
                p.data = null;
            },
        });
    }

    /** Number of particles currently alive. */
    get activeCount() {
        return this.pool.used;
    }

    /**
     * How many particles update() returned to the pool on its most recent call —
     * life expiry plus bounds culling. Resets at the top of every update().
     *
     * clear() and destroy() do NOT touch this: it measures the steady-state churn of
     * the simulation, and a scene reset is not churn. Feed it to lite-profiler
     * alongside activeCount to watch pool health.
     */
    get recycledThisFrame() {
        return this._recycledThisFrame;
    }

    /** The PRNG driving zone sampling. Exposed so a configFn can share the stream. */
    get random() {
        return this._rng;
    }

    /**
     * Re-seed the emitter. Parity with lite-confetti's .seed(s).
     * No-op when you injected your own PRNG — that stream is yours to manage.
     */
    seed(s) {
        if (this._destroyed || !this._ownsRng) return;
        this._rng.reset(s);
    }

    /** Swap the emission zone at runtime. Pass null to go back to raw config x/y. */
    setZone(zone) {
        if (this._destroyed) return;
        this.zone = normalizeZone(zone);
    }

    /**
     * Write a sampled position onto the particle. Zero allocation.
     * Only ever called AFTER a successful pool.acquire() — so a full pool never burns
     * an rng draw, and replay stays stable across runs where the pool saturates.
     */
    _sampleZone(p) {
        const z = this.zone;
        const rng = this._rng;

        if (z.type === 'point') {
            p.x = z.x;
            p.y = z.y;
            return;
        }

        if (z.type === 'line') {
            const t = rng.next();
            p.x = z.x1 + (z.x2 - z.x1) * t;
            p.y = z.y1 + (z.y2 - z.y1) * t;
            return;
        }

        if (z.type === 'rect') {
            p.x = z.x + rng.next() * z.width;
            p.y = z.y + rng.next() * z.height;
            return;
        }

        // ring
        const theta = rng.next() * TAU;
        const ro = z.radius;
        const ri = z.innerRadius;
        let r;
        if (ri === ro) {
            r = ro; // perimeter — the shockwave case, 1 draw
        } else {
            // Uniform BY AREA. The naive `ri + rng() * (ro - ri)` is uniform in radius,
            // which piles particles up toward the centre — an annulus emitter would look
            // visibly dense in the middle and thin at the rim.
            r = Math.sqrt(ri * ri + rng.next() * (ro * ro - ri * ri));
        }
        p.x = z.x + Math.cos(theta) * r;
        p.y = z.y + Math.sin(theta) * r;
    }

    /**
     * Spawn a single particle. Returns the particle, or null if the pool is full.
     *
     * When a zone is set it supplies the base x/y; anything your config returns is
     * applied on top, so `config.x` still wins if you want to override or offset.
     *
     * @param {Object} [config] - Properties to assign (x, y, vx, vy, life, ...)
     */
    emit(config) {
        if (this._destroyed) return null;
        const p = this.pool.acquire();
        if (!p) return null;
        if (this.zone !== null) this._sampleZone(p);
        return config ? Object.assign(p, config) : p;
    }

    /**
     * Spawn multiple particles at once. Stops early if the pool fills.
     *
     * @param {number}   count    How many to spawn
     * @param {Function} configFn Receives index i, returns config object
     * @returns {number} How many were actually emitted (< count when the pool saturated)
     */
    emitBurst(count, configFn) {
        let emitted = 0;
        for (let i = 0; i < count; i++) {
            if (!this.emit(configFn(i))) break; // stop if pool fills
            emitted++;
        }
        return emitted;
    }

    /** Instantly kill all particles (great for scene resets). */
    clear() {
        if (this._destroyed) return;
        this.pool.releaseAll();
    }

    /**
     * Core physics update. Call this in your game loop.
     *
     * IMPORTANT: dt must be in SECONDS.
     * If using rAF timestamps: emitter.update((now - last) / 1000)
     *
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        if (this._destroyed) return;

        // Collect dead particles separately to avoid modifying the Set
        // during iteration (pool.forEachActive iterates _out)
        const dead = [];

        this.pool.forEachActive((p) => {
            p.life -= dt;

            if (p.life <= 0) {
                dead.push(p);
                return;
            }

            // Physics integration
            p.vy += p.gravity * dt;

            // Frame-independent drag
            if (p.drag !== 1) {
                const dragFactor = Math.pow(p.drag, dt * 60);
                p.vx *= dragFactor;
                p.vy *= dragFactor;
            }

            p.x += p.vx * dt;
            p.y += p.vy * dt;

            // Bounds culling
            if (this.bounds) {
                const b = this.bounds;
                if (p.x < b.x || p.x > b.x + b.width ||
                    p.y < b.y || p.y > b.y + b.height) {
                    dead.push(p);
                    return;
                }
            }

            // Custom user logic
            if (this.onUpdate) this.onUpdate(p, dt);
        });

        // Release dead particles after iteration
        for (const p of dead) this.pool.release(p);

        // v1.1.0 — frame-perfect churn metric. Life expiry + bounds culls, nothing else.
        this._recycledThisFrame = dead.length;
    }

    /**
     * Iterate active particles for rendering.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} renderCallback - (ctx, particle, normalizedLife)
     *   normalizedLife is 1.0 at birth, 0.0 at death — perfect for easing.
     */
    draw(ctx, renderCallback) {
        if (this._destroyed) return;

        this.pool.forEachActive((p) => {
            const normalizedLife = Math.max(0, p.life / p.maxLife);
            renderCallback(ctx, p, normalizedLife);
        });
    }

    /**
     * Destroy the emitter and its underlying object pool.
     * Idempotent — safe to call multiple times.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.pool.destroy();
        this.onUpdate = null;
        this.bounds = null;
        this.zone = null;
    }
}

export default Emitter;
