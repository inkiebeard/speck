import type { Entity } from '../core/entity';
import type { TransformStore } from '../components/transform';
import type { SpatialGrid } from '../core/spatial-grid';

/** A steering vector — add to velocity, don't treat as one directly. */
export interface Steering {
  x: number;
  y: number;
  z: number;
}

/**
 * Rudimentary separation + cohesion steering for one entity against its
 * neighbors (queried from `grid`, so call `world.registerSpatialGrid` first).
 * Deliberately not alignment — that needs a velocity component this engine
 * doesn't ship, since `TransformStore` only holds position/rotation/scale.
 * Add your own velocity store and an `alignmentSteer` alongside this one the
 * same way: read neighbor velocities, average, return a `Steering`.
 *
 * This is a plain function, not wired into `AiSystem` — call it from inside
 * your own behavior tree `action()` node and apply the result to whatever
 * drives movement (a velocity component, a Rapier body's linvel, ...).
 */
export function separationCohesionSteer(
  grid: SpatialGrid,
  transforms: TransformStore,
  self: Entity,
  radius: number,
  weights: { separation: number; cohesion: number } = { separation: 1.5, cohesion: 1 },
  out: Steering = { x: 0, y: 0, z: 0 },
): Steering {
  out.x = 0;
  out.y = 0;
  out.z = 0;

  const slot = transforms.slotOf(self);
  if (slot === -1) return out;
  const raw = transforms.raw;
  const stride = transforms.stride;
  const o = slot * stride;
  const sx = raw[o];
  const sy = raw[o + 1];
  const sz = raw[o + 2];

  const neighbors = grid.queryRadius(transforms, sx, sy, sz, radius);

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

  out.x = sepX * weights.separation + cohX * weights.cohesion;
  out.y = sepY * weights.separation + cohY * weights.cohesion;
  out.z = sepZ * weights.separation + cohZ * weights.cohesion;
  return out;
}
