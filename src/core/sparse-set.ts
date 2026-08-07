import { entityIndex, type Entity } from './entity';

/**
 * The bookkeeping layer that gives you packed iteration *and* stable identity.
 *
 *  - `sparse[entityIndex] -> denseSlot`  (lookup by identity)
 *  - `dense[denseSlot]    -> entity`     (parallel to your component data)
 *
 * Removal is swap-remove: the last element is moved into the vacated slot and
 * both mappings are patched, so the dense array never develops holes and never
 * has to shift. Component stores keep their data arrays parallel to `dense`.
 */
export class SparseSet {
  private sparse: Int32Array;
  readonly dense: Entity[] = [];

  /** @param capacity Initial slot capacity; grows automatically as needed. */
  constructor(capacity = 1024) {
    this.sparse = new Int32Array(capacity).fill(-1);
  }

  private ensure(index: number): void {
    if (index < this.sparse.length) return;
    const next = new Int32Array(Math.max(index + 1, this.sparse.length * 2)).fill(-1);
    next.set(this.sparse);
    this.sparse = next;
  }

  /** Whether `e` is currently present. */
  has(e: Entity): boolean {
    const i = entityIndex(e);
    if (i >= this.sparse.length) return false;
    const slot = this.sparse[i];
    return slot !== -1 && this.dense[slot] === e;
  }

  /** Dense slot of an entity, or -1 if absent. */
  slotOf(e: Entity): number {
    const i = entityIndex(e);
    if (i >= this.sparse.length) return -1;
    const slot = this.sparse[i];
    return slot !== -1 && this.dense[slot] === e ? slot : -1;
  }

  /** Adds an entity, returning the dense slot it now occupies. */
  add(e: Entity): number {
    const slot = this.dense.length;
    this.ensure(entityIndex(e));
    this.dense.push(e);
    this.sparse[entityIndex(e)] = slot;
    return slot;
  }

  /**
   * Swap-removes an entity. Returns the slot that was vacated and the slot the
   * tail element moved *from*, so a parallel data array can mirror the move:
   *   data[removedSlot] = data[movedSlot]; data.pop();
   * When the removed element was already the tail, removedSlot === movedSlot.
   */
  remove(e: Entity): { removedSlot: number; movedSlot: number } {
    const slot = this.sparse[entityIndex(e)];
    const lastSlot = this.dense.length - 1;
    const lastEntity = this.dense[lastSlot];

    this.dense[slot] = lastEntity;
    this.sparse[entityIndex(lastEntity)] = slot;
    this.dense.pop();
    this.sparse[entityIndex(e)] = -1;

    return { removedSlot: slot, movedSlot: lastSlot };
  }

  /** Number of entities currently present. */
  get size(): number {
    return this.dense.length;
  }
}
