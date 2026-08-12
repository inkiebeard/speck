import { test, expect } from '@playwright/test';
import { gotoHarness } from './helpers';

// Vec3 isn't itself wired into any hot per-entity loop the engine ships
// (flocking.ts's inner accumulation deliberately stays plain-number math,
// see its own comment) — but it's meant to be reusable, zero-allocation
// per call so *callers* can put it in one (a velocity-integration system,
// steering applied on top of separationCohesionSteer's output). This
// benchmarks exactly that shape: one scratch Vec3 per "entity", reused
// across many ticks, doing the kind of add/normalize/lerp a movement
// system would do every tick for every entity.
test('Vec3 add/normalize/lerp stays allocation-cheap across many entities and ticks', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3 } = (window as any).Speck;
    const ENTITY_COUNT = 20_000;
    const TICKS = 60;

    const positions: any[] = [];
    const velocities: any[] = [];
    for (let i = 0; i < ENTITY_COUNT; i++) {
      positions.push(new Vec3(Math.random() * 100, 0, Math.random() * 100));
      velocities.push(new Vec3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize());
    }

    const target = new Vec3(50, 0, 50);
    const dt = 1 / 60;
    const scratch = new Vec3(); // reused every entity, every tick — no per-call allocation

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) {
      for (let i = 0; i < ENTITY_COUNT; i++) {
        const pos = positions[i];
        const vel = velocities[i];
        // Steer a bit toward `target`, then integrate — representative of
        // what a movement system built on Vec3 actually does per entity.
        scratch.subVectors(target, pos).normalize();
        vel.lerp(scratch, 0.02).normalize();
        pos.addScaledVector(vel, dt * 5);
      }
    }
    const totalMs = performance.now() - start;

    return { entityCount: ENTITY_COUNT, ticks: TICKS, totalMs, msPerTick: totalMs / TICKS };
  });

  console.log(
    `[perf] Vec3: ${result.entityCount} entities, ${result.ticks} ticks, ` +
      `${result.msPerTick.toFixed(3)} ms/tick (${result.totalMs.toFixed(1)} ms total)`,
  );
  expect(result.msPerTick).toBeLessThan(50);
});
