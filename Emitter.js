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
 * v1.3.0 — pin the contract: emit() throws on an unknown config field (custom state
 *          lives in .data) and rejects an invalid lifecycle to null instead of
 *          spawning a dead-on-arrival particle; normalizedLife is clamped to [0,1];
 *          a ring zone always draws 2 rng values, so innerRadius can never desync a
 *          seeded replay (findings LP-01/04/05/06/07/10). Particles are Object.seal'd.
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
export const VERSION = '1.3.0';

const TAU = Math.PI * 2;

/**
 * The particle schema — the only fields emit() will copy from a config object.
 * A key outside this set is rejected (see emit()): custom colours / sprites /
 * metadata belong on `data`, never welded onto the pooled particle, where reset()
 * would miss them and a recycled particle would inherit a dead one's state (LP-01).
 */
const SCHEMA_KEYS = new Set([
    'x', 'y', 'vx', 'vy', 'gravity', 'drag', 'life', 'maxLife', 'size', 'data',
]);
const SCHEMA_FIELDS = '{ x, y, vx, vy, gravity, drag, life, maxLife, size, data }';

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

/**
 * The determinism contract: how many rng.next() draws each zone kind consumes per
 * particle. This footprint is INVARIANT for a zone's whole life — a `ring` always
 * draws 2 (perimeter and annulus alike; the perimeter draws the radius sample and
 * discards it), so mutating `innerRadius` across the perimeter/annulus boundary can
 * never desync a seeded replay (LP-06). Exported and asserted (LP-07): a seeded
 * stream advances by exactly ZONE_DRAWS[zone.type] per emitted particle.
 *
 * Frozen: this is a shared contract, not a scratch object.
 */
export const ZONE_DRAWS = Object.freeze({ point: 0, line: 1, rect: 2, ring: 2 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate and normalize an emission zone. Throws on a malformed zone rather than
 * silently emitting at (0, 0) — a typo'd zone that quietly does nothing is the
 * worst possible failure mode for a visual library.
 *
 * Returns a fresh, mutable object. Mutating the POSITION live is supported — that is
 * how you make a zone follow the mouse (`emitter.zone.x = mouseX`). Changing a
 * DIMENSION (radius, innerRadius, width, height, or a line endpoint) should go through
 * `setZone()`, which re-validates: a raw in-place dimension write skips validation
 * (e.g. innerRadius > radius would sample NaN). It no longer breaks a seeded replay
 * — a ring's rng footprint is constant now (see ZONE_DRAWS) — but it can still emit a
 * malformed shape, so treat dimensions as setZone-only.
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
            // Object.seal pins the shape: a hook, initFn, or emit() config can only
            // write EXISTING fields — welding a stray key (a leaked colour, LP-01)
            // throws instead of surviving reset() onto a recycled particle. Sealing
            // also fixes the hidden class, which is the deopt the pool exists to avoid;
            // writes to existing keys on a sealed object are a V8 win, so the hot path
            // is unaffected (torture Phase B proves 0 B/call and no throughput loss).
            () => Object.seal({
                x: 0, y: 0,
                vx: 0, vy: 0,
                gravity: 0, drag: 1,
                life: 0, maxLife: 1,
                size: 1, data: null, // attach custom colors/sprites/metadata HERE
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

        // ring — ALWAYS two draws (LP-06), theta then a radius sample `u`. Drawing `u`
        // even on the perimeter (ri === ro), where it is discarded, keeps a ring's rng
        // footprint invariant: theta is draw #1 and `u` is draw #2 in BOTH branches, so
        // mutating innerRadius across the perimeter/annulus boundary shifts NO later
        // draw and a seeded replay stays in sync (see ZONE_DRAWS, decisions/0006).
        const theta = rng.next() * TAU;
        const u = rng.next();
        const ro = z.radius;
        const ri = z.innerRadius;
        // Perimeter: r = ro (the shockwave case). Annulus: uniform BY AREA. The naive
        // `ri + u * (ro - ri)` is uniform in radius, which piles particles toward the
        // centre — an annulus emitter would look dense in the middle and thin at the rim.
        const r = (ri === ro) ? ro : Math.sqrt(ri * ri + u * (ro * ro - ri * ri));
        p.x = z.x + Math.cos(theta) * r;
        p.y = z.y + Math.sin(theta) * r;
    }

    /**
     * Spawn a single particle. Returns the particle, or `null` when it cannot be
     * spawned — the pool is full, or the lifecycle is invalid (see below).
     *
     * When a zone is set it supplies the base x/y; anything your config assigns is
     * applied on top, so `config.x` still wins if you want to override or offset.
     *
     * CONTRACT (v1.3.0):
     * - Config keys must be particle fields: {@link SCHEMA_FIELDS}. An unknown key
     *   THROWS a TypeError naming it — a stray `color`/`sprite` welded onto the pooled
     *   object would survive reset() and reappear on a recycled particle (LP-01).
     *   Put custom colours / sprites / metadata on `data` (e.g. `{ data: {...} }`).
     * - `life` and `maxLife` are coupled: give either and the other mirrors it, so the
     *   documented "1.0 at birth -> 0.0 at death" ramp is real. An effective
     *   `life <= 0`, `maxLife <= 0`, or non-finite value is an INVALID emission and
     *   returns `null` (never a dead-on-arrival particle that inflates
     *   recycledThisFrame, LP-05). Immortal effects use a large finite `life`.
     *
     * @param {Object} [config] - Fields to assign (x, y, vx, vy, life, maxLife, ...)
     */
    emit(config) {
        if (this._destroyed) return null;

        let life;
        let maxLife;
        if (config !== null && config !== undefined) {
            // LP-01: reject any non-schema key LOUDLY, BEFORE touching the pool.
            for (const k in config) {
                if (!SCHEMA_KEYS.has(k)) {
                    throw new TypeError(
                        `lite-particles: unknown particle field "${k}" in emit() config -- ` +
                        `attach custom state to .data (e.g. emit({ data: { ${k}: ... } })). ` +
                        `The schema is ${SCHEMA_FIELDS}.`,
                    );
                }
            }
            life = config.life;
            maxLife = config.maxLife;
        }

        // LP-04/LP-05: resolve + validate the lifecycle BEFORE acquire(), so an invalid
        // emission burns neither a pool slot nor an rng draw — it returns null exactly
        // as a full pool does. Couple the fields, then fail closed on a non-positive or
        // non-finite lifespan (undefined fails `> 0`, so a missing life is rejected too).
        if (life === undefined) life = maxLife;
        if (maxLife === undefined) maxLife = life;
        if (!(life > 0) || !Number.isFinite(life)) return null;
        if (!(maxLife > 0) || !Number.isFinite(maxLife)) return null;

        const p = this.pool.acquire();
        if (!p) return null;
        if (this.zone !== null) this._sampleZone(p);
        if (config) Object.assign(p, config);
        // Write the resolved pair — covers the mirrored-default case where the config
        // supplied only one of the two.
        p.life = life;
        p.maxLife = maxLife;
        return p;
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
     * This is the RAW path: `initFn` writes straight onto a sealed particle, so custom
     * state must go on `data` (writing a stray key throws), and the LIFECYCLE IS YOURS
     * — set a positive `life` (and `maxLife`). Unlike `emit`, this does not validate or
     * reject a bad lifespan; a particle left with `life <= 0` simply expires on the next
     * update(). Use `emit` when you want that checked. `draw()` still clamps
     * normalizedLife to [0,1] regardless of what you write here.
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
     * PHASE ORDER (pinned — LP-10). Per particle, every frame:
     *   1. decrement life (`life -= dt`)
     *   2. early death: `life <= 0` -> release, skip the rest of this frame
     *   3. integrate: gravity, then frame-independent drag, then position
     *   4. bounds cull: outside `bounds` -> release
     *   5. `onUpdate(particle, dt)` hook
     * Culling deliberately precedes the hook: a particle culled this frame does NOT
     * see its hook, and a hook cannot pull a culled particle back in bounds. This
     * order is a contract (a named test pins it); a refactor must not reorder it.
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
            // normalizedLife is CLAMPED to [0,1] (LP-04) and NaN-safe: guard maxLife<=0,
            // and the `t > 0` test sends any NaN (from a NaN life/maxLife written by a
            // hook or initFn) to 0, so no NaN reaches the render callback. One divide,
            // two compares — measured neutral on the draw() hot path (torture Phase B).
            const t = p.life / p.maxLife;
            const normalizedLife = (p.maxLife > 0 && t > 0) ? (t < 1 ? t : 1) : 0;
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
