import type { World } from './world';

/**
 * A system is just something with an `update`. Keep them stateless where you
 * can and let them read/write component stores. Rendering and physics *could*
 * be systems too, but in the example they're called explicitly because they
 * need concrete handles (the THREE scene, the Rapier world) and frame timing.
 */
export interface System {
  update(world: World, dt: number): void;
}

/** A plain function with a `System`'s signature — what `system()` below wraps. */
export type SystemFn = (world: World, dt: number) => void;

/** Wraps a plain function as a `System`, so `World.addSystem` has an object to hold. */
export function system(fn: SystemFn): System {
  return { update: fn };
}
