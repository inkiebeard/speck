import { test, expect } from '@playwright/test';
import { gotoHarness } from '../perf/helpers';

// Correctness tests for src/core/quaternion.ts, not perf — reuses the perf
// harness only because it's the one place that already loads the *built*
// dist/speck.js as a real ES module (see tests/perf/helpers.ts). Like Vec3,
// Quat is deliberately dependency-free (no `three`) so rotation math that
// only ever ends up as raw floats in TransformStore — or gets replayed
// server-side against no renderer at all — doesn't need `three` loaded to
// compute (see src/core/quaternion.ts's own doc comment).

test('Quat.setFromAxisAngle rotates a Vec3 via applyQuaternion correctly', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3, Quat } = (window as any).Speck;

    // 90 degrees around +Y should send +X to -Z (right-handed rotation).
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 2);
    const rotated = new Vec3(1, 0, 0).applyQuaternion(q);

    // 180 degrees around +Y should send +X to -X.
    const qHalfTurn = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI);
    const flipped = new Vec3(1, 0, 0).applyQuaternion(qHalfTurn);

    // Identity quaternion leaves a vector unchanged.
    const unchanged = new Vec3(3, -2, 5).applyQuaternion(new Quat());

    return {
      rotated: { x: rotated.x, y: rotated.y, z: rotated.z },
      flipped: { x: flipped.x, y: flipped.y, z: flipped.z },
      unchanged: { x: unchanged.x, y: unchanged.y, z: unchanged.z },
    };
  });

  expect(result.rotated.x).toBeCloseTo(0, 10);
  expect(result.rotated.y).toBeCloseTo(0, 10);
  expect(result.rotated.z).toBeCloseTo(-1, 10);
  expect(result.flipped.x).toBeCloseTo(-1, 10);
  expect(result.flipped.z).toBeCloseTo(0, 10);
  expect(result.unchanged).toEqual({ x: 3, y: -2, z: 5 });
});

test('Quat.setFromUnitVectors finds the shortest rotation between two directions, including the opposite case', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3, Quat } = (window as any).Speck;

    const from = new Vec3(1, 0, 0);
    const to = new Vec3(0, 1, 0);
    const q = new Quat().setFromUnitVectors(from, to);
    const applied = from.clone().applyQuaternion(q);

    // Identical vectors -> identity rotation.
    const same = new Quat().setFromUnitVectors(new Vec3(0, 0, 1), new Vec3(0, 0, 1));
    const identityCheck = new Vec3(5, 6, 7).applyQuaternion(same);

    // Opposite vectors -> the degenerate 180-degree case (no unique axis,
    // but must still be a valid unit quaternion that maps from -> to).
    const opposite = new Quat().setFromUnitVectors(new Vec3(1, 0, 0), new Vec3(-1, 0, 0));
    const oppositeApplied = new Vec3(1, 0, 0).applyQuaternion(opposite);

    return {
      applied: { x: applied.x, y: applied.y, z: applied.z },
      qLength: q.length(),
      identityCheck: { x: identityCheck.x, y: identityCheck.y, z: identityCheck.z },
      oppositeLength: opposite.length(),
      oppositeApplied: { x: oppositeApplied.x, y: oppositeApplied.y, z: oppositeApplied.z },
    };
  });

  expect(result.applied.x).toBeCloseTo(0, 9);
  expect(result.applied.y).toBeCloseTo(1, 9);
  expect(result.applied.z).toBeCloseTo(0, 9);
  expect(result.qLength).toBeCloseTo(1, 9);
  expect(result.identityCheck).toEqual({ x: 5, y: 6, z: 7 });
  expect(result.oppositeLength).toBeCloseTo(1, 9);
  expect(result.oppositeApplied.x).toBeCloseTo(-1, 9);
  expect(result.oppositeApplied.y).toBeCloseTo(0, 9);
  expect(result.oppositeApplied.z).toBeCloseTo(0, 9);
});

test('Quat.multiply composes rotations, and invert undoes them', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3, Quat } = (window as any).Speck;

    const UP = new Vec3(0, 1, 0);
    const q90 = new Quat().setFromAxisAngle(UP, Math.PI / 2);
    const q180ByMultiply = q90.clone().multiply(q90.clone());
    const q180Direct = new Quat().setFromAxisAngle(UP, Math.PI);

    const v = new Vec3(1, 2, 3);
    const rotated = v.clone().applyQuaternion(q90);
    const roundTrip = rotated.clone().applyQuaternion(q90.clone().invert());

    return {
      composedDot: Math.abs(q180ByMultiply.dot(q180Direct)), // 1 for equal-or-opposite-sign same rotation
      roundTrip: { x: roundTrip.x, y: roundTrip.y, z: roundTrip.z },
    };
  });

  expect(result.composedDot).toBeCloseTo(1, 9);
  expect(result.roundTrip.x).toBeCloseTo(1, 9);
  expect(result.roundTrip.y).toBeCloseTo(2, 9);
  expect(result.roundTrip.z).toBeCloseTo(3, 9);
});

test('Quat.slerp interpolates between orientations and matches endpoints at t=0/t=1', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Vec3, Quat } = (window as any).Speck;

    const UP = new Vec3(0, 1, 0);
    const a = new Quat(); // identity
    const b = new Quat().setFromAxisAngle(UP, Math.PI / 2);

    const atStart = a.clone().slerp(b, 0);
    const atEnd = a.clone().slerp(b, 1);
    const midpoint = a.clone().slerp(b, 0.5);

    // Halfway between a 0deg and 90deg rotation around Y should be ~45deg,
    // i.e. applying it twice should match the 90deg rotation.
    const twiceMidpoint = new Vec3(1, 0, 0).applyQuaternion(midpoint).applyQuaternion(midpoint);
    const direct90 = new Vec3(1, 0, 0).applyQuaternion(b);

    return {
      atStart: { x: atStart.x, y: atStart.y, z: atStart.z, w: atStart.w },
      atEnd: { x: atEnd.x, y: atEnd.y, z: atEnd.z, w: atEnd.w },
      midpointLength: midpoint.length(),
      twiceMidpoint: { x: twiceMidpoint.x, y: twiceMidpoint.y, z: twiceMidpoint.z },
      direct90: { x: direct90.x, y: direct90.y, z: direct90.z },
    };
  });

  expect(result.atStart).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(result.atEnd.y).toBeCloseTo(Math.sin(Math.PI / 4), 9);
  expect(result.atEnd.w).toBeCloseTo(Math.cos(Math.PI / 4), 9);
  expect(result.midpointLength).toBeCloseTo(1, 9);
  expect(result.twiceMidpoint.x).toBeCloseTo(result.direct90.x, 9);
  expect(result.twiceMidpoint.z).toBeCloseTo(result.direct90.z, 9);
});

test('Quat.normalize corrects drift and leaves a zero quaternion as identity; fromArray/toArray round-trip', async ({ page }) => {
  await gotoHarness(page);

  const result = await page.evaluate(() => {
    const { Quat } = (window as any).Speck;

    const drifted = new Quat(2, 0, 0, 0); // length 2, not unit
    drifted.normalize();

    const zero = new Quat(0, 0, 0, 0).normalize();

    const flat = [0, 99, 0.1, 0.2, 0.3, 0.9, 88];
    const fromSlice = new Quat().fromArray(flat, 1);
    const target = [0, 0, 0, 0, 0, 0];
    fromSlice.toArray(target, 1);

    return {
      driftedLength: drifted.length(),
      drifted: { x: drifted.x, y: drifted.y, z: drifted.z, w: drifted.w },
      zero: { x: zero.x, y: zero.y, z: zero.z, w: zero.w },
      fromSlice: { x: fromSlice.x, y: fromSlice.y, z: fromSlice.z, w: fromSlice.w },
      target,
    };
  });

  expect(result.driftedLength).toBeCloseTo(1, 10);
  expect(result.drifted).toEqual({ x: 1, y: 0, z: 0, w: 0 });
  expect(result.zero).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  expect(result.fromSlice).toEqual({ x: 99, y: 0.1, z: 0.2, w: 0.3 });
  expect(result.target).toEqual([0, 99, 0.1, 0.2, 0.3, 0]);
});
