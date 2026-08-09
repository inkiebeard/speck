import type { Entity } from './entity';
import { SparseSet } from './sparse-set';

/** Minimal interface the World uses to clean an entity out of every store. */
export interface EntitySink {
  has(e: Entity): boolean;
  remove(e: Entity): void;
}

/** Common shape for any per-entity component storage — what `World.store<S>()`
 *  callers and systems generally code against, rather than a concrete store type. */
export interface ComponentStore<T> extends EntitySink {
  /** The component value for `e`, or `undefined` if it doesn't have one. */
  get(e: Entity): T | undefined;
  /** Adds a component, or overwrites it if `e` already has one. */
  add(e: Entity, value: T): void;
  /** Every entity with this component, in dense (packed) order. */
  readonly entities: readonly Entity[];
  /** Number of entities with this component. */
  readonly size: number;
}

/**
 * A component store whose data is a plain `T[]` kept parallel to a SparseSet.
 * Use this for *cold* or *heterogeneous* components — a Rapier body handle, an
 * AI blackboard, a type id. For a hot numeric component that a system streams
 * over every frame (transforms, velocities), prefer a typed-array-backed store
 * so the data is truly contiguous — see TransformStore.
 */
export class ArrayComponentStore<T> implements ComponentStore<T> {
  private set: SparseSet;
  private data: T[] = [];

  /** @param capacity Initial slot capacity; grows automatically as needed. */
  constructor(capacity = 1024) {
    this.set = new SparseSet(capacity);
  }

  /** Whether `e` currently has this component. */
  has(e: Entity): boolean {
    return this.set.has(e);
  }

  /** The component value for `e`, or `undefined` if it doesn't have one. */
  get(e: Entity): T | undefined {
    const slot = this.set.slotOf(e);
    return slot === -1 ? undefined : this.data[slot];
  }

  /** Adds a component, or overwrites it if `e` already has one. */
  add(e: Entity, value: T): void {
    const existing = this.set.slotOf(e);
    if (existing !== -1) {
      this.data[existing] = value;
      return;
    }
    const slot = this.set.add(e);
    this.data[slot] = value;
  }

  /** Removes `e`'s component, if it has one. A no-op otherwise. */
  remove(e: Entity): void {
    if (!this.set.has(e)) return;
    const { removedSlot, movedSlot } = this.set.remove(e);
    this.data[removedSlot] = this.data[movedSlot];
    this.data.pop();
  }

  /** Every entity with this component, in dense (packed) order. */
  get entities(): readonly Entity[] {
    return this.set.dense;
  }

  /** Every component value, in the same dense order as `entities` (i.e.
   *  `values[i]` is `entities[i]`'s component) — for a hot loop that wants to
   *  walk every entity+component pair without re-deriving each entity's slot
   *  via `get()`, which `entities`/`values` already share by construction. */
  get values(): readonly T[] {
    return this.data;
  }

  /** Number of entities with this component. */
  get size(): number {
    return this.set.size;
  }
}
