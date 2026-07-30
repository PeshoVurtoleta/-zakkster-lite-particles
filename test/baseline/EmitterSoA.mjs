/**
 * @zakkster/lite-particles — Headless Particle Engine (Structure-of-Arrays core)
 *
 * Handles GC-free physics, lifecycles, and bounds culling. One runtime dependency:
 * @zakkster/lite-random, whose full API is re-exposed via the `random` getter.
 *
 * IMPORTANT: dt is in SECONDS (not milliseconds).
 * If using requestAnimationFrame, divide by 1000: emitter.update(dt / 1000)
 *
 * v2.0.0 — SoA core + GPU handoff (BREAKING). Pooled particle OBJECTS become parallel
 *          typed-array COLUMNS (Structure-of-Arrays). update()/draw()/onDeath/onUpdate/
 *          emitEach stop passing a particle object and pass an INDEX + a stable `cols`
 *          view of the typed arrays: `cb(ctx, i, cols, normalizedLife)`, read as
 *          `cols.x[i]`. `emit(config)` survives (config still validated) but RETURNS THE
 *          INDEX (>= 0) or -1, not a particle. The `data` escape hatch is gone; per-
 *          particle metadata is one `userData` Uint32Array column — an integer handle
 *          into the caller's own registry (you cannot store an object reference in a
 *          typed array without reintroducing the GC this core exists to avoid). The
 *          schema gains r,g,b,a colour columns ([0,1]). `packTo(out, offset)` writes the
 *          render columns straight into a @zakkster/lite-gl LAYOUT.POINT buffer
 *          (x, y, size, r, g, b, a, _pad) — zero allocation, no downcast, no math — so a
 *          Canvas2D particle system becomes a 100k-instance GPU one with one method.
 *          All columns are Float32Array, including x/y/vx/vy: particles are ephemeral and
 *          screen-scale, so f32 is exact to sub-pixel and packTo is a plain copy; f64 was
 *          rejected (it doubles the hot-loop working set for precision the f32 GPU
 *          boundary discards every frame). Consequence: stored x/y differ from 1.x (which
 *          held f64 in object fields) in the low bits for the same seed — the rng STREAM
 *          is identical, only stored precision changed (sub-pixel). emitBurst is removed.
 *          See decisions/0010-0013 and the migration guide in README / CHANGELOG.
 * v1.4.0 — lifecycle hooks: onDeath sub-emitter, curves LUT, follow(target). See 0007-0009.
 * v1.3.0 — pin the contract: strict emit schema, coupled lifecycle, clamped normalizedLife,
 *          constant ring rng footprint (LP-01/04/05/06/07/10). See decisions/0004-0006.
 * v1.2.0 — GC-free made true: update()/draw() 0 B/call at every count (LP-02/03).
 * v1.1.0 — emission zones, seeded determinism, recycledThisFrame.
 */

import { Random } from '@zakkster/lite-random';

/** Package version. Kept in three-place sync with package.json and CHANGELOG.md. */
export const VERSION = '2.0.0';

const TAU = Math.PI * 2;

/**
 * The writable particle schema — the only keys emit()/a config may assign, each the name
 * of a column. A key outside this set is rejected (see emit()): custom identity/metadata
 * belongs on the `userData` integer column (a handle into your own registry), never welded
 * onto the store where it would break the pure-SoA, zero-GC contract.
 */
const SCHEMA_KEYS = new Set([
    'x', 'y', 'vx', 'vy', 'gravity', 'drag', 'life', 'maxLife', 'size', 'r', 'g', 'b', 'a', 'userData',
]);
const SCHEMA_FIELDS = '{ x, y, vx, vy, gravity, drag, life, maxLife, size, r, g, b, a, userData }';

/**
 * The GPU handoff contract (v2.0.0). packTo() writes @zakkster/lite-gl LAYOUT.POINT
 * instances: 8 floats per particle, (x, y, size, r, g, b, a, _pad). SCREEN PIXELS — do any
 * world->screen projection before packing, exactly as lite-gl's `project` expects. A buffer
 * another package reads is a contract, so the stride, the field offsets, and a version are
 * exported and frozen (bump LAYOUT_VERSION if the packed shape ever changes).
 */
export const LAYOUT_VERSION = 1;
export const POINT_STRIDE = 8;
export const POINT_OFFSETS = Object.freeze({ x: 0, y: 1, size: 2, r: 3, g: 4, b: 5, a: 6, _pad: 7 });

/**
 * Structure-of-Arrays particle store — parallel typed-array columns, one slot per particle.
 * Active particles occupy `[0, active)`; free slots are `[active, size)`. This replaces the
 * v1.x object pool: there is no per-particle object, so update()/draw() stream contiguous
 * columns (cache-friendly) and there is nothing for the GC to walk.
 *
 * All physics/render fields are Float32Array (see the v2.0.0 header for why not f64).
 * `userData` is a Uint32Array foreign key. `_gen` (Uint16Array, internal) is the onDeath
 * cascade generation and is deliberately NOT in the public `cols` view.
 *
 * RESET-ON-ACQUIRE (from decisions/0007). A slot is cleared by acquire(), NOT by releaseAt().
 * releaseAt(i) swap-EXCHANGES the row at i with the boundary row, so a just-released particle
 * keeps its dying values at the freed boundary index (= `active` after the decrement) — which
 * is what lets update() release a dying particle BEFORE firing onDeath(i, cols): the hook
 * reads the death x/y, a 1:1 sub-emitter reuses that very slot, and a cap-exceeded throw
 * leaves the store already consistent. update()/draw() only read `[0, active)`, so stale
 * values in the free region are never observed.
 */
class ParticleColumns {
    constructor(size) {
        this.size = size;   // capacity — pool.size / pool.free / pool.used are the v1.x contract
        this.active = 0;

        const f32 = () => new Float32Array(size);
        // The stable view handed to every callback. The MAPPING is frozen (same object, same
        // column references every frame — 0 alloc to pass); the array CONTENTS are mutable.
        this.cols = {
            x: f32(), y: f32(), vx: f32(), vy: f32(),
            gravity: f32(), drag: f32(),
            life: f32(), maxLife: f32(), size: f32(),
            r: f32(), g: f32(), b: f32(), a: f32(),
            userData: new Uint32Array(size),
        };
        Object.freeze(this.cols);

        // Cascade generation, internal. Uint16 (not Uint8) so a large maxCascadeDepth cannot
        // silently wrap; never exposed in `cols` (keeps the public shape exactly the schema).
        this._gen = new Uint16Array(size);
    }

    /**
     * O(1). Clears the boundary slot (reset-on-acquire) and returns its index, or -1 when full.
     * Colour defaults to opaque white so a particle emitted without a colour is still visible.
     */
    acquire() {
        if (this.active >= this.size) return -1;
        const i = this.active++;
        const c = this.cols;
        c.x[i] = 0; c.y[i] = 0; c.vx[i] = 0; c.vy[i] = 0;
        c.gravity[i] = 0; c.drag[i] = 1;
        c.life[i] = 0; c.maxLife[i] = 1; c.size[i] = 1;
        c.r[i] = 1; c.g[i] = 1; c.b[i] = 1; c.a[i] = 1;
        c.userData[i] = 0;
        this._gen[i] = 0;
        return i;
    }

    /**
     * O(1) swap-remove of the active row at index `i`. EXCHANGES row i with the last active
     * row (via temporaries), then shrinks — so the released row survives at index `active`
     * (the freed boundary) for onDeath to read, and the previously-last row (already visited
     * by update()'s reverse scan) fills the hole. When i is already the boundary, only the
     * count shrinks. Reset happens later, on reacquire.
     */
    releaseAt(i) {
        const last = --this.active;
        if (i === last) return;
        const c = this.cols;
        swapF(c.x, i, last); swapF(c.y, i, last); swapF(c.vx, i, last); swapF(c.vy, i, last);
        swapF(c.gravity, i, last); swapF(c.drag, i, last);
        swapF(c.life, i, last); swapF(c.maxLife, i, last); swapF(c.size, i, last);
        swapF(c.r, i, last); swapF(c.g, i, last); swapF(c.b, i, last); swapF(c.a, i, last);
        swapF(c.userData, i, last);
        swapF(this._gen, i, last);
    }

    /** Empty the active region — a pointer move; freed rows are reset lazily on reacquire. */
    releaseAll() { this.active = 0; }

    get used() { return this.active; }
    get free() { return this.size - this.active; }

    destroy() {
        this.cols = null;
        this._gen = null;
        this.active = 0;
    }
}

/** Swap two elements of a typed array. Allocation-free; the one temp is a stack scalar. */
function swapF(arr, i, j) {
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
}

/**
 * The determinism contract: how many rng.next() draws each zone kind consumes per particle.
 * A `ring` ALWAYS draws 2 (perimeter and annulus alike; the perimeter draws the radius sample
 * and discards it), so mutating `innerRadius` across the perimeter/annulus boundary can never
 * desync a seeded replay (LP-06). Frozen: a shared contract, not a scratch object.
 */
export const ZONE_DRAWS = Object.freeze({ point: 0, line: 1, rect: 2, ring: 2 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate and normalize an emission zone. Throws on a malformed zone rather than silently
 * emitting at (0, 0). Returns a fresh, mutable object. Mutating the POSITION live is supported
 * (that is how a zone follows the mouse); changing a DIMENSION should go through setZone().
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
     * @param {number}   [options.maxParticles=1000] Hard memory limit (column length)
     * @param {Function} [options.onUpdate]          Per-particle physics hook (i, cols, dt)
     * @param {Function} [options.onDeath]           Sub-emitter hook (i, cols) fired on life-expiry
     * @param {number}   [options.maxCascadeDepth=8] onDeath cascade cap; emit past it THROWS
     * @param {Object}   [options.bounds]            { x, y, width, height } for off-screen culling
     * @param {Object}   [options.zone]              Emission shape, sampled at emit time
     * @param {Object}   [options.curves]            { name: (t)=>number } baked into Float32Array LUTs
     * @param {number}   [options.curveSegments=256] LUT resolution per curve
     * @param {number}   [options.seed]              RNG seed. Same seed => same emission sequence.
     * @param {Object}   [options.random]            Inject your own PRNG (.next() -> [0,1)). Wins over seed.
     */
    constructor({
        maxParticles = 1000,
        onUpdate = null,
        onDeath = null,
        maxCascadeDepth = 8,
        bounds = null,
        zone = null,
        curves = null,
        curveSegments = 256,
        seed,
        random = null,
    } = {}) {
        this.onUpdate = onUpdate;
        this.onDeath = onDeath;
        this.bounds = bounds;
        this.zone = normalizeZone(zone);
        this._destroyed = false;

        // onDeath cascade guard. `_emitGen` is the generation stamped onto a particle emitted
        // RIGHT NOW: 0 for a normal emit, and (dying particle's _gen + 1) inside _fireDeath().
        this._maxCascadeDepth = maxCascadeDepth;
        this._emitGen = 0;

        // follow(target) state — world-space: move the ZONE ORIGIN each update(), never the
        // live particles. `_followX/_followY` remember the last origin so a line zone can be
        // translated by delta.
        this._follow = null;
        this._followX = 0;
        this._followY = 0;

        // curves: bake each easing fn into a Float32Array LUT once, here (cold).
        this._curveLuts = null;
        this._curveFns = null;
        if (curves !== null && curves !== undefined) this._bakeCurves(curves, curveSegments);

        if (random !== null && typeof random.next !== 'function') {
            throw new TypeError('lite-particles: options.random must expose a next() -> [0,1) method');
        }
        // Mirrors @zakkster/lite-confetti: seed in, own Random instance inside. Replay parity
        // comes from SEED parity, never from sharing one Random across libraries.
        this._rng = random ?? new Random(seed ?? Date.now());
        this._ownsRng = random === null;

        this._recycledThisFrame = 0;

        // SoA column store. Strict, non-expanding memory limit (maxParticles): a full store
        // returns -1 from acquire() rather than growing, so there is no GC spike.
        this.pool = new ParticleColumns(maxParticles);
    }

    /** Number of particles currently alive. */
    get activeCount() {
        return this.pool.used;
    }

    /**
     * The stable column view — the same object every frame, so hoist it once
     * (`const cols = emitter.cols`) and index by particle: `cols.x[i]`. null after destroy().
     * Contains the writable schema columns; the private cascade generation is not exposed.
     */
    get cols() {
        return this._destroyed ? null : this.pool.cols;
    }

    /**
     * How many particles update() returned to the store on its most recent call — life expiry
     * plus bounds culling. Resets at the top of every update(). clear()/destroy() do NOT touch
     * it: a scene reset is not steady-state churn.
     */
    get recycledThisFrame() {
        return this._recycledThisFrame;
    }

    /** The PRNG driving zone sampling. Exposed so an initFn/onDeath can share the stream. */
    get random() {
        return this._rng;
    }

    /** Re-seed the emitter. No-op when you injected your own PRNG — that stream is yours. */
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
     * Bake a { name: (t)=>number } map of easing functions into Float32Array LUTs and pre-build
     * one sampler closure per name. Cold — runs once at construction.
     */
    _bakeCurves(curves, segments) {
        if (typeof curves !== 'object') {
            throw new TypeError('lite-particles: options.curves must be a { name: (t)=>number } object');
        }
        const seg = segments | 0;
        if (!(seg >= 2)) throw new RangeError('lite-particles: curveSegments must be an integer >= 2');
        const N1 = seg - 1;

        const luts = {};
        const fns = {};
        for (const name in curves) {
            const fn = curves[name];
            if (typeof fn !== 'function') {
                throw new TypeError(`lite-particles: curve "${name}" must be a (t)=>number function`);
            }
            const lut = new Float32Array(seg);
            for (let j = 0; j < seg; j++) lut[j] = fn(j / N1);
            luts[name] = lut;
            fns[name] = (t) => {
                if (t <= 0) return lut[0];
                if (t >= 1) return lut[N1];
                const x = t * N1;
                const i = x | 0;
                return lut[i] + (lut[i + 1] - lut[i]) * (x - i);
            };
        }
        this._curveLuts = luts;
        this._curveFns = fns;
    }

    /**
     * The baked sampler for a named curve: `emitter.curve('size')(normalizedLife)` returns the
     * eased value with no easing math on the hot path. HOIST it out of your render loop. Throws
     * if the name was not configured (fail closed).
     * @param {string} name
     * @returns {(t:number)=>number}
     */
    curve(name) {
        const fn = this._curveFns && this._curveFns[name];
        if (!fn) throw new TypeError(`lite-particles: no curve named "${name}" (configure it via new Emitter({ curves }))`);
        return fn;
    }

    /**
     * The raw Float32Array LUT behind a named curve, for callers who want a bare index. Throws
     * if the name was not configured.
     * @param {string} name
     * @returns {Float32Array}
     */
    curveTable(name) {
        const lut = this._curveLuts && this._curveLuts[name];
        if (!lut) throw new TypeError(`lite-particles: no curve named "${name}" (configure it via new Emitter({ curves }))`);
        return lut;
    }

    /**
     * Make the emission zone track a moving target (world-space). Each update() reads target.x
     * / target.y and moves the ZONE ORIGIN there — two property reads, O(1), never per-particle.
     * Particles already emitted stay where they were born (a comet trail).
     *
     * Pass null to stop. Requires a zone (throws otherwise — fail loud). If the target later
     * goes non-object or its x/y non-finite, update() skips the move that frame (no NaN written).
     *
     * @param {{x:number,y:number}|null} target
     */
    follow(target) {
        if (this._destroyed) return;
        if (target === null || target === undefined) {
            this._follow = null;
            return;
        }
        if (this.zone === null) {
            throw new TypeError('lite-particles: follow(target) needs a zone to move -- set one via new Emitter({ zone }) or setZone() first');
        }
        this._follow = target;
        const z = this.zone;
        this._followX = z.type === 'line' ? z.x1 : z.x;
        this._followY = z.type === 'line' ? z.y1 : z.y;
    }

    /** Move the zone origin to the followed target. Called at the TOP of update(). No-op on a
     *  missing/non-finite target (fail closed, no NaN). */
    _trackFollow() {
        const t = this._follow;
        if (t === null || typeof t !== 'object') return;
        const tx = t.x;
        const ty = t.y;
        if (!(typeof tx === 'number' && Number.isFinite(tx) &&
              typeof ty === 'number' && Number.isFinite(ty))) return;

        const z = this.zone;
        if (z === null) return;
        if (z.type === 'line') {
            const dx = tx - this._followX;
            const dy = ty - this._followY;
            z.x1 += dx; z.y1 += dy;
            z.x2 += dx; z.y2 += dy;
        } else {
            z.x = tx;
            z.y = ty;
        }
        this._followX = tx;
        this._followY = ty;
    }

    /**
     * Fire the onDeath sub-emitter for an expired particle. COLD — only runs on a death with a
     * hook set, so its try/finally (which would deopt update()'s hot loop) is isolated here.
     * `idx` is the freed boundary slot still holding the dying row; `g` is that row's captured
     * generation, so any emit() the hook makes stamps its newborns one level deeper. Always
     * clears _emitGen — even when emit() throws the cascade-cap RangeError.
     */
    _fireDeath(idx, g) {
        this._emitGen = g + 1;
        try {
            this.onDeath(idx, this.pool.cols);
        } finally {
            this._emitGen = 0;
        }
    }

    /**
     * Write a sampled position onto the row at index `i`. Zero allocation. Only ever called
     * AFTER a successful acquire(), so a full store never burns an rng draw and replay stays
     * stable across runs where the store saturates.
     */
    _sampleZone(i) {
        const z = this.zone;
        const rng = this._rng;
        const c = this.pool.cols;

        if (z.type === 'point') {
            c.x[i] = z.x;
            c.y[i] = z.y;
            return;
        }

        if (z.type === 'line') {
            const t = rng.next();
            c.x[i] = z.x1 + (z.x2 - z.x1) * t;
            c.y[i] = z.y1 + (z.y2 - z.y1) * t;
            return;
        }

        if (z.type === 'rect') {
            c.x[i] = z.x + rng.next() * z.width;
            c.y[i] = z.y + rng.next() * z.height;
            return;
        }

        // ring — ALWAYS two draws (LP-06), theta then a radius sample `u`.
        const theta = rng.next() * TAU;
        const u = rng.next();
        const ro = z.radius;
        const ri = z.innerRadius;
        const r = (ri === ro) ? ro : Math.sqrt(ri * ri + u * (ro * ro - ri * ri));
        c.x[i] = z.x + Math.cos(theta) * r;
        c.y[i] = z.y + Math.sin(theta) * r;
    }

    /**
     * Spawn a single particle. Returns its INDEX (>= 0), or -1 when it cannot be spawned — the
     * store is full, or the lifecycle is invalid. (v1.x returned the particle object; there is
     * no object in the SoA core, so tweak the row via `emitter.cols` at the returned index.)
     *
     * When a zone is set it supplies the base x/y; anything the config assigns is applied on top.
     *
     * CONTRACT:
     * - Config keys must be schema fields: {@link SCHEMA_FIELDS}. An unknown key THROWS a
     *   TypeError naming it — put custom identity/metadata on the `userData` integer column
     *   (a handle into your own registry), e.g. `emit({ userData: spriteId })`.
     * - `life`/`maxLife` are coupled: give either and the other mirrors it. An effective
     *   `life <= 0`, `maxLife <= 0`, or non-finite value is INVALID and returns -1 (never a
     *   dead-on-arrival particle, LP-05). Colour columns r,g,b,a are [0,1].
     * - Inside an onDeath cascade the newborn is tagged one generation deeper; past
     *   maxCascadeDepth this THROWS a RangeError.
     *
     * @param {Object} [config]
     * @returns {number} the new particle's index, or -1
     */
    emit(config) {
        if (this._destroyed) return -1;

        let life;
        let maxLife;
        if (config !== null && config !== undefined) {
            for (const k in config) {
                if (!SCHEMA_KEYS.has(k)) {
                    throw new TypeError(
                        `lite-particles: unknown particle field "${k}" in emit() config -- ` +
                        `attach custom identity to the userData integer column (e.g. emit({ userData: id })). ` +
                        `The schema is ${SCHEMA_FIELDS}.`,
                    );
                }
            }
            life = config.life;
            maxLife = config.maxLife;
        }

        // Resolve + validate the lifecycle BEFORE acquire(), so an invalid emission burns
        // neither a slot nor an rng draw — it returns -1 exactly as a full store does.
        if (life === undefined) life = maxLife;
        if (maxLife === undefined) maxLife = life;
        if (!(life > 0) || !Number.isFinite(life)) return -1;
        if (!(maxLife > 0) || !Number.isFinite(maxLife)) return -1;

        // onDeath cascade cap. Past it, THROW — an unbounded self-emitting effect is a bug,
        // surfaced loud like the unknown-key case. Checked BEFORE acquire() so the offending
        // emit burns no slot and no rng draw.
        if (this._emitGen > this._maxCascadeDepth) {
            throw new RangeError(
                `lite-particles: onDeath cascade exceeded maxCascadeDepth (${this._maxCascadeDepth}) -- ` +
                `bound your sub-emitter's generations or raise maxCascadeDepth.`,
            );
        }

        const pool = this.pool;
        const i = pool.acquire();
        if (i < 0) return -1;
        const c = pool.cols;
        if (this.zone !== null) this._sampleZone(i);
        if (config !== null && config !== undefined) {
            // Each key is a validated column name: c[k] is the column, [i] the row.
            for (const k in config) c[k][i] = config[k];
        }
        // Write the resolved pair — covers the mirrored-default case.
        c.life[i] = life;
        c.maxLife[i] = maxLife;
        pool._gen[i] = this._emitGen;
        return i;
    }

    /**
     * Spawn multiple particles at once, writing columns directly. The allocation-free burst
     * path — `initFn(i, cols)` mutates the store in place (`cols.vx[i] = ...`) instead of
     * returning a config object, so a 5000-particle burst allocates nothing (LP-08).
     *
     * Store capacity is checked BEFORE initFn runs, so a saturated store consumes neither a
     * call nor an rng draw for a particle it cannot emit (LP-09).
     *
     * This is the RAW path: initFn writes straight into columns, and the LIFECYCLE IS YOURS —
     * set a positive life (and maxLife). Unlike emit(), it does not validate a bad lifespan;
     * a row left with life <= 0 simply expires on the next update(). draw() still clamps
     * normalizedLife to [0,1] regardless.
     *
     * @param {number}   count
     * @param {Function} initFn Receives (index, cols); writes columns at that index
     * @returns {number} How many were actually emitted (< count when the store saturated)
     */
    emitEach(count, initFn) {
        if (this._destroyed) return 0;
        const pool = this.pool;
        const c = pool.cols;
        let emitted = 0;
        for (let k = 0; k < count; k++) {
            const i = pool.acquire();
            if (i < 0) break; // full — stop BEFORE initFn (no wasted rng draw)
            if (this.zone !== null) this._sampleZone(i);
            initFn(i, c);
            pool._gen[i] = this._emitGen; // track cascade generation (0 outside an onDeath)
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
     * Core physics update. Call this in your game loop. dt is in SECONDS.
     *
     * PHASE ORDER (pinned — LP-10). Once per frame, then per particle:
     *   0. follow: move the zone origin to the tracked target (once, top of frame)
     *   1. decrement life
     *   2. early death: life <= 0 -> release, then onDeath(i, cols) (expiry ONLY)
     *   3. integrate: gravity, frame-independent drag, position
     *   4. bounds cull: outside `bounds` -> release (NO onDeath — off-screen != death)
     *   5. onUpdate(i, cols, dt) hook
     *
     * Columns are hoisted into locals so the loop is pure indexed typed-array access — no
     * closure, no iterator, 0 B/call at every particle count. Reverse scan + swap-remove is
     * correct: releaseAt(i) moves the top row into slot i, above the descending cursor and
     * already visited. A particle emitted by onDeath lands above the cursor -> integrated NEXT
     * frame, which bounds same-frame recursion.
     *
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        if (this._destroyed) return;

        if (this._follow !== null) this._trackFollow();

        const pool = this.pool;
        const c = pool.cols;
        const life = c.life, vx = c.vx, vy = c.vy, gravity = c.gravity, drag = c.drag, x = c.x, y = c.y;
        const gen = pool._gen;
        const onDeath = this.onDeath;
        const onUpdate = this.onUpdate;
        const bounds = this.bounds;

        let deaths = 0;
        let i = pool.active;

        while (i-- > 0) {
            const l = life[i] - dt;
            life[i] = l;

            if (l <= 0) {
                const g = gen[i];            // capture the dying generation BEFORE the swap
                pool.releaseAt(i);           // dying row survives at index pool.active
                deaths++;
                if (onDeath) this._fireDeath(pool.active, g);
                continue;
            }

            vy[i] += gravity[i] * dt;

            const d = drag[i];
            if (d !== 1) {
                const f = Math.pow(d, dt * 60);
                vx[i] *= f;
                vy[i] *= f;
            }

            x[i] += vx[i] * dt;
            y[i] += vy[i] * dt;

            if (bounds) {
                const bx = bounds.x, by = bounds.y;
                if (x[i] < bx || x[i] > bx + bounds.width ||
                    y[i] < by || y[i] > by + bounds.height) {
                    pool.releaseAt(i);
                    deaths++;
                    continue;
                }
            }

            if (onUpdate) onUpdate(i, c, dt);
        }

        this._recycledThisFrame = deaths;
    }

    /**
     * Iterate active particles for rendering.
     * @param {*} ctx        Passed straight through to the callback (e.g. a Canvas2D context)
     * @param {Function} renderCallback - (ctx, i, cols, normalizedLife)
     *   normalizedLife is 1.0 at birth, 0.0 at death (clamped [0,1], NaN-safe). Read the row
     *   via cols: `cols.x[i]`, `cols.r[i]`, etc. To ease normalizedLife without Math on the
     *   hot path, configure `curves` and hoist a sampler.
     */
    draw(ctx, renderCallback) {
        if (this._destroyed) return;

        const c = this.pool.cols;
        const life = c.life, maxLife = c.maxLife;
        const active = this.pool.active;
        for (let i = 0; i < active; i++) {
            const t = life[i] / maxLife[i];
            const normalizedLife = (maxLife[i] > 0 && t > 0) ? (t < 1 ? t : 1) : 0;
            renderCallback(ctx, i, c, normalizedLife);
        }
    }

    /**
     * Pack the active particles into a @zakkster/lite-gl LAYOUT.POINT buffer and return the
     * count. Each particle writes 8 floats — (x, y, size, r, g, b, a, _pad) — straight from
     * the f32 columns: zero allocation, no downcast, no math. Hand the result to a POINT sink:
     *
     *     const buf = new Float32Array(emitter.pool.size * POINT_STRIDE);   // once
     *     const n = emitter.packTo(buf);
     *     sink.upload(buf, 0, n * POINT_STRIDE, 0, POINT_STRIDE);           // per frame
     *
     * POINT is SCREEN PIXELS — project world->screen before packing if your columns hold world
     * coordinates. `out` must be a Float32Array large enough for `offset + active*8` floats,
     * else a RangeError (fail closed).
     *
     * @param {Float32Array} out     Destination POINT buffer
     * @param {number}       [offset=0] Float offset to start writing at
     * @returns {number} particles written (= activeCount)
     */
    packTo(out, offset = 0) {
        if (this._destroyed) return 0;
        if (!(out instanceof Float32Array)) {
            throw new TypeError('lite-particles: packTo(out) needs a Float32Array LAYOUT.POINT buffer');
        }
        const active = this.pool.active;
        const end = offset + active * POINT_STRIDE;
        if (!(offset >= 0) || end > out.length) {
            throw new RangeError(
                `lite-particles: packTo out too small -- need ${end} floats from offset ${offset}, ` +
                `have ${out.length} (${active} particles x ${POINT_STRIDE})`,
            );
        }

        const c = this.pool.cols;
        const x = c.x, y = c.y, size = c.size, r = c.r, g = c.g, b = c.b, a = c.a;
        let o = offset;
        for (let i = 0; i < active; i++) {
            out[o] = x[i];
            out[o + 1] = y[i];
            out[o + 2] = size[i];
            out[o + 3] = r[i];
            out[o + 4] = g[i];
            out[o + 5] = b[i];
            out[o + 6] = a[i];
            out[o + 7] = 0; // _pad
            o += POINT_STRIDE;
        }
        return active;
    }

    /**
     * Destroy the emitter and its underlying column store. Idempotent.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.pool.destroy();
        this.onUpdate = null;
        this.onDeath = null;
        this.bounds = null;
        this.zone = null;
        this._follow = null;
        this._curveLuts = null;
        this._curveFns = null;
    }
}

export default Emitter;
