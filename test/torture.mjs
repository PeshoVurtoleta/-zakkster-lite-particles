/**
 * @zakkster/lite-particles -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * Five phases, in the lite-arena vocabulary:
 *
 *     Phase A  retention    -- 4096 emit/expire cycles; activeCount -> 0 and
 *                              pool.free -> pool.size. Passes.
 *     Phase B  GC budget    -- update() AND draw() on an empty emitter allocate
 *                              0 B/call (measured the LP-02 way), a frame where
 *                              every particle dies at once triggers no full GC,
 *                              and a >= 200k-op update() window is clean at
 *                              maxMajor:0. As of v1.2.0 this is a HARD GATE
 *                              (STRICT_PHASE_B). It was a registered XFAIL on
 *                              1.1.0/1.1.1 (finding LP-02: a per-call arrow
 *                              closure + a per-call `dead = []`); P1 removed the
 *                              allocation by replacing lite-object-pool's Set with
 *                              an inline dense free-list iterated in reverse with
 *                              swap-remove (LP-03), so update() releases inline
 *                              with no buffer, no closure, no iterator.
 *     Phase C  controls     -- an intentionally-allocating workload run through
 *                              the SAME gate, asserted to come back red. Proves
 *                              the gate can fail. `TORTURE_CONTROL=alloc`
 *                              additionally forces the whole process to exit
 *                              non-zero -- on-demand falsifiability.
 *     Phase D  burst        -- emitEach(count, initFn) allocates nothing across
 *                              20 x 5000 (finding LP-08), and a SATURATED burst
 *                              consumes exactly the rng draws of the particles it
 *                              actually emitted -- asserted by stream position,
 *                              not just the count (finding LP-09).
 *     Phase E  mixed loop   -- 200k mixed emit/update/draw under measureOps with
 *                              stabilize:'deep', gated at maxArrayBuffersGrowth:0
 *                              and maxMajor:0. No steady-state growth of any kind.
 *     Phase F  degenerate   -- every degenerate input has a PINNED answer (v1.3.0,
 *                              findings LP-04/LP-05): an invalid lifecycle is rejected
 *                              to null and never inflates recycledThisFrame;
 *                              normalizedLife is always finite in [0,1]; and NaN
 *                              dt/gravity/drag plus degenerate bounds neither throw
 *                              nor leak a NaN to the normalizedLife callback.
 *
 * Replay a Phase A/B corpus with its printed seed:
 *
 *     TORTURE_SEED=<seed> node --expose-gc test/torture.mjs
 *
 * Phases run STRICTLY SEQUENTIALLY: lite-gc-profiler allows one measurement at
 * a time and throws "already in flight" on nesting. Never measure two at once.
 *
 * lite-gc-profiler is a devDependency, never a runtime dep: Emitter.js does not
 * import it. lite-random IS a runtime dep of the package, so importing Random
 * here (Phase D's parity oracle) imports nothing the package does not already ship.
 *
 * @license MIT
 */

import { GcProfiler, checkNoGc, measureOps, checkOps } from '@zakkster/lite-gc-profiler';
import { Random } from '@zakkster/lite-random';
import { Emitter } from '../Emitter.js';

// v1.2.0: Phase B is a HARD GATE. Set false only to re-baseline a regression while
// you bisect it -- the CHANGELOG entry for the version that flipped this is the record.
const STRICT_PHASE_B = true;

const CONTROL = process.env.TORTURE_CONTROL || null;
const SEED = process.env.TORTURE_SEED ? Number(process.env.TORTURE_SEED) : 1234;

// The hot loops allocate STRUCTURALLY zero bytes (no per-call array/closure/iterator).
// Any positive reading is heapUsed granularity noise; observed <1 B/call after a
// double-GC settle and a 3-rep min. The floor sits far below the 331 B/call this
// session removed, so it separates "fixed" from "regressed" without flaking.
const NOISE_FLOOR_BPC = 4.0;

const OPS_RULES = { maxBytesPerOp: 0 };
const GC_RULES = { maxMajor: 0, maxPauseMs: 4 };
const MIXED_RULES = { maxMajor: 0, maxArrayBuffersGrowth: 0 };
// A stabilized bytesPerOp is a two-point live-set delta; its noise floor is sub-byte,
// so gating it at exactly 0 flakes. The real Phase E gate is maxMajor:0 +
// maxArrayBuffersGrowth:0 (checkNoGc); bytesPerOp is corroboration held below this.
const MIXED_BYTES_FLOOR = 4.0;

function fail(phase, msg) {
    throw new Error(`torture: FAIL [${phase}] ${msg}`);
}

function log(msg) {
    process.stderr.write(msg + '\n');
}

const noop = () => {};

/**
 * Gross transient allocation per call -- the LP-02 method, and the exact method
 * P1's "0 B/call" assertion uses: warm the call site, force a full settle, then
 * take the heapUsed delta over `calls` invocations with no GC in between (so any
 * per-call garbage accumulates rather than being scavenged). measureOps' bytesPerOp
 * is the wrong lane here: it reports NET steady-phase growth, which minor GCs drive
 * to ~0 and which would hide a transient regression.
 */
function bytesPerCall(fn, calls) {
    for (let i = 0; i < 5000; i++) fn(); // warm the site so V8 inlines it
    global.gc();
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < calls; i++) fn();
    const after = process.memoryUsage().heapUsed;
    return (after - before) / calls;
}

/** Min over reps -- allocation noise is one-sided (upward), so the min is the floor. */
function minBytesPerCall(fn, calls, reps = 3) {
    let m = Infinity;
    for (let r = 0; r < reps; r++) {
        const v = bytesPerCall(fn, calls);
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
// Phase B -- GC budget. The headline: update()/draw() are 0 B/call at every
// particle count, and no full GC fires across a long update() window or a frame
// where the entire population dies at once.
// ---------------------------------------------------------------------------
async function phaseB() {
    if (typeof global.gc !== 'function') {
        log('  Phase B inconclusive -- run with node --expose-gc');
        return;
    }

    const N = 1000;

    // (1) Empty emitter: the exact LP-02 fixture. update() and draw() on zero
    // particles were 331 / 243 B/call; they must now be ~0.
    const empty = new Emitter({ maxParticles: N, seed: SEED });
    const bpcUpdate0 = minBytesPerCall(() => empty.update(1 / 6000), 100000);
    const bpcDraw0 = minBytesPerCall(() => empty.draw(null, noop), 100000);
    empty.destroy();

    // (2) Steady population: pre-fill OUTSIDE the window with long-lived particles
    // so update() integrates every frame and never releases -- the steady hot loop.
    const e = new Emitter({ maxParticles: N, seed: SEED });
    e.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; p.gravity = 10; p.drag = 0.99; });
    const step = () => e.update(1 / 6000);
    const bpcUpdate1k = minBytesPerCall(step, 50000);

    // (3) GC-budget window: >= 200k iterations under the profiler, gated at
    // maxMajor:0 -- the "checkNoGc at maxMajor 0" reading the brief names.
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
    // release runs the swap-remove path at full width; assert no full GC across the
    // cycles (structural -- avoids conflating emit + update in a heapUsed delta).
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

    // Non-strict fallback (only if someone re-baselines): report, never gate.
    log(`  Phase B (non-strict) -- ${nums}; window [${gcLine}]; ` +
        `all-expire [major=${sumx.gc.major}]. Set STRICT_PHASE_B=true to gate.`);
}

// ---------------------------------------------------------------------------
// Phase C -- controls. An allocating workload MUST make the gate go red. If it
// does not, the gate is broken and this phase fails. TORTURE_CONTROL=alloc also
// forces a non-zero process exit as the external falsifiability proof.
// ---------------------------------------------------------------------------
function phaseC() {
    const N = 256;
    const e = new Emitter({ maxParticles: N, seed: SEED });
    e.emitEach(N, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; });

    // RETAIN a fresh object every op (never reset the sink) so the allocation
    // survives collection and shows up as robust net growth, not sub-byte noise.
    const sink = [];
    const result = measureOps((i) => {
        e.update(1 / 6000);
        sink.push({ garbage: i, pad: i * 2 });
    }, { ops: 50000, warmup: 5000, source: 'gc' });

    const report = checkOps(result, OPS_RULES);
    e.destroy();

    if (report.verdict !== 'fail') {
        fail('C', `an allocating control workload did NOT trip the gate ` +
            `(verdict=${report.verdict}, bytesPerOp=${result.bytesPerOp}, source=${result.source}) ` +
            `-- the gate cannot be trusted`);
    }
    log(`  Phase C ok -- allocating control tripped the gate ` +
        `(${(result.bytesPerOp ?? 0).toFixed(1)} B/op -> verdict=fail)`);

    if (CONTROL === 'alloc') {
        fail('C', `TORTURE_CONTROL=alloc -- forcing non-zero exit (falsifiability proof)`);
    }
}

// ---------------------------------------------------------------------------
// Phase D -- burst. emitEach writes onto the particle directly (LP-08: no config
// object), and checks pool capacity BEFORE initFn (LP-09: a saturated pool burns
// no rng draw). Both are asserted.
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
        fail('D', `emitEach allocates ${perParticle.toFixed(3)} B/particle across 20x${SIZE} ` +
            `(floor ${NOISE_FLOOR_BPC})`);
    }

    // (2) rng-draw parity on saturation. A rect zone consumes 2 rng draws/particle.
    // Fill to N-10, then over-request 100: only 10 fit, and the pool must burn draws
    // for exactly those 10 -- not the 90 it rejected. Assert the STREAM POSITION.
    const N = 256;
    const DRAWS_PER = 2; // rect zone: x uses one next(), y uses another
    const zone = { type: 'rect', x: 0, y: 0, width: 100, height: 100 };
    const s = new Emitter({ maxParticles: N, seed: SEED, zone });

    const firstFill = s.emitEach(N - 10, noop);      // fills to N-10
    const emitted = s.emitEach(100, noop);           // only 10 slots remain
    const state = s.random.getState();

    if (firstFill !== N - 10) fail('D', `first fill emitted ${firstFill}, expected ${N - 10}`);
    if (emitted !== 10) fail('D', `saturating burst emitted ${emitted}, expected 10`);

    // Oracle: same seed, exactly DRAWS_PER * (particles actually emitted) draws.
    const ref = new Random(SEED);
    const expectedDraws = DRAWS_PER * ((N - 10) + emitted);
    for (let i = 0; i < expectedDraws; i++) ref.next();
    if (ref.getState() !== state) {
        fail('D', `rng stream position mismatch: emitter consumed a different number of ` +
            `draws than ${expectedDraws} (${DRAWS_PER}/particle x ${(N - 10) + emitted} emitted) ` +
            `-- a saturated slot burned an rng draw (LP-09 regression)`);
    }
    s.destroy();

    log(`  Phase D ok -- emitEach ${perParticle.toFixed(3)} B/particle (20x${SIZE}); ` +
        `saturated burst consumed exactly ${expectedDraws} draws for ${(N - 10) + emitted} emitted, ` +
        `none for the ${100 - emitted} rejected`);
}

// ---------------------------------------------------------------------------
// Phase E -- mixed loop. A realistic emit/update/draw churn, 200k ops, must not
// grow the heap or any ArrayBuffer in steady state. stabilize:'deep' settles
// before each boundary so bytesPerOp reflects SURVIVING allocation, not transients.
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
    // Each op: emit a few short-lived, integrate, render. Population stays bounded
    // because the emitted particles expire within a few frames.
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

    // Hard structural gate (the brief's assertion): no full GC and no ArrayBuffer
    // growth across the window.
    if (!budget.ok) {
        fail('E', `mixed loop breached maxMajor:0 / maxArrayBuffersGrowth:0: ` +
            `verdict=${budget.verdict} major=${result.summary.gc.major} [${abLine}]`);
    }
    // Corroboration: retained bytes/op sits at the sub-byte noise floor, not a leak.
    if (retained > MIXED_BYTES_FLOOR) {
        fail('E', `mixed loop retained ${retained.toFixed(3)} B/op, over the ` +
            `${MIXED_BYTES_FLOOR} B/op floor -- steady-state growth [${abLine}]`);
    }

    log(`  Phase E ok -- 200k mixed emit/update/draw: ${retained.toFixed(3)} B/op retained ` +
        `(<= ${MIXED_BYTES_FLOOR} floor), major=${result.summary.gc.major}, ${abLine}`);
}

// ---------------------------------------------------------------------------
// Phase F -- degenerate values (v1.3.0, findings LP-04/LP-05). Not an allocation
// gate: it pins a defined answer for each degenerate input so none is a silent
// wrong answer. Needs no profiler; runs regardless of --expose-gc.
// ---------------------------------------------------------------------------
function phaseF() {
    // (1) Invalid lifecycle -> emit returns null, takes no slot, no phantom churn.
    const e = new Emitter({ maxParticles: 16 });
    const rejected = [
        { x: 1, y: 1 },                                    // no life at all
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

    // (3) Degenerate dt + NaN physics must not throw and must not leak NaN to the
    // normalizedLife callback (position may be GIGO -- that is the caller's input).
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

    // (4) Degenerate bounds: zero-area culls a particle off the corner; NaN edges
    // compare false, so they cull nothing (fail-open) -- both pinned, neither throws.
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
// Throughput note (not a gate): the HOT PATH ledger wants update()@1k and (since
// v1.3.0's normalizedLife clamp) draw()@1k on record.
// ---------------------------------------------------------------------------
function throughputNote() {
    const e = new Emitter({ maxParticles: 1000, seed: SEED });
    e.emitEach(1000, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; p.gravity = 10; p.drag = 0.99; });
    const ru = measureOps(() => e.update(1 / 6000), { ops: 200000, warmup: 20000, source: 'gc' });
    const rd = measureOps(() => e.draw(null, noop), { ops: 200000, warmup: 20000, source: 'gc' });
    e.destroy();
    log(`  throughput -- update()@1k ${(ru.opsPerSec / 1e6).toFixed(2)} M ops/s; ` +
        `draw()@1k (clamped normalizedLife) ${(rd.opsPerSec / 1e6).toFixed(2)} M ops/s (informational)`);
}

async function main() {
    const phases = [
        ['A-retention', phaseA],
        ['B-gc-budget', phaseB],
        ['C-controls', phaseC],
        ['D-burst', phaseD],
        ['E-mixed', phaseE],
        ['F-degenerate', phaseF],
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
    // stdout stays EXACTLY "ok" on pass -- nothing else writes to it.
    process.stdout.write('ok\n');
    process.exit(0);
}

main();
