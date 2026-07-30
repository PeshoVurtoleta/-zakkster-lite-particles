/**
 * @zakkster/lite-particles -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * Eight phases, in the lite-arena vocabulary:
 *
 *     Phase A  retention    -- 4096 emit/expire cycles; activeCount -> 0 and
 *                              pool.free -> pool.size.
 *     Phase B  GC budget    -- update() AND draw() on an empty emitter allocate
 *                              0 B/call, a frame where every particle dies at once
 *                              triggers no full GC, and a >= 200k-op update() window
 *                              is clean at maxMajor:0. HARD GATE (STRICT_PHASE_B).
 *     Phase C  controls     -- an intentionally-allocating workload run through the
 *                              SAME gate, asserted red. TORTURE_CONTROL=alloc also
 *                              forces a non-zero process exit.
 *     Phase D  burst        -- emitEach(count, initFn) allocates nothing across
 *                              20 x 5000 (LP-08), and a SATURATED burst consumes
 *                              exactly the rng draws of the particles it actually
 *                              emitted -- asserted by stream position (LP-09).
 *     Phase E  mixed loop   -- 200k mixed emit/update/draw under measureOps with
 *                              stabilize:'deep', gated at maxArrayBuffersGrowth:0.
 *     Phase F  degenerate   -- every degenerate input has a PINNED answer
 *                              (LP-04/LP-05): invalid lifecycle rejected to null with
 *                              no phantom churn; normalizedLife finite in [0,1]; NaN
 *                              dt/gravity/drag + degenerate bounds neither throw nor
 *                              leak a NaN to the callback.
 *     Phase G  hooks        -- v1.4.0 lifecycle hooks stay allocation-free and correct:
 *                              onDeath dispatch triggers no full GC across millions of
 *                              fires; a hoisted curve sampler in draw() and update()
 *                              under follow() are 0 B/call; the cascade cap THROWS
 *                              (generation cap+1 never born); 20k steps of sub-emitting
 *                              churn never break the pool.
 *     Phase H  packTo (v1.5)-- packTo writes an exact LAYOUT.POINT buffer (8 floats
 *                              incl _pad) round-trip, is 0 B/call at 100k, guards a
 *                              too-small / wrong-typed `out`, and -- when the sibling
 *                              @zakkster/lite-gl is importable -- fills a real headless
 *                              createField({stride:8}) whose bytes match the particles.
 *
 * Replay a Phase A/B corpus with its printed seed:
 *
 *     TORTURE_SEED=<seed> node --expose-gc test/torture.mjs
 *
 * Phases run STRICTLY SEQUENTIALLY: lite-gc-profiler allows one measurement at a time.
 *
 * lite-gc-profiler is a devDependency, never a runtime dep. lite-random IS a runtime dep,
 * so importing Random here (Phase D's oracle) imports nothing the package does not ship.
 * @zakkster/lite-gl is NOT a dependency (its lite-signal/lite-raf peers pull a reactive
 * stack this package does not use); Phase H drives its HEADLESS core from the monorepo
 * sibling when present, and degrades to the pure round-trip otherwise.
 *
 * A NOTE ON WHY THIS IS STILL AN OBJECT CORE: a Structure-of-Arrays rewrite was built and
 * measured against this core (test/bench-soa.mjs, decisions/0010). It regressed update()
 * 25-40% at every size -- a physics update touches most per-particle fields, the pattern
 * that favours arrays-of-structs -- so SoA was shelved and packTo (its one real win) was
 * added to this core instead. See decisions/0011.
 *
 * @license MIT
 */

import { GcProfiler, checkNoGc, measureOps, checkOps } from '@zakkster/lite-gc-profiler';
import { Random } from '@zakkster/lite-random';
import { Emitter, POINT_STRIDE } from '../Emitter.js';

// Phase B is a HARD GATE. Set false only to re-baseline a regression while you bisect it.
const STRICT_PHASE_B = true;

const CONTROL = process.env.TORTURE_CONTROL || null;
const SEED = process.env.TORTURE_SEED ? Number(process.env.TORTURE_SEED) : 1234;

// The hot loops allocate STRUCTURALLY zero bytes. Any positive reading is heapUsed
// granularity noise; the floor separates "fixed" from "regressed" without flaking.
const NOISE_FLOOR_BPC = 4.0;

const OPS_RULES = { maxBytesPerOp: 0 };
const GC_RULES = { maxMajor: 0, maxPauseMs: 4 };
const MIXED_RULES = { maxMajor: 0, maxArrayBuffersGrowth: 0 };
const MIXED_BYTES_FLOOR = 4.0;

function fail(phase, msg) {
    throw new Error(`torture: FAIL [${phase}] ${msg}`);
}

function log(msg) {
    process.stderr.write(msg + '\n');
}

const noop = () => {};

/**
 * Gross transient allocation per call -- the LP-02 method: warm the call site, force a full
 * settle, then take the heapUsed delta over `calls` invocations with no GC in between.
 * `warm` is tunable so a heavy call site (packTo @100k) need not pay 5000 warm iterations.
 */
function bytesPerCall(fn, calls, warm = 5000) {
    for (let i = 0; i < warm; i++) fn();
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < calls; i++) fn();
    const after = process.memoryUsage().heapUsed;
    return (after - before) / calls;
}

/** Min over reps -- allocation noise is one-sided (upward), so the min is the floor. */
function minBytesPerCall(fn, calls, reps = 3, warm = 5000) {
    let m = Infinity;
    for (let r = 0; r < reps; r++) {
        const v = bytesPerCall(fn, calls, warm);
        if (v < m) m = v;
    }
    return m;
}

// ---------------------------------------------------------------------------
// Phase A -- retention. 4096 emit/expire cycles must leave the pool pristine.
// ---------------------------------------------------------------------------
function phaseA() {
    const CYCLES = 4096;
    const PER_CYCLE = 64;
    const SIZE = 256;
    const e = new Emitter({ maxParticles: SIZE, seed: SEED });

    for (let c = 0; c < CYCLES; c++) {
        // A short-lived burst (exercises the legacy emitBurst path on purpose)...
        e.emitBurst(PER_CYCLE, () => ({ life: 0.1, maxLife: 0.1, vx: 1, vy: 1 }));
        // ...expired in a single fat frame.
        e.update(1);

        if (e.activeCount !== 0) {
            fail('A', `cycle ${c}: activeCount=${e.activeCount}, expected 0 (seed=${SEED})`);
        }
        if (e.pool.free !== e.pool.size) {
            fail('A', `cycle ${c}: pool.free=${e.pool.free}, expected ${e.pool.size} (seed=${SEED})`);
        }
    }

    e.destroy();
    log(`  Phase A ok -- ${CYCLES} emit/expire cycles, pool returned to ${SIZE}/${SIZE} free every cycle`);
}

// ---------------------------------------------------------------------------
// Phase B -- GC budget. update()/draw() are 0 B/call at every particle count, and no
// full GC fires across a long update() window or a frame where the whole population dies.
// ---------------------------------------------------------------------------
async function phaseB() {
    if (typeof global.gc !== 'function') {
        log('  Phase B inconclusive -- run with node --expose-gc');
        return;
    }

    const N = 1000;

    // (1) Empty emitter: the exact LP-02 fixture.
    const empty = new Emitter({ maxParticles: N, seed: SEED });
    const bpcUpdate0 = minBytesPerCall(() => empty.update(1 / 6000), 100000);
    const bpcDraw0 = minBytesPerCall(() => empty.draw(null, noop), 100000);
    empty.destroy();

    // (2) Steady population: pre-fill OUTSIDE the window with long-lived particles.
    const e = new Emitter({ maxParticles: N, seed: SEED });
    e.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; p.gravity = 10; p.drag = 0.99; });
    const step = () => e.update(1 / 6000);
    const bpcUpdate1k = minBytesPerCall(step, 50000);

    // (3) GC-budget window: >= 200k iterations under the profiler, gated at maxMajor:0.
    const gc = new GcProfiler(256, { heap: true }).start();
    for (let i = 0; i < 200000; i++) step();
    await gc.settle();
    const summary = gc.summary();
    gc.stop();
    const budget = checkNoGc(summary, GC_RULES);
    e.destroy();
    const gcLine = `major=${summary.gc.major} minor=${summary.gc.minor} ` +
        `maxMs=${summary.gc.maxMs.toFixed(2)} source=${summary.source}`;

    // (4) All-expire-at-once: every particle dies in a single fat frame, repeatedly.
    const ex = new Emitter({ maxParticles: N, seed: SEED });
    const CYCLES = 2000;
    const gcx = new GcProfiler(256, { heap: true }).start();
    for (let c = 0; c < CYCLES; c++) {
        ex.emitEach(N, (p) => { p.life = 0.01; p.maxLife = 0.01; });
        ex.update(1); // one fat frame expires all N at once
    }
    await gcx.settle();
    const sumx = gcx.summary();
    gcx.stop();
    const budgetx = checkNoGc(sumx, GC_RULES);
    const allExpiredClean = ex.activeCount === 0;
    ex.destroy();

    const nums = `update0=${bpcUpdate0.toFixed(2)} draw0=${bpcDraw0.toFixed(2)} ` +
        `update1k=${bpcUpdate1k.toFixed(2)} B/call`;

    const overFloor =
        bpcUpdate0 > NOISE_FLOOR_BPC ? 'update()@0' :
        bpcDraw0 > NOISE_FLOOR_BPC ? 'draw()@0' :
        bpcUpdate1k > NOISE_FLOOR_BPC ? 'update()@1k' : null;

    if (STRICT_PHASE_B) {
        if (overFloor) {
            fail('B', `${overFloor} allocates over the ${NOISE_FLOOR_BPC} B/call floor [${nums}]`);
        }
        if (!budget.ok) {
            fail('B', `200k update() window breached the GC budget: verdict=${budget.verdict} [${gcLine}]`);
        }
        if (!budgetx.ok) {
            fail('B', `all-expire cycles breached the GC budget: verdict=${budgetx.verdict} ` +
                `[major=${sumx.gc.major} minor=${sumx.gc.minor}]`);
        }
        if (!allExpiredClean) {
            fail('B', `all-expire frame left activeCount=${ex.activeCount}, expected 0`);
        }
        log(`  Phase B ok -- ${nums}; 200k-op window clean [${gcLine}]; ` +
            `${CYCLES}x all-expire clean [major=${sumx.gc.major} minor=${sumx.gc.minor}]`);
        return;
    }

    log(`  Phase B (non-strict) -- ${nums}; window [${gcLine}]; ` +
        `all-expire [major=${sumx.gc.major}]. Set STRICT_PHASE_B=true to gate.`);
}

// ---------------------------------------------------------------------------
// Phase C -- controls. An allocating workload MUST make the gate go red.
// ---------------------------------------------------------------------------
function phaseC() {
    const N = 256;
    const e = new Emitter({ maxParticles: N, seed: SEED });
    e.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; });

    const sink = [];
    const result = measureOps((i) => {
        e.update(1 / 6000);
        sink.push({ garbage: i, pad: i * 2 });
    }, { ops: 50000, warmup: 5000, source: 'gc' });

    const report = checkOps(result, OPS_RULES);
    e.destroy();

    if (report.verdict !== 'fail') {
        fail('C', `an allocating control workload did NOT trip the gate ` +
            `(verdict=${report.verdict}, bytesPerOp=${result.bytesPerOp}, source=${result.source})`);
    }
    log(`  Phase C ok -- allocating control tripped the gate ` +
        `(${(result.bytesPerOp ?? 0).toFixed(1)} B/op -> verdict=fail)`);

    if (CONTROL === 'alloc') {
        fail('C', `TORTURE_CONTROL=alloc -- forcing non-zero exit (falsifiability proof)`);
    }
}

// ---------------------------------------------------------------------------
// Phase D -- burst. emitEach writes onto the particle directly (LP-08), and checks pool
// capacity BEFORE initFn (LP-09: a saturated pool burns no rng draw). Both asserted.
// ---------------------------------------------------------------------------
function phaseD() {
    if (typeof global.gc !== 'function') {
        log('  Phase D inconclusive -- run with node --expose-gc');
        return;
    }

    // (1) Allocation: 20 x 5000 emitEach bursts, cleared each round, allocate nothing.
    const SIZE = 5000;
    const e = new Emitter({ maxParticles: SIZE, seed: SEED });
    const burst = () => {
        e.emitEach(SIZE, (p, i) => { p.life = 1; p.maxLife = 1; p.vx = i; p.vy = -i; });
        e.clear();
    };
    const perParticle = minBytesPerCall(burst, 20) / SIZE;
    e.destroy();
    if (perParticle > NOISE_FLOOR_BPC) {
        fail('D', `emitEach allocates ${perParticle.toFixed(3)} B/particle across 20x${SIZE} (floor ${NOISE_FLOOR_BPC})`);
    }

    // (2) rng-draw parity on saturation. A rect zone consumes 2 rng draws/particle.
    const N = 256;
    const DRAWS_PER = 2;
    const zone = { type: 'rect', x: 0, y: 0, width: 100, height: 100 };
    const s = new Emitter({ maxParticles: N, seed: SEED, zone });

    const firstFill = s.emitEach(N - 10, noop);      // fills to N-10
    const emitted = s.emitEach(100, noop);           // only 10 slots remain
    const state = s.random.getState();

    if (firstFill !== N - 10) fail('D', `first fill emitted ${firstFill}, expected ${N - 10}`);
    if (emitted !== 10) fail('D', `saturating burst emitted ${emitted}, expected 10`);

    const ref = new Random(SEED);
    const expectedDraws = DRAWS_PER * ((N - 10) + emitted);
    for (let i = 0; i < expectedDraws; i++) ref.next();
    if (ref.getState() !== state) {
        fail('D', `rng stream position mismatch: emitter consumed a different number of draws ` +
            `than ${expectedDraws} -- a saturated slot burned an rng draw (LP-09 regression)`);
    }
    s.destroy();

    log(`  Phase D ok -- emitEach ${perParticle.toFixed(3)} B/particle (20x${SIZE}); ` +
        `saturated burst consumed exactly ${expectedDraws} draws for ${(N - 10) + emitted} emitted, ` +
        `none for the ${100 - emitted} rejected`);
}

// ---------------------------------------------------------------------------
// Phase E -- mixed loop. 200k emit/update/draw churn, no heap or ArrayBuffer growth.
// ---------------------------------------------------------------------------
function phaseE() {
    if (typeof global.gc !== 'function') {
        log('  Phase E inconclusive -- run with node --expose-gc');
        return;
    }

    const e = new Emitter({
        maxParticles: 1000,
        seed: SEED,
        bounds: { x: -1e6, y: -1e6, width: 2e6, height: 2e6 },
    });
    const mixed = (i) => {
        e.emitEach(4, (p, k) => { p.life = 0.05; p.maxLife = 0.05; p.vx = k; p.vy = -k; });
        e.update(1 / 60);
        e.draw(null, noop);
    };

    const result = measureOps(mixed, { ops: 200000, warmup: 10000, source: 'gc', stabilize: 'deep' });
    const budget = checkNoGc(result.summary, MIXED_RULES);
    e.destroy();

    const ab = result.summary.arrayBuffers;
    const abLine = ab && ab.supported && ab.settled
        ? `arrayBuffers.growth=${ab.growthBytes}B`
        : `arrayBuffers=unsettled(n/a)`;
    const retained = result.bytesPerOp ?? 0;

    if (!budget.ok) {
        fail('E', `mixed loop breached maxMajor:0 / maxArrayBuffersGrowth:0: ` +
            `verdict=${budget.verdict} major=${result.summary.gc.major} [${abLine}]`);
    }
    if (retained > MIXED_BYTES_FLOOR) {
        fail('E', `mixed loop retained ${retained.toFixed(3)} B/op, over the ${MIXED_BYTES_FLOOR} B/op floor [${abLine}]`);
    }

    log(`  Phase E ok -- 200k mixed emit/update/draw: ${retained.toFixed(3)} B/op retained ` +
        `(<= ${MIXED_BYTES_FLOOR} floor), major=${result.summary.gc.major}, ${abLine}`);
}

// ---------------------------------------------------------------------------
// Phase F -- degenerate values (LP-04/LP-05). Pins a defined answer for each input.
// ---------------------------------------------------------------------------
function phaseF() {
    // (1) Invalid lifecycle -> emit returns null, takes no slot, no phantom churn.
    const e = new Emitter({ maxParticles: 16 });
    const rejected = [
        { x: 1, y: 1 },
        { life: 0 }, { life: -1 }, { life: NaN }, { life: Infinity }, { life: -Infinity },
        { life: 1, maxLife: 0 }, { life: 1, maxLife: -2 },
        { life: 1, maxLife: NaN }, { life: 1, maxLife: Infinity },
    ];
    for (const cfg of rejected) {
        if (e.emit(cfg) !== null) fail('F', `emit(${JSON.stringify(cfg)}) should return null`);
    }
    if (e.activeCount !== 0) fail('F', `rejected emits took ${e.activeCount} slots, expected 0`);
    e.update(1 / 60);
    if (e.recycledThisFrame !== 0) fail('F', `rejected emits inflated recycledThisFrame to ${e.recycledThisFrame}`);
    e.destroy();

    // (2) normalizedLife is ALWAYS finite in [0,1], even for degenerate raw particles.
    const nlMatrix = [
        { life: 2, maxLife: 1 }, { life: 5, maxLife: 0 }, { life: NaN, maxLife: 1 },
        { life: 1, maxLife: NaN }, { life: -3, maxLife: 1 }, { life: Infinity, maxLife: 1 },
        { life: 0, maxLife: 0 }, { life: 1, maxLife: 1 },
    ];
    for (const fields of nlMatrix) {
        const em = new Emitter({ maxParticles: 1 });
        em.emitEach(1, (p) => { Object.assign(p, fields); });
        let nl = null;
        em.draw(null, (_c, _p, t) => { nl = t; });
        if (!Number.isFinite(nl) || nl < 0 || nl > 1) {
            fail('F', `normalizedLife=${nl} for ${JSON.stringify(fields)} -- expected finite in [0,1]`);
        }
        em.destroy();
    }

    // (3) Degenerate dt + NaN physics must not throw and must not leak NaN to the callback.
    for (const dt of [0, -1, NaN, 10, Infinity]) {
        const em = new Emitter({ maxParticles: 8, bounds: { x: 0, y: 0, width: 100, height: 100 } });
        em.emitEach(4, (p) => { p.x = 50; p.y = 50; p.life = 1; p.maxLife = 1; p.gravity = NaN; p.drag = NaN; p.size = NaN; });
        try {
            em.update(dt);
            em.draw(null, (_c, _p, t) => { if (Number.isNaN(t)) throw new Error('NaN normalizedLife'); });
        } catch (err) {
            fail('F', `dt=${dt} with NaN gravity/drag/size: ${err.message}`);
        }
        em.destroy();
    }

    // (4) Degenerate bounds: zero-area culls a corner particle; NaN edges cull nothing.
    const zero = new Emitter({ maxParticles: 4, bounds: { x: 0, y: 0, width: 0, height: 0 } });
    zero.emitEach(1, (p) => { p.x = 5; p.y = 5; p.life = 10; p.maxLife = 10; });
    zero.update(1 / 60);
    if (zero.activeCount !== 0) fail('F', `zero-area bounds left ${zero.activeCount} alive, expected (5,5) culled`);
    zero.destroy();

    const nan = new Emitter({ maxParticles: 4, bounds: { x: NaN, y: NaN, width: NaN, height: NaN } });
    nan.emitEach(2, (p) => { p.x = 5; p.y = 5; p.life = 10; p.maxLife = 10; });
    try { nan.update(1 / 60); } catch (err) { fail('F', `NaN-edge bounds threw: ${err.message}`); }
    if (nan.activeCount !== 2) fail('F', `NaN bounds culled ${2 - nan.activeCount} (expected 0 -- NaN compares false)`);
    nan.destroy();

    log('  Phase F ok -- invalid lifecycle rejected to null (no phantom churn); normalizedLife ' +
        'finite in [0,1] across the degenerate matrix; NaN dt/gravity/drag + degenerate bounds ' +
        'neither throw nor leak NaN to the callback');
}

// ---------------------------------------------------------------------------
// Phase G -- lifecycle hooks. onDeath dispatch, curve sampling, follow tracking each stay
// 0 B/call; the cascade cap throws; randomized sub-emitting churn never corrupts the pool.
// ---------------------------------------------------------------------------
async function phaseG() {
    const N = 1000;

    // (1) onDeath DISPATCH is 0 B/call across a wide window.
    const initShort = (p) => { p.life = 0.01; p.maxLife = 0.01; };
    const eod = new Emitter({ maxParticles: N, seed: SEED, onDeath: noop });
    let fires = 0;
    eod.onDeath = () => { fires++; }; // counts, does not allocate
    const CYCLES = 2000;
    if (typeof global.gc === 'function') {
        const gcod = new GcProfiler(256, { heap: true }).start();
        for (let c = 0; c < CYCLES; c++) { eod.emitEach(N, initShort); eod.update(1); }
        await gcod.settle();
        const sod = gcod.summary();
        gcod.stop();
        const bod = checkNoGc(sod, GC_RULES);
        if (!bod.ok) fail('G', `onDeath dispatch breached the GC budget: verdict=${bod.verdict} [major=${sod.gc.major} minor=${sod.gc.minor}]`);
        if (fires !== CYCLES * N) fail('G', `onDeath fired ${fires} times, expected ${CYCLES * N}`);
    }
    eod.destroy();

    // (2) Randomized sub-emitting churn must never break the pool invariants. Bounded by
    // generation so the cap does not trip -- this fuzzes ITERATION, not the cap.
    const rng = new Random(SEED);
    const efz = new Emitter({
        maxParticles: 128,
        onDeath: (p) => { if (p._gen < 4) { const n = (rng.next() * 3) | 0; for (let k = 0; k < n; k++) efz.emit({ x: p.x, y: p.y, life: 0.2 + rng.next() * 0.6 }); } },
    });
    for (let step = 0; step < 20000; step++) {
        if (rng.next() < 0.6) efz.emit({ x: rng.next() * 50, y: rng.next() * 50, life: 0.1 + rng.next() });
        efz.update(0.1 + rng.next() * 0.2);
        if (efz.pool.used + efz.pool.free !== efz.pool.size) fail('G', `pool invariant broken at step ${step}: used+free != size`);
        if (efz.activeCount !== efz.pool.active) fail('G', `activeCount desynced from pool.active at step ${step}`);
        if (efz.activeCount > efz.pool.size) fail('G', `activeCount ${efz.activeCount} exceeded size at step ${step}`);
    }
    efz.clear();
    if (efz.activeCount !== 0 || efz.pool.free !== efz.pool.size) fail('G', 'clear() after fuzz left the pool dirty');
    efz.destroy();

    // (3) Cascade cap THROWS, and generation cap+1 is never born.
    const CAP = 5;
    const seen = new Set();
    const ecap = new Emitter({ maxParticles: 64, maxCascadeDepth: CAP, onDeath: (p) => { seen.add(p._gen); ecap.emit({ x: 0, y: 0, life: 0.001 }); } });
    ecap.emit({ x: 0, y: 0, life: 0.001 });
    let threw = null;
    try { for (let f = 0; f < 50; f++) ecap.update(1); } catch (err) { threw = err; }
    if (!(threw instanceof RangeError)) fail('G', `cascade past cap ${CAP} did not throw a RangeError`);
    if (Math.max(...seen) !== CAP || seen.has(CAP + 1)) fail('G', `cascade let generation ${CAP + 1} be born (max seen=${Math.max(...seen)})`);
    ecap.destroy();

    // (4) A hoisted curve sampler in draw() is 0 B/call, and matches the source curve.
    const cubic = (t) => t * t * t;
    const ec = new Emitter({ maxParticles: N, seed: SEED, curves: { s: cubic } });
    ec.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; });
    const sampler = ec.curve('s');
    let sink = 0;
    const cb = (_c, _p, t) => { sink += sampler(t); };
    const bpcDrawCurve = typeof global.gc === 'function' ? minBytesPerCall(() => ec.draw(null, cb), 50000) : 0;
    if (bpcDrawCurve > NOISE_FLOOR_BPC) fail('G', `draw() with a curve sampler allocates ${bpcDrawCurve.toFixed(2)} B/call over the ${NOISE_FLOOR_BPC} floor`);
    let maxErr = 0;
    for (let i = 0; i <= 256; i++) { const t = i / 256; const err = Math.abs(sampler(t) - cubic(t)); if (err > maxErr) maxErr = err; }
    if (maxErr > 1e-3) fail('G', `curve LUT deviates ${maxErr} from the source easing (> 1e-3)`);
    if (sink === 0) fail('G', 'curve sink optimized away');
    ec.destroy();

    // (5) update() with follow active is 0 B/call.
    const ef = new Emitter({ maxParticles: N, seed: SEED, zone: { type: 'point', x: 0, y: 0 } });
    ef.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; });
    const target = { x: 0, y: 0 };
    ef.follow(target);
    let kk = 0;
    const stepF = () => { kk = (kk + 1) & 1023; target.x = kk; target.y = kk; ef.update(1 / 6000); };
    const bpcFollow = typeof global.gc === 'function' ? minBytesPerCall(stepF, 50000) : 0;
    if (bpcFollow > NOISE_FLOOR_BPC) fail('G', `update() with follow active allocates ${bpcFollow.toFixed(2)} B/call over the ${NOISE_FLOOR_BPC} floor`);
    ef.destroy();

    log(`  Phase G ok -- onDeath dispatch clean (${CYCLES}x${N} fires, major=0); ` +
        `20k-step sub-emit fuzz held pool invariants; cascade cap throws (gen ${CAP + 1} never born); ` +
        `curve draw ${bpcDrawCurve.toFixed(2)} B/call (LUT err ${maxErr.toExponential(1)}); follow update ${bpcFollow.toFixed(2)} B/call`);
}

// ---------------------------------------------------------------------------
// Phase H -- packTo (v1.5.0). The GPU handoff writes an exact LAYOUT.POINT buffer, is
// 0 B/call at 100k, guards a bad `out`, and (when the sibling lite-gl is present) fills a
// real headless createField whose bytes match the particles.
// ---------------------------------------------------------------------------
async function phaseH() {
    const N = 1000;
    const f = Math.fround; // packTo writes f64 particle fields into a Float32Array -> compare rounded

    // (1) Round-trip correctness incl _pad, against the particle objects.
    const e = new Emitter({ maxParticles: N, seed: SEED });
    const rr = new Random(SEED + 7);
    e.emitEach(N, (p) => {
        p.x = rr.next() * 1000; p.y = rr.next() * 1000; p.size = 1 + rr.next() * 4;
        p.r = rr.next(); p.g = rr.next(); p.b = rr.next(); p.a = rr.next();
        p.life = 1; p.maxLife = 1;
    });
    const buf = new Float32Array(N * POINT_STRIDE);
    const packed = e.packTo(buf);
    if (packed !== N) fail('H', `packTo returned ${packed}, expected ${N}`);
    const slots = e.pool.slots;
    for (let i = 0; i < N; i++) {
        const p = slots[i];
        const o = i * POINT_STRIDE;
        if (buf[o] !== f(p.x) || buf[o + 1] !== f(p.y) || buf[o + 2] !== f(p.size) ||
            buf[o + 3] !== f(p.r) || buf[o + 4] !== f(p.g) || buf[o + 5] !== f(p.b) ||
            buf[o + 6] !== f(p.a) || buf[o + 7] !== 0) {
            fail('H', `packTo instance ${i} does not match its particle (or _pad != 0)`);
        }
    }

    // Offset honored: pack again at a float offset, first block untouched.
    const buf2 = new Float32Array(N * POINT_STRIDE + POINT_STRIDE);
    buf2.fill(-1);
    const packed2 = e.packTo(buf2, POINT_STRIDE);
    if (packed2 !== N) fail('H', `packTo(offset) returned ${packed2}, expected ${N}`);
    if (buf2[0] !== -1) fail('H', `packTo(offset) wrote before its offset`);
    if (buf2[POINT_STRIDE] !== f(slots[0].x)) fail('H', `packTo(offset) did not start at the offset`);

    // Guards: too-small buffer -> RangeError; non-Float32Array -> TypeError.
    let threwR = false;
    try { e.packTo(new Float32Array(8)); } catch (err) { threwR = err instanceof RangeError; }
    if (!threwR) fail('H', 'packTo did not RangeError on a too-small buffer');
    let threwT = false;
    try { e.packTo([]); } catch (err) { threwT = err instanceof TypeError; }
    if (!threwT) fail('H', 'packTo did not TypeError on a non-Float32Array');
    e.destroy();

    // (2) 0 B/call at 100k, plus a structural no-full-GC window.
    let bpcPack = 0;
    if (typeof global.gc === 'function') {
        const BIG = 100000;
        const eb = new Emitter({ maxParticles: BIG, seed: SEED });
        eb.emitEach(BIG, (p, i) => { p.x = i; p.y = -i; p.size = 1; p.life = 1e9; p.maxLife = 1e9; });
        const out = new Float32Array(BIG * POINT_STRIDE);
        bpcPack = minBytesPerCall(() => eb.packTo(out), 500, 3, 300); // light warm: packTo@100k is heavy
        if (bpcPack > NOISE_FLOOR_BPC) fail('H', `packTo allocates ${bpcPack.toFixed(2)} B/call at 100k over the ${NOISE_FLOOR_BPC} floor`);
        const gcp = new GcProfiler(256, { heap: true }).start();
        for (let k = 0; k < 2000; k++) eb.packTo(out);
        await gcp.settle();
        const sp = gcp.summary();
        gcp.stop();
        const bp = checkNoGc(sp, GC_RULES);
        if (!bp.ok) fail('H', `packTo window breached the GC budget: verdict=${bp.verdict} [major=${sp.gc.major}]`);
        eb.destroy();
    }

    // (3) Drive lite-gl's HEADLESS core (sibling) if present -- else skip cleanly.
    let glNote = 'lite-gl integration skipped (sibling ../../LiteGL not importable)';
    try {
        const gl = await import(new URL('../../LiteGL/GL.js', import.meta.url));
        if (gl.LAYOUT.POINT !== POINT_STRIDE) {
            fail('H', `lite-gl LAYOUT.POINT=${gl.LAYOUT.POINT} != our POINT_STRIDE ${POINT_STRIDE}`);
        }
        const cap = 64;
        const eg = new Emitter({ maxParticles: cap, seed: SEED });
        const rg = new Random(SEED + 3);
        eg.emitEach(cap, (p) => {
            p.x = rg.next() * 500; p.y = rg.next() * 500; p.size = 2;
            p.r = rg.next(); p.g = rg.next(); p.b = rg.next(); p.a = 1;
            p.life = 1; p.maxLife = 1;
        });
        const field = gl.createField({ capacity: cap, stride: gl.LAYOUT.POINT });
        const nGl = eg.packTo(field.data, 0);
        field.setCount(nGl);
        const gslots = eg.pool.slots;
        for (let i = 0; i < nGl; i++) {
            const p = gslots[i];
            const o = i * gl.LAYOUT.POINT;
            if (field.data[o] !== f(p.x) || field.data[o + 2] !== f(p.size) ||
                field.data[o + 3] !== f(p.r) || field.data[o + 6] !== f(p.a)) {
                fail('H', `lite-gl POINT field instance ${i} does not match its particle`);
            }
        }
        glNote = `lite-gl POINT field OK (LAYOUT.POINT=${gl.LAYOUT.POINT}, ${nGl} instances packed & byte-verified)`;
        eg.destroy();
    } catch (err) {
        if (String(err.message).startsWith('torture:')) throw err; // a real assertion, not an import miss
        glNote = `lite-gl integration skipped (${err.code || err.message})`;
    }

    log(`  Phase H ok -- packTo round-trip exact incl _pad, offset honored, out guarded; ` +
        `${typeof global.gc === 'function' ? `${bpcPack.toFixed(2)} B/call @100k; ` : ''}${glNote}`);
}

// ---------------------------------------------------------------------------
// Throughput note (not a gate).
// ---------------------------------------------------------------------------
function throughputNote() {
    const e = new Emitter({ maxParticles: 1000, seed: SEED });
    e.emitEach(1000, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; p.gravity = 10; p.drag = 0.99; });
    const ru = measureOps(() => e.update(1 / 6000), { ops: 200000, warmup: 20000, source: 'gc' });
    const rd = measureOps(() => e.draw(null, noop), { ops: 200000, warmup: 20000, source: 'gc' });
    e.destroy();
    log(`  throughput -- update()@1k ${(ru.opsPerSec / 1e6).toFixed(2)} M ops/s; ` +
        `draw()@1k ${(rd.opsPerSec / 1e6).toFixed(2)} M ops/s (informational)`);
}

async function main() {
    const phases = [
        ['A-retention', phaseA],
        ['B-gc-budget', phaseB],
        ['C-controls', phaseC],
        ['D-burst', phaseD],
        ['E-mixed', phaseE],
        ['F-degenerate', phaseF],
        ['G-hooks', phaseG],
        ['H-packto', phaseH],
        ['throughput', throughputNote],
    ];
    for (const [name, run] of phases) {
        try {
            await run();
        } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            process.stderr.write((msg.startsWith('torture:') ? msg : `torture: FAIL [${name}] ${msg}`) + '\n');
            process.exit(1);
        }
    }
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
