import type { Quat } from './quaternion';

/**
 * A mutable 3D vector for engine math — steering, aiming, knockback, terrain
 * placement, anything that isn't hot enough to justify its own SoA store
 * (that's what `TransformStore.raw` is for). Every method mutates `this` and
 * returns it, so a caller reusing one instance across a per-frame loop (the
 * same pattern `SpatialGrid.queryRadius`'s `out` param and `flocking`'s
 * `Steering out` already use) does zero allocation per call. Use `clone()`
 * when you actually need a new, independent instance.
 *
 * API intentionally mirrors `THREE.Vector3`'s naming (`set`, `addScaledVector`,
 * `lengthSq`, ...) since `three` is already a peer dep most projects using
 * this engine will have loaded — no second vocabulary to learn.
 */
export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  /** Overwrites this vector's components in place. */
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  /** Copies `v`'s components into this vector. */
  copy(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  /** A new, independent `Vec3` with the same components. */
  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  /** Adds `v` to this vector in place. */
  add(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  /** Sets this vector to `a + b`. */
  addVectors(a: Vec3, b: Vec3): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  /** Adds `v` scaled by `scalar` to this vector in place — the common
   *  "integrate velocity * dt into position" / "accumulate a weighted
   *  steering contribution" shape, without an intermediate allocation. */
  addScaledVector(v: Vec3, scalar: number): this {
    this.x += v.x * scalar;
    this.y += v.y * scalar;
    this.z += v.z * scalar;
    return this;
  }

  /** Subtracts `v` from this vector in place. */
  sub(v: Vec3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  /** Sets this vector to `a - b`. */
  subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  /** Scales this vector by `scalar` in place. */
  multiplyScalar(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    this.z *= scalar;
    return this;
  }

  /** Divides this vector by `scalar` in place. */
  divideScalar(scalar: number): this {
    return this.multiplyScalar(1 / scalar);
  }

  /** Dot product with `v`. */
  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /** Sets this vector to `a × b` (cross product). Safe to call with `a` or
   *  `b` being `this` — reads both inputs before writing. */
  crossVectors(a: Vec3, b: Vec3): this {
    const ax = a.x, ay = a.y, az = a.z;
    const bx = b.x, by = b.y, bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  /** Cross product of this vector with `v`, in place. */
  cross(v: Vec3): this {
    return this.crossVectors(this, v);
  }

  /** Squared length — prefer over `length()` for comparisons/sorting, no
   *  `Math.sqrt` needed. */
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  /** Euclidean length. */
  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Scales this vector to unit length in place. A zero-length vector is
   *  left unchanged (rather than producing `NaN` from a divide by zero). */
  normalize(): this {
    const len = this.length();
    if (len === 0) return this;
    return this.multiplyScalar(1 / len);
  }

  /** Rescales this vector to exactly `length`, preserving direction, in
   *  place. A zero-length vector is left unchanged (same zero-divide guard
   *  as `normalize`). */
  setLength(length: number): this {
    const len = this.length();
    if (len === 0) return this;
    return this.multiplyScalar(length / len);
  }

  /** Clamps this vector's length in place to the `[min, max]` range,
   *  preserving direction — e.g. capping a launch/steering vector's
   *  magnitude ("force") without flattening its aim. A zero-length vector
   *  is left unchanged. */
  clampLength(min: number, max: number): this {
    const len = this.length();
    if (len === 0) return this;
    return this.multiplyScalar(Math.min(Math.max(len, min), max) / len);
  }

  /** Squared distance to `v` — prefer over `distanceTo` for comparisons. */
  distanceToSquared(v: Vec3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Euclidean distance to `v`. */
  distanceTo(v: Vec3): number {
    return Math.sqrt(this.distanceToSquared(v));
  }

  /** Linearly interpolates this vector toward `v` by `t` (0 = stays here,
   *  1 = becomes `v`), in place. */
  lerp(v: Vec3, t: number): this {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }

  /** Rotates this vector by `q` in place — the standard optimized
   *  quaternion-vector rotation (avoids building the equivalent 3x3 matrix).
   *  `q` is assumed unit length, as any rotation quaternion should be. */
  applyQuaternion(q: Quat): this {
    const x = this.x, y = this.y, z = this.z;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;

    // t = 2 * cross(q.xyz, this)
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);

    this.x = x + qw * tx + (qy * tz - qz * ty);
    this.y = y + qw * ty + (qz * tx - qx * tz);
    this.z = z + qw * tz + (qx * ty - qy * tx);
    return this;
  }

  /** Whether every component exactly matches `v`'s. */
  equals(v: Vec3): boolean {
    return this.x === v.x && this.y === v.y && this.z === v.z;
  }

  /** Reads three components starting at `offset` (default 0) out of a flat
   *  array — e.g. a slice of `TransformStore.raw` — into this vector. */
  fromArray(array: ArrayLike<number>, offset = 0): this {
    this.x = array[offset];
    this.y = array[offset + 1];
    this.z = array[offset + 2];
    return this;
  }

  /** Writes this vector's components into `array` at `offset` (default 0) —
   *  e.g. back into a slice of `TransformStore.raw`. */
  toArray(array: number[] = [], offset = 0): number[] {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    return array;
  }
}
