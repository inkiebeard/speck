/**
 * Procedural noise for terrain, density fields, and placement. Three.js
 * ships none of this — it's a renderer, not a world generator — so this is
 * the engine's own implementation, dependency-free and seeded throughout
 * (never `Math.random`) so a given seed reproduces the same terrain/layout
 * every run, which a save file or a networked level seed depends on.
 *
 * - `SimplexNoise` — classic (Gustavson) simplex noise, 2D and 3D. Chosen
 *   over Perlin noise for the usual reasons: no axis-aligned directional
 *   artifact, cheaper per sample at higher dimensions, and a well-known
 *   public-domain reference implementation to seed from.
 * - `fbm2D`/`fbm3D` — fractal Brownian motion: layers octaves of simplex
 *   noise at increasing frequency/decreasing amplitude, the standard way to
 *   turn single-frequency noise into terrain-like detail (heightmaps,
 *   cave density fields, cloud/foliage masks).
 * - `poissonDiskSample2D` — blue-noise-*like* point placement via Bridson's
 *   dart-throwing algorithm. True blue noise (flat power spectrum, no low
 *   frequencies) is expensive to synthesize exactly; Bridson's algorithm is
 *   the standard cheap approximation and is what "blue noise sampling" means
 *   in practice for placement (trees, rocks, spawn points) — evenly spread,
 *   minimum-distance-respecting, without the clumping or gaps a uniform
 *   random scatter produces.
 */

export type Rng = () => number;

/**
 * Seeded PRNG (mulberry32) returning floats in [0, 1). Used internally by
 * `SimplexNoise` and `poissonDiskSample2D` for reproducibility — pass the
 * same seed (or a `Rng` from this) to get identical output every run.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;

// Gradient directions shared by both the 2D and 3D paths, matching the
// reference implementation's 12-edge-midpoint set.
const GRAD3: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

/**
 * Simplex noise sampler seeded once at construction. Each instance owns its
 * own permutation table, so different `SimplexNoise` instances with
 * different seeds sample independent, uncorrelated fields — layer several
 * (e.g. one for height, one for moisture) without them lining up.
 */
export class SimplexNoise {
  private perm = new Uint8Array(512);
  private permMod12 = new Uint8Array(512);

  /** @param seed A number (hashed into a PRNG) or an existing `Rng` to draw from. */
  constructor(seed: number | Rng = 1) {
    const rng = typeof seed === 'function' ? seed : createRng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /** Samples 2D noise at (x, y), roughly in [-1, 1]. */
  noise2D(x: number, y: number): number {
    const { perm, permMod12 } = this;
    let n0 = 0, n1 = 0, n2 = 0;

    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = x - X0, y0 = y - Y0;

    let i1: number, j1: number;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }

    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;

    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0][0] * x0 + GRAD3[gi0][1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1][0] * x1 + GRAD3[gi1][1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2][0] * x2 + GRAD3[gi2][1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  /** Samples 3D noise at (x, y, z), roughly in [-1, 1]. */
  noise3D(x: number, y: number, z: number): number {
    const { perm, permMod12 } = this;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;

    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const X0 = i - t, Y0 = j - t, Z0 = k - t;
    const x0 = x - X0, y0 = y - Y0, z0 = z - Z0;

    let i1: number, j1: number, k1: number;
    let i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;

    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD3[gi0][0] * x0 + GRAD3[gi0][1] * y0 + GRAD3[gi0][2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD3[gi1][0] * x1 + GRAD3[gi1][1] * y1 + GRAD3[gi1][2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD3[gi2][0] * x2 + GRAD3[gi2][1] * y2 + GRAD3[gi2][2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 >= 0) {
      const gi3 = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n3 = t3 * t3 * (GRAD3[gi3][0] * x3 + GRAD3[gi3][1] * y3 + GRAD3[gi3][2] * z3);
    }
    return 32 * (n0 + n1 + n2 + n3);
  }
}

export interface FbmOptions {
  /** Number of noise layers summed together. More = finer detail, more cost. Default 4. */
  octaves?: number;
  /** Starting sample frequency (input scale). Default 1. */
  frequency?: number;
  /** Starting layer weight. Default 1. */
  amplitude?: number;
  /** Frequency multiplier per octave. Default 2 (each octave doubles detail). */
  lacunarity?: number;
  /** Amplitude multiplier per octave. Default 0.5 (each octave contributes half as much). */
  persistence?: number;
}

/**
 * Fractal Brownian motion over `noise.noise2D` — the standard way to build
 * terrain-like heightmaps or masks from raw simplex noise. Output is
 * normalized back into roughly [-1, 1] regardless of octave count.
 */
export function fbm2D(noise: SimplexNoise, x: number, y: number, opts: FbmOptions = {}): number {
  const { octaves = 4, frequency = 1, amplitude = 1, lacunarity = 2, persistence = 0.5 } = opts;
  let freq = frequency, amp = amplitude, sum = 0, max = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise.noise2D(x * freq, y * freq) * amp;
    max += amp;
    freq *= lacunarity;
    amp *= persistence;
  }
  return sum / max;
}

/** Same as `fbm2D` but over `noise.noise3D` — for volumetric fields (cave density, 3D clouds). */
export function fbm3D(noise: SimplexNoise, x: number, y: number, z: number, opts: FbmOptions = {}): number {
  const { octaves = 4, frequency = 1, amplitude = 1, lacunarity = 2, persistence = 0.5 } = opts;
  let freq = frequency, amp = amplitude, sum = 0, max = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise.noise3D(x * freq, y * freq, z * freq) * amp;
    max += amp;
    freq *= lacunarity;
    amp *= persistence;
  }
  return sum / max;
}

export interface PoissonDiskOptions {
  /** Sample region width, starting at x = 0. */
  width: number;
  /** Sample region height, starting at y = 0. */
  height: number;
  /** Minimum allowed distance between any two points. */
  minDistance: number;
  /** Candidate points tried around each active point before it's retired. Default 30 (Bridson's recommendation). */
  maxAttempts?: number;
  /** Seeded RNG to draw from; defaults to a fixed seed so calls are reproducible unless you pass your own. */
  rng?: Rng;
}

/**
 * Blue-noise-like 2D point placement via Bridson's dart-throwing algorithm:
 * every returned point is at least `minDistance` from every other, with no
 * large empty gaps — the property that makes it read as "natural" scatter
 * for tree/rock/prop placement, vs. the clumps and holes a uniform random
 * scatter produces at the same density. Runs in roughly O(n) in the number
 * of points produced.
 */
export function poissonDiskSample2D(opts: PoissonDiskOptions): Array<[number, number]> {
  const { width, height, minDistance, maxAttempts = 30, rng = createRng(1) } = opts;
  const cellSize = minDistance / Math.SQRT2;
  const gridW = Math.max(1, Math.ceil(width / cellSize));
  const gridH = Math.max(1, Math.ceil(height / cellSize));
  const grid = new Int32Array(gridW * gridH).fill(-1);
  const points: Array<[number, number]> = [];
  const active: number[] = [];

  const gridIndex = (x: number, y: number): number =>
    Math.floor(y / cellSize) * gridW + Math.floor(x / cellSize);

  const addPoint = (x: number, y: number): void => {
    const idx = points.length;
    points.push([x, y]);
    active.push(idx);
    grid[gridIndex(x, y)] = idx;
  };

  const farEnoughFromExisting = (x: number, y: number): boolean => {
    const gx = Math.floor(x / cellSize), gy = Math.floor(y / cellSize);
    const minGx = Math.max(gx - 2, 0), maxGx = Math.min(gx + 2, gridW - 1);
    const minGy = Math.max(gy - 2, 0), maxGy = Math.min(gy + 2, gridH - 1);
    const minDistSq = minDistance * minDistance;
    for (let iy = minGy; iy <= maxGy; iy++) {
      for (let ix = minGx; ix <= maxGx; ix++) {
        const idx = grid[iy * gridW + ix];
        if (idx === -1) continue;
        const [px, py] = points[idx];
        const dx = px - x, dy = py - y;
        if (dx * dx + dy * dy < minDistSq) return false;
      }
    }
    return true;
  };

  addPoint(rng() * width, rng() * height);
  while (active.length > 0) {
    const activeSlot = Math.floor(rng() * active.length);
    const [ox, oy] = points[active[activeSlot]];
    let placed = false;
    for (let k = 0; k < maxAttempts; k++) {
      const angle = rng() * Math.PI * 2;
      const r = minDistance * (1 + rng());
      const nx = ox + Math.cos(angle) * r;
      const ny = oy + Math.sin(angle) * r;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      if (farEnoughFromExisting(nx, ny)) {
        addPoint(nx, ny);
        placed = true;
        break;
      }
    }
    if (!placed) active.splice(activeSlot, 1);
  }
  return points;
}
