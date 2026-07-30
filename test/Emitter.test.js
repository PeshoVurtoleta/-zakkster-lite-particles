import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { Emitter, normalizeZone, VERSION, ZONE_DRAWS, POINT_STRIDE, LAYOUT_VERSION, POINT_OFFSETS } from '../Emitter.js';
import { Random } from '@zakkster/lite-random';
// devDependencies (v1.4.0): the easing curves and interpolation used to build and
// cross-check the LUTs. The runtime reads a baked table and depends on neither.
import { easeOutCubic, easeInQuad } from '@zakkster/lite-ease';
import { lerp } from '@zakkster/lite-lerp';

// toBeCloseTo parity (from the ported suite): pass when |expected - actual| < 10**-digits / 2.
const closeTo = (actual, expected, digits = 2) =>
    assert.ok(
        Math.abs(expected - actual) < Math.pow(10, -digits) / 2,
        `expected ${actual} to be close to ${expected} (${digits} digits)`
    );

describe('lite-particles', () => {
    let emitter;

    beforeEach(() => {
        emitter = new Emitter({ maxParticles: 100 });
    });

    describe('package metadata', () => {
        it('exports a VERSION string', () => {
            assert.equal(typeof VERSION, 'string');
        });
    });

    describe('constructor', () => {
        it('starts with 0 active particles', () => {
            assert.equal(emitter.activeCount, 0);
        });

        it('accepts custom maxParticles', () => {
            const em = new Emitter({ maxParticles: 50 });
            assert.equal(em.pool.size, 50);
        });

        it('accepts onUpdate hook', () => {
            const hook = mock.fn();
            const em = new Emitter({ onUpdate: hook });
            assert.equal(em.onUpdate, hook);
        });

        it('accepts bounds', () => {
            const bounds = { x: 0, y: 0, width: 800, height: 600 };
            const em = new Emitter({ bounds });
            assert.equal(em.bounds, bounds);
        });
    });

    describe('emit()', () => {
        it('spawns a particle', () => {
            const p = emitter.emit({ x: 100, y: 200, life: 1 });
            assert.notEqual(p, null);
            assert.equal(p.x, 100);
            assert.equal(p.y, 200);
            assert.equal(emitter.activeCount, 1);
        });

        it('returns null when pool is full', () => {
            const em = new Emitter({ maxParticles: 2 });
            em.emit({ life: 1 });
            em.emit({ life: 1 });
            assert.equal(em.emit({ life: 1 }), null);
        });

        it('returns null after destroy', () => {
            emitter.destroy();
            assert.equal(emitter.emit({ life: 1 }), null);
        });
    });

    describe('emitBurst()', () => {
        it('spawns multiple particles', () => {
            emitter.emitBurst(10, (i) => ({
                x: i * 10, y: 0, life: 1,
            }));
            assert.equal(emitter.activeCount, 10);
        });

        it('stops when pool fills', () => {
            const em = new Emitter({ maxParticles: 5 });
            em.emitBurst(10, () => ({ life: 1 }));
            assert.equal(em.activeCount, 5);
        });

        it('passes index to configFn', () => {
            const configs = [];
            emitter.emitBurst(3, (i) => {
                configs.push(i);
                return { life: 1 };
            });
            assert.deepEqual(configs, [0, 1, 2]);
        });
    });

    describe('emitEach()', () => {
        it('writes fields directly onto each particle (no config object)', () => {
            emitter.emitEach(3, (p, i) => { p.x = i * 10; p.y = i; p.life = 1; });
            const xs = [];
            emitter.draw(null, (_c, p) => xs.push(p.x));
            assert.equal(emitter.activeCount, 3);
            assert.deepEqual(xs.sort((a, b) => a - b), [0, 10, 20]);
        });

        it('passes (particle, index) to initFn', () => {
            const seen = [];
            emitter.emitEach(3, (p, i) => { seen.push(i); p.life = 1; });
            assert.deepEqual(seen, [0, 1, 2]);
        });

        it('returns how many actually spawned', () => {
            const e = new Emitter({ maxParticles: 10 });
            assert.equal(e.emitEach(4, (p) => { p.life = 1; }), 4);
        });

        it('stops when the pool fills and reports the short count', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.equal(e.emitEach(10, (p) => { p.life = 1; }), 5);
            assert.equal(e.activeCount, 5);
        });

        it('checks capacity BEFORE initFn - a saturated slot never runs initFn (LP-09)', () => {
            const e = new Emitter({ maxParticles: 3 });
            let calls = 0;
            e.emitEach(50, (p) => { calls++; p.life = 1; });
            assert.equal(calls, 3); // exactly the 3 that fit, never the 47 rejected
        });

        it('a saturated burst burns no rng draw, so replay survives saturation (LP-09)', () => {
            const zone = { type: 'rect', x: 0, y: 0, width: 100, height: 100 };
            const roomy = new Emitter({ maxParticles: 10, seed: 77, zone });
            roomy.emitEach(3, (p) => { p.life = 1; });
            const expected = positions(roomy);

            // A pool of 3 hammered with 50: the 47 rejected must not advance the stream.
            const tight = new Emitter({ maxParticles: 3, seed: 77, zone });
            assert.equal(tight.emitEach(50, (p) => { p.life = 1; }), 3);
            assert.deepEqual(positions(tight), expected);
        });

        it('samples the zone first; initFn can override (config-wins parity with emit)', () => {
            const zone = { type: 'point', x: 100, y: 200 };
            const e = new Emitter({ maxParticles: 5, zone });
            e.emitEach(1, (p) => { p.life = 1; });           // no override -> zone position
            e.emitEach(1, (p) => { p.life = 1; p.x = 7; });  // override x, keep zone y
            const pos = positions(e);
            assert.deepEqual(pos[0], { x: 100, y: 200 });
            assert.deepEqual(pos[1], { x: 7, y: 200 });
        });

        it('is a no-op after destroy(), returning 0', () => {
            const e = new Emitter({ maxParticles: 5 });
            e.destroy();
            assert.equal(e.emitEach(3, (p) => { p.life = 1; }), 0);
        });
    });

    describe('update()', () => {
        it('decrements particle life', () => {
            const p = emitter.emit({ life: 1, maxLife: 1 });
            emitter.update(0.5);
            closeTo(p.life, 0.5);
        });

        it('removes dead particles', () => {
            emitter.emit({ life: 0.1 });
            emitter.update(0.2); // life goes to -0.1 -> released
            assert.equal(emitter.activeCount, 0);
        });

        it('applies gravity', () => {
            const p = emitter.emit({ life: 10, vy: 0, gravity: 100 });
            emitter.update(0.1);
            closeTo(p.vy, 10); // gravity * dt = 100 * 0.1
        });

        it('applies drag', () => {
            const p = emitter.emit({ life: 10, vx: 100, drag: 0.9 });
            emitter.update(1 / 60);
            assert.ok(p.vx < 100);
        });

        it('updates position', () => {
            const p = emitter.emit({ life: 10, x: 0, vx: 100 });
            emitter.update(0.1);
            closeTo(p.x, 10); // 100 * 0.1
        });

        it('skips drag when drag is 1', () => {
            const p = emitter.emit({ life: 10, vx: 50, drag: 1 });
            emitter.update(0.1);
            assert.equal(p.vx, 50); // unchanged
        });

        it('culls out-of-bounds particles', () => {
            const em = new Emitter({
                maxParticles: 10,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
            });
            em.emit({ x: 50, y: 50, vx: 2000, life: 10 });
            em.update(0.1); // x = 50 + 2000*0.1 = 250 -> out of bounds
            assert.equal(em.activeCount, 0);
        });

        it('calls onUpdate hook', () => {
            const hook = mock.fn();
            const em = new Emitter({ maxParticles: 10, onUpdate: hook });
            em.emit({ life: 10 });
            em.update(0.016);
            assert.equal(hook.mock.callCount(), 1);
            const args = hook.mock.calls[0].arguments;
            assert.equal(typeof args[0], 'object');
            assert.equal(args[1], 0.016);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            assert.doesNotThrow(() => emitter.update(0.1));
        });
    });

    describe('clear()', () => {
        it('releases all active particles', () => {
            emitter.emitBurst(10, () => ({ life: 1 }));
            assert.equal(emitter.activeCount, 10);
            emitter.clear();
            assert.equal(emitter.activeCount, 0);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            assert.doesNotThrow(() => emitter.clear());
        });
    });

    describe('draw()', () => {
        it('calls renderCallback for each active particle', () => {
            emitter.emit({ life: 1, maxLife: 1 });
            emitter.emit({ life: 0.5, maxLife: 1 });

            const ctx = {};
            const callback = mock.fn();
            emitter.draw(ctx, callback);

            assert.equal(callback.mock.callCount(), 2);
        });

        it('passes normalized life (1 at birth, 0 at death)', () => {
            emitter.emit({ life: 0.5, maxLife: 1 });

            const ctx = {};
            const callback = mock.fn();
            emitter.draw(ctx, callback);

            const normalizedLife = callback.mock.calls[0].arguments[2];
            closeTo(normalizedLife, 0.5);
        });

        it('passes ctx and particle to callback', () => {
            const p = emitter.emit({ life: 1, maxLife: 1 });

            const ctx = { fake: true };
            const callback = mock.fn();
            emitter.draw(ctx, callback);

            assert.equal(callback.mock.calls[0].arguments[0], ctx);
            assert.equal(callback.mock.calls[0].arguments[1], p);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            const callback = mock.fn();
            emitter.draw({}, callback);
            assert.equal(callback.mock.callCount(), 0);
        });
    });

    describe('destroy()', () => {
        it('sets _destroyed flag', () => {
            emitter.destroy();
            assert.equal(emitter._destroyed, true);
        });

        it('destroys the pool', () => {
            const spy = mock.method(emitter.pool, 'destroy');
            emitter.destroy();
            assert.ok(spy.mock.callCount() > 0);
        });

        it('is idempotent', () => {
            emitter.destroy();
            assert.doesNotThrow(() => emitter.destroy());
        });

        it('nulls onUpdate and bounds', () => {
            emitter.onUpdate = () => {};
            emitter.bounds = { x: 0, y: 0, width: 100, height: 100 };
            emitter.destroy();
            assert.equal(emitter.onUpdate, null);
            assert.equal(emitter.bounds, null);
        });
    });

    describe('full lifecycle', () => {
        it('emit -> update -> draw -> clear cycle', () => {
            // Spawn burst
            emitter.emitBurst(20, (i) => ({
                x: 400, y: 300,
                vx: Math.cos(i) * 100,
                vy: Math.sin(i) * 100,
                gravity: 200,
                life: 1,
                maxLife: 1,
            }));
            assert.equal(emitter.activeCount, 20);

            // Simulate a few frames
            for (let i = 0; i < 10; i++) emitter.update(0.016);

            // Some may have died
            assert.ok(emitter.activeCount <= 20);

            // Draw
            const ctx = {};
            const drawn = [];
            emitter.draw(ctx, (_, p, life) => drawn.push(life));
            assert.equal(drawn.length, emitter.activeCount);
            drawn.forEach((life) => {
                assert.ok(life >= 0);
                assert.ok(life <= 1);
            });

            // Clear
            emitter.clear();
            assert.equal(emitter.activeCount, 0);
        });
    });

    // ==========================================================
    //  v1.1.0 - emission zones
    // ==========================================================

    /** Collect the spawned positions of every live particle. */
    const positions = (e) => {
        const out = [];
        e.draw(null, (_ctx, p) => out.push({ x: p.x, y: p.y }));
        return out;
    };
    const alive = () => ({ life: 1, maxLife: 1 });

    describe('normalizeZone()', () => {
        it('returns null for null/undefined', () => {
            assert.equal(normalizeZone(null), null);
            assert.equal(normalizeZone(undefined), null);
        });
        it('throws on an unknown type rather than silently emitting at 0,0', () => {
            assert.throws(() => normalizeZone({ type: 'blob' }), RangeError);
        });
        it('throws on a non-object', () => {
            assert.throws(() => normalizeZone('ring'), TypeError);
        });
        it('rejects missing or non-finite point fields', () => {
            assert.throws(() => normalizeZone({ type: 'point', x: 0 }), TypeError);
            assert.throws(() => normalizeZone({ type: 'point', x: NaN, y: 0 }), TypeError);
        });
        it('rejects incomplete line / rect / ring', () => {
            assert.throws(() => normalizeZone({ type: 'line', x1: 0, y1: 0, x2: 5 }), TypeError);
            assert.throws(() => normalizeZone({ type: 'rect', x: 0, y: 0, width: 5 }), TypeError);
            assert.throws(() => normalizeZone({ type: 'ring', x: 0, y: 0 }), TypeError);
            assert.throws(() => normalizeZone({ type: 'ring', x: 0, y: 0, radius: -1 }), TypeError);
        });
        it('defaults ring innerRadius to radius (perimeter)', () => {
            assert.equal(normalizeZone({ type: 'ring', x: 0, y: 0, radius: 10 }).innerRadius, 10);
        });
        it('rejects an innerRadius outside [0, radius]', () => {
            assert.throws(() => normalizeZone({ type: 'ring', x: 0, y: 0, radius: 10, innerRadius: 11 }), RangeError);
            assert.throws(() => normalizeZone({ type: 'ring', x: 0, y: 0, radius: 10, innerRadius: -1 }), RangeError);
        });
        it('returns a fresh object, so mutating the caller copy cannot corrupt the emitter', () => {
            const src = { type: 'point', x: 1, y: 2 };
            const z = normalizeZone(src);
            assert.notEqual(z, src);
            src.x = 999;
            assert.equal(z.x, 1);
        });
    });

    describe('zone: point', () => {
        it('spawns every particle at the point and consumes no rng draws', () => {
            const e = new Emitter({ maxParticles: 10, seed: 1, zone: { type: 'point', x: 42, y: 99 } });
            e.emitBurst(5, alive);
            for (const p of positions(e)) {
                assert.equal(p.x, 42);
                assert.equal(p.y, 99);
            }
        });
    });

    describe('zone: line', () => {
        it('spawns on the segment', () => {
            const e = new Emitter({ maxParticles: 300, seed: 2, zone: { type: 'line', x1: 0, y1: 0, x2: 100, y2: 50 } });
            e.emitBurst(300, alive);
            for (const p of positions(e)) {
                assert.ok(p.x >= 0);
                assert.ok(p.x <= 100);
                closeTo(p.y, p.x * 0.5, 6);   // exactly on the line
            }
        });
        it('handles a degenerate zero-length line', () => {
            const e = new Emitter({ maxParticles: 5, seed: 3, zone: { type: 'line', x1: 7, y1: 7, x2: 7, y2: 7 } });
            e.emitBurst(5, alive);
            for (const p of positions(e)) { assert.equal(p.x, 7); assert.equal(p.y, 7); }
        });
    });

    describe('zone: rect', () => {
        it('spawns inside the rectangle', () => {
            const e = new Emitter({ maxParticles: 400, seed: 4, zone: { type: 'rect', x: 10, y: 20, width: 100, height: 50 } });
            e.emitBurst(400, alive);
            for (const p of positions(e)) {
                assert.ok(p.x >= 10);
                assert.ok(p.x < 110);
                assert.ok(p.y >= 20);
                assert.ok(p.y < 70);
            }
        });
    });

    describe('zone: ring', () => {
        it('with no innerRadius, spawns exactly ON the perimeter', () => {
            const e = new Emitter({ maxParticles: 400, seed: 5, zone: { type: 'ring', x: 0, y: 0, radius: 10 } });
            e.emitBurst(400, alive);
            for (const p of positions(e)) {
                closeTo(Math.hypot(p.x, p.y), 10, 9);
            }
        });

        it('with an innerRadius, spawns inside the annulus', () => {
            const e = new Emitter({ maxParticles: 500, seed: 6, zone: { type: 'ring', x: 0, y: 0, radius: 10, innerRadius: 4 } });
            e.emitBurst(500, alive);
            for (const p of positions(e)) {
                const r = Math.hypot(p.x, p.y);
                assert.ok(r >= 4 - 1e-9);
                assert.ok(r <= 10 + 1e-9);
            }
        });

        it('samples the disc uniformly BY AREA, not by radius', () => {
            // Half the area of a disc of radius R lies inside R/sqrt(2).
            // Uniform-by-area  -> ~50% of particles inside.
            // Naive `ri + u * (ro - ri)` -> ~71%, visibly bunched at the centre.
            const e = new Emitter({ maxParticles: 20000, seed: 7, zone: { type: 'ring', x: 0, y: 0, radius: 10, innerRadius: 0 } });
            e.emitBurst(20000, alive);
            const pts = positions(e);
            const inner = pts.filter((p) => Math.hypot(p.x, p.y) < 10 / Math.SQRT2).length;
            assert.ok(inner / pts.length > 0.47);
            assert.ok(inner / pts.length < 0.53);
        });
    });

    describe('zone + config interaction', () => {
        it('config x/y overrides the zone sample', () => {
            const e = new Emitter({ maxParticles: 5, seed: 8, zone: { type: 'rect', x: 0, y: 0, width: 100, height: 100 } });
            e.emitBurst(3, () => ({ ...alive(), x: -1, y: -2 }));
            for (const p of positions(e)) { assert.equal(p.x, -1); assert.equal(p.y, -2); }
        });

        it('no zone leaves the v1.0 behaviour untouched', () => {
            const e = new Emitter({ maxParticles: 5 });
            e.emitBurst(3, () => ({ ...alive(), x: 5, y: 6 }));
            for (const p of positions(e)) { assert.equal(p.x, 5); assert.equal(p.y, 6); }
        });

        it('setZone() swaps the shape at runtime, and null restores raw config x/y', () => {
            const e = new Emitter({ maxParticles: 10, seed: 9, zone: { type: 'point', x: 1, y: 1 } });
            e.setZone({ type: 'point', x: 8, y: 9 });
            e.emitBurst(1, alive);
            assert.deepEqual(positions(e)[0], { x: 8, y: 9 });
            e.clear();
            e.setZone(null);
            e.emitBurst(1, () => ({ ...alive(), x: 3, y: 4 }));
            assert.deepEqual(positions(e)[0], { x: 3, y: 4 });
        });

        it('a moving emitter can mutate zone.x directly', () => {
            const e = new Emitter({ maxParticles: 10, seed: 10, zone: { type: 'point', x: 0, y: 0 } });
            e.zone.x = 250;
            e.emitBurst(1, alive);
            assert.equal(positions(e)[0].x, 250);
        });

        it('setZone() rejects a malformed zone', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.throws(() => e.setZone({ type: 'nope' }), RangeError);
        });
    });

    // ==========================================================
    //  v1.1.0 - determinism
    // ==========================================================

    describe('seeded determinism', () => {
        const emitRing = (seed) => {
            const e = new Emitter({ maxParticles: 100, seed, zone: { type: 'ring', x: 100, y: 100, radius: 50, innerRadius: 10 } });
            e.emitBurst(40, alive);
            return positions(e);
        };

        it('same seed => identical emission sequence', () => {
            assert.deepEqual(emitRing(12345), emitRing(12345));
        });

        it('different seed => different sequence', () => {
            assert.notDeepEqual(emitRing(1), emitRing(2));
        });

        it('.seed(s) re-seeds and replays, matching lite-confetti', () => {
            const e = new Emitter({ maxParticles: 100, seed: 99, zone: { type: 'rect', x: 0, y: 0, width: 500, height: 500 } });
            e.emitBurst(10, alive);
            const first = positions(e);

            e.clear();
            e.seed(99);
            e.emitBurst(10, alive);
            assert.deepEqual(positions(e), first);
        });

        it('a FULL POOL does not burn an rng draw, so replay survives saturation', () => {
            // Sample 3 positions from a roomy pool.
            const roomy = new Emitter({ maxParticles: 10, seed: 77, zone: { type: 'rect', x: 0, y: 0, width: 100, height: 100 } });
            roomy.emitBurst(3, alive);
            const expected = positions(roomy);

            // Now a pool of 3, hammered with 50 emits. The 47 rejected emits must not
            // advance the stream - if the zone were sampled before acquire(), they would.
            const tight = new Emitter({ maxParticles: 3, seed: 77, zone: { type: 'rect', x: 0, y: 0, width: 100, height: 100 } });
            assert.equal(tight.emitBurst(50, alive), 3);
            assert.deepEqual(positions(tight), expected);
        });

        it('accepts an injected PRNG via `random`', () => {
            let n = 0;
            const fake = { next: () => [0.25, 0.75][n++ % 2] };
            const e = new Emitter({ maxParticles: 5, random: fake, zone: { type: 'rect', x: 0, y: 0, width: 100, height: 200 } });
            e.emitBurst(1, alive);
            assert.deepEqual(positions(e)[0], { x: 25, y: 150 });
        });

        it('rejects a `random` without next()', () => {
            assert.throws(() => new Emitter({ random: {} }), TypeError);
        });

        it('.seed() is a no-op when you brought your own PRNG', () => {
            const fake = { next: () => 0.5, reset: mock.fn() };
            const e = new Emitter({ maxParticles: 5, random: fake });
            e.seed(1);
            assert.equal(fake.reset.mock.callCount(), 0);
        });

        it('exposes .random so a configFn can share the stream', () => {
            const e = new Emitter({ maxParticles: 10, seed: 5 });
            assert.equal(typeof e.random.next, 'function');
        });
    });

    // ==========================================================
    //  v1.1.0 - recycledThisFrame
    // ==========================================================

    describe('recycledThisFrame', () => {
        it('starts at 0', () => {
            assert.equal(new Emitter({ maxParticles: 10 }).recycledThisFrame, 0);
        });

        it('counts particles that died of old age', () => {
            const e = new Emitter({ maxParticles: 10 });
            e.emitBurst(4, () => ({ life: 0.1, maxLife: 0.1 }));
            e.update(0.2);
            assert.equal(e.recycledThisFrame, 4);
            assert.equal(e.activeCount, 0);
        });

        it('counts particles culled by bounds', () => {
            const e = new Emitter({ maxParticles: 10, bounds: { x: 0, y: 0, width: 100, height: 100 } });
            e.emitBurst(3, () => ({ x: 50, y: 50, vx: 10000, vy: 0, life: 10, maxLife: 10 }));
            e.update(1 / 60);
            assert.equal(e.recycledThisFrame, 3);
        });

        it('is frame-perfect - it resets on every update()', () => {
            const e = new Emitter({ maxParticles: 10 });
            e.emitBurst(2, () => ({ life: 0.1, maxLife: 0.1 }));
            e.update(0.2);
            assert.equal(e.recycledThisFrame, 2);
            e.update(0.2);
            assert.equal(e.recycledThisFrame, 0);
        });

        it('is 0 when nothing died', () => {
            const e = new Emitter({ maxParticles: 10 });
            e.emitBurst(5, () => ({ life: 10, maxLife: 10 }));
            e.update(1 / 60);
            assert.equal(e.recycledThisFrame, 0);
            assert.equal(e.activeCount, 5);
        });

        it('clear() is a scene reset, not churn - it does not inflate the metric', () => {
            const e = new Emitter({ maxParticles: 10 });
            e.emitBurst(5, () => ({ life: 10, maxLife: 10 }));
            e.update(1 / 60);
            e.clear();
            assert.equal(e.activeCount, 0);
            assert.equal(e.recycledThisFrame, 0);
        });
    });

    describe('emitBurst() return value', () => {
        it('reports how many actually spawned', () => {
            const e = new Emitter({ maxParticles: 10 });
            assert.equal(e.emitBurst(4, alive), 4);
        });

        it('reports the short count when the pool saturates', () => {
            const e = new Emitter({ maxParticles: 3 });
            assert.equal(e.emitBurst(10, alive), 3);
        });
    });

    // ==========================================================
    //  v1.3.0 - LP-01: the emit() schema is a whitelist, particles are sealed
    // ==========================================================

    describe('emit() schema contract (LP-01)', () => {
        it('throws on a config key outside the particle schema, naming it', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.throws(
                () => e.emit({ x: 1, y: 2, color: 'red', life: 1 }),
                (err) => err instanceof TypeError && /color/.test(err.message) && /\.data/.test(err.message),
            );
        });

        it('a rejected emit consumes no pool slot (it threw before acquire)', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.throws(() => e.emit({ sprite: 'boom', life: 1 }));
            assert.equal(e.activeCount, 0);
        });

        it('accepts custom state on data', () => {
            const e = new Emitter({ maxParticles: 5 });
            const p = e.emit({ x: 1, life: 1, data: { color: 'red', sprite: 'boom' } });
            assert.equal(p.data.color, 'red');
        });

        it('a recycled particle carries exactly the schema fields, no inherited key', () => {
            const e = new Emitter({ maxParticles: 2 });
            e.emit({ x: 1, life: 1, r: 0.9, userData: 7, data: { color: 'red' } });
            e.clear();
            const p = e.emit({ x: 5, life: 1 });
            // v1.5.0 added first-class colour (r,g,b,a) and the numeric userData handle.
            assert.deepEqual(
                Object.keys(p).sort(),
                ['a', 'b', 'data', 'drag', 'g', 'gravity', 'life', 'maxLife', 'r', 'size', 'userData', 'vx', 'vy', 'x', 'y'],
            );
            assert.equal(p.data, null);     // no ghost object from the dead particle
            assert.equal(p.r, 1);           // colour reset to opaque white, not the dead 0.9
            assert.equal(p.userData, 0);    // handle reset to 0, not the dead 7
        });

        it('particles are sealed, so a hook cannot weld a stray key on', () => {
            const e = new Emitter({ maxParticles: 5 });
            const p = e.emit({ life: 1 });
            assert.ok(Object.isSealed(p));
            assert.throws(() => { 'use strict'; p.color = 'red'; }, TypeError);
        });

        it('emitEach writes to data fine, but a stray key throws (sealed raw path)', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.doesNotThrow(() => e.emitEach(1, (p) => { p.life = 1; p.data = { color: 'red' }; }));
            assert.throws(() => e.emitEach(1, (p) => { p.life = 1; p.color = 'red'; }), TypeError);
        });
    });

    // ==========================================================
    //  v1.3.0 - LP-04 / LP-05: lifecycle contract + normalizedLife in [0,1]
    // ==========================================================

    /** Draw one particle and return the normalizedLife handed to the callback. */
    const normLifeOf = (e) => {
        let nl;
        e.draw(null, (_c, _p, t) => { nl = t; });
        return nl;
    };
    /** Build a single particle with raw (possibly degenerate) fields via the emitEach path. */
    const raw = (fields) => {
        const e = new Emitter({ maxParticles: 1 });
        e.emitEach(1, (p) => { Object.assign(p, fields); });
        return e;
    };

    describe('lifecycle contract (LP-04 / LP-05)', () => {
        it('couples maxLife to life when only life is given (ramp starts at 1.0)', () => {
            const e = new Emitter({ maxParticles: 5 });
            const p = e.emit({ life: 5 });
            assert.equal(p.maxLife, 5);
            closeTo(normLifeOf(e), 1, 9);
        });

        it('couples life to maxLife when only maxLife is given', () => {
            const e = new Emitter({ maxParticles: 5 });
            const p = e.emit({ maxLife: 3 });
            assert.equal(p.life, 3);
        });

        it('returns null for a missing / non-positive / non-finite life', () => {
            const e = new Emitter({ maxParticles: 5 });
            assert.equal(e.emit({ x: 1, y: 1 }), null);   // no life at all
            assert.equal(e.emit({ life: 0 }), null);
            assert.equal(e.emit({ life: -1 }), null);
            assert.equal(e.emit({ life: NaN }), null);
            assert.equal(e.emit({ life: Infinity }), null);
            assert.equal(e.emit({ life: 1, maxLife: 0 }), null);
            assert.equal(e.emit({ life: 1, maxLife: -2 }), null);
            assert.equal(e.activeCount, 0); // none of them took a slot
        });

        it('normalizedLife is clamped to [0,1] across the degenerate matrix', () => {
            closeTo(normLifeOf(raw({ life: 2, maxLife: 1 })), 1, 9);      // was 2
            assert.equal(normLifeOf(raw({ life: 5, maxLife: 0 })), 0);    // was Infinity
            assert.equal(normLifeOf(raw({ life: NaN, maxLife: 1 })), 0);  // no NaN to the callback
            assert.equal(normLifeOf(raw({ life: 1, maxLife: NaN })), 0);
            assert.equal(normLifeOf(raw({ life: -3, maxLife: 1 })), 0);
            assert.equal(normLifeOf(raw({ life: Infinity, maxLife: 1 })), 1);
            closeTo(normLifeOf(raw({ life: 0.25, maxLife: 1 })), 0.25, 9);
        });

        it('never lets a NaN reach the render callback', () => {
            for (const fields of [{ life: NaN, maxLife: 1 }, { life: 1, maxLife: NaN }, { life: NaN, maxLife: NaN }]) {
                assert.equal(Number.isNaN(normLifeOf(raw(fields))), false);
            }
        });

        it('recycledThisFrame never counts a particle that was never emitted', () => {
            const e = new Emitter({ maxParticles: 5 });
            for (let i = 0; i < 10; i++) e.emit({ x: i, y: 0 }); // all rejected (no life) -> null
            e.update(1 / 60);
            assert.equal(e.activeCount, 0);
            assert.equal(e.recycledThisFrame, 0); // no phantom churn from dead-on-arrival particles
        });
    });

    // ==========================================================
    //  v1.3.0 - LP-06 / LP-07: the zone determinism contract (ZONE_DRAWS)
    // ==========================================================

    describe('zone determinism contract (LP-06 / LP-07)', () => {
        it('ZONE_DRAWS is exported, frozen, and a ring is 2', () => {
            assert.ok(Object.isFrozen(ZONE_DRAWS));
            assert.deepEqual({ ...ZONE_DRAWS }, { point: 0, line: 1, rect: 2, ring: 2 });
        });

        // For each zone type, a seeded stream must advance by exactly ZONE_DRAWS[type]
        // per emitted particle -- assert the STREAM POSITION against a fresh oracle.
        const ZONES = {
            point: { type: 'point', x: 0, y: 0 },
            line: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10 },
            rect: { type: 'rect', x: 0, y: 0, width: 10, height: 10 },
            ring: { type: 'ring', x: 0, y: 0, radius: 10 },            // perimeter
            ringAnnulus: { type: 'ring', x: 0, y: 0, radius: 10, innerRadius: 4 },
        };
        for (const [name, zone] of Object.entries(ZONES)) {
            it(`${name} advances the stream by ZONE_DRAWS[${zone.type}] per particle`, () => {
                const N = 6;
                const e = new Emitter({ maxParticles: 20, seed: 42, zone });
                e.emitEach(N, (p) => { p.life = 1; });
                const ref = new Random(42);
                for (let i = 0; i < ZONE_DRAWS[zone.type] * N; i++) ref.next();
                assert.equal(e.random.getState(), ref.getState());
            });
        }

        it('a ring draws 2 on the perimeter AND as an annulus (constant footprint)', () => {
            const at = (innerRadius) => {
                const e = new Emitter({ maxParticles: 20, seed: 7, zone: { type: 'ring', x: 0, y: 0, radius: 10, innerRadius } });
                e.emitEach(5, (p) => { p.life = 1; });
                return e.random.getState();
            };
            assert.equal(at(10), at(4)); // perimeter and annulus land at the same stream position
        });

        it('mutating innerRadius live across the boundary does NOT desync a seeded replay', () => {
            const e = new Emitter({ maxParticles: 100, seed: 42, zone: { type: 'ring', x: 0, y: 0, radius: 10 } });
            e.emitEach(2, (p) => { p.life = 1; }); // perimeter
            e.zone.innerRadius = 3;                // flip to annulus mid-flight
            e.emitEach(2, (p) => { p.life = 1; }); // annulus
            const ref = new Random(42);
            for (let i = 0; i < ZONE_DRAWS.ring * 4; i++) ref.next();
            assert.equal(e.random.getState(), ref.getState());
        });

        it('perimeter particles still land exactly on the perimeter', () => {
            const e = new Emitter({ maxParticles: 200, seed: 5, zone: { type: 'ring', x: 0, y: 0, radius: 10 } });
            e.emitEach(200, (p) => { p.life = 1; });
            for (const p of positions(e)) closeTo(Math.hypot(p.x, p.y), 10, 9);
        });
    });

    // ==========================================================
    //  v1.3.0 - LP-10: the update() phase order is pinned
    // ==========================================================

    describe('update() phase order (LP-10)', () => {
        it('culls before the onUpdate hook - a culled particle does not see its hook', () => {
            const hook = mock.fn();
            const e = new Emitter({
                maxParticles: 5,
                onUpdate: hook,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
            });
            e.emit({ x: 50, y: 50, vx: 10000, vy: 0, life: 10 }); // integrates out of bounds this frame
            e.update(1 / 60);
            assert.equal(e.activeCount, 0);              // integrated, THEN culled
            assert.equal(hook.mock.callCount(), 0);      // hook never ran for the culled particle
        });

        it('an in-bounds particle is integrated and DOES see the hook', () => {
            const hook = mock.fn();
            const e = new Emitter({
                maxParticles: 5,
                onUpdate: hook,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
            });
            const p = e.emit({ x: 50, y: 50, vx: 10, vy: 0, life: 10 });
            e.update(0.1);
            closeTo(p.x, 51, 6);                         // integrated (50 + 10*0.1)
            assert.equal(hook.mock.callCount(), 1);      // survived the cull, hook ran
        });
    });

    // ==========================================================
    //  v1.4.0 - onDeath sub-emitter (fires on expiry only)
    // ==========================================================

    describe('onDeath sub-emitter', () => {
        it('fires on life-expiry, with the particle at its death position', () => {
            let seen = null;
            const e = new Emitter({ maxParticles: 5, onDeath: (p) => { seen = { x: p.x, y: p.y }; } });
            e.emit({ x: 12, y: 34, life: 0.5 });
            e.update(1); // life -> -0.5 <= 0 : expires
            assert.deepEqual(seen, { x: 12, y: 34 });
            assert.equal(e.recycledThisFrame, 1);
        });

        it('does NOT fire on a bounds cull (off-screen is not death)', () => {
            let fired = 0;
            const e = new Emitter({
                maxParticles: 5,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
                onDeath: () => { fired++; },
            });
            e.emit({ x: 50, y: 50, vx: 100000, vy: 0, life: 100 }); // integrates way out of bounds
            e.update(1);
            assert.equal(e.activeCount, 0);   // it was culled
            assert.equal(fired, 0);           // but onDeath did not fire
            assert.equal(e.recycledThisFrame, 1); // cull still counts as churn
        });

        it('does NOT fire on clear() or destroy() (a scene reset is not death)', () => {
            let fired = 0;
            const e = new Emitter({ maxParticles: 5, onDeath: () => { fired++; } });
            e.emit({ life: 5 });
            e.emit({ life: 5 });
            e.clear();
            assert.equal(e.activeCount, 0);
            e.emit({ life: 5 });
            e.destroy();
            assert.equal(fired, 0);
        });

        it('a particle emitted by onDeath is integrated NEXT frame, not this one', () => {
            let spark = null;
            const e = new Emitter({ maxParticles: 5, onDeath: () => { spark = e.emit({ x: 0, y: 0, vx: 100, life: 2 }); } });
            e.emit({ x: 0, y: 0, life: 0.5 });
            e.update(1); // kills parent, hook emits spark
            assert.equal(e.activeCount, 1);   // the spark is alive
            assert.ok(spark);
            assert.equal(spark.life, 2);      // NOT decremented this frame (born after the cursor passed)
            assert.equal(spark.x, 0);         // NOT integrated this frame (would be 100*1)
            e.update(1);                      // now it moves
            closeTo(spark.x, 100, 6);
        });

        it('a full-pool 1:1 sub-emitter reuses the just-freed slot', () => {
            let sparks = 0;
            const e = new Emitter({ maxParticles: 1, onDeath: () => { sparks++; e.emit({ x: 0, y: 0, life: 1 }); } });
            e.emit({ x: 0, y: 0, life: 0.5 }); // pool now full (size 1)
            e.update(1);                       // parent dies, frees the slot, hook re-emits into it
            assert.equal(sparks, 1);
            assert.equal(e.activeCount, 1);    // spark took the freed slot
        });

        it('keeps iteration correct under randomized churn with a 1:N sub-emitter (fuzz vs invariants)', () => {
            const rng = new Random(1234);
            const e = new Emitter({
                maxParticles: 64,
                onDeath: (p) => {
                    // spawn 0..2 shorter-lived children at the death site, but bound the
                    // lineage well under the cap so the fuzz stays about ITERATION, not the cap
                    if (p._gen >= 4) return;
                    const n = (rng.next() * 3) | 0;
                    for (let k = 0; k < n; k++) e.emit({ x: p.x, y: p.y, vx: rng.next() * 10, life: 0.2 + rng.next() * 0.6 });
                },
            });
            for (let step = 0; step < 4000; step++) {
                if (rng.next() < 0.6) e.emit({ x: rng.next() * 50, y: rng.next() * 50, life: 0.1 + rng.next() });
                e.update(0.1 + rng.next() * 0.2);
                // pool invariants must hold every single step
                assert.equal(e.pool.used + e.pool.free, e.pool.size);
                assert.equal(e.activeCount, e.pool.active);
                assert.ok(e.activeCount >= 0 && e.activeCount <= e.pool.size);
            }
            e.clear();
            assert.equal(e.activeCount, 0);
            assert.equal(e.pool.free, e.pool.size);
        });
    });

    // ==========================================================
    //  v1.4.0 - onDeath cascade cap (throws past maxCascadeDepth)
    // ==========================================================

    describe('onDeath cascade cap', () => {
        // Drive a self-emitting cascade (each spark dies next frame and spawns one deeper)
        // until it either settles or throws. Returns { threw, err, gens } (generations that
        // actually lived and died).
        const runCascade = (maxCascadeDepth) => {
            const gens = new Set();
            const opts = { maxParticles: 256, onDeath: (p) => { gens.add(p._gen); e.emit({ x: 0, y: 0, life: 0.001 }); } };
            if (maxCascadeDepth !== undefined) opts.maxCascadeDepth = maxCascadeDepth;
            const e = new Emitter(opts);
            e.emit({ x: 0, y: 0, life: 0.001 });
            let threw = null;
            try { for (let f = 0; f < 50; f++) e.update(1); }
            catch (err) { threw = err; }
            return { threw, gens };
        };

        it('throws a RangeError naming maxCascadeDepth once the cascade is too deep', () => {
            const { threw } = runCascade(3);
            assert.ok(threw instanceof RangeError);
            assert.match(threw.message, /maxCascadeDepth \(3\)/);
        });

        it('never lets generation cap+1 be born', () => {
            const cap = 4;
            const { gens } = runCascade(cap);
            assert.equal(Math.max(...gens), cap); // deepest generation that ever lived == the cap
            assert.ok(!gens.has(cap + 1));         // cap+1 was refused before it could exist
        });

        it('defaults the cap to 8', () => {
            const { threw, gens } = runCascade(undefined);
            assert.ok(threw instanceof RangeError);
            assert.match(threw.message, /maxCascadeDepth \(8\)/);
            assert.equal(Math.max(...gens), 8);
        });

        it('a bounded cascade (fewer generations than the cap) completes without throwing', () => {
            let depth = 0;
            const e = new Emitter({
                maxParticles: 64,
                maxCascadeDepth: 8,
                onDeath: (p) => { if (p._gen < 3) e.emit({ x: 0, y: 0, life: 0.001 }); }, // stops at gen 3
            });
            e.emit({ x: 0, y: 0, life: 0.001 });
            assert.doesNotThrow(() => { for (let f = 0; f < 20; f++) e.update(1); });
            assert.equal(e.activeCount, 0);
        });
    });

    // ==========================================================
    //  v1.4.0 - curves (baked Float32Array LUTs)
    // ==========================================================

    describe('curves', () => {
        it('curve(name) matches the easing function within tolerance across 256 samples', () => {
            const e = new Emitter({ maxParticles: 1, curves: { grow: easeOutCubic } });
            const grow = e.curve('grow');
            for (let i = 0; i <= 256; i++) {
                const t = i / 256;
                assert.ok(Math.abs(grow(t) - easeOutCubic(t)) < 1e-3, `t=${t}`);
            }
        });

        it('is exact at the endpoints and clamps outside [0,1]', () => {
            const e = new Emitter({ maxParticles: 1, curves: { q: easeInQuad } });
            const q = e.curve('q');
            closeTo(q(0), easeInQuad(0), 9);
            closeTo(q(1), easeInQuad(1), 9);
            assert.equal(q(-5), q(0)); // clamped low
            assert.equal(q(5), q(1));  // clamped high
        });

        it('interpolates linearly between samples (matches a hand lerp of the table)', () => {
            const e = new Emitter({ maxParticles: 1, curveSegments: 8, curves: { c: easeOutCubic } });
            const table = e.curveTable('c');
            const c = e.curve('c');
            const t = 0.3;
            const x = t * (table.length - 1);
            const i = x | 0;
            closeTo(c(t), lerp(table[i], table[i + 1], x - i), 6);
        });

        it('curveTable(name) is a Float32Array of curveSegments length', () => {
            const e = new Emitter({ maxParticles: 1, curveSegments: 128, curves: { c: easeOutCubic } });
            const t = e.curveTable('c');
            assert.ok(t instanceof Float32Array);
            assert.equal(t.length, 128);
        });

        it('curve() returns a stable closure (same reference every call)', () => {
            const e = new Emitter({ maxParticles: 1, curves: { c: easeOutCubic } });
            assert.equal(e.curve('c'), e.curve('c'));
        });

        it('an unknown curve name throws (both curve and curveTable)', () => {
            const e = new Emitter({ maxParticles: 1, curves: { c: easeOutCubic } });
            assert.throws(() => e.curve('nope'), TypeError);
            assert.throws(() => e.curveTable('nope'), TypeError);
        });

        it('an emitter with no curves throws on curve()', () => {
            const e = new Emitter({ maxParticles: 1 });
            assert.throws(() => e.curve('c'), TypeError);
        });

        it('rejects a malformed curves config', () => {
            assert.throws(() => new Emitter({ curves: { bad: 42 } }), TypeError);
            assert.throws(() => new Emitter({ curves: 'nope' }), TypeError);
            assert.throws(() => new Emitter({ curves: { c: easeOutCubic }, curveSegments: 1 }), RangeError);
        });
    });

    // ==========================================================
    //  v1.4.0 - follow(target) (world-space: moves the zone origin)
    // ==========================================================

    describe('follow(target)', () => {
        it('moves a point / ring / rect zone origin to the target each update', () => {
            for (const zone of [
                { type: 'point', x: 0, y: 0 },
                { type: 'ring', x: 0, y: 0, radius: 5 },
                { type: 'rect', x: 0, y: 0, width: 4, height: 4 },
            ]) {
                const e = new Emitter({ maxParticles: 4, zone });
                const target = { x: 7, y: 9 };
                e.follow(target);
                e.update(0.016);
                assert.equal(e.zone.x, 7);
                assert.equal(e.zone.y, 9);
            }
        });

        it('translates a line zone by the target delta, preserving its shape', () => {
            const e = new Emitter({ maxParticles: 4, zone: { type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 } });
            const target = { x: 0, y: 0 };
            e.follow(target);
            target.x = 3; target.y = 4;
            e.update(0.016);
            assert.deepEqual(
                { x1: e.zone.x1, y1: e.zone.y1, x2: e.zone.x2, y2: e.zone.y2 },
                { x1: 3, y1: 4, x2: 13, y2: 4 }, // both endpoints shifted by (3,4); length still 10
            );
        });

        it('is world-space: particles already emitted do not move', () => {
            const e = new Emitter({ maxParticles: 4, zone: { type: 'point', x: 0, y: 0 } });
            const target = { x: 0, y: 0 };
            e.follow(target);
            const born = e.emit({ life: 100 }); // spawns at (0,0)
            target.x = 500; target.y = 500;
            e.update(0.016);                    // zone jumps to (500,500)...
            assert.equal(e.zone.x, 500);
            assert.equal(born.x, 0);            // ...but the existing particle stays put
            assert.equal(born.y, 0);
            const next = e.emit({ life: 100 }); // a NEW emit uses the moved origin
            assert.equal(next.x, 500);
            assert.equal(next.y, 500);
        });

        it('follow(null) stops tracking', () => {
            const e = new Emitter({ maxParticles: 4, zone: { type: 'point', x: 0, y: 0 } });
            const target = { x: 1, y: 1 };
            e.follow(target);
            e.update(0.016);
            assert.equal(e.zone.x, 1);
            e.follow(null);
            target.x = 99; target.y = 99;
            e.update(0.016);
            assert.equal(e.zone.x, 1); // unchanged: no longer following
        });

        it('a null / non-finite target is a per-frame no-op (no NaN in the zone)', () => {
            const e = new Emitter({ maxParticles: 4, zone: { type: 'point', x: 2, y: 3 } });
            const target = { x: 2, y: 3 };
            e.follow(target);
            target.x = NaN;
            e.update(0.016);
            assert.ok(Number.isFinite(e.zone.x) && Number.isFinite(e.zone.y));
            assert.equal(e.zone.x, 2); // stayed at the last good origin
            target.x = undefined;
            e.update(0.016);
            assert.equal(e.zone.x, 2);
        });

        it('throws if asked to follow with no zone to move', () => {
            const e = new Emitter({ maxParticles: 4 });
            assert.throws(() => e.follow({ x: 1, y: 1 }), TypeError);
        });
    });

    // -- v1.5.0: first-class colour ------------------------------------------------------
    describe('colour columns (v1.5.0)', () => {
        it('defaults to opaque white', () => {
            const e = new Emitter({ maxParticles: 4 });
            const p = e.emit({ life: 1 });
            assert.deepEqual([p.r, p.g, p.b, p.a], [1, 1, 1, 1]);
        });

        it('emit() assigns r,g,b,a from config', () => {
            const e = new Emitter({ maxParticles: 4 });
            const p = e.emit({ life: 1, r: 0.2, g: 0.4, b: 0.6, a: 0.8 });
            assert.deepEqual([p.r, p.g, p.b, p.a], [0.2, 0.4, 0.6, 0.8]);
        });

        it('resets to opaque white on recycle (no inherited colour, LP-01)', () => {
            const e = new Emitter({ maxParticles: 1 });
            e.emit({ life: 1, r: 0.1, g: 0.2, b: 0.3, a: 0.4 });
            e.clear();
            const p = e.emit({ life: 1 });
            assert.deepEqual([p.r, p.g, p.b, p.a], [1, 1, 1, 1]);
        });

        it('an unknown colour-ish key still throws (color is not a field)', () => {
            const e = new Emitter({ maxParticles: 4 });
            assert.throws(() => e.emit({ life: 1, color: 'red' }), TypeError);
        });
    });

    // -- v1.5.0: userData numeric handle -------------------------------------------------
    describe('userData handle (v1.5.0)', () => {
        it('round-trips an integer and coexists with the data object', () => {
            const e = new Emitter({ maxParticles: 4 });
            const p = e.emit({ life: 1, userData: 12345, data: { sprite: 'boom' } });
            assert.equal(p.userData, 12345);
            assert.equal(p.data.sprite, 'boom');
        });

        it('defaults to 0 and resets on recycle', () => {
            const e = new Emitter({ maxParticles: 1 });
            const a = e.emit({ life: 1 });
            assert.equal(a.userData, 0);
            e.emit({ life: 1 }); // (a already used the only slot; emit returns null)
            e.clear();
            e.emit({ life: 1, userData: 99 });
            e.clear();
            const p = e.emit({ life: 1 });
            assert.equal(p.userData, 0); // no ghost handle from the dead particle
        });
    });

    // -- v1.5.0: packTo GPU handoff ------------------------------------------------------
    describe('packTo (v1.5.0)', () => {
        it('exports the layout contract', () => {
            assert.equal(POINT_STRIDE, 8);
            assert.equal(LAYOUT_VERSION, 1);
            assert.deepEqual(POINT_OFFSETS, { x: 0, y: 1, size: 2, r: 3, g: 4, b: 5, a: 6, _pad: 7 });
        });

        it('writes (x,y,size,r,g,b,a,_pad) per particle and returns the count', () => {
            const e = new Emitter({ maxParticles: 4 });
            e.emit({ x: 10, y: 20, size: 3, r: 0.5, g: 0.25, b: 0.75, a: 0.5, life: 1 });
            e.emit({ x: 30, y: 40, size: 2, life: 1 }); // opaque white default
            const buf = new Float32Array(4 * POINT_STRIDE);
            const n = e.packTo(buf);
            assert.equal(n, 2);
            const f = Math.fround;
            assert.deepEqual(Array.from(buf.slice(0, 8)), [f(10), f(20), f(3), f(0.5), f(0.25), f(0.75), f(0.5), 0]);
            assert.deepEqual(Array.from(buf.slice(8, 16)), [f(30), f(40), f(2), 1, 1, 1, 1, 0]);
        });

        it('honours a float offset and leaves prior floats untouched', () => {
            const e = new Emitter({ maxParticles: 2 });
            e.emit({ x: 7, life: 1 });
            const buf = new Float32Array(2 * POINT_STRIDE);
            buf.fill(-1);
            const n = e.packTo(buf, POINT_STRIDE);
            assert.equal(n, 1);
            assert.equal(buf[0], -1);                 // before the offset: untouched
            assert.equal(buf[POINT_STRIDE], Math.fround(7)); // x of instance 0 at the offset
        });

        it('throws RangeError on a too-small buffer (fail closed)', () => {
            const e = new Emitter({ maxParticles: 4 });
            e.emit({ life: 1 });
            e.emit({ life: 1 });
            assert.throws(() => e.packTo(new Float32Array(POINT_STRIDE)), RangeError); // room for 1, need 2
        });

        it('throws TypeError on a non-Float32Array out', () => {
            const e = new Emitter({ maxParticles: 4 });
            e.emit({ life: 1 });
            assert.throws(() => e.packTo([]), TypeError);
            assert.throws(() => e.packTo(new Float64Array(64)), TypeError);
        });

        it('returns 0 and writes nothing when empty', () => {
            const e = new Emitter({ maxParticles: 4 });
            const buf = new Float32Array(POINT_STRIDE).fill(-1);
            assert.equal(e.packTo(buf), 0);
            assert.equal(buf[0], -1);
        });

        it('reflects live count after expiry', () => {
            const e = new Emitter({ maxParticles: 4 });
            e.emit({ life: 0.5 });
            e.emit({ life: 5 });
            e.update(1); // first expires
            const buf = new Float32Array(4 * POINT_STRIDE);
            assert.equal(e.packTo(buf), 1);
        });
    });
});
