import type { Vec3 } from './vector';

/**
 * A mutable quaternion for engine rotation math — facing/yaw, orienting one
 * direction toward another, blending between orientations — with the same
 * dependency-free, in-place, chainable shape as `Vec3` (see that file's own
 * doc comment) and for the same reason: rotation math that only ever ends up
 * as raw floats in `TransformStore` (or replayed server-side against no
 * renderer at all) shouldn't need `three` loaded to compute. Reserve
 * `THREE.Quaternion` for what's actually tied to a scene-graph object (a
 * camera, a mesh) or a Three-specific operation this doesn't reimplement.
 *
 * API intentionally mirrors `THREE.Quaternion`'s naming, same rationale as
 * `Vec3`: no second vocabulary for projects that also use `three`.
 */
export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  /** Overwrites this quaternion's components in place. */
  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  /** Resets this quaternion to the identity rotation. */
  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  /** Copies `q`'s components into this quaternion. */
  copy(q: Quat): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  /** A new, independent `Quat` with the same components. */
  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  /** Sets this quaternion to a rotation of `angle` radians around `axis`
   *  (expected unit length) — the common "yaw around up" / "spin around an
   *  arbitrary axis" case. */
  setFromAxisAngle(axis: Vec3, angle: number): this {
    const half = angle / 2;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  /** Sets this quaternion to the shortest rotation that takes unit vector
   *  `from` onto unit vector `to` — the building block for "face this
   *  direction" without a full look-at/matrix path. Both inputs are assumed
   *  unit length; normalize them first if they aren't. */
  setFromUnitVectors(from: Vec3, to: Vec3): this {
    let r = from.dot(to) + 1;
    if (r < 1e-8) {
      // `from`/`to` point in opposite directions — no single shortest cross
      // product axis exists, so pick any axis orthogonal to `from`.
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.x = -from.y;
        this.y = from.x;
        this.z = 0;
      } else {
        this.x = 0;
        this.y = -from.z;
        this.z = from.y;
      }
    } else {
      this.x = from.y * to.z - from.z * to.y;
      this.y = from.z * to.x - from.x * to.z;
      this.z = from.x * to.y - from.y * to.x;
    }
    this.w = r;
    return this.normalize();
  }

  /** Sets this quaternion to the Hamilton product `a * b` (apply `b` first,
   *  then `a`) — safe to call with `a` or `b` being `this`. */
  multiplyQuaternions(a: Quat, b: Quat): this {
    const ax = a.x, ay = a.y, az = a.z, aw = a.w;
    const bx = b.x, by = b.y, bz = b.z, bw = b.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /** Multiplies this quaternion by `q` in place (`this = this * q`), i.e.
   *  applies `q`'s rotation before this one's. */
  multiply(q: Quat): this {
    return this.multiplyQuaternions(this, q);
  }

  /** Multiplies this quaternion by `q` from the left in place
   *  (`this = q * this`), i.e. applies this rotation before `q`'s. */
  premultiply(q: Quat): this {
    return this.multiplyQuaternions(q, this);
  }

  /** Negates the imaginary (x, y, z) part in place — for a unit quaternion,
   *  this is its inverse (the rotation that undoes it). */
  conjugate(): this {
    this.x *= -1;
    this.y *= -1;
    this.z *= -1;
    return this;
  }

  /** Squared length — prefer over `length()` when only comparing. */
  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }

  /** Euclidean length. A rotation quaternion should stay at length 1;
   *  accumulated floating-point error is what `normalize()` corrects. */
  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  /** Scales this quaternion to unit length in place. A zero-length
   *  quaternion is left as identity, matching `Vec3.normalize`'s "don't
   *  produce NaN" guarantee. */
  normalize(): this {
    const len = this.length();
    if (len === 0) return this.identity();
    const inv = 1 / len;
    this.x *= inv;
    this.y *= inv;
    this.z *= inv;
    this.w *= inv;
    return this;
  }

  /** Inverts this quaternion in place — the rotation that undoes it.
   *  Equivalent to `conjugate()` for a unit quaternion, but also correct for
   *  a non-unit one (unlike a bare `conjugate()`). */
  invert(): this {
    return this.conjugate().normalize();
  }

  /** Dot product with `q` — its magnitude is a similarity measure between
   *  two orientations (1 = identical, -1 = the same rotation's opposite
   *  sign, 0 = maximally different), and it's what `slerp` uses internally
   *  to pick the shorter path. */
  dot(q: Quat): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /** Spherically interpolates this quaternion toward `q` by `t` (0 = stays
   *  here, 1 = becomes `q`), in place — the correct way to blend between two
   *  orientations (unlike a per-component `lerp`, which doesn't stay unit
   *  length or move at a constant angular rate). Falls back to a normalized
   *  linear interpolation when the two are nearly identical, where slerp's
   *  formula becomes numerically unstable. */
  slerp(q: Quat, t: number): this {
    if (t === 0) return this;
    if (t === 1) return this.copy(q);

    const { x, y, z, w } = this;
    let cosHalfTheta = w * q.w + x * q.x + y * q.y + z * q.z;

    // Negate one side if the dot product is negative, so slerp takes the
    // shorter path between the two orientations (q and -q represent the
    // same rotation, but interpolate very differently).
    let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    if (cosHalfTheta < 0) {
      cosHalfTheta = -cosHalfTheta;
      qx = -qx; qy = -qy; qz = -qz; qw = -qw;
    }

    if (cosHalfTheta >= 1 - 1e-6) {
      this.x = x + (qx - x) * t;
      this.y = y + (qy - y) * t;
      this.z = z + (qz - z) * t;
      this.w = w + (qw - w) * t;
      return this.normalize();
    }

    const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
    const halfTheta = Math.atan2(sinHalfTheta, cosHalfTheta);
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

    this.x = x * ratioA + qx * ratioB;
    this.y = y * ratioA + qy * ratioB;
    this.z = z * ratioA + qz * ratioB;
    this.w = w * ratioA + qw * ratioB;
    return this;
  }

  /** Whether every component exactly matches `q`'s. */
  equals(q: Quat): boolean {
    return this.x === q.x && this.y === q.y && this.z === q.z && this.w === q.w;
  }

  /** Reads four components starting at `offset` (default 0) out of a flat
   *  array — e.g. a slice of `TransformStore.raw` — into this quaternion. */
  fromArray(array: ArrayLike<number>, offset = 0): this {
    this.x = array[offset];
    this.y = array[offset + 1];
    this.z = array[offset + 2];
    this.w = array[offset + 3];
    return this;
  }

  /** Writes this quaternion's components into `array` at `offset` (default
   *  0) — e.g. back into a slice of `TransformStore.raw`. */
  toArray(array: number[] = [], offset = 0): number[] {
    array[offset] = this.x;
    array[offset + 1] = this.y;
    array[offset + 2] = this.z;
    array[offset + 3] = this.w;
    return array;
  }
}
