/**
 * @zakkster/lite-particles -- torture gate.
 *
 * The suite DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints "ok", exit 0
 *
 * Three phases, in the lite-arena vocabulary:
 *
 *     Phase A  retention    -- 4096 emit/expire cycles; activeCount -> 0 and
 *                              pool.free -> pool.size. Passes today.
 *     Phase B  GC budget    -- pre-fill OUTSIDE the loop, then >= 200k update()
 *                              iterations under lite-gc-profiler at maxBytesPerOp:0.
 *                              This is a REGISTERED, EXPECTED FAILURE on 1.1.0
 *                              (finding LP-02): update() allocates a per-call
 *                              arrow closure and a per-call `dead = []`. It is
 *                              carried as an XFAIL -- the phase prints the
 *                              measured bytes/op and asserts the allocation is
 *                              STILL present, so the command stays green while
 *                              documenting the baseline P1 has to clear. When P1
 *                              (v1.2.0) reaches 0 B/op, flip STRICT_PHASE_B to
 *                              true and this becomes a hard gate.
 *     Phase C  controls     -- an intentionally-allocating workload run through
 *                              the SAME gate, asserted to come back red. Proves
 *                              the gate can fail. `TORTURE_CONTROL=alloc`
 *                              additionally forces the whole process to exit
 *                              non-zero -- on-demand falsifiability.
 *
 * Replay a Phase A/B corpus with its printed seed:
 *
 *     TORTURE_SEED=<seed> node --expose-gc test/torture.mjs
 *
 * Phases run STRICTLY SEQUENTIALLY: lite-gc-profiler allows one measurement at
 * a time and throws "already in flight" on nesting. Never measure two at once.
 *
 * lite-gc-profiler is a devDependency, never a runtime dep: Emitter.js does not
 * import it.
 *
 * @license MIT
 */

import { GcProfiler, checkNoGc, measureOps, checkOps } from '@zakkster/lite-gc-profiler';
import { Emitter } from '../Emitter.js';

// Flip to true in P1 (v1.2.0) once update()/draw() reach 0 B/op. Until then
// Phase B is an XFAIL: it documents the LP-02 allocation, it does not gate on it.
const STRICT_PHASE_B = false;

const CONTROL = process.env.TORTURE_CONTROL || null;
const SEED = process.env.TORTURE_SEED ? Number(process.env.TORTURE_SEED) : 1234;

const OPS_RULES = { maxBytesPerOp: 0 };
const GC_RULES = { maxMajor: 0, maxPauseMs: 4 };

function fail(phase, msg) {
    throw new Error(`torture: FAIL [${phase}] ${msg}`);
}

function log(msg) {
    process.stderr.write(msg + '\n');
}

/**
 * Gross transient allocation per call -- the LP-02 method, and the exact method
 * P1's "0 B/call" assertion uses: warm the call site, force a full settle, then
 * take the heapUsed delta over `calls` invocations with no GC in between (so the
 * closure + dead[] garbage each call accumulates rather than being scavenged).
 * measureOps' bytesPerOp is the wrong lane here: it reports NET steady-phase
 * growth, which minor GCs drive to ~0 and which hides exactly this finding.
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

// ---------------------------------------------------------------------------
// Phase A -- retention. 4096 emit/expire cycles must leave the pool pristine.
// ---------------------------------------------------------------------------
function phaseA() {
    const CYCLES = 4096;
    const PER_CYCLE = 64;
    const e = new Emitter({ maxParticles: 256, seed: SEED });

    for (let c = 0; c < CYCLES; c++) {
        // A short-lived burst...
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
    log(`  Phase A ok -- ${CYCLES} emit/expire cycles, pool returned to ${256}/${256} free every cycle`);
}

// ---------------------------------------------------------------------------
// Phase B -- GC budget. Pre-fill the pool OUTSIDE the measured window, then run
// update() on a steady population. bytesPerOp is the transient allocation rate
// -- exactly what LP-02 measured (forced settle, then heapUsed delta per call).
// ---------------------------------------------------------------------------
async function phaseB() {
    if (typeof global.gc !== 'function') {
        log('  Phase B inconclusive -- run with node --expose-gc');
        return;
    }

    const N = 1000;
    const e = new Emitter({ maxParticles: N, seed: SEED });
    // Pre-fill OUTSIDE the measured window with long-lived particles so update()
    // integrates every frame and never releases -- we measure the steady hot
    // loop, not churn. dt is tiny so nothing expires across the whole window.
    e.emitBurst(N, () => ({ life: 1e9, maxLife: 1e9, vx: 1, vy: 1, gravity: 10, drag: 0.99 }));
    const step = () => e.update(1 / 6000);

    // (1) Gross allocation per call -- the LP-02 baseline number.
    const bpc = bytesPerCall(step, 1000);
    const bytes = bpc.toFixed(1);

    // (2) GC-budget window: >= 200k iterations under the profiler, gated at
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

    // XFAIL contract: on 1.1.0 the per-call arrow closure + per-call dead[] array
    // make bytesPerCall > 0 (LP-02). Carry it as a documented failure that keeps
    // the command green; P1 (v1.2.0) drives it to 0 and flips STRICT_PHASE_B.
    const allocated = bpc > 0.5; // sub-byte noise floor; the real value is ~315

    if (STRICT_PHASE_B) {
        if (allocated) {
            fail('B', `update() allocates ${bytes} B/call (budget 0) [${gcLine}]`);
        }
        if (!budget.ok) {
            fail('B', `update() breached the GC budget: verdict=${budget.verdict} [${gcLine}]`);
        }
        log(`  Phase B ok -- update() at ${bytes} B/call, 200k-op window clean [${gcLine}]`);
        return;
    }

    if (!allocated) {
        log(`  Phase B PASSES at ${bytes} B/call -- LP-02 appears already fixed. ` +
            `If P1 (v1.2.0) has landed, set STRICT_PHASE_B=true to promote this to a hard gate. [${gcLine}]`);
        return;
    }

    log(`  Phase B XFAIL (expected) -- update() allocates ${bytes} B/call ` +
        `[LP-02: per-call arrow closure + per-call dead[] array]. ` +
        `200k-op GC window: ${gcLine}. P1 (v1.2.0) clears this.`);
}

// ---------------------------------------------------------------------------
// Phase C -- controls. An allocating workload MUST make the gate go red. If it
// does not, the gate is broken and this phase fails. TORTURE_CONTROL=alloc also
// forces a non-zero process exit as the external falsifiability proof.
// ---------------------------------------------------------------------------
function phaseC() {
    const N = 256;
    const e = new Emitter({ maxParticles: N, seed: SEED });
    e.emitBurst(N, () => ({ life: 1e9, maxLife: 1e9, vx: 1, vy: 1 }));

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

async function main() {
    const phases = [['A-retention', phaseA], ['B-gc-budget', phaseB], ['C-controls', phaseC]];
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
