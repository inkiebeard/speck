import { test, expect } from '@playwright/test';
import { gotoHarness } from '../perf/helpers';

// Correctness tests for src/core/vector.ts, not perf — reuses the perf
// harness only because it's the one place that already loads the *built*
// dist/speck.js as a real ES module (see tests/perf/helpers.ts). `Vec3` is
// deliberately dependency-free (no `three`, see src/core/vector.ts's own
// doc comment) so it can back headless/server-side simulation — these
// checks are the contract that has to hold for that to be trustworthy:
// every method mutates `this` and returns it (chaining, no hidden
// allocation), and the arithmetic itself is correct.

test('Vec3 basic arithmetic (add, sub, multiplyScalar, dot, cross) is correct and chainable', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3 } = (window as any).Speck;

    const a = new Vec3(1, 2, 3);
    const b = new Vec3(4, 5, 6);

    const sum = a.clone().add(b);
    const diff = a.clone().sub(b);
    const scaled = a.clone().multiplyScalar(2);
    const divided = b.clone().divideScalar(2);
    const dot = a.dot(b);
    const cross = new Vec3().crossVectors(a, b);

    // add() returns `this`, not a new instance.
    const self = new Vec3(1, 1, 1);
    const returnedSelf = self.add(new Vec3(1, 1, 1));
    const isSameInstance = returnedSelf === self;

    return {
      sum: { x: sum.x, y: sum.y, z: sum.z },
      diff: { x: diff.x, y: diff.y, z: diff.z },
      scaled: { x: scaled.x, y: scaled.y, z: scaled.z },
      divided: { x: divided.x, y: divided.y, z: divided.z },
      dot,
      cross: { x: cross.x, y: cross.y, z: cross.z },
      isSameInstance,
      // clone() must be independent — mutating the clone shouldn't touch `a`.
      aAfterCloneMutated: { x: a.x, y: a.y, z: a.z },
    };
  });

  expect(result.sum).toEqual({ x: 5, y: 7, z: 9 });
  expect(result.diff).toEqual({ x: -3, y: -3, z: -3 });
  expect(result.scaled).toEqual({ x: 2, y: 4, z: 6 });
  expect(result.divided).toEqual({ x: 2, y: 2.5, z: 3 });
  expect(result.dot).toBe(1 * 4 + 2 * 5 + 3 * 6); // 32
  expect(result.cross).toEqual({ x: 2 * 6 - 3 * 5, y: 3 * 4 - 1 * 6, z: 1 * 5 - 2 * 4 }); // (-3, 6, -3)
  expect(result.isSameInstance).toBe(true);
  expect(result.aAfterCloneMutated).toEqual({ x: 1, y: 2, z: 3 });
});

test('Vec3 length/normalize/distance are correct, and normalize leaves a zero vector unchanged', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3 } = (window as any).Speck;

    const v = new Vec3(3, 4, 0);
    const length = v.length();
    const lengthSq = v.lengthSq();

    const normalized = v.clone().normalize();
    const normalizedLength = normalized.length();

    const zero = new Vec3(0, 0, 0).normalize();

    const a = new Vec3(1, 2, 3);
    const b = new Vec3(4, 6, 3);
    const distance = a.distanceTo(b);
    const distanceSq = a.distanceToSquared(b);

    return {
      length,
      lengthSq,
      normalized: { x: normalized.x, y: normalized.y, z: normalized.z },
      normalizedLength,
      zero: { x: zero.x, y: zero.y, z: zero.z },
      distance,
      distanceSq,
    };
  });

  expect(result.length).toBe(5);
  expect(result.lengthSq).toBe(25);
  expect(result.normalized.x).toBeCloseTo(0.6, 10);
  expect(result.normalized.y).toBeCloseTo(0.8, 10);
  expect(result.normalized.z).toBeCloseTo(0, 10);
  expect(result.normalizedLength).toBeCloseTo(1, 10);
  expect(result.zero).toEqual({ x: 0, y: 0, z: 0 });
  // (1,2,3) -> (4,6,3): dx=3, dy=4, dz=0 -> 5, matching the 3-4-5 case above.
  expect(result.distance).toBe(5);
  expect(result.distanceSq).toBe(25);
});

test('Vec3 lerp, equals, and fromArray/toArray round-trip correctly', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3 } = (window as any).Speck;

    const start = new Vec3(0, 0, 0);
    const end = new Vec3(10, 20, 30);
    const midpoint = start.clone().lerp(end, 0.5);
    const atStart = start.clone().lerp(end, 0);
    const atEnd = start.clone().lerp(end, 1);

    const same = new Vec3(1, 2, 3).equals(new Vec3(1, 2, 3));
    const different = new Vec3(1, 2, 3).equals(new Vec3(1, 2, 3.0001));

    // fromArray reads a 3-float slice at an offset (e.g. out of a
    // TransformStore.raw-shaped buffer); toArray writes back at an offset,
    // preserving whatever was already at other offsets in the array.
    const flat = [99, 1, 2, 3, 88];
    const fromSlice = new Vec3().fromArray(flat, 1);
    const target = [0, 0, 0, 0, 0];
    fromSlice.toArray(target, 2);

    return {
      midpoint: { x: midpoint.x, y: midpoint.y, z: midpoint.z },
      atStart: { x: atStart.x, y: atStart.y, z: atStart.z },
      atEnd: { x: atEnd.x, y: atEnd.y, z: atEnd.z },
      same,
      different,
      fromSlice: { x: fromSlice.x, y: fromSlice.y, z: fromSlice.z },
      target,
    };
  });

  expect(result.midpoint).toEqual({ x: 5, y: 10, z: 15 });
  expect(result.atStart).toEqual({ x: 0, y: 0, z: 0 });
  expect(result.atEnd).toEqual({ x: 10, y: 20, z: 30 });
  expect(result.same).toBe(true);
  expect(result.different).toBe(false);
  expect(result.fromSlice).toEqual({ x: 1, y: 2, z: 3 });
  expect(result.target).toEqual([0, 0, 1, 2, 3]);
});

test('Vec3 setLength/clampLength rescale in place preserving direction, and leave a zero vector unchanged', async ({
  page,
}) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3 } = (window as any).Speck;

    const set = new Vec3(3, 4, 0).setLength(10); // same direction, length 5 -> 10
    const clampedUp = new Vec3(1, 0, 0).clampLength(5, 10); // below min -> raised to 5
    const clampedDown = new Vec3(0, 20, 0).clampLength(5, 10); // above max -> lowered to 10
    const clampedInRange = new Vec3(3, 4, 0).clampLength(1, 10); // already within range -> untouched

    const zeroSet = new Vec3(0, 0, 0).setLength(5);
    const zeroClamped = new Vec3(0, 0, 0).clampLength(1, 5);

    return {
      set: { x: set.x, y: set.y, z: set.z, length: set.length() },
      clampedUp: { x: clampedUp.x, y: clampedUp.y, z: clampedUp.z, length: clampedUp.length() },
      clampedDown: { x: clampedDown.x, y: clampedDown.y, z: clampedDown.z, length: clampedDown.length() },
      clampedInRange: { x: clampedInRange.x, y: clampedInRange.y, z: clampedInRange.z },
      zeroSet: { x: zeroSet.x, y: zeroSet.y, z: zeroSet.z },
      zeroClamped: { x: zeroClamped.x, y: zeroClamped.y, z: zeroClamped.z },
    };
  });

  expect(result.set.x).toBeCloseTo(6, 10);
  expect(result.set.y).toBeCloseTo(8, 10);
  expect(result.set.length).toBeCloseTo(10, 10);
  expect(result.clampedUp).toEqual({ x: 5, y: 0, z: 0, length: 5 });
  expect(result.clampedDown).toEqual({ x: 0, y: 10, z: 0, length: 10 });
  expect(result.clampedInRange).toEqual({ x: 3, y: 4, z: 0 });
  expect(result.zeroSet).toEqual({ x: 0, y: 0, z: 0 });
  expect(result.zeroClamped).toEqual({ x: 0, y: 0, z: 0 });
});
