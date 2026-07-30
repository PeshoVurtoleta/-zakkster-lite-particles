/**
 * @zakkster/lite-particles -- SoA perf gate (decisions/0010). REPRODUCIBLE EVIDENCE.
 *
 * Compares update() THROUGHPUT of the experimental SoA core (./baseline/EmitterSoA.mjs)
 * against the v1.4.0 object core (./baseline/EmitterObject.mjs), across the particle-count
 * range that matters at both ends. The pass condition and the fail-action were fixed in
 * decisions/0010 BEFORE this code existed -- the number decides, not the sunk cost.
 *
 * OUTCOME (v1.5.0): the gate FAILED -- SoA regressed update() 25-40% at every size, because
 * a physics update touches most per-particle fields (the arrays-of-structs-favourable
 * pattern) and SoA's only edge, streaming packTo, merely ties the object core. So the SoA
 * core was SHELVED here as evidence (never shipped), and packTo was added to the object core
 * (the gate winner) instead. Re-run this any time to reproduce the verdict. See decisions/0011.
 *
 * Run:
 *     node --expose-gc test/bench-soa.mjs        -> prints a table, exit 0 on PASS
 *
 * PASS (both must hold):
 *   1. no regression beyond a 5% noise band at 100 / 500 / 1000, and
 *   2. a clear win (>= 1.10x) at 10000 and 100000.
 * On FAIL of (1): SoA does NOT ship as the default Emitter -- see the fail-action in
 * decisions/0010 (ship EmitterSoA as a second export, or shelve).
 *
 * NOTE: in this lite-gc-profiler version compareOps/assertCompareOps compare ALLOCATION
 * budgets, not throughput, so the throughput gate is computed directly from opsPerSec;
 * compareOps is used only as a secondary allocation-parity corroboration.
 *
 * @license MIT
 */

import { measureOps, compareOps, captureFingerprint } from '@zakkster/lite-gc-profiler';
import { Emitter as EmitterObject } from './baseline/EmitterObject.mjs';
import { Emitter as EmitterSoA } from './baseline/EmitterSoA.mjs';

const COUNTS = [100, 500, 1000, 10000, 100000];
const SMALL = new Set([100, 500, 1000]);
const REPS = 5;
const NOISE = 0.05; // small-N two-sided noise band: SoA must stay >= 0.95x object
const WIN = 1.10;   // large-N: SoA must be >= 1.10x object (a clear win)
const DT = 1 / 6000; // small dt: exercise the integrate path, never trip the drag branch off

// Steady fill, pre-populated OUTSIDE the timed window: long-lived particles that integrate
// every frame and never release -- the steady-state update() hot loop.
//
// drag is left at its default 1, so the Math.pow(drag, ...) branch is SKIPPED. That is
// deliberate and it is what makes this a fair STORAGE comparison: the pow is identical work
// in both cores (storage-invariant), so including it would swamp the memory-access difference
// the SoA layout actually governs -- the very thing this gate exists to measure. The path
// here (life--, vy += gravity*dt, x/y integrate) is memory-bound, where object-per-particle
// pointer-chasing vs contiguous columns is exactly the variable under test.
function fillObject(e, n) {
    e.emitEach(n, (p) => { p.life = 1e9; p.maxLife = 1e9; p.vx = 1; p.vy = 1; p.gravity = 10; });
}
function fillSoA(e, n) {
    e.emitEach(n, (i, c) => { c.life[i] = 1e9; c.maxLife[i] = 1e9; c.vx[i] = 1; c.vy[i] = 1; c.gravity[i] = 10; });
}

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Fewer timed ops at large N so wall time stays sane; the loop body is heavy there.
function opsFor(n) { return n >= 100000 ? 3000 : n >= 10000 ? 20000 : 200000; }
function warmupFor(n) { return n >= 10000 ? 2000 : 20000; }

function benchCore(Ctor, fill, n) {
    const ops = opsFor(n);
    const warmup = warmupFor(n);
    const perSec = [];
    for (let r = 0; r < REPS; r++) {
        const e = new Ctor({ maxParticles: n, seed: 1234 });
        fill(e, n);
        const res = measureOps(() => e.update(DT), { ops, warmup, source: 'gc' });
        perSec.push(res.opsPerSec);
        e.destroy();
    }
    return median(perSec);
}

function mops(v) { return (v / 1e6).toFixed(3); }

function main() {
    const fp = captureFingerprint();
    process.stdout.write(
        `lite-particles P4 SoA perf gate (decisions/0010)\n` +
        `fingerprint: node ${fp.node} | v8 ${fp.v8} | ${fp.platform}/${fp.arch} | ${fp.cpu}\n` +
        `reps=${REPS} (median opsPerSec); small-N band ${(NOISE * 100)}% ; large-N win >= ${WIN}x\n\n`);

    const rows = [];
    let allPass = true;
    let regressedSmall = false;

    for (const n of COUNTS) {
        const obj = benchCore(EmitterObject, fillObject, n);
        const soa = benchCore(EmitterSoA, fillSoA, n);
        const ratio = soa / obj;
        const pass = SMALL.has(n) ? ratio >= (1 - NOISE) : ratio >= WIN;
        if (!pass) {
            allPass = false;
            if (SMALL.has(n)) regressedSmall = true;
        }
        rows.push({ n, obj, soa, ratio, pass });
    }

    // Secondary: allocation parity at N=1000 -- SoA update() must not allocate more per op
    // than the object core (both are meant to be 0 B/op). Corroboration only, never the gate.
    let allocLine = 'alloc-parity: skipped (needs --expose-gc)';
    if (typeof global.gc === 'function') {
        const eo = new EmitterObject({ maxParticles: 1000, seed: 1234 }); fillObject(eo, 1000);
        const es = new EmitterSoA({ maxParticles: 1000, seed: 1234 }); fillSoA(es, 1000);
        const cmp = compareOps(() => eo.update(DT), () => es.update(DT),
            { maxExtraBytesPerOp: 0 }, { ops: 50000, warmup: 20000, source: 'gc' });
        eo.destroy(); es.destroy();
        allocLine = `alloc-parity @1k: verdict=${cmp.verdict} (SoA extra B/op vs object; want no extra)`;
    }

    // Table
    process.stdout.write('   N     object Mops/s   SoA Mops/s   ratio   verdict\n');
    process.stdout.write('  ----   -------------   ----------   -----   -------\n');
    for (const r of rows) {
        process.stdout.write(
            `  ${String(r.n).padStart(6)}   ${mops(r.obj).padStart(11)}   ${mops(r.soa).padStart(10)}   ` +
            `${r.ratio.toFixed(3).padStart(5)}   ${r.pass ? 'ok' : 'FAIL'}\n`);
    }
    process.stdout.write(`\n${allocLine}\n`);

    if (allPass) {
        process.stdout.write('\nGATE: PASS -- SoA ships as the default Emitter.\n');
        process.exit(0);
    }

    process.stdout.write('\nGATE: FAIL.\n');
    if (regressedSmall) {
        process.stdout.write(
            'A small-N (<=1k) regression fires the decisions/0010 fail-action: SoA does NOT ship as\n' +
            'the default Emitter -- ship it as a second export EmitterSoA (object core kept), or shelve.\n');
    } else {
        process.stdout.write(
            'No clear win at 10k/100k: the rewrite has no payoff at scale -- do not ship SoA this version\n' +
            '(decisions/0010). NOTE: before the SoA rewrite lands this is the EXPECTED result -- the bench\n' +
            'is comparing the object core against itself.\n');
    }
    process.exit(1);
}

main();
