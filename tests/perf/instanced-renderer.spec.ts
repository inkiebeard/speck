import { test, expect } from '@playwright/test';
import { gotoHarness } from './helpers';

// InstancedRenderer.sync() runs once per rendered frame (not per fixed
// step), walking every entity to write its matrix into the right
// InstancedMesh — the render-side equivalent of the ECS benchmark. This is
// the path the matching-game example's 3000-item pile exercises every
// frame; this benchmark pushes it an order of magnitude further to see
// where it starts to bend.
test('InstancedRenderer.sync scales with instance count', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { World, TransformStore, ArrayComponentStore, InstancedRenderer } = (window as any).Speck;
    const THREE = (window as any).THREE;
    const INSTANCE_COUNT = 20_000;
    const TYPE_COUNT = 8;
    const TICKS = 60;

    const scene = new THREE.Scene();
    const world = new (World as any)();
    const transforms = world.registerStore('transform', new (TransformStore as any)(INSTANCE_COUNT));
    const types = world.registerStore('type', new (ArrayComponentStore as any)(INSTANCE_COUNT));

    const renderer = new (InstancedRenderer as any)(scene);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    for (let t = 0; t < TYPE_COUNT; t++) renderer.registerType(t, geo, material, INSTANCE_COUNT);

    for (let i = 0; i < INSTANCE_COUNT; i++) {
      const e = world.spawn();
      transforms.add(e, Math.random() * 100, Math.random() * 10, Math.random() * 100);
      types.add(e, i % TYPE_COUNT);
    }

    const start = performance.now();
    for (let t = 0; t < TICKS; t++) renderer.sync(transforms, types);
    const totalMs = performance.now() - start;
    return { instanceCount: INSTANCE_COUNT, ticks: TICKS, totalMs, msPerSync: totalMs / TICKS };
  });

  console.log(
    `[perf] InstancedRenderer: ${result.instanceCount} instances, ${result.ticks} syncs, ` +
      `${result.msPerSync.toFixed(3)} ms/sync (${result.totalMs.toFixed(1)} ms total)`,
  );
  expect(result.msPerSync).toBeLessThan(50);
});
