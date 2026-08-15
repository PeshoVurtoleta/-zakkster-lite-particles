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
 * v1.5.0 — GPU handoff (additive, non-breaking). The particle schema gains first-class
 *          r,g,b,a colour fields ([0,1], default opaque white) and a numeric `userData`
 *          handle (an integer id into your own registry — the GPU/ECS-friendly sibling of
 *          the object `data` escape hatch, which is unchanged). `packTo(out, offset)` writes
 *          the active particles straight into a @zakkster/lite-gl LAYOUT.POINT buffer
 *          (x, y, size, r, g, b, a, _pad) — zero allocation — so a Canvas2D system reaches
 *          the GPU (100k instances in one draw) with one method. LAYOUT_VERSION / POINT_STRIDE
 *          / POINT_OFFSETS export the packed contract. NOTE: a Structure-of-Arrays core was
 *          built and measured against this object core (test/bench-soa.mjs, decisions/0010);
 *          it REGRESSED update() 25-40% at every size because a physics update touches most
 *          per-particle fields (the AoS-favourable pattern) and SoA's only edge (streaming
 *          packTo) merely ties the object core — so SoA was SHELVED and packTo added here
 *          instead. The number decided, not the sunk cost. See decisions/0010-0011.
 * v1.4.0 — lifecycle hooks: onDeath(p) sub-emitter fires on life-expiry (a dying spark
 *          can spawn embers), bounded by a per-particle generation cap that THROWS past
 *          maxCascadeDepth; `curves` bakes easing functions into Float32Array LUTs read
 *          via curve()/curveTable() (no Math in the draw path); follow(target) tracks a
 *          moving object world-space (moves the zone origin, O(1)/frame). The pool is
 *          now reset-on-acquire so a dying particle can be released BEFORE onDeath reads
 *          it. lite-ease / lite-ease-lut / lite-lerp are devDeps only — the runtime bakes
 *          and reads a plain table. See decisions/0007-0009.
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
export const VERSION = '1.5.1';

const TAU = Math.PI * 2;

/**
 * The particle schema — the only fields emit() will copy from a config object.
 * A key outside this set is rejected (see emit()): arbitrary custom state belongs on the
 * `data` object escape hatch (or the numeric `userData` handle), never welded onto the
 * pooled particle, where reset() would miss it and a recycled particle would inherit a dead
 * one's state (LP-01). r,g,b,a are [0,1] colour (v1.5.0), fed to the GPU by packTo().
 */
const SCHEMA_KEYS = new Set([
    'x', 'y', 'vx', 'vy', 'gravity', 'drag', 'life', 'maxLife', 'size',
    'r', 'g', 'b', 'a', 'userData', 'data',
]);
const SCHEMA_FIELDS = '{ x, y, vx, vy, gravity, drag, life, maxLife, size, r, g, b, a, userData, data }';

/**
 * The GPU handoff contract (v1.5.0). packTo() writes @zakkster/lite-gl LAYOUT.POINT
 * instances: 8 floats per particle, (x, y, size, r, g, b, a, _pad). SCREEN PIXELS — do any
 * world->screen projection before packing, as lite-gl's `project` expects. A buffer another
 * package reads is a contract, so the stride, the field offsets, and a version are exported
 * and frozen (bump LAYOUT_VERSION if the packed shape ever changes).
 */
export const LAYOUT_VERSION = 1;
export const POINT_STRIDE = 8;
export const POINT_OFFSETS = Object.freeze({ x: 0, y: 1, size: 2, r: 3, g: 4, b: 5, a: 6, _pad: 7 });

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
 *
 * RESET-ON-ACQUIRE (v1.4.0). The particle is cleared by acquire(), NOT by releaseAt().
 * releaseAt() only swap-removes, so a just-released particle keeps its dying values
 * until something reacquires that slot. This is what lets update() release a dying
 * particle BEFORE firing onDeath(p): the hook still reads the particle's death x/y, a
 * cap-exceeded throw leaves the pool already consistent, and a full pool's freed slot
 * is immediately reusable by a 1:1 sub-emitter. Net allocation is unchanged — the reset
 * merely moved from release-time to acquire-time (writes to existing sealed keys, 0 B).
 * update()/draw() only ever read `[0, active)`, so stale values in the free region are
 * never observed. See decisions/0007.
 */
class ParticlePool {
    constructor(size, create, reset) {
        this._reset = reset;
        this.size = size;
        this.active = 0;
        this.slots = new Array(size);
        for (let i = 0; i < size; i++) this.slots[i] = create();
    }

    /** O(1). Returns a clean particle (reset on the way out), or null when full. */
    acquire() {
        if (this.active >= this.size) return null;
        const p = this.slots[this.active++];
        this._reset(p);
        return p;
    }

    /**
     * O(1) swap-remove of the active particle at index `i`. Does NOT reset — the
     * released particle keeps its values (read by onDeath) until it is reacquired.
     */
    releaseAt(i) {
        const slots = this.slots;
        const last = --this.active;
        const p = slots[i];
        slots[i] = slots[last];
        slots[last] = p;
    }

    /**
     * Empty the active region. Freed particles are reset lazily on reacquire, so this
     * is just a pointer move — no per-particle work for a scene reset.
     */
    releaseAll() {
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
     * @param {Function} [options.onDeath]           Sub-emitter hook (particle) fired on life-expiry (v1.4.0)
     * @param {number}   [options.maxCascadeDepth=8] onDeath cascade cap; emit past it THROWS (v1.4.0)
     * @param {Object}   [options.bounds]            { x, y, width, height } for off-screen culling
     * @param {Object}   [options.zone]              Emission shape, sampled at emit time
     * @param {Object}   [options.curves]           { name: (t)=>number } baked into Float32Array LUTs (v1.4.0)
     * @param {number}   [options.curveSegments=256] LUT resolution per curve (v1.4.0)
     * @param {number}   [options.seed]              RNG seed. Same seed => same emission sequence.
     * @param {Object}   [options.random]            Inject your own PRNG. Any object with .next() -> [0,1).
     *                                               Wins over `seed`. Use this to bring a non-lite-random PRNG.
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

        // onDeath cascade guard (v1.4.0). `_emitGen` is the generation stamped onto a
        // particle emitted RIGHT NOW: 0 for a normal emit, and (dying particle's _gen + 1)
        // while inside _fireDeath(). emit() throws once it would exceed _maxCascadeDepth,
        // so a runaway self-emitting effect fails loud instead of stalling the frame.
        this._maxCascadeDepth = maxCascadeDepth;
        this._emitGen = 0;

        // follow(target) state (v1.4.0). World-space: we move the ZONE ORIGIN each
        // update(), never the live particles. `_followX/_followY` remember the last
        // origin so a line zone can be translated by delta.
        this._follow = null;
        this._followX = 0;
        this._followY = 0;

        // curves (v1.4.0): bake each easing fn into a Float32Array LUT once, here (cold),
        // and pre-build the sampler closure so curve()/the draw path allocate nothing and
        // call no Math.sin/pow. lite-ease supplies the fns in userland; we only read a table.
        this._curveLuts = null;
        this._curveFns = null;
        if (curves !== null && curves !== undefined) this._bakeCurves(curves, curveSegments);

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
            () => {
                const p = {
                    x: 0, y: 0,
                    vx: 0, vy: 0,
                    gravity: 0, drag: 1,
                    life: 0, maxLife: 1,
                    size: 1,
                    r: 1, g: 1, b: 1, a: 1, // [0,1] colour (v1.5.0); default opaque white so a
                    //                          colourless particle is visible and packTo-ready
                    userData: 0,            // numeric handle into your own registry (v1.5.0)
                    data: null,             // arbitrary object escape hatch (sprites/metadata)
                };
                // `_gen` is the onDeath cascade generation (private, v1.4.0). NON-ENUMERABLE
                // on purpose: it must not appear in Object.keys(p) / {...p}, so the public
                // particle shape stays exactly the P2 schema. Writable (reset/emit set it),
                // and the fixed hidden class is preserved for the hot path.
                Object.defineProperty(p, '_gen', { value: 0, writable: true, enumerable: false, configurable: false });
                return Object.seal(p);
            },
            (p) => {
                p.x = p.y = 0;
                p.vx = p.vy = 0;
                p.gravity = 0;
                p.drag = 1;
                p.life = 0;
                p.maxLife = 1;
                p.size = 1;
                p.r = p.g = p.b = p.a = 1; // reset colour to opaque white — a recycled particle
                //                            must not inherit a dead one's colour (LP-01)
                p.userData = 0;
                p.data = null;
                p._gen = 0;
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
     * Bake a { name: (t)=>number } map of easing functions into Float32Array LUTs and
     * pre-build one sampler closure per name. Cold — runs once at construction. The
     * baked table is what the hot path reads: no Math.sin/pow, no per-frame closure.
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
            // Sampler: clamp the ends, linearly interpolate between the two nearest
            // samples inside. Pre-built ONCE here, so calling it per particle allocates
            // nothing and evaluates no easing math — just a table read plus a lerp.
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
     * The baked sampler for a named curve: `emitter.curve('size')(normalizedLife)` returns
     * the eased value with no easing math on the hot path. HOIST it out of your render loop
     * (`const sizeCurve = emitter.curve('size')`) — it is a stable closure, same reference
     * every call. Throws if the name was not configured (fail closed).
     * @param {string} name
     * @returns {(t:number)=>number}
     */
    curve(name) {
        const fn = this._curveFns && this._curveFns[name];
        if (!fn) throw new TypeError(`lite-particles: no curve named "${name}" (configure it via new Emitter({ curves }))`);
        return fn;
    }

    /**
     * The raw Float32Array LUT behind a named curve, for callers who want a bare index
     * (`lut[(t * (lut.length - 1)) | 0]`) instead of the interpolating sampler. Throws if
     * the name was not configured.
     * @param {string} name
     * @returns {Float32Array}
     */
    curveTable(name) {
        const lut = this._curveLuts && this._curveLuts[name];
        if (!lut) throw new TypeError(`lite-particles: no curve named "${name}" (configure it via new Emitter({ curves }))`);
        return lut;
    }

    /**
     * Make the emission zone track a moving target (world-space). Each update() reads
     * `target.x` / `target.y` and moves the ZONE ORIGIN there — two property reads,
     * O(1), never per-particle. Particles already emitted stay where they were born
     * (a comet trail), so this does NOT rigidly drag the whole system.
     *
     * Pass `null` to stop following. Requires a zone: following with nothing to move is
     * a silent no-op, so it THROWS instead (fail loud). If the target is later set to a
     * non-object, or its x/y go non-finite (detached mid-flight), update() simply skips
     * the move that frame — the zone stays put and no NaN is written.
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
        // Seed the delta reference from the current zone origin so a line zone's first
        // tracked frame translates from where it is now, not from (0,0).
        const z = this.zone;
        this._followX = z.type === 'line' ? z.x1 : z.x;
        this._followY = z.type === 'line' ? z.y1 : z.y;
    }

    /**
     * Move the zone origin to the followed target. Called at the TOP of update(), before
     * the particle loop, so this frame's physics and any post-update emit see the new
     * origin. No-op (fail closed, no NaN) when the target is missing or non-finite.
     */
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
            // Translate all four endpoints by the delta from the last tracked origin.
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
     * Fire the onDeath sub-emitter for an expired particle. COLD — only runs on a death
     * with a hook set, so its try/finally (which would deopt update()'s hot loop) is
     * isolated here. Stamps the ambient generation so any emit() the hook makes marks its
     * newborns one level deeper, and always clears it — even when emit() throws the
     * cascade-cap RangeError. The dying particle was already releaseAt()'d by update(),
     * so it still holds its death x/y here and the pool is consistent if this throws.
     */
    _fireDeath(p) {
        this._emitGen = p._gen + 1;
        try {
            this.onDeath(p);
        } finally {
            this._emitGen = 0;
        }
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
     * - When called from inside an `onDeath` sub-emitter (v1.4.0), the newborn is tagged
     *   one generation deeper. Past `maxCascadeDepth` this THROWS a `RangeError` — an
     *   unbounded self-emitting cascade is a bug, surfaced loud like the unknown-key case.
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

        // onDeath cascade cap (v1.4.0). `_emitGen` is 0 for a normal emit and
        // (dying particle's _gen + 1) inside _fireDeath(). Past the cap, THROW — an
        // unbounded self-emitting effect is a bug, surfaced loud like emit()'s
        // unknown-key throw, not silently dropped into a frame-time cliff. Checked
        // BEFORE acquire() so the offending emit burns no slot and no rng draw.
        if (this._emitGen > this._maxCascadeDepth) {
            throw new RangeError(
                `lite-particles: onDeath cascade exceeded maxCascadeDepth (${this._maxCascadeDepth}) -- ` +
                `bound your sub-emitter's generations or raise maxCascadeDepth.`,
            );
        }

        const p = this.pool.acquire();
        if (!p) return null;
        if (this.zone !== null) this._sampleZone(p);
        if (config) Object.assign(p, config);
        // Write the resolved pair — covers the mirrored-default case where the config
        // supplied only one of the two.
        p.life = life;
        p.maxLife = maxLife;
        p._gen = this._emitGen; // 0 normally; deeper inside an onDeath cascade
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
     * Inside an `onDeath` cascade this stamps the generation like `emit`, so the counter
     * keeps climbing — but the cap is enforced by `emit`'s throw, not here. For bounded
     * sub-emission, spawn from `onDeath` via `emit`.
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
            p._gen = this._emitGen; // track cascade generation (0 outside an onDeath)
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
     * PHASE ORDER (pinned — LP-10). Once per frame, then per particle:
     *   0. follow: move the zone origin to the tracked target (once, top of frame)
     *   1. decrement life (`life -= dt`)
     *   2. early death: `life <= 0` -> release, then fire `onDeath(p)` (expiry ONLY)
     *   3. integrate: gravity, then frame-independent drag, then position
     *   4. bounds cull: outside `bounds` -> release (NO onDeath — off-screen != death)
     *   5. `onUpdate(particle, dt)` hook
     * Culling deliberately precedes the hook: a particle culled this frame does NOT
     * see its hook, and a hook cannot pull a culled particle back in bounds. This
     * order is a contract (a named test pins it); a refactor must not reorder it.
     *
     * onDeath fires on life-expiry only (v1.4.0), AFTER the particle is released, so the
     * hook reads its death x/y and a 1:1 sub-emitter reuses the just-freed slot. A
     * particle emitted by the hook lands above the descending cursor -> integrated NEXT
     * frame, never this one (which is what bounds same-frame recursion).
     *
     * @param {number} dt - Delta time in seconds
     */
    update(dt) {
        if (this._destroyed) return;

        // Phase 0: world-space follow — move the zone origin once, before the loop.
        if (this._follow !== null) this._trackFollow();

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
                // Release FIRST (reset-on-acquire keeps p's dying values), THEN fire the
                // sub-emitter: the hook reads p's death position and any emit() it makes
                // can reuse this just-freed slot. onDeath is cold-pathed in _fireDeath so
                // its try/finally never deopts this loop.
                pool.releaseAt(i);
                deaths++;
                if (this.onDeath) this._fireDeath(p);
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
     * Iterate active particles for rendering (the Canvas2D path). For the GPU, skip the
     * per-particle callback and use {@link Emitter#packTo} instead.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} renderCallback - (ctx, particle, normalizedLife)
     *   normalizedLife is 1.0 at birth, 0.0 at death — perfect for easing. The particle
     *   carries r,g,b,a in [0,1] (v1.5.0) alongside x/y/size. To ease normalizedLife without
     *   Math on the hot path, configure `curves` and hoist a sampler out of your loop:
     *   `const fade = emitter.curve('alpha')` then `ctx.globalAlpha = fade(t)`.
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
     * Pack the active particles into a @zakkster/lite-gl LAYOUT.POINT buffer and return the
     * count. Each particle writes 8 floats — (x, y, size, r, g, b, a, _pad) — read straight
     * from its fields: zero allocation. Hand the result to a POINT sink:
     *
     *     const buf = new Float32Array(emitter.pool.size * POINT_STRIDE);   // once
     *     const n = emitter.packTo(buf);
     *     sink.upload(buf, 0, n * POINT_STRIDE, 0, POINT_STRIDE);           // per frame
     *
     * This is the GPU handoff (v1.5.0): a Canvas2D particle system becomes a 100k-instance
     * GPU one in a single instanced draw, no per-particle JS call. POINT is SCREEN PIXELS —
     * project world->screen before packing if your particles hold world coordinates. `out`
     * must be a Float32Array large enough for `offset + activeCount*8` floats, else a
     * RangeError (fail closed).
     *
     * @param {Float32Array} out        Destination POINT buffer
     * @param {number}       [offset=0] Float offset to start writing at
     * @returns {number} particles written (= activeCount)
     */
    packTo(out, offset = 0) {
        if (this._destroyed) return 0;
        if (!(out instanceof Float32Array)) {
            throw new TypeError('lite-particles: packTo(out) needs a Float32Array LAYOUT.POINT buffer');
        }
        const pool = this.pool;
        const slots = pool.slots;
        const active = pool.active;
        const end = offset + active * POINT_STRIDE;
        if (!(offset >= 0) || end > out.length) {
            throw new RangeError(
                `lite-particles: packTo out too small -- need ${end} floats from offset ${offset}, ` +
                `have ${out.length} (${active} particles x ${POINT_STRIDE})`,
            );
        }

        let o = offset;
        for (let i = 0; i < active; i++) {
            const p = slots[i];
            out[o] = p.x;
            out[o + 1] = p.y;
            out[o + 2] = p.size;
            out[o + 3] = p.r;
            out[o + 4] = p.g;
            out[o + 5] = p.b;
            out[o + 6] = p.a;
            out[o + 7] = 0; // _pad
            o += POINT_STRIDE;
        }
        return active;
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
        this.onDeath = null;
        this.bounds = null;
        this.zone = null;
        this._follow = null;
        this._curveLuts = null;
        this._curveFns = null;
    }
}

export default Emitter;
