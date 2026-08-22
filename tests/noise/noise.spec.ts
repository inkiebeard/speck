import { test, expect } from '@playwright/test';
import { gotoHarness } from '../perf/helpers';

// Correctness tests for src/core/noise.ts, not perf — reuses the perf
// harness only because it's the one place that already loads the *built*
// dist/index.js as a real ES module (see tests/perf/helpers.ts). What's
// checked here is the contract the rest of the engine (and logo-flight.js's
// terrain/placement) actually depends on: bounded output, determinism
// given a seed, and poissonDiskSample2D's minimum-distance guarantee.

test('SimplexNoise.noise2D/noise3D are deterministic per seed and stay in range', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { SimplexNoise } = (window as any).Speck;

    const a = new SimplexNoise(42);
    const b = new SimplexNoise(42);
    const c = new SimplexNoise(43);

    let min2 = Infinity;
    let max2 = -Infinity;
    let sameSeedMismatch2 = 0;
    let diffSeedIdentical2 = 0;
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 40; y++) {
        const va = a.noise2D(x * 0.13, y * 0.13);
        const vb = b.noise2D(x * 0.13, y * 0.13);
        const vc = c.noise2D(x * 0.13, y * 0.13);
        min2 = Math.min(min2, va);
        max2 = Math.max(max2, va);
        if (va !== vb) sameSeedMismatch2++;
        if (va === vc) diffSeedIdentical2++;
      }
    }

    let min3 = Infinity;
    let max3 = -Infinity;
    let sameSeedMismatch3 = 0;
    for (let x = 0; x < 15; x++) {
      for (let y = 0; y < 15; y++) {
        for (let z = 0; z < 15; z++) {
          const va = a.noise3D(x * 0.2, y * 0.2, z * 0.2);
          const vb = b.noise3D(x * 0.2, y * 0.2, z * 0.2);
          min3 = Math.min(min3, va);
          max3 = Math.max(max3, va);
          if (va !== vb) sameSeedMismatch3++;
        }
      }
    }

    return { min2, max2, sameSeedMismatch2, diffSeedIdentical2, min3, max3, sameSeedMismatch3 };
  });

  expect(result.sameSeedMismatch2).toBe(0);
  expect(result.sameSeedMismatch3).toBe(0);
  // A different seed producing an identical sample at every single one of
  // 1600 points would mean the seed isn't doing anything; some incidental
  // overlap is fine, all of them isn't.
  expect(result.diffSeedIdentical2).toBeLessThan(1600);
  // Classic simplex noise isn't strictly bounded to [-1, 1] (the 70/32
  // normalization constants are an approximation), but it shouldn't wander
  // far past it either — a bug in the gradient/falloff math tends to show
  // up as a much larger excursion than this.
  expect(result.min2).toBeGreaterThan(-1.05);
  expect(result.max2).toBeLessThan(1.05);
  expect(result.min3).toBeGreaterThan(-1.05);
  expect(result.max3).toBeLessThan(1.05);
});

test('fbm2D/fbm3D stay bounded and respect octave count', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { SimplexNoise, fbm2D, fbm3D } = (window as any).Speck;
    const noise = new SimplexNoise(7);

    let min = Infinity;
    let max = -Infinity;
    for (let x = 0; x < 30; x++) {
      for (let y = 0; y < 30; y++) {
        const v = fbm2D(noise, x * 0.3, y * 0.3, { octaves: 5 });
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }

    const v3 = fbm3D(noise, 1.23, 4.56, 7.89, { octaves: 3 });

    // octaves: 1 must reduce to a single, unscaled noise2D sample.
    const single = fbm2D(noise, 3.3, 4.4, { octaves: 1, frequency: 1, amplitude: 1 });
    const raw = noise.noise2D(3.3, 4.4);

    return { min, max, v3, single, raw };
  });

  expect(result.min).toBeGreaterThan(-1.05);
  expect(result.max).toBeLessThan(1.05);
  expect(result.v3).toBeGreaterThan(-1.05);
  expect(result.v3).toBeLessThan(1.05);
  expect(result.single).toBeCloseTo(result.raw, 10);
});

test('createRng is deterministic per seed and produces [0, 1)', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { createRng } = (window as any).Speck;
    const a = createRng(123);
    const b = createRng(123);

    let min = Infinity;
    let max = -Infinity;
    let mismatches = 0;
    for (let i = 0; i < 1000; i++) {
      const va = a();
      const vb = b();
      if (va !== vb) mismatches++;
      min = Math.min(min, va);
      max = Math.max(max, va);
    }
    return { min, max, mismatches };
  });

  expect(result.mismatches).toBe(0);
  expect(result.min).toBeGreaterThanOrEqual(0);
  expect(result.max).toBeLessThan(1);
});

// This is the guarantee logo-flight.js's blue-noise sculpture scatter
// actually leans on (see PLACEMENT_CANDIDATE_SPACING in
// examples/dynamic-lighting/logo-flight.js) — every candidate point at
// least minDistance from every other, none outside the requested region.
test('poissonDiskSample2D respects minDistance and bounds, and is deterministic per rng seed', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { poissonDiskSample2D, createRng } = (window as any).Speck;

    const width = 100;
    const height = 80;
    const minDistance = 5;

    const pointsA = poissonDiskSample2D({ width, height, minDistance, rng: createRng(9) });
    const pointsB = poissonDiskSample2D({ width, height, minDistance, rng: createRng(9) });

    let outOfBounds = 0;
    for (const [x, y] of pointsA) {
      if (x < 0 || x >= width || y < 0 || y >= height) outOfBounds++;
    }

    let minPairDist = Infinity;
    for (let i = 0; i < pointsA.length; i++) {
      for (let j = i + 1; j < pointsA.length; j++) {
        const dx = pointsA[i][0] - pointsA[j][0];
        const dy = pointsA[i][1] - pointsA[j][1];
        minPairDist = Math.min(minPairDist, Math.hypot(dx, dy));
      }
    }

    const identical =
      pointsA.length === pointsB.length && pointsA.every(([x, y], i) => x === pointsB[i][0] && y === pointsB[i][1]);

    return { count: pointsA.length, outOfBounds, minPairDist, identical };
  });

  expect(result.count).toBeGreaterThan(0);
  expect(result.outOfBounds).toBe(0);
  expect(result.minPairDist).toBeGreaterThanOrEqual(5 - 1e-9);
  expect(result.identical).toBe(true);
});
