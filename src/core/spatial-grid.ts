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

  /** Inverse of `cellKey` — recovers (cx, cy, cz) from a packed key, for
   *  code (like `buildNeighborLists`) that iterates `buckets` directly
   *  rather than looking a specific cell up. */
  private decodeCellKey(key: number): [number, number, number] {
    const z = key % AXIS_SPAN;
    const rest = (key - z) / AXIS_SPAN;
    const y = rest % AXIS_SPAN;
    const x = (rest - y) / AXIS_SPAN;
    return [x - AXIS_OFFSET, y - AXIS_OFFSET, z - AXIS_OFFSET];
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

  /**
   * Computes every entity's neighbors within `radius` in one batched pass,
   * instead of the redundant work a `queryRadius`-per-entity loop pays for
   * at any real population size: entities sharing or bordering the same
   * cells each independently rescan nearly the same neighborhood, and every
   * mutual pair's distance gets computed twice — once from each side. This
   * visits each nearby *pair of cells* once (not once per entity) and each
   * entity pair's distance once, appending the hit to *both* sides' lists.
   * For a flocking/AI population — which, being spatially clustered by
   * construction, is exactly the dense case where per-entity queries
   * overlap the most — this is the difference between an AI tick that fits
   * a 60fps frame budget at thousands of entities and one that doesn't (see
   * the perf test for the measured gap).
   *
   * Call once per tick, after `rebuild()`, for the whole population —
   * not once per entity. `out` is reused across calls the same way
   * `queryRadius`'s `out` array is; each entity's list is cleared in place
   * rather than the map being torn down and rebuilt.
   */
  buildNeighborLists(
    transforms: TransformStore,
    radius: number,
    out: Map<Entity, Entity[]> = new Map(),
  ): Map<Entity, Entity[]> {
    for (const list of out.values()) list.length = 0;

    const listOf = (e: Entity): Entity[] => {
      let list = out.get(e);
      if (!list) {
        list = [];
        out.set(e, list);
      }
      return list;
    };

    const raw = transforms.raw;
    const stride = transforms.stride;
    const r2 = radius * radius;
    // Safe per-cell neighbor range: two entities anywhere within `radius`
    // of each other, however they sit inside their respective cells, land
    // at most `ceil(radius / cellSize)` cells apart on any axis — e.g.
    // cellSize == radius gives range 1, the immediate 3x3x3 neighborhood.
    const range = Math.max(1, Math.ceil(radius / this.cellSize));

    for (const [key, bucket] of this.buckets) {
      const [cx, cy, cz] = this.decodeCellKey(key);

      // Within-cell pairs: i < j so each pair is checked exactly once.
      for (let i = 0; i < bucket.length; i++) {
        const ei = bucket[i];
        const oi = transforms.slotOf(ei) * stride;
        for (let j = i + 1; j < bucket.length; j++) {
          const ej = bucket[j];
          const oj = transforms.slotOf(ej) * stride;
          const dx = raw[oi] - raw[oj];
          const dy = raw[oi + 1] - raw[oj + 1];
          const dz = raw[oi + 2] - raw[oj + 2];
          if (dx * dx + dy * dy + dz * dz <= r2) {
            listOf(ei).push(ej);
            listOf(ej).push(ei);
          }
        }
      }

      // Cross-cell pairs: only the "forward half" of neighbor offsets
      // (dx > 0, or dx == 0 && dy > 0, or dx == 0 && dy == 0 && dz > 0) —
      // visiting just this half from every cell covers every unordered
      // cell pair exactly once, since the complementary "backward" half is
      // this same set seen from the other cell.
      for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
          for (let dz = -range; dz <= range; dz++) {
            if (!(dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0))) continue;
            const otherBucket = this.buckets.get(this.cellKey(cx + dx, cy + dy, cz + dz));
            if (!otherBucket) continue;
            for (let i = 0; i < bucket.length; i++) {
              const ei = bucket[i];
              const oi = transforms.slotOf(ei) * stride;
              for (let j = 0; j < otherBucket.length; j++) {
                const ej = otherBucket[j];
                const oj = transforms.slotOf(ej) * stride;
                const ddx = raw[oi] - raw[oj];
                const ddy = raw[oi + 1] - raw[oj + 1];
                const ddz = raw[oi + 2] - raw[oj + 2];
                if (ddx * ddx + ddy * ddy + ddz * ddz <= r2) {
                  listOf(ei).push(ej);
                  listOf(ej).push(ei);
                }
              }
            }
          }
        }
      }
    }

    // Every entity with a transform gets a list, even an empty one, so
    // callers can `out.get(e)!` without an `?? []` for entities with no
    // neighbors this tick.
    const entities = transforms.entities;
    for (let i = 0; i < entities.length; i++) listOf(entities[i]);

    return out;
  }
}
