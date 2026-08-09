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
