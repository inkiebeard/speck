import { EntityManager, type Entity } from './entity';
import type { EntitySink } from './component-store';
import { EventQueue, type GameEvent } from './event-queue';
import type { System } from './system';
import type { SpatialGrid } from './spatial-grid';
import type { TransformStore } from '../components/transform';
import type { TweenRunner } from './tween';

/** Emitted by `World.despawn()`, after the entity is stripped from every
 *  store but before its handle is recycled. */
export interface EntityDespawned extends GameEvent {
  type: 'entity:despawned';
  entity: Entity;
}

/**
 * Ties the pieces together: it owns entity allocation, a registry of component
 * stores (keyed by name), the system list, and the event queue. `despawn`
 * removes the entity from every registered store, then recycles the handle.
 */
export class World {
  /** Entity allocation — `spawn()`/`despawn()` are the usual entry points; use this directly for `isAlive()`, `idOf()`/`entityOf()`, or `count`. */
  readonly entities = new EntityManager();
  /** The world's event bus — `events.on()`/`events.emit()`; drained automatically each `step()`. */
  readonly events = new EventQueue();

  private stores = new Map<string, unknown>();
  private sinks: EntitySink[] = [];
  private systems: System[] = [];
  private spatial?: { grid: SpatialGrid; transforms: TransformStore };
  private tweens?: TweenRunner;

  /** Register a component store under a name. Anything with remove(e)/has(e) is
   *  also cleaned up automatically on despawn. */
  registerStore<S extends object>(name: string, store: S): S {
    this.stores.set(name, store);
    if (isSink(store)) this.sinks.push(store);
    return store;
  }

  /** Looks up a store registered under `name`. Throws if nothing's registered there. */
  store<S>(name: string): S {
    const s = this.stores.get(name);
    if (s === undefined) throw new Error(`No store registered as "${name}"`);
    return s as S;
  }

  /** Introspection for tooling (e.g. DebugOverlay): every registered store's
   *  name paired with its `.size`, where the store exposes one. */
  storeSizes(): [name: string, size: number][] {
    const out: [string, number][] = [];
    for (const [name, store] of this.stores) {
      const size = (store as { size?: unknown }).size;
      if (typeof size === 'number') out.push([name, size]);
    }
    return out;
  }

  /** Registers a system to run every `step()`, in registration order. */
  addSystem(system: System): void {
    this.systems.push(system);
  }

  /** Registers a spatial grid to be rebuilt from `transforms` at the start of
   *  every step(), before systems run, so AI/flocking systems can query
   *  current-frame neighbors without managing the rebuild themselves. */
  registerSpatialGrid(grid: SpatialGrid, transforms: TransformStore): void {
    this.spatial = { grid, transforms };
  }

  /** Registers a TweenRunner to be advanced at the end of every step(), after
   *  events drain — so a tween started by an event handler this tick (e.g. a
   *  match-combine animation) gets its first tick the same frame, not one
   *  frame late. */
  registerTweenRunner(runner: TweenRunner): void {
    this.tweens = runner;
  }

  /** Allocates a new entity. It has no components until you add some via a registered store. */
  spawn(): Entity {
    return this.entities.create();
  }

  /** Removes `e` from every registered store, emits `entity:despawned`, then recycles the handle. */
  despawn(e: Entity): void {
    for (let i = 0; i < this.sinks.length; i++) this.sinks[i].remove(e);
    const ev: EntityDespawned = { type: 'entity:despawned', entity: e };
    this.events.emit(ev);
    this.entities.destroy(e);
  }

  /** Run one logic tick: rebuild the spatial grid (if registered), all
   *  systems, drain the event queue, then advance tweens (if registered). */
  step(dt: number): void {
    if (this.spatial) this.spatial.grid.rebuild(this.spatial.transforms);
    for (let i = 0; i < this.systems.length; i++) this.systems[i].update(this, dt);
    this.events.drain(this);
    if (this.tweens) this.tweens.update(dt);
  }
}

function isSink(x: unknown): x is EntitySink {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as EntitySink).remove === 'function' &&
    typeof (x as EntitySink).has === 'function'
  );
}
