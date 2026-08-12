import type { Entity } from '../core/entity';
import type { TransformStore } from '../components/transform';
import { Vec3 } from '../core/vector';

/**
 * Rudimentary separation + cohesion steering for one entity against a
 * precomputed `neighbors` list — get one from `SpatialGrid.buildNeighborLists`,
 * called *once per tick* for the whole population (not once per entity;
 * that's the difference between an AI tick that fits a 60fps budget at
 * thousands of entities and one that doesn't — see that method's own doc
 * comment and `tests/perf/flocking.spec.ts`). Deliberately not alignment —
 * that needs a velocity component this engine doesn't ship, since
 * `TransformStore` only holds position/rotation/scale. Add your own
 * velocity store and an `alignmentSteer` alongside this one the same way:
 * read neighbor velocities, average, return a `Vec3`.
 *
 * This is a plain function, not wired into `AiSystem` — call it from inside
 * your own behavior tree `action()` node and apply the result to whatever
 * drives movement (a velocity component, a Rapier body's linvel, ...). `out`
 * defaults to a fresh `Vec3` but, like `buildNeighborLists`'s own `out` map,
 * is meant to be reused across calls in a per-frame loop to avoid an
 * allocation per entity per tick — the inner accumulation below stays plain
 * numbers rather than `Vec3` math for the same reason (this runs once per
 * neighbor, every entity, every tick).
 */
export function separationCohesionSteer(
  transforms: TransformStore,
  self: Entity,
  neighbors: readonly Entity[],
  weights: { separation: number; cohesion: number } = { separation: 1.5, cohesion: 1 },
  out: Vec3 = new Vec3(),
): Vec3 {
  out.set(0, 0, 0);

  const slot = transforms.slotOf(self);
  if (slot === -1) return out;
  const raw = transforms.raw;
  const stride = transforms.stride;
  const o = slot * stride;
  const sx = raw[o];
  const sy = raw[o + 1];
  const sz = raw[o + 2];

  let sepX = 0, sepY = 0, sepZ = 0;
  let cohX = 0, cohY = 0, cohZ = 0;
  let count = 0;

  for (let i = 0; i < neighbors.length; i++) {
    const n = neighbors[i];
    if (n === self) continue;
    const nSlot = transforms.slotOf(n);
    const no = nSlot * stride;
    const dx = sx - raw[no];
    const dy = sy - raw[no + 1];
    const dz = sz - raw[no + 2];
    const distSq = dx * dx + dy * dy + dz * dz || 1e-6;

    // Separation: push away, weighted more strongly the closer the neighbor.
    sepX += dx / distSq;
    sepY += dy / distSq;
    sepZ += dz / distSq;

    // Cohesion: accumulate neighbor positions to steer toward their center.
    cohX += raw[no];
    cohY += raw[no + 1];
    cohZ += raw[no + 2];
    count++;
  }

  if (count === 0) return out;

  cohX = cohX / count - sx;
  cohY = cohY / count - sy;
  cohZ = cohZ / count - sz;

  return out.set(
    sepX * weights.separation + cohX * weights.cohesion,
    sepY * weights.separation + cohY * weights.cohesion,
    sepZ * weights.separation + cohZ * weights.cohesion,
  );
}
