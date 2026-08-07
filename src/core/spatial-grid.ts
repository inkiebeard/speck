import type { Entity } from './entity';
import type { TransformStore } from '../components/transform';

// Cell coordinates are packed into a single safe-integer key via multiplication
// (not bitwise ops, which truncate to 32 bits in JS). 16 bits per axis, offset
// to allow negative coordinates: covers cell indices in [-32768, 32767] per
// axis, i.e. a world extent of ±32768 * cellSize on each axis.
const AXIS_BITS = 16;
const AXIS_OFFSET = 1 << (AXIS_BITS - 1); // 32768
const AXIS_SPAN = 1 << AXIS_BITS; // 65536

/**
 * Uniform spatial hash grid over entity positions. Rebuilt from a
 * `TransformStore` in one flat pass each tick — no persistent per-entity
 * pointers, no tree rebalancing — which is what makes it cheap to redo every
 * frame for entities that are constantly moving (flocking, steering). A
 * tree (quadtree/octree) adapts better to sparse/uneven worlds, but pays for
 * that with pointer-chasing inserts that fight this engine's flat-array
 * design; a grid is the right default for a roughly-uniform, fully-dynamic
 * population like a swarm or a level's active entity set.
 */
export class SpatialGrid {
  private cellSize: number;
  private buckets = new Map<number, Entity[]>();

  /** @param cellSize Bucket edge length in world units — pick something near
   *  the query radius you'll actually use, so a query touches only a handful
   *  of cells instead of many tiny ones or one giant one. */
  constructor(cellSize = 2) {
    this.cellSize = cellSize;
  }

  private cellKey(cx: number, cy: number, cz: number): number {
    const x = cx + AXIS_OFFSET;
    const y = cy + AXIS_OFFSET;
    const z = cz + AXIS_OFFSET;
    return (x * AXIS_SPAN + y) * AXIS_SPAN + z;
  }

  /** Empties the grid. `rebuild()` calls this itself — rarely needed directly. */
  clear(): void {
    this.buckets.clear();
  }

  /** Rebuilds the grid from every entity in `transforms`, discarding the previous contents. */
  rebuild(transforms: TransformStore): void {
    this.clear();
    const raw = transforms.raw;
    const stride = transforms.stride;
    const entities = transforms.entities;
    for (let i = 0; i < entities.length; i++) {
      const o = i * stride;
      const cx = Math.floor(raw[o] / this.cellSize);
      const cy = Math.floor(raw[o + 1] / this.cellSize);
      const cz = Math.floor(raw[o + 2] / this.cellSize);
      const key = this.cellKey(cx, cy, cz);
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = [];
        this.buckets.set(key, bucket);
      }
      bucket.push(entities[i]);
    }
  }

  /**
   * Entities within `radius` of (x, y, z), exact-filtered by distance (the
   * cell scan itself is only an AABB-of-cells approximation). Reuses `out` if
   * given, to avoid an allocation per query in a flocking/AI inner loop.
   */
  queryRadius(
    transforms: TransformStore,
    x: number,
    y: number,
    z: number,
    radius: number,
    out: Entity[] = [],
  ): Entity[] {
    out.length = 0;
    const r2 = radius * radius;
    const raw = transforms.raw;
    const stride = transforms.stride;

    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    const minCz = Math.floor((z - radius) / this.cellSize);
    const maxCz = Math.floor((z + radius) / this.cellSize);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const bucket = this.buckets.get(this.cellKey(cx, cy, cz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const e = bucket[i];
            const slot = transforms.slotOf(e);
            const o = slot * stride;
            const dx = raw[o] - x;
            const dy = raw[o + 1] - y;
            const dz = raw[o + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
          }
        }
      }
    }
    return out;
  }
}
