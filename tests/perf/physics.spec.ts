import { test, expect, type Page } from '@playwright/test';
import { gotoHarness } from './helpers';

// PhysicsSystem.update() is by far the heaviest system in the engine — it's
// the one matching-game.js already caps to maxStepsPerFrame=1 specifically
// because a single step can outrun a frame budget at high body counts (see
// that file's comment on FixedStep). This benchmark mirrors its actual
// scenario (a pile of dynamic boxes settling under gravity onto a static
// ground) instead of an idealized workload, so the number reflects the real
// cost profile: physics wasm has to init and load from CDN inside the page,
// same as any real consumer, which is also why this is the one spec that
// needs the generous top-level test timeout.
async function runPileBenchmark(page: Page, events: { collisions?: boolean; contactForces?: boolean } | undefined) {
  await gotoHarness(page);
  return page.evaluate(async (events) => {
    const { World, TransformStore, ArrayComponentStore, PhysicsSystem } = (window as any).Speck;
    const BODY_COUNT = 3000;
    const TICKS = 120; // ~2s simulated at 60Hz — still actively settling, not yet asleep
    const ARENA_HALF = 40;

    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(BODY_COUNT));
    const bodies = world.registerStore('body', new (ArrayComponentStore as any)(BODY_COUNT));

    const physics = await (PhysicsSystem as any).create(bodies, { x: 0, y: -20, z: 0 });
    physics.addStaticGround(0, { x: ARENA_HALF, z: ARENA_HALF }, 40, events);

    for (let i = 0; i < BODY_COUNT; i++) {
      const e = world.spawn();
      const x = (Math.random() - 0.5) * 2 * (ARENA_HALF - 3);
      const y = 5 + Math.random() * 20;
      const z = (Math.random() - 0.5) * 2 * (ARENA_HALF - 3);
      transforms.add(e, x, y, z);
      physics.addDynamicBox(e, transforms, undefined, undefined, undefined, events);
    }

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) physics.update(transforms, 1 / 60);
    const totalMs = performance.now() - start;
    return { bodyCount: BODY_COUNT, ticks: TICKS, totalMs, msPerTick: totalMs / TICKS };
  }, events);
}

test('PhysicsSystem.update scales with dynamic body count (default event channels)', async ({ page }) => {
  const result = await runPileBenchmark(page, undefined);

  console.log(
    `[perf] Physics (collisions+contactForces): ${result.bodyCount} dynamic bodies, ${result.ticks} ticks, ` +
      `${result.msPerTick.toFixed(3)} ms/tick (${result.totalMs.toFixed(1)} ms total)`,
  );
  // A generous ceiling: this is the heaviest system by a wide margin, and the
  // point of this suite is visibility into that number over time, not a
  // tight gate that fails on ordinary hardware/CDN-latency noise.
  expect(result.msPerTick).toBeLessThan(200);
});

// Companion to the benchmark above: matching-game.js only ever calls
// drainContactForces, never drainCollisions, so it disables the `collisions`
// channel (see its physicsReady setup) — Rapier was doing collision
// start/stop bookkeeping every step for every touching pair in the pile for
// a channel nothing ever read. Kept as its own test (not folded into the
// default-channels one above) so the actual measured effect of that opt-out
// stays visible here over time, instead of being an unverified assumption.
test('PhysicsSystem.update scales with dynamic body count (contactForces only)', async ({ page }) => {
  const result = await runPileBenchmark(page, { collisions: false });

  console.log(
    `[perf] Physics (contactForces only):     ${result.bodyCount} dynamic bodies, ${result.ticks} ticks, ` +
      `${result.msPerTick.toFixed(3)} ms/tick (${result.totalMs.toFixed(1)} ms total)`,
  );
  expect(result.msPerTick).toBeLessThan(200);
});
