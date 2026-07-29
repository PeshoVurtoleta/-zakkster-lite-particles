/**
 * @zakkster/lite-particles — Headless Particle Engine
 *
 * Handles GC-free physics, lifecycles, and bounds culling.
 * Owns an inline dense free-list (see ParticlePool below) — no runtime object-pool
 * dependency. One runtime dependency remains: @zakkster/lite-random, whose full API
 * is re-exposed via the `random` getter.
 *
 * IMPORTANT: dt is in SECONDS (not milliseconds).
 * If using requestAnimationFrame, divide by 1000: emitter.update(dt / 1000)
 *
 * v1.2.0 — GC-free made true: update()/draw() allocate 0 B/call at every particle
 *          count (finding LP-02/LP-03), and emitEach() is an allocation-free burst.
 * v1.1.0 — emission zones, seeded determinism, recycledThisFrame.
 *
 * NOTE ON THE HOT PATH: v1.1.0's update() carried a per-call `dead` array and a
 * forEachActive closure, and its header claimed escape analysis elided both at
 * ~0 B/frame. Measurement disproved that (~331 B/call on an empty emitter). The
 * header's OTHER claim held up: hoisting that state onto `this` costs a measured
 * 7-8% throughput regression, so that was NOT the fix. The fix is the third option
 * the old ledger never tested — a dense active array iterated in reverse with
 * swap-remove, releasing inline, so the array, the closure and the Set iterator all
 * disappear at once and nothing moves onto `this`. See decisions/0001.
 */

import { Random } from '@zakkster/lite-random';

/** Package version. Kept in three-place sync with package.json and CHANGELOG.md. */
export const VERSION = '1.2.0';

const TAU = Math.PI * 2;

/**
 * Inline dense free-list — the O(1) pool that lite-object-pool used to provide,
 * minus the per-call Set iterator that made the hot path allocate (LP-03).
 *
 * All particle objects are pre-allocated once into `slots`. Active particles occupy
 * `slots[0 .. active-1]`; free ones occupy `slots[active .. size-1]`. acquire() takes
 * the boundary slot; releaseAt(i) swap-removes — the last active particle fills the
 * hole and the released one moves to the free region. That makes reverse iteration
 * with in-place release safe (the swapped-in element sits above the cursor and has
 * already been visited), which is the whole reason update() can drop its `dead[]`
 * buffer. `slots` and `active` are read directly by update()/draw() so those loops
 * need no callback.
 */
class ParticlePool {
    constructor(size, create, reset) {
        this._reset = reset;
        this.size = size;
        this.active = 0;
        this.slots = new Array(size);
        for (let i = 0; i < size; i++) this.slots[i] = create();
    }

    /** O(1). Returns a clean particle, or null when full. */
    acquire() {
        if (this.active >= this.size) return null;
        return this.slots[this.active++];
    }

    /** O(1) swap-remove of the active particle at index `i`, then reset it. */
    releaseAt(i) {
        const slots = this.slots;
        const last = --this.active;
        const p = slots[i];
        slots[i] = slots[last];
        slots[last] = p;
        this._reset(p);
    }

    /** Reset every active particle and empty the active region. */
    releaseAll() {
        const slots = this.slots;
        for (let i = 0; i < this.active; i++) this._reset(slots[i]);
        this.active = 0;
    }

    get used() { return this.active; }
    get free() { return this.size - this.active; }

    destroy() {
        this.slots = null;
        this._reset = null;
        this.active = 0;
    }
}

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

        // Inline dense free-list. Strict, non-expanding memory limit (maxParticles)
        // prevents GC spikes; a full pool returns null from acquire() rather than growing.
        this.pool = new ParticlePool(
            maxParticles,
            () => ({
                x: 0, y: 0,
                vx: 0, vy: 0,
                gravity: 0, drag: 1,
                life: 0, maxLife: 1,
                size: 1, data: null, // attach custom colors/sprites/metadata
            }),
            (p) => {
                p.x = p.y = 0;
                p.vx = p.vy = 0;
                p.gravity = 0;
                p.drag = 1;
                p.life = 0;
                p.maxLife = 1;
                p.size = 1;
                p.data = null;
            },
        );
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
     * Spawn multiple particles at once, writing fields directly onto each particle.
     * The allocation-free burst path — `initFn(p, i)` mutates the pooled particle in
     * place instead of returning a config object, so a 5000-particle burst allocates
     * nothing (finding LP-08).
     *
     * Pool capacity is checked BEFORE `initFn` runs, so a saturated pool consumes
     * neither a call nor an rng draw for a particle it cannot emit (finding LP-09) —
     * matching `_sampleZone`'s acquire-then-sample discipline.
     *
     * When a zone is set it supplies the base x/y first; `initFn` runs after and can
     * override, mirroring `emit`'s "config wins" rule.
     *
     * @param {number}   count  How many to spawn
     * @param {Function} initFn Receives (particle, index); writes fields onto the particle
     * @returns {number} How many were actually emitted (< count when the pool saturated)
     */
    emitEach(count, initFn) {
        if (this._destroyed) return 0;
        let emitted = 0;
        for (let i = 0; i < count; i++) {
            const p = this.pool.acquire();
            if (!p) break; // pool full — stop BEFORE calling initFn (no wasted rng draw)
            if (this.zone !== null) this._sampleZone(p);
            initFn(p, i);
            emitted++;
        }
        return emitted;
    }

    /**
     * Spawn multiple particles at once. Stops early if the pool fills.
     *
     * @deprecated Since v1.2.0. Use {@link Emitter#emitEach}, whose `initFn(p, i)`
     *   writes onto the particle directly and allocates nothing. This config-returning
     *   form allocates one object literal per particle and is removed in v2.0.0.
     *   Migrate: `emitBurst(n, i => ({vx: i}))` -> `emitEach(n, (p, i) => { p.vx = i; })`.
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

        // Dense active array iterated in REVERSE, releasing in place with swap-remove
        // (releaseAt). No `dead[]` buffer, no forEachActive closure, no Set iterator —
        // 0 B/call at every particle count, including a frame where all die at once.
        // Reverse + swap-remove is correct: releaseAt(i) moves the top active particle
        // into slot i, and that element sits above the cursor, already visited.
        const pool = this.pool;
        const slots = pool.slots;
        let deaths = 0;
        let i = pool.active;

        while (i-- > 0) {
            const p = slots[i];
            p.life -= dt;

            if (p.life <= 0) {
                pool.releaseAt(i);
                deaths++;
                continue;
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
                    pool.releaseAt(i);
                    deaths++;
                    continue;
                }
            }

            // Custom user logic
            if (this.onUpdate) this.onUpdate(p, dt);
        }

        // v1.1.0 — frame-perfect churn metric. Life expiry + bounds culls, nothing else.
        this._recycledThisFrame = deaths;
    }

    /**
     * Iterate active particles for rendering.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} renderCallback - (ctx, particle, normalizedLife)
     *   normalizedLife is 1.0 at birth, 0.0 at death — perfect for easing.
     */
    draw(ctx, renderCallback) {
        if (this._destroyed) return;

        // Forward index loop over the dense active region — no closure, no iterator,
        // 0 B/call. draw() never releases, so forward order is fine.
        const pool = this.pool;
        const slots = pool.slots;
        const active = pool.active;
        for (let i = 0; i < active; i++) {
            const p = slots[i];
            const normalizedLife = Math.max(0, p.life / p.maxLife);
            renderCallback(ctx, p, normalizedLife);
        }
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
