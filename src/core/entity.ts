/**
 * An Entity is just a number, but a *generational* one: the low 20 bits are a
 * slot index, the high 12 bits are a generation counter. When an entity is
 * destroyed its slot is recycled with a bumped generation, so any old handle
 * pointing at that slot fails `isAlive()` instead of silently addressing the
 * new occupant. This is the fix for the "raw index feels fragile" problem —
 * you never reason about raw slots, only opaque Entity handles.
 */
import { generateId } from './id';

export type Entity = number & { readonly __brand: unique symbol };

const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xFFFFF -> 1,048,575
const GENERATION_MASK = 0xfff; // 12 bits -> 4095

/** Total addressable slots — the low 20 bits of an `Entity`, so `2^20`. */
export const MAX_ENTITIES = INDEX_MASK + 1; // 1,048,576

/** Extracts the slot index (low 20 bits) from an `Entity` handle. */
export function entityIndex(e: Entity): number {
  return e & INDEX_MASK;
}

/** Extracts the generation counter (high 12 bits) from an `Entity` handle. */
export function entityGeneration(e: Entity): number {
  return (e >>> INDEX_BITS) & GENERATION_MASK;
}

/** Packs a slot index and generation counter into an `Entity` handle. Mainly
 *  for `EntityManager`'s own use — most code should get handles from
 *  `EntityManager.create()`/`World.spawn()`, not construct them by hand. */
export function makeEntity(index: number, generation: number): Entity {
  // `>>> 0` forces an unsigned 32-bit result so handles stay positive.
  return ((((generation & GENERATION_MASK) << INDEX_BITS) | (index & INDEX_MASK)) >>> 0) as Entity;
}

/**
 * Allocates and recycles entity handles. Freed slots go on a free list and are
 * reissued with an incremented generation.
 */
export class EntityManager {
  private generations: number[] = [];
  private freeList: number[] = [];
  private aliveCount = 0;
  // Stable random id per slot, the handle external tooling (level editors,
  // save files, network messages) should hold instead of the raw Entity —
  // reissued on every create() (including slot reuse) so a stale id never
  // aliases a live entity, and looking one up never requires decoding
  // index/generation bits by hand.
  private ids: string[] = [];
  private idToEntity = new Map<string, Entity>();

  /** Allocates a new entity handle — a recycled slot if the free list has
   *  one (with its generation bumped), otherwise the next unused slot. Also
   *  mints and records the entity's stable external id (see `idOf`). */
  create(): Entity {
    let index: number;
    if (this.freeList.length > 0) {
      index = this.freeList.pop()!;
    } else {
      index = this.generations.length;
      if (index >= MAX_ENTITIES) {
        throw new Error(`Entity index space exhausted (${MAX_ENTITIES})`);
      }
      this.generations.push(0);
    }
    this.aliveCount++;
    const entity = makeEntity(index, this.generations[index]);
    const id = generateId();
    this.ids[index] = id;
    this.idToEntity.set(id, entity);
    return entity;
  }

  /** Frees the entity's slot for reuse, bumping its generation so any handle
   *  still pointing at it fails `isAlive()`, and drops its stable id. */
  destroy(e: Entity): void {
    const index = entityIndex(e);
    this.idToEntity.delete(this.ids[index]);
    // Bump generation (wraps at 4096) so stale handles no longer validate.
    this.generations[index] = (this.generations[index] + 1) & GENERATION_MASK;
    this.freeList.push(index);
    this.aliveCount--;
  }

  /** Whether `e`'s slot is still occupied by that exact generation — false
   *  for a destroyed entity or a stale handle to a recycled slot. */
  isAlive(e: Entity): boolean {
    const index = entityIndex(e);
    return index < this.generations.length && this.generations[index] === entityGeneration(e);
  }

  /** The stable string id for this entity's current occupancy of its slot. */
  idOf(e: Entity): string {
    return this.ids[entityIndex(e)];
  }

  /** Resolve a stable id back to its live Entity handle, if still alive. */
  entityOf(id: string): Entity | undefined {
    return this.idToEntity.get(id);
  }

  /** Number of currently-alive entities. */
  get count(): number {
    return this.aliveCount;
  }
}
