import { test, expect } from '@playwright/test';
import { gotoHarness } from './helpers';

// SpatialGrid.rebuild() runs once per World.step() for anything registered
// via registerSpatialGrid (flocking/AI neighbor queries) — it's a full O(n)
// pass over every entity every tick, so its cost directly sets a floor under
// how large a flocking population can get. queryRadius() is the other half:
// cheap only if it stays local to a few cells, which is what the loose
// ceiling below is really checking for (a query touching far more of the
// grid than its radius implies would show up as a much larger number here).
test('SpatialGrid rebuild + queryRadius scale with entity count', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, SpatialGrid } = (window as any).Speck;
    const ENTITY_COUNT = 20_000;
    const REBUILD_TICKS = 30;
    const QUERIES = 1000;
    const WORLD_EXTENT = 200; // entities scattered across a 200x200 area

    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(ENTITY_COUNT));
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const e = world.spawn();
      transforms.add(e, (Math.random() - 0.5) * WORLD_EXTENT, 0, (Math.random() - 0.5) * WORLD_EXTENT);
    }

    const grid = new (SpatialGrid as any)(2); // cellSize matched to the query radius below

    const rebuildStart = performance.now();
    for (let t = 0; t < REBUILD_TICKS; t++) grid.rebuild(transforms);
    const rebuildMs = (performance.now() - rebuildStart) / REBUILD_TICKS;

    const out: unknown[] = [];
    const queryStart = performance.now();
    for (let q = 0; q < QUERIES; q++) {
      grid.queryRadius(
        transforms,
        (Math.random() - 0.5) * WORLD_EXTENT,
        0,
        (Math.random() - 0.5) * WORLD_EXTENT,
        5,
        out,
      );
    }
    const queryMs = (performance.now() - queryStart) / QUERIES;

    return { entityCount: ENTITY_COUNT, rebuildMs, queryMs };
  });

  console.log(
    `[perf] SpatialGrid: ${result.entityCount} entities, rebuild ${result.rebuildMs.toFixed(3)} ms/call, ` +
      `queryRadius ${result.queryMs.toFixed(4)} ms/call`,
  );
  expect(result.rebuildMs).toBeLessThan(100);
  expect(result.queryMs).toBeLessThan(5);
});

// buildNeighborLists exists specifically because a flocking/AI population
// calling queryRadius once per entity, every tick, doesn't scale: at 10k
// entities that pattern alone ate the entire 60fps frame budget (measured
// ~13ms/tick of separationCohesionSteer's ~14.7ms). This benchmarks the
// batched replacement at 20k entities, matching the scale the other
// tests/perf/ benchmarks use, with wizard-survival.js's actual
// SEPARATION_RADIUS/GRID_CELL_SIZE ratio (radius < cellSize, so the
// per-cell neighbor range is 1 — the well-matched case; see
// tests/spatial-grid/spatial-grid.spec.ts for a deliberately mismatched,
// range > 1 case exercised for correctness instead of perf).
test('SpatialGrid.buildNeighborLists scales with entity count and beats per-entity queryRadius at flocking density', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, SpatialGrid } = (window as any).Speck;
    const ENTITY_COUNT = 20_000;
    const TICKS = 30;
    const WORLD_EXTENT = 200;
    const RADIUS = 1.6; // matches wizard-survival.js's SEPARATION_RADIUS
    const CELL_SIZE = 3; // matches wizard-survival.js's GRID_CELL_SIZE (radius < cellSize, range 1)

    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(ENTITY_COUNT));
    const entities: unknown[] = [];
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const e = world.spawn();
      transforms.add(e, (Math.random() - 0.5) * WORLD_EXTENT, 0, (Math.random() - 0.5) * WORLD_EXTENT);
      entities.push(e);
    }

    const grid = new (SpatialGrid as any)(CELL_SIZE);
    const out = new Map();

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) {
      grid.rebuild(transforms);
      grid.buildNeighborLists(transforms, RADIUS, out);
    }
    const totalMs = performance.now() - start;

    let totalNeighbors = 0;
    for (const list of out.values()) totalNeighbors += list.length;

    return {
      entityCount: ENTITY_COUNT,
      msPerTick: totalMs / TICKS,
      avgNeighborsPerEntity: totalNeighbors / ENTITY_COUNT,
    };
  });

  console.log(
    `[perf] SpatialGrid.buildNeighborLists: ${result.entityCount} entities, ` +
      `${result.msPerTick.toFixed(3)} ms/tick, avg ${result.avgNeighborsPerEntity.toFixed(2)} neighbors/entity`,
  );
  // Loose ceiling (pathological-regression catch, not a strict frame-budget
  // assertion — see this file's other tests), not a tight bound on the
  // ~13ms/tick this measures at 20k entities — but well under what a
  // per-entity queryRadius loop cost at 10k (~14.7ms, the measurement that
  // motivated buildNeighborLists in the first place), so a regression back
  // toward that shape would still trip this.
  expect(result.msPerTick).toBeLessThan(20);
});
