import ObjectPool from 'lite-object-pool';

export interface Particle {
    x: number;
    y: number;
    vx: number;
    vy: number;
    gravity: number;
    drag: number;
    life: number;
    maxLife: number;
    size: number;
    data: any;
}

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface EmitterOptions {
    /** Hard memory limit. Default: 1000 */
    maxParticles?: number;
    /** Custom per-particle physics hook. */
    onUpdate?: ((particle: Particle, dt: number) => void) | null;
    /** Bounding box for off-screen culling. */
    bounds?: Bounds | null;
}

export class Emitter {
    readonly pool: ObjectPool<Particle>;
    readonly activeCount: number;
    onUpdate: ((particle: Particle, dt: number) => void) | null;
    bounds: Bounds | null;

    constructor(options?: EmitterOptions);

    /** Spawn a particle. Returns null if pool is full or destroyed. */
    emit(config: Partial<Particle>): Particle | null;
    /** Spawn multiple. configFn receives index. */
    emitBurst(count: number, configFn: (index: number) => Partial<Particle>): void;
    /** Kill all particles. */
    clear(): void;
    /** Core physics update. dt is in SECONDS. */
    update(dt: number): void;
    /** Iterate for rendering. normalizedLife: 1 at birth, 0 at death. */
    draw(ctx: any, renderCallback: (ctx: any, particle: Particle, normalizedLife: number) => void): void;
    /** Destroy emitter and pool. Idempotent. */
    destroy(): void;
}

export default Emitter;
