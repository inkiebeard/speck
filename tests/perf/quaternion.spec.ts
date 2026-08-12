import { test, expect } from '@playwright/test';
import { gotoHarness } from './helpers';

// Quat's motivating case is server-side replay of facing/orientation (see
// wizard-survival.js's yawQuaternion, now built on this instead of
// THREE.Quaternion) — a per-entity-per-tick computation for however many
// entities are alive. This benchmarks that shape: for each of many
// "entities," derive a facing quaternion from a direction each tick, rotate
// a forward vector by it, and slerp toward a target orientation — all
// reusing scratch instances, no per-call allocation.
test('Quat setFromAxisAngle/slerp/applyQuaternion stays allocation-cheap across many entities and ticks', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3, Quat } = (window as any).Speck;
    const ENTITY_COUNT = 20_000;
    const TICKS = 60;
    const UP = new Vec3(0, 1, 0);

    const orientations: any[] = [];
    const targetYaws: number[] = [];
    for (let i = 0; i < ENTITY_COUNT; i++) {
      orientations.push(new Quat());
      targetYaws.push(Math.random() * Math.PI * 2);
    }

    const scratchTarget = new Quat();
    const scratchForward = new Vec3();
    const dt = 1 / 60;

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) {
      for (let i = 0; i < ENTITY_COUNT; i++) {
        scratchTarget.setFromAxisAngle(UP, targetYaws[i]);
        orientations[i].slerp(scratchTarget, 1 - Math.exp(-6 * dt));
        scratchForward.set(1, 0, 0).applyQuaternion(orientations[i]);
      }
    }
    const totalMs = performance.now() - start;

    return { entityCount: ENTITY_COUNT, ticks: TICKS, totalMs, msPerTick: totalMs / TICKS };
  });

  console.log(
    `[perf] Quat: ${result.entityCount} entities, ${result.ticks} ticks, ` +
      `${result.msPerTick.toFixed(3)} ms/tick (${result.totalMs.toFixed(1)} ms total)`,
  );
  expect(result.msPerTick).toBeLessThan(50);
});
