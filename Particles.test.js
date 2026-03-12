import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock lite-object-pool with the real implementation
vi.mock('lite-object-pool', async () => {
    const { ObjectPool } = await import('./LiteObjectPool.js');
    return { default: ObjectPool, ObjectPool };
});

import { Emitter } from './LiteParticles.js';

describe('🎆 lite-particles', () => {
    let emitter;

    beforeEach(() => {
        emitter = new Emitter({ maxParticles: 100 });
    });

    describe('constructor', () => {
        it('starts with 0 active particles', () => {
            expect(emitter.activeCount).toBe(0);
        });

        it('accepts custom maxParticles', () => {
            const em = new Emitter({ maxParticles: 50 });
            expect(em.pool.size).toBe(50);
        });

        it('accepts onUpdate hook', () => {
            const hook = vi.fn();
            const em = new Emitter({ onUpdate: hook });
            expect(em.onUpdate).toBe(hook);
        });

        it('accepts bounds', () => {
            const bounds = { x: 0, y: 0, width: 800, height: 600 };
            const em = new Emitter({ bounds });
            expect(em.bounds).toBe(bounds);
        });
    });

    describe('emit()', () => {
        it('spawns a particle', () => {
            const p = emitter.emit({ x: 100, y: 200, life: 1 });
            expect(p).not.toBeNull();
            expect(p.x).toBe(100);
            expect(p.y).toBe(200);
            expect(emitter.activeCount).toBe(1);
        });

        it('returns null when pool is full', () => {
            const em = new Emitter({ maxParticles: 2 });
            em.emit({ life: 1 });
            em.emit({ life: 1 });
            expect(em.emit({ life: 1 })).toBeNull();
        });

        it('returns null after destroy', () => {
            emitter.destroy();
            expect(emitter.emit({ life: 1 })).toBeNull();
        });
    });

    describe('emitBurst()', () => {
        it('spawns multiple particles', () => {
            emitter.emitBurst(10, (i) => ({
                x: i * 10, y: 0, life: 1,
            }));
            expect(emitter.activeCount).toBe(10);
        });

        it('stops when pool fills', () => {
            const em = new Emitter({ maxParticles: 5 });
            em.emitBurst(10, () => ({ life: 1 }));
            expect(em.activeCount).toBe(5);
        });

        it('passes index to configFn', () => {
            const configs = [];
            emitter.emitBurst(3, (i) => {
                configs.push(i);
                return { life: 1 };
            });
            expect(configs).toEqual([0, 1, 2]);
        });
    });

    describe('update()', () => {
        it('decrements particle life', () => {
            const p = emitter.emit({ life: 1, maxLife: 1 });
            emitter.update(0.5);
            expect(p.life).toBeCloseTo(0.5);
        });

        it('removes dead particles', () => {
            emitter.emit({ life: 0.1 });
            emitter.update(0.2); // life goes to -0.1 → released
            expect(emitter.activeCount).toBe(0);
        });

        it('applies gravity', () => {
            const p = emitter.emit({ life: 10, vy: 0, gravity: 100 });
            emitter.update(0.1);
            expect(p.vy).toBeCloseTo(10); // gravity * dt = 100 * 0.1
        });

        it('applies drag', () => {
            const p = emitter.emit({ life: 10, vx: 100, drag: 0.9 });
            emitter.update(1 / 60);
            expect(p.vx).toBeLessThan(100);
        });

        it('updates position', () => {
            const p = emitter.emit({ life: 10, x: 0, vx: 100 });
            emitter.update(0.1);
            expect(p.x).toBeCloseTo(10); // 100 * 0.1
        });

        it('skips drag when drag is 1', () => {
            const p = emitter.emit({ life: 10, vx: 50, drag: 1 });
            emitter.update(0.1);
            expect(p.vx).toBe(50); // unchanged
        });

        it('culls out-of-bounds particles', () => {
            const em = new Emitter({
                maxParticles: 10,
                bounds: { x: 0, y: 0, width: 100, height: 100 },
            });
            em.emit({ x: 50, y: 50, vx: 2000, life: 10 });
            em.update(0.1); // x = 50 + 2000*0.1 = 250 → out of bounds
            expect(em.activeCount).toBe(0);
        });

        it('calls onUpdate hook', () => {
            const hook = vi.fn();
            const em = new Emitter({ maxParticles: 10, onUpdate: hook });
            em.emit({ life: 10 });
            em.update(0.016);
            expect(hook).toHaveBeenCalledWith(expect.any(Object), 0.016);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            expect(() => emitter.update(0.1)).not.toThrow();
        });
    });

    describe('clear()', () => {
        it('releases all active particles', () => {
            emitter.emitBurst(10, () => ({ life: 1 }));
            expect(emitter.activeCount).toBe(10);
            emitter.clear();
            expect(emitter.activeCount).toBe(0);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            expect(() => emitter.clear()).not.toThrow();
        });
    });

    describe('draw()', () => {
        it('calls renderCallback for each active particle', () => {
            emitter.emit({ life: 1, maxLife: 1 });
            emitter.emit({ life: 0.5, maxLife: 1 });

            const ctx = {};
            const callback = vi.fn();
            emitter.draw(ctx, callback);

            expect(callback).toHaveBeenCalledTimes(2);
        });

        it('passes normalized life (1 at birth, 0 at death)', () => {
            emitter.emit({ life: 0.5, maxLife: 1 });

            const ctx = {};
            const callback = vi.fn();
            emitter.draw(ctx, callback);

            const normalizedLife = callback.mock.calls[0][2];
            expect(normalizedLife).toBeCloseTo(0.5);
        });

        it('passes ctx and particle to callback', () => {
            const p = emitter.emit({ life: 1, maxLife: 1 });

            const ctx = { fake: true };
            const callback = vi.fn();
            emitter.draw(ctx, callback);

            expect(callback.mock.calls[0][0]).toBe(ctx);
            expect(callback.mock.calls[0][1]).toBe(p);
        });

        it('is no-op after destroy', () => {
            emitter.emit({ life: 1 });
            emitter.destroy();
            const callback = vi.fn();
            emitter.draw({}, callback);
            expect(callback).not.toHaveBeenCalled();
        });
    });

    describe('destroy()', () => {
        it('sets _destroyed flag', () => {
            emitter.destroy();
            expect(emitter._destroyed).toBe(true);
        });

        it('destroys the pool', () => {
            const spy = vi.spyOn(emitter.pool, 'destroy');
            emitter.destroy();
            expect(spy).toHaveBeenCalled();
        });

        it('is idempotent', () => {
            emitter.destroy();
            expect(() => emitter.destroy()).not.toThrow();
        });

        it('nulls onUpdate and bounds', () => {
            emitter.onUpdate = () => {};
            emitter.bounds = { x: 0, y: 0, width: 100, height: 100 };
            emitter.destroy();
            expect(emitter.onUpdate).toBeNull();
            expect(emitter.bounds).toBeNull();
        });
    });

    describe('full lifecycle', () => {
        it('emit → update → draw → clear cycle', () => {
            // Spawn burst
            emitter.emitBurst(20, (i) => ({
                x: 400, y: 300,
                vx: Math.cos(i) * 100,
                vy: Math.sin(i) * 100,
                gravity: 200,
                life: 1,
                maxLife: 1,
            }));
            expect(emitter.activeCount).toBe(20);

            // Simulate a few frames
            for (let i = 0; i < 10; i++) emitter.update(0.016);

            // Some may have died
            expect(emitter.activeCount).toBeLessThanOrEqual(20);

            // Draw
            const ctx = {};
            const drawn = [];
            emitter.draw(ctx, (_, p, life) => drawn.push(life));
            expect(drawn.length).toBe(emitter.activeCount);
            drawn.forEach(life => {
                expect(life).toBeGreaterThanOrEqual(0);
                expect(life).toBeLessThanOrEqual(1);
            });

            // Clear
            emitter.clear();
            expect(emitter.activeCount).toBe(0);
        });
    });
});
