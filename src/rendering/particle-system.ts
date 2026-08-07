import * as THREE from 'three';

export interface ParticleSystemOptions {
  /** Point size in world units. Default 0.15. */
  size?: number;
  /** Applied to every particle's velocity each `update()`. Default `{ x: 0, y: -9.81, z: 0 }`. */
  gravity?: { x: number; y: number; z: number };
  /** Linear velocity damping (drag), 0 = none. Default 0. */
  damping?: number;
}

// Raw ShaderMaterial rather than PointsMaterial: stock PointsMaterial has no
// per-vertex alpha (`vertexColors` only ever reads RGB), so a fade-out could
// only darken toward black, not actually go transparent. `vertexColors: true`
// on the material (set below) still gets Three.js to auto-declare `attribute
// vec3 color;` for us, same as any built-in material; `alpha` isn't a
// standard attribute, so it needs declaring by hand here. Circular (not
// square) points, alpha-blended and soft-edged, cost one `discard` +
// `smoothstep` and read a lot less like flat sprites.
const VERTEX_SHADER = /* glsl */ `
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uSize;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - smoothstep(0.3, 0.5, d)));
  }
`;

/**
 * A basic particle burst effect — spawn(), update(dt), done. Particles are
 * deliberately *not* entities: at the count and churn a "basic particle
 * system" implies (spawn dozens at once, dead within a second), the
 * per-particle overhead a full `Entity`/`TransformStore` row buys you
 * (stable identity, picking, component composition) is pure waste, since
 * nothing ever needs to look a particle up by handle. Instead it's one flat
 * pool of typed arrays (position, velocity, life, color, alpha) rendered as
 * a single `THREE.Points` — the same "SoA, not a Map of objects" call
 * `TransformStore` makes, just without the SparseSet identity layer this
 * doesn't need.
 *
 * Dead particles are swap-removed (the last alive particle's data moves into
 * the freed slot) so the live set stays packed at the front of every array —
 * `update()` only ever touches `count` slots, not `capacity`. Emitting past
 * `capacity` is silently dropped, not queued or grown; size the pool for the
 * biggest burst you actually need.
 *
 * Alpha fades to 0 over each particle's life (a real per-vertex fade, via a
 * small custom shader — see the two GLSL strings above). Not driven by
 * `World`/`step()` — call `update(dt)` yourself, fixed or per-frame `dt`
 * both work fine for a purely decorative effect.
 */
export class ParticleSystem {
  /** Add to a scene, or read `.material` to tweak blending. */
  readonly points: THREE.Points;

  private readonly capacity: number;
  private aliveCount = 0;

  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseColor: Float32Array;
  private readonly alpha: Float32Array;

  private readonly geometry: THREE.BufferGeometry;
  private readonly gravity: { x: number; y: number; z: number };
  private readonly damping: number;

  /** @param capacity Max simultaneously-alive particles across every `emit()`
   *  call — a fixed pool, not resized later. Size it for the biggest burst
   *  this instance will ever need. */
  constructor(capacity = 500, options: ParticleSystemOptions = {}) {
    this.capacity = capacity;
    this.gravity = options.gravity ?? { x: 0, y: -9.81, z: 0 };
    this.damping = options.damping ?? 0;

    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseColor = new Float32Array(capacity * 3);
    this.alpha = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.baseColor, 3));
    this.geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: options.size ?? 0.15 } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, material);
  }

  /** Number of particles currently alive. */
  get count(): number {
    return this.aliveCount;
  }

  /**
   * Spawns one particle. Silently dropped if already at `capacity` — this is
   * a fixed-size pool, not a growable queue.
   */
  emit(
    position: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
    life: number,
    color: THREE.Color = WHITE,
  ): void {
    if (this.aliveCount >= this.capacity) return;
    const i = this.aliveCount++;
    const o = i * 3;
    this.positions[o] = position.x;
    this.positions[o + 1] = position.y;
    this.positions[o + 2] = position.z;
    this.velocities[o] = velocity.x;
    this.velocities[o + 1] = velocity.y;
    this.velocities[o + 2] = velocity.z;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseColor[o] = color.r;
    this.baseColor[o + 1] = color.g;
    this.baseColor[o + 2] = color.b;
    this.alpha[i] = 1;
  }

  /** Integrates position/velocity, fades alpha toward 0 over remaining life,
   *  and reaps dead particles. Call once per frame or fixed step. */
  update(dt: number): void {
    for (let i = this.aliveCount - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }

      const o = i * 3;
      this.velocities[o] += this.gravity.x * dt;
      this.velocities[o + 1] += this.gravity.y * dt;
      this.velocities[o + 2] += this.gravity.z * dt;
      if (this.damping) {
        const d = 1 / (1 + this.damping * dt);
        this.velocities[o] *= d;
        this.velocities[o + 1] *= d;
        this.velocities[o + 2] *= d;
      }
      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;

      this.alpha[i] = this.life[i] / this.maxLife[i];
    }

    this.geometry.setDrawRange(0, this.aliveCount);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
  }

  /** Moves the last alive particle's data into slot `i`, then shrinks the
   *  alive count — keeps the live set packed at the front, no holes. `alpha`
   *  is copied too (not just recomputed next frame) since the source slot's
   *  value was already brought current earlier in this same `update()` pass
   *  — copying it avoids a one-frame flash of whatever stale value used to
   *  occupy slot `i`. */
  private swapRemove(i: number): void {
    const last = --this.aliveCount;
    if (i === last) return;

    const oi = i * 3;
    const ol = last * 3;
    this.positions[oi] = this.positions[ol];
    this.positions[oi + 1] = this.positions[ol + 1];
    this.positions[oi + 2] = this.positions[ol + 2];
    this.velocities[oi] = this.velocities[ol];
    this.velocities[oi + 1] = this.velocities[ol + 1];
    this.velocities[oi + 2] = this.velocities[ol + 2];
    this.baseColor[oi] = this.baseColor[ol];
    this.baseColor[oi + 1] = this.baseColor[ol + 1];
    this.baseColor[oi + 2] = this.baseColor[ol + 2];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.alpha[i] = this.alpha[last];
  }
}

const WHITE = new THREE.Color(1, 1, 1);
