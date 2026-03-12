/**
 * @zakkster/lite-particles — Zero-Dependency Headless Particle Engine
 *
 * Handles GC-free physics, lifecycles, and bounds culling.
 * Uses lite-object-pool for O(1) acquire/release with double-release protection.
 *
 * IMPORTANT: dt is in SECONDS (not milliseconds).
 * If using requestAnimationFrame, divide by 1000: emitter.update(dt / 1000)
 */

import ObjectPool from 'lite-object-pool';

export class Emitter {
    /**
     * @param {Object}   options
     * @param {number}   [options.maxParticles=1000] Hard memory limit
     * @param {Function} [options.onUpdate]          Custom per-particle physics hook (particle, dt)
     * @param {Object}   [options.bounds]            { x, y, width, height } for off-screen culling
     */
    constructor({ maxParticles = 1000, onUpdate = null, bounds = null } = {}) {
        this.onUpdate = onUpdate;
        this.bounds = bounds;
        this._destroyed = false;

        this.pool = new ObjectPool({
            size: maxParticles,
            expand: false, // Strict memory limit prevents GC spikes
            create: () => ({
                x: 0, y: 0,
                vx: 0, vy: 0,
                gravity: 0, drag: 1,
                life: 0, maxLife: 1,
                size: 1, data: null, // attach custom colors/sprites/metadata
            }),
            reset: (p) => {
                p.x = p.y = 0;
                p.vx = p.vy = 0;
                p.gravity = 0;
                p.drag = 1;
                p.life = 0;
                p.maxLife = 1;
                p.size = 1;
                p.data = null;
            },
        });
    }

    /** Number of particles currently alive. */
    get activeCount() {
        return this.pool.used;
    }

    /**
     * Spawn a single particle. Returns the particle, or null if pool is full.
     * @param {Object} config - Properties to assign (x, y, vx, vy, life, etc.)
     */
    emit(config) {
        if (this._destroyed) return null;
        const p = this.pool.acquire();
        if (!p) return null;
        return Object.assign(p, config);
    }

    /**
     * Spawn multiple particles at once.
     * @param {number}   count    How many to spawn
     * @param {Function} configFn Receives index i, returns config object
     */
    emitBurst(count, configFn) {
        for (let i = 0; i < count; i++) {
            if (!this.emit(configFn(i))) break; // stop if pool fills
        }
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

        // Collect dead particles separately to avoid modifying the Set
        // during iteration (pool.forEachActive iterates _out)
        const dead = [];

        this.pool.forEachActive((p) => {
            p.life -= dt;

            if (p.life <= 0) {
                dead.push(p);
                return;
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
                    dead.push(p);
                    return;
                }
            }

            // Custom user logic
            if (this.onUpdate) this.onUpdate(p, dt);
        });

        // Release dead particles after iteration
        for (const p of dead) this.pool.release(p);
    }

    /**
     * Iterate active particles for rendering.
     * @param {CanvasRenderingContext2D} ctx
     * @param {Function} renderCallback - (ctx, particle, normalizedLife)
     *   normalizedLife is 1.0 at birth, 0.0 at death — perfect for easing.
     */
    draw(ctx, renderCallback) {
        if (this._destroyed) return;

        this.pool.forEachActive((p) => {
            const normalizedLife = Math.max(0, p.life / p.maxLife);
            renderCallback(ctx, p, normalizedLife);
        });
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
    }
}

export default Emitter;
