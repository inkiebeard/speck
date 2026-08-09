import { test, expect } from '@playwright/test';
import { gotoHarness } from './helpers';

// The ECS core (World/TransformStore/ArrayComponentStore) is the floor every
// other system sits on — if this scales badly, everything built on it does
// too. Not a tight perf gate: the threshold below is a generous sanity
// ceiling meant to catch a pathological regression (an accidental per-tick
// allocation, an O(n^2) creeping into a "streams through raw in dense order"
// path), not to fail on ordinary noise between runs/hardware.
test('World.step scales with entity count', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, ArrayComponentStore, system } = (window as any).Speck;
    const ENTITY_COUNT = 20_000;
    const TICKS = 60;

    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(ENTITY_COUNT));
    const velocity = world.registerStore('velocity', new (ArrayComponentStore as any)(ENTITY_COUNT));

    for (let i = 0; i < ENTITY_COUNT; i++) {
      const e = world.spawn();
      transforms.add(e, Math.random() * 100, 0, Math.random() * 100);
      velocity.add(e, { x: Math.random() - 0.5, z: Math.random() - 0.5 });
    }

    world.addSystem(
      (system as any)((_w: unknown, dt: number) => {
        const raw = transforms.raw;
        const stride = transforms.stride;
        const entities = transforms.entities;
        for (let i = 0; i < entities.length; i++) {
          const v = velocity.get(entities[i]);
          if (!v) continue;
          const o = i * stride;
          raw[o] += v.x * dt;
          raw[o + 2] += v.z * dt;
        }
      }),
    );

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) world.step(1 / 60);
    const totalMs = performance.now() - start;
    return { entityCount: ENTITY_COUNT, ticks: TICKS, totalMs, msPerTick: totalMs / TICKS };
  });

  console.log(
    `[perf] ECS: ${result.entityCount} entities, ${result.ticks} ticks, ` +
      `${result.msPerTick.toFixed(3)} ms/tick (${result.totalMs.toFixed(1)} ms total)`,
  );
  expect(result.msPerTick).toBeLessThan(50);
});
