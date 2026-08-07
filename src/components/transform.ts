import type { Entity } from '../core/entity';
import type { EntitySink } from '../core/component-store';
import { SparseSet } from '../core/sparse-set';

/**
 * The hot-path component. Every entity's transform lives in ONE interleaved
 * Float32Array, stride 10 per entity:
 *
 *   [ px py pz | qx qy qz qw | sx sy sz ]
 *
 * A system streams straight through `raw` in dense order (cache-friendly), and
 * the SparseSet on top gives each row a stable Entity handle. Removal is a
 * single `copyWithin` of the tail row — no holes, no reindexing. This is the
 * layout that actually pays off at 10k+ entities touched every frame.
 */
const STRIDE = 10;

export class TransformStore implements EntitySink {
  private set: SparseSet;
  private data: Float32Array;

  /** @param capacity Initial slot capacity; grows automatically as needed. */
  constructor(capacity = 1024) {
    this.set = new SparseSet(capacity);
    this.data = new Float32Array(capacity * STRIDE);
  }

  private ensure(slot: number): void {
    if ((slot + 1) * STRIDE <= this.data.length) return;
    const next = new Float32Array(Math.max((slot + 1) * STRIDE, this.data.length * 2));
    next.set(this.data);
    this.data = next;
  }

  /** Whether `e` currently has a transform. */
  has(e: Entity): boolean {
    return this.set.has(e);
  }

  /** `e`'s dense-array slot (into `raw`, as `slot * stride`), or -1 if it has no transform. */
  slotOf(e: Entity): number {
    return this.set.slotOf(e);
  }

  /** Add or overwrite a transform. Defaults: origin, identity rotation, unit scale. */
  add(
    e: Entity,
    px = 0, py = 0, pz = 0,
    qx = 0, qy = 0, qz = 0, qw = 1,
    sx = 1, sy = 1, sz = 1,
  ): number {
    let slot = this.set.slotOf(e);
    if (slot === -1) slot = this.set.add(e);
    this.ensure(slot);
    const o = slot * STRIDE;
    const d = this.data;
    d[o] = px; d[o + 1] = py; d[o + 2] = pz;
    d[o + 3] = qx; d[o + 4] = qy; d[o + 5] = qz; d[o + 6] = qw;
    d[o + 7] = sx; d[o + 8] = sy; d[o + 9] = sz;
    return slot;
  }

  /** Removes `e`'s transform, if it has one. A no-op otherwise. */
  remove(e: Entity): void {
    if (!this.set.has(e)) return;
    const { removedSlot, movedSlot } = this.set.remove(e);
    if (removedSlot !== movedSlot) {
      const from = movedSlot * STRIDE;
      this.data.copyWithin(removedSlot * STRIDE, from, from + STRIDE);
    }
  }

  /** Raw interleaved buffer for hot loops. Read/write via `slot * stride + offset`. */
  get raw(): Float32Array {
    return this.data;
  }

  /** Floats per entity in `raw` — currently 10 (position 3, quaternion 4, scale 3). */
  get stride(): number {
    return STRIDE;
  }

  /** Every entity with a transform, in dense (packed) order — parallel to `raw`. */
  get entities(): readonly Entity[] {
    return this.set.dense;
  }

  /** Number of entities with a transform. */
  get size(): number {
    return this.set.size;
  }
}
