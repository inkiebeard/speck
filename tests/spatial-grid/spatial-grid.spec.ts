import { test, expect } from '@playwright/test';
import { gotoHarness } from '../perf/helpers';

// Correctness tests for SpatialGrid.buildNeighborLists — its batched
// cell-pair scan (each nearby cell pair visited once, each entity pair's
// distance computed once, appended to both sides' lists) is trickier than
// queryRadius's straightforward per-point cell scan, so it's cross-checked
// against an O(n^2) brute-force reference: every pair, every distance,
// no shortcuts. Not perf (see tests/perf/spatial-grid.spec.ts for that) —
// this only checks the result set is right.

test('buildNeighborLists matches an O(n^2) brute-force reference: symmetric, no self, exact distance cutoff', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, SpatialGrid } = (window as any).Speck;
    const ENTITY_COUNT = 400; // small enough for an O(n^2) reference to be cheap
    const WORLD_EXTENT = 40; // deliberately dense relative to count, so radius spans multiple cells
    const RADIUS = 3;
    const CELL_SIZE = 2; // deliberately mismatched from radius, to exercise range > 1

    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(ENTITY_COUNT));
    const entities: any[] = [];
    const positions: [number, number, number][] = [];
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const e = world.spawn();
      const x = (Math.random() - 0.5) * WORLD_EXTENT;
      const y = (Math.random() - 0.5) * WORLD_EXTENT; // non-planar on purpose, exercises the Y axis too
      const z = (Math.random() - 0.5) * WORLD_EXTENT;
      transforms.add(e, x, y, z);
      entities.push(e);
      positions.push([x, y, z]);
    }

    const grid = new (SpatialGrid as any)(CELL_SIZE);
    grid.rebuild(transforms);
    const lists = grid.buildNeighborLists(transforms, RADIUS);

    // Brute-force reference: every unordered pair, exact distance check.
    const reference = new Map<any, Set<any>>();
    for (const e of entities) reference.set(e, new Set());
    const r2 = RADIUS * RADIUS;
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const [ax, ay, az] = positions[i];
        const [bx, by, bz] = positions[j];
        const dx = ax - bx, dy = ay - by, dz = az - bz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          reference.get(entities[i])!.add(entities[j]);
          reference.get(entities[j])!.add(entities[i]);
        }
      }
    }

    let mismatches = 0;
    let selfIncluded = 0;
    let duplicatesInList = 0;
    let entitiesMissingFromResult = 0;
    let totalReferenceNeighbors = 0;

    for (const e of entities) {
      const got = lists.get(e);
      if (got === undefined) {
        entitiesMissingFromResult++;
        continue;
      }
      if (got.includes(e)) selfIncluded++;
      if (new Set(got).size !== got.length) duplicatesInList++;

      const expected = reference.get(e)!;
      totalReferenceNeighbors += expected.size;
      const gotSet = new Set(got);
      if (gotSet.size !== expected.size) {
        mismatches++;
        continue;
      }
      for (const n of expected) {
        if (!gotSet.has(n)) {
          mismatches++;
          break;
        }
      }
    }

    return {
      entityCount: ENTITY_COUNT,
      mismatches,
      selfIncluded,
      duplicatesInList,
      entitiesMissingFromResult,
      totalReferenceNeighbors,
    };
  });

  // Sanity: the scenario should actually produce some neighbor pairs, or
  // this test would trivially pass by finding nothing to get wrong.
  expect(result.totalReferenceNeighbors).toBeGreaterThan(0);
  expect(result.entitiesMissingFromResult).toBe(0);
  expect(result.selfIncluded).toBe(0);
  expect(result.duplicatesInList).toBe(0);
  expect(result.mismatches).toBe(0);
});

test('buildNeighborLists reuses `out` correctly across calls as entities move (stale entries cleared, not accumulated)', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, SpatialGrid } = (window as any).Speck;
    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(8));
    const a = world.spawn();
    const b = world.spawn();
    transforms.add(a, 0, 0, 0);
    transforms.add(b, 1, 0, 0); // within radius 2 of a

    const grid = new (SpatialGrid as any)(2);
    const out = new Map();

    grid.rebuild(transforms);
    grid.buildNeighborLists(transforms, 2, out);
    const closeNeighborsOfA = [...out.get(a)];

    // Move b far away and rebuild — a's list should now be empty, not
    // still holding b from the previous call's stale entry.
    transforms.add(b, 100, 0, 0);
    grid.rebuild(transforms);
    grid.buildNeighborLists(transforms, 2, out);
    const farNeighborsOfA = [...out.get(a)];

    return { closeNeighborsOfA, farNeighborsOfA };
  });

  expect(result.closeNeighborsOfA.length).toBe(1);
  expect(result.farNeighborsOfA.length).toBe(0);
});
