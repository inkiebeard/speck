/**
 * Wizard survival — a basic player controller (wizard.glb) fighting off a
 * necromancer (necromancer.glb) that periodically raises a swarm of
 * skeletons (skeleton.glb, capped at 100 concurrently alive), which seek the
 * player out and attack in melee. The player fights back with a mana-gated
 * spell bolt.
 *
 * Shows the engine's GLTF loader, AI (behavior trees + the per-entity AI
 * system + separation steering off SpatialGrid), the event queue for
 * damage/death, InputBuffer, and Preloader for the loading screen — no
 * physics, unlike the examples/physics demo.
 *
 * Run `npm run build` first, then serve the repo root statically and open
 * wizard-survival.html.
 */
// Vector/rotation math note: world-space position/velocity/direction/facing
// math below uses the engine's own Vec3 and Quat (src/core/vector.ts,
// src/core/quaternion.ts) rather than THREE.Vector3/Quaternion — both have
// zero dependency on three (this engine treats three as an optional peer,
// confined to rendering/audio; see src/index.ts), so game logic written
// against them — player/skeleton/necromancer facing and movement included —
// stays portable to a headless/server context that never loads three at
// all (e.g. a server replaying/validating a recorded action log). THREE's
// own Vector3/Vector2/Quaternion are still used for the handful of spots
// tied to an actual three.js scene-graph object (mesh.position, a Box3
// query, the camera) — Vec3/Quat deliberately don't reimplement those.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import {
  World,
  TransformStore,
  ArrayComponentStore,
  SpatialGrid,
  GltfLoader,
  ParticleSystem,
  InputBuffer,
  SoundSystem,
  DebugOverlay,
  Preloader,
  FixedStep,
  createAiSystem,
  sequence,
  selector,
  action,
  condition,
  separationCohesionSteer,
  Vec3,
  Quat,
} from '../../dist/speck.js';

// --- Synthesized sound effects (no audio assets needed) ---------------------

function createCastBuffer(context) {
  const duration = 0.3;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const freq = 500 + t * 1400; // rising sweep reads as a "casting" whoosh
    const envelope = Math.sin(Math.PI * (t / duration));
    data[i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.6;
  }
  return buffer;
}

function createHitBuffer(context) {
  const duration = 0.1;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const envelope = Math.exp(-30 * t);
    data[i] = (Math.random() * 2 - 1) * envelope * 0.5;
  }
  return buffer;
}

function createDeathBuffer(context) {
  const duration = 0.4;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const freq = 300 * Math.exp(-3 * t);
    const envelope = Math.exp(-4 * t);
    data[i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.5;
  }
  return buffer;
}

function createHurtBuffer(context) {
  const duration = 0.15;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const envelope = Math.exp(-12 * t);
    data[i] = Math.sin(2 * Math.PI * 110 * t) * envelope * 0.7;
  }
  return buffer;
}

function createSpawnBuffer(context) {
  const duration = 0.35;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const freq = 90 + t * 40;
    const envelope = Math.exp(-6 * t);
    data[i] = Math.sin(2 * Math.PI * freq * t) * envelope * 0.6;
  }
  return buffer;
}

/** The necromancer's own bolt — a falling, dissonant two-tone sting, deliberately
 *  darker than the player's rising castSfx sweep so the two read as distinct threats. */
function createNecromancerCastBuffer(context) {
  const duration = 0.4;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const freqs = [220, 233]; // a minor second apart — deliberately dissonant
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const sweep = 1 - 0.4 * (t / duration);
    const envelope = Math.exp(-3 * t);
    let sample = 0;
    for (const f of freqs) sample += Math.sin(2 * Math.PI * f * sweep * t);
    data[i] = (sample / freqs.length) * envelope * 0.7;
  }
  return buffer;
}

// --- Tuning constants ---------------------------------------------------

const ARENA_HALF = 45;
const PLAYER_START = { x: 0, y: 0, z: 18 };
const NECROMANCER_POS = { x: 0, y: 0, z: -25 };

const PLAYER_MAX_HP = 100;
const PLAYER_SPEED = 7.5;
const PLAYER_RADIUS = 0.5;

// Chase cam orbiting the player at (CAM_DISTANCE, CAM_YAW, CAM_PITCH) — yaw
// doubles as the player's own facing (mouse/touch-look turns the character).
const CAM_MIN_DISTANCE = 3;
const CAM_MAX_DISTANCE = 16;
const CAM_MIN_PITCH = -0.15;
const CAM_MAX_PITCH = 1.15;
const CAM_EYE_HEIGHT = 1.4;
const MOUSE_LOOK_SENSITIVITY = 0.0024;
const TOUCH_LOOK_SENSITIVITY = 0.0055;
const JOYSTICK_RADIUS = 45; // px

const MANA_MAX = 100;
const MANA_REGEN_PER_SEC = 14;
// Press-and-hold power-up: charge fraction 0..1 ramps over CHARGE_MAX_TIME and
// lerps cost/damage/radius/speed between their MIN/MAX pair.
const CHARGE_MAX_TIME = 1.1;
const SPELL_MIN_COST = 12;
const SPELL_MAX_COST = 42;
const SPELL_MIN_DAMAGE = 15;
const SPELL_MAX_DAMAGE = 55;
const SPELL_MIN_RADIUS = 0.35;
const SPELL_MAX_RADIUS = 0.75;
const SPELL_MIN_SPEED = 15;
const SPELL_MAX_SPEED = 34;
// Reach scales with charge too, not just a flat cap — otherwise a bare tap
// (slow, and least affected by gravity per SPELL_MIN_GRAVITY_SCALE below)
// hangs in the air nearly as long as a full charge and reads as an
// oddly long throw for the weakest possible shot. Past its lerped range a
// still-airborne bolt is forced down regardless of charge.
const SPELL_MIN_RANGE = 12;
const SPELL_MAX_RANGE = 45;
const GRAVITY = -24; // heavier than Earth's — reads as a weighty lob, not floaty
// A bigger charge is a heavier mass of energy, not just a faster copy of a
// small one — scaling gravity too is what sells that weight.
const SPELL_MIN_GRAVITY_SCALE = 0.65;
const SPELL_MAX_GRAVITY_SCALE = 1.5;
// Splash on impact — horizontal-only distance, damage falling off linearly to
// 0 at the edge. MIN_RADIUS is kept past SEPARATION_RADIUS so even an
// uncharged tap reliably catches a crowded neighbor.
const SPLASH_MIN_RADIUS = 2.4;
const SPLASH_MAX_RADIUS = 5.5;
const SPLASH_MIN_DAMAGE = 14;
const SPLASH_MAX_DAMAGE = 42;

// The necromancer cycles 'wandering' -> 'ritual' (raises a skeleton wave,
// standing still) -> 'wandering'. Any non-lethal hit switches it to
// 'fleeing' toward cover until line of sight breaks and a minimum flee
// duration has passed. Every NECROMANCER_RITUALS_PER_SPELL-th completed
// ritual queues a bolt at the player, fired once line of sight opens.
const NECROMANCER_MAX_HP = 600;
const NECROMANCER_SPAWN_INTERVAL = 3.5;
const NECROMANCER_RITUAL_DURATION = 2.2; // must exceed the last skeleton's spawn offset + rise time
const NECROMANCER_WANDER_SPEED = 3.5;
const SKELETONS_PER_WAVE = 3;
const MAX_SKELETONS = 100;
const SPAWN_JITTER_RADIUS = 4;
const NECROMANCER_RADIUS = 1.1;
const NECROMANCER_FLEE_SPEED = 5.5;
const NECROMANCER_FLEE_MIN_DURATION = 2; // timed from the *last* hit
const NECROMANCER_FLEE_MAX_DURATION = 15; // safety cap if LOS never breaks
const NECROMANCER_MIN_DISTANCE = 14; // never wanders closer than this to the player
const NECROMANCER_COVER_MIN_CLEARANCE = 6; // ignores obstacles already this close when picking cover
const NECROMANCER_RITUALS_PER_SPELL = 2;
const NECROMANCER_BOLT_SPEED = 22;
const NECROMANCER_BOLT_DAMAGE = 10;
const NECROMANCER_BOLT_MAX_RANGE = 60;
const NECROMANCER_BOLT_HIT_RADIUS = 1.1;

// Each skeleton runs its own perception state machine: 'wander' near where it
// rose until it notices the player (proximity or line-of-sight vision range),
// then 'chase'. Losing track for SKELETON_LOSE_INTEREST_TIME drops it back to
// wandering. An ally dying alerts nearby wandering skeletons to 'investigate'.
const SKELETON_MAX_HP = 30;
const SKELETON_SPEED = 3.2;
const SKELETON_WANDER_SPEED = 1.4;
const SKELETON_INVESTIGATE_SPEED = 2.4;
const SKELETON_ATTACK_RANGE = 1.7;
const SKELETON_ATTACK_DAMAGE = 6;
const SKELETON_ATTACK_COOLDOWN = 1.1;
const SEPARATION_RADIUS = 1.6;
const SKELETON_DETECT_RADIUS = 6; // always notices the player this close, sightline or not
const SKELETON_VISION_RANGE = 16; // farther, but only with a clear line of sight
const SKELETON_LOSE_INTEREST_TIME = 4;
const SKELETON_WANDER_RADIUS = 8; // roams within this of where it rose
// A target on the far side of an unreachable obstacle never counts as
// "arrived," so this timeout forces a fresh pick regardless (this was the
// "a skeleton is just standing there doing nothing" bug).
const SKELETON_WANDER_TARGET_TIMEOUT = 6;
const SKELETON_ALERT_RADIUS = 10;
const SKELETON_INVESTIGATE_TIMEOUT = 5;
// A freshly-raised skeleton spends this long climbing out of the ground,
// buried deep enough at the start to be fully hidden below the terrain.
const SKELETON_RISE_DURATION = 1.1;
const SKELETON_RISE_DEPTH = 1.9;
const SKELETON_SINK_DURATION = 0.5;
const SKELETON_RADIUS = 0.4;

const GRID_CELL_SIZE = 3;

// Static circular obstacles — block movement and spell bolts alike, give the
// skeleton swarm something to path around, and give the player cover.
// Hand-placed so they never overlap or block the start spots. `type`
// (default 'rock') only picks the geometry/texture, not collision logic.
const OBSTACLES = [
  { x: -14, z: 6, radius: 2.2, height: 3.2 },
  { x: 12, z: -4, radius: 1.8, height: 2.6 },
  { x: -8, z: -14, radius: 2.6, height: 3.6 },
  { x: 16, z: -16, radius: 2, height: 3 },
  { x: -20, z: -22, radius: 2.4, height: 3.4 },
  { x: 6, z: 10, radius: 1.6, height: 2.2 },
  { x: -22, z: 12, radius: 2, height: 2.8 },
  { x: 22, z: 8, radius: 1.8, height: 2.6 },
  { x: 2, z: -9, radius: 1.6, height: 2.4 },
  { x: 26, z: -20, radius: 2.2, height: 3.2 },
  { x: -30, z: -5, radius: 1.1, height: 5.5, type: 'pillar' },
  { x: -30, z: 5, radius: 1.1, height: 5, type: 'pillar' },
  { x: 30, z: -8, radius: 1.2, height: 6, type: 'pillar' },
  { x: 30, z: 2, radius: 1, height: 4.5, type: 'pillar' },
  { x: -4, z: 30, radius: 1.2, height: 5.5, type: 'pillar' },
  { x: 8, z: 32, radius: 1, height: 4.8, type: 'pillar' },
];

// --- Small helpers ---------------------------------------------------

/** Gentle analytic rolling terrain, shared by the ground mesh's own vertex
 *  displacement and every entity/obstacle's Y placement. */
function groundHeight(x, z) {
  return Math.sin(x * 0.15) * 0.22 + Math.cos(z * 0.13) * 0.22 + Math.sin((x + z) * 0.05) * 0.28;
}

/** Horizontal-only (X/Z) distance/distance-squared between two points —
 *  shared by every ground-plane check below (obstacles, AI perception,
 *  splash damage, ...), where Y doesn't matter (see hasLineOfSight). */
const _horizA = new Vec3();
const _horizB = new Vec3();
function horizontalDistance(x1, z1, x2, z2) {
  return _horizA.set(x1, 0, z1).distanceTo(_horizB.set(x2, 0, z2));
}
function horizontalDistanceSq(x1, z1, x2, z2) {
  return _horizA.set(x1, 0, z1).distanceToSquared(_horizB.set(x2, 0, z2));
}

/** Pushes (x, z) out of any `OBSTACLES` entry it's overlapping — simple
 *  circle-vs-circle resolution. Runs a few passes so clearing one obstacle
 *  can't shove a point straight into a second, close-together one. */
const _resolvePush = new Vec3();
function resolveObstacles(x, z, radius) {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < OBSTACLES.length; i++) {
      const ob = OBSTACLES[i];
      _resolvePush.set(x - ob.x, 0, z - ob.z);
      const minDist = ob.radius + radius;
      const distSq = _resolvePush.lengthSq();
      if (distSq < minDist * minDist && distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        _resolvePush.multiplyScalar((minDist - dist) / dist);
        x += _resolvePush.x;
        z += _resolvePush.z;
      }
    }
  }
  return { x, z };
}

/** Whether the segment (x1,z1)-(x2,z2) passes within `radius` of (cx,cz). */
const _segAB = new Vec3();
const _segAC = new Vec3();
function segmentIntersectsCircle(x1, z1, x2, z2, cx, cz, radius) {
  _segAB.set(x2 - x1, 0, z2 - z1);
  _segAC.set(cx - x1, 0, cz - z1);
  const len2 = _segAB.lengthSq();
  let t = len2 > 1e-8 ? _segAC.dot(_segAB) / len2 : 0;
  t = THREE.MathUtils.clamp(t, 0, 1);
  const px = x1 + t * _segAB.x;
  const pz = z1 + t * _segAB.z;
  const ddx = px - cx;
  const ddz = pz - cz;
  return ddx * ddx + ddz * ddz <= radius * radius;
}

/** Horizontal-only line of sight, blocked by any OBSTACLES entry the line
 *  passes through — height ignored since every obstacle is tall enough to
 *  fully occlude at this game's scale. */
function hasLineOfSight(x1, z1, x2, z2) {
  for (let i = 0; i < OBSTACLES.length; i++) {
    const ob = OBSTACLES[i];
    if (segmentIntersectsCircle(x1, z1, x2, z2, ob.x, ob.z, ob.radius)) return false;
  }
  return true;
}

/** Nearest OBSTACLES entry to (x, z) — used to pick flee cover. `minClearance`
 *  excludes anything already closer than that, so getting hit while already
 *  next to a rock doesn't just pick that same rock as "cover". */
function nearestObstacle(x, z, minClearance = 0) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < OBSTACLES.length; i++) {
    const ob = OBSTACLES[i];
    const dist = horizontalDistance(ob.x, ob.z, x, z);
    if (dist - ob.radius < minClearance) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = ob;
    }
  }
  return best;
}

/** Wraps a cloned GLTF scene in a Group scaled to `targetHeight`, centered on
 *  X/Z with its base at local y=0, so every model can be positioned uniformly
 *  regardless of its authored scale/pivot. `cloneMaterials` opts one instance
 *  out of the normal shared-material cloning (see GltfLoader), for cases like
 *  a hit flash that shouldn't tint every instance of the model at once. */
function normalizedInstance(template, targetHeight, cloneMaterials = false) {
  const model = template.clone(true);
  model.traverse((child) => {
    if (!child.isMesh) return;
    if (cloneMaterials) child.material = child.material.clone();
    child.castShadow = true;
    child.receiveShadow = true;
  });
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const scale = size.y > 0 ? targetHeight / size.y : 1;
  model.scale.setScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = new THREE.Vector3();
  scaledBox.getCenter(center);
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= scaledBox.min.y;

  const root = new THREE.Group();
  root.add(model);
  return root;
}

// wizard/necromancer/skeleton all face down +X at identity rotation (not
// +Z), so atan2(-dz, dx) rotates that pose to point at (dx, dz). Built on
// the engine's own Quat, not THREE.Quaternion — the result only ever gets
// unpacked (via quatArray) into raw floats for TransformStore, never handed
// to a three.js scene-graph object, so it doesn't need three loaded at all.
function yawQuaternion(dx, dz, out = new Quat()) {
  const yaw = Math.atan2(-dz, dx);
  return out.setFromAxisAngle(UP, yaw);
}

const UP = new Vec3(0, 1, 0);
// Reused across yawQuaternion's hot call sites (steering, facing) to avoid a
// per-entity-per-tick Quaternion allocation — safe since each caller reads
// its x/y/z/w out of it synchronously before the next call.
const yawScratch = new Quat();

const isTouch = matchMedia('(pointer: coarse)').matches;

async function main() {
  // --- Three.js boilerplate ---
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a12, 0.014);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setSize(innerWidth, innerHeight);
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(gl.domElement);

  scene.add(new THREE.HemisphereLight(0x8899cc, 0x201814, 1.1));
  const sun = new THREE.DirectionalLight(0xffe8c8, 1.4);
  sun.position.set(20, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Fixed orthographic box covering the whole arena, not a following box —
  // the arena is static, so a tight fixed frustum gives sharper shadows.
  const shadowExtent = ARENA_HALF * 1.3;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  // --- Loading screen (game-side; the engine's Preloader only emits 0..1) ---
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText =
    'position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; ' +
    'align-items: center; justify-content: center; gap: 12px; background: #05050a; ' +
    'font: 14px/1.4 monospace; color: #ddd;';
  const loadingLabel = document.createElement('div');
  loadingLabel.textContent = 'Raising the dead…';
  const barTrack = document.createElement('div');
  barTrack.style.cssText = 'width: 240px; height: 8px; border-radius: 4px; background: #222; overflow: hidden;';
  const barFill = document.createElement('div');
  barFill.style.cssText = 'width: 0%; height: 100%; background: #7c4dff; transition: width 80ms linear;';
  barTrack.appendChild(barFill);
  loadingEl.append(loadingLabel, barTrack);
  document.body.appendChild(loadingEl);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    gl.setSize(innerWidth, innerHeight);
  });

  // --- Input: WASD movement + Space to cast ---
  const input = new InputBuffer({
    moveForward: [{ device: 'keyboard', code: 'KeyW' }],
    moveBack: [{ device: 'keyboard', code: 'KeyS' }],
    moveLeft: [{ device: 'keyboard', code: 'KeyA' }],
    moveRight: [{ device: 'keyboard', code: 'KeyD' }],
    cast: [{ device: 'keyboard', code: 'Space' }],
  });

  const sound = new SoundSystem(camera, { maxVoices: 10, queueTTL: 250 });
  const castSfx = createCastBuffer(sound.listener.context);
  const hitSfx = createHitBuffer(sound.listener.context);
  const deathSfx = createDeathBuffer(sound.listener.context);
  const hurtSfx = createHurtBuffer(sound.listener.context);
  const spawnSfx = createSpawnBuffer(sound.listener.context);
  const necroCastSfx = createNecromancerCastBuffer(sound.listener.context);

  const particles = new ParticleSystem(600, { size: 0.18, gravity: { x: 0, y: -3, z: 0 }, damping: 1.2 });
  scene.add(particles.points);

  // --- Engine wiring ---
  const world = new World();
  const debug = new DebugOverlay(world);
  const transforms = world.registerStore('transform', new TransformStore(256));
  const kinds = world.registerStore('kind', new ArrayComponentStore(256)); // 'player' | 'necromancer' | 'skeleton'
  const health = world.registerStore('health', new ArrayComponentStore(256)); // { hp, max }
  const meshes = world.registerStore('mesh', new ArrayComponentStore(256)); // THREE.Object3D (root group)
  const ai = world.registerStore('ai', new ArrayComponentStore(256)); // AiState<{ attackCooldown }>
  const healthBars = world.registerStore('healthbar', new ArrayComponentStore(256)); // THREE.Sprite, skeletons only

  const spatialGrid = new SpatialGrid(GRID_CELL_SIZE);
  world.registerSpatialGrid(spatialGrid, transforms);

  // Skeleton separation/cohesion neighbor lists — built once per tick (see
  // the main loop, right before world.step()) via buildNeighborLists rather
  // than each skeleton's steerToward calling queryRadius individually: at
  // any real skeleton count, batching this touches each nearby cell pair
  // once instead of redundantly rescanning overlapping neighborhoods once
  // per skeleton (see SpatialGrid.buildNeighborLists's own doc comment).
  const skeletonNeighborLists = new Map();
  const EMPTY_NEIGHBORS = [];

  // --- Load the 3 GLB templates once; every instance clones from these ---
  const gltf = new GltfLoader();
  const preloader = new Preloader();
  preloader.onProgress(({ fraction }) => {
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  });

  const textureLoader = new THREE.TextureLoader();
  function tileable(texture, repeatX, repeatY) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  const { templates, textures } = await preloader.load(
    {
      templates: async (report) => {
        const [wizard, necromancer, skeleton] = await Promise.all([
          gltf.instantiate('./wizard.glb', (f) => report(f * 0.33)),
          gltf.instantiate('./necromancer.glb', (f) => report(0.33 + f * 0.33)),
          gltf.instantiate('./skeleton.glb', (f) => report(0.66 + f * 0.34)),
        ]);
        report(1);
        return { wizard, necromancer, skeleton };
      },
      textures: async (report) => {
        const [ground, stone, marble, pillar, background] = await Promise.all([
          textureLoader.loadAsync('./ground-texture.jpg'),
          textureLoader.loadAsync('./stone-texture.jpg'),
          textureLoader.loadAsync('./marble-stone-texture.jpg'),
          textureLoader.loadAsync('./pillar-texture.jpg'),
          textureLoader.loadAsync('./spooky background.jpg'),
        ]);
        report(1);
        return { ground, stone, marble, pillar, background };
      },
    },
    { templates: 5, textures: 1 }, // GLBs are ~10-15MB each vs a few hundred KB per texture
  );
  loadingEl.remove();

  // Flat backdrop (not an equirectangular env map), so it fills the sky above
  // the fogged horizon without turning with the chase cam.
  textures.background.colorSpace = THREE.SRGBColorSpace;
  scene.background = textures.background;

  const groundGeo = new THREE.PlaneGeometry(ARENA_HALF * 2.4, ARENA_HALF * 2.4, 60, 60);
  groundGeo.rotateX(-Math.PI / 2);
  const groundPos = groundGeo.attributes.position;
  for (let i = 0; i < groundPos.count; i++) {
    groundPos.setY(i, groundHeight(groundPos.getX(i), groundPos.getZ(i)));
  }
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({
    map: tileable(textures.ground, (ARENA_HALF * 2.4) / 6, (ARENA_HALF * 2.4) / 6),
    roughness: 1,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // Rocks (DodecahedronGeometry) alternate between two stone textures for
  // variety; pillars (CylinderGeometry) get their own texture. Every obstacle
  // is sunk partway into the terrain so an imperfect base-to-ground fit never shows.
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockTextures = [tileable(textures.stone, 1, 1), tileable(textures.marble, 1, 1)];
  const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
  let rockIndex = 0;
  for (const ob of OBSTACLES) {
    if (ob.type === 'pillar') {
      const pillarTexture = tileable(textures.pillar.clone(), 2, Math.max(1, Math.round(ob.height / 2)));
      pillarTexture.needsUpdate = true;
      const mesh = new THREE.Mesh(
        pillarGeo,
        new THREE.MeshStandardMaterial({ map: pillarTexture, roughness: 0.85 }),
      );
      mesh.scale.set(ob.radius, ob.height, ob.radius);
      mesh.position.set(ob.x, groundHeight(ob.x, ob.z) + ob.height / 2 - 0.15, ob.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    } else {
      const mesh = new THREE.Mesh(
        rockGeo,
        new THREE.MeshStandardMaterial({ map: rockTextures[rockIndex % 2], roughness: 1, flatShading: true }),
      );
      rockIndex++;
      mesh.scale.set(ob.radius, ob.height / 2, ob.radius);
      mesh.position.set(ob.x, groundHeight(ob.x, ob.z) + ob.height * 0.28, ob.z);
      mesh.rotation.set(Math.random() * 0.3, Math.random() * Math.PI * 2, Math.random() * 0.3);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // --- Run stats, shown on the completion screen once the level clears.
  // Timers measured from here, not page load, so asset loading doesn't count. ---
  const gameStartTime = performance.now();
  const stats = {
    spellsShot: 0,
    directHits: 0,
    mostDamageSingleShot: 0,
    manaUsed: 0,
    skeletonsKilled: 0,
    skeletonHitsTaken: 0,
    necromancerBoltsHit: 0,
    healthLost: 0,
    necromancerKillTime: null,
    levelClearTime: null,
  };

  // --- Spawn helpers ---
  // Every character mesh spawnStatic creates, tagged with its owning entity —
  // input to sweepOrphanedMeshes' cleanup pass below.
  const spawnedCharacterMeshes = new Set();

  function spawnStatic(kind, template, targetHeight, pos, maxHp, cloneMaterials = false) {
    const e = world.spawn();
    const y = groundHeight(pos.x, pos.z);
    transforms.add(e, pos.x, y, pos.z);
    kinds.add(e, kind);
    if (maxHp !== undefined) health.add(e, { hp: maxHp, max: maxHp });
    const obj = normalizedInstance(template, targetHeight, cloneMaterials);
    obj.position.set(pos.x, y, pos.z);
    obj.userData.ownerEntity = e;
    meshes.add(e, obj);
    scene.add(obj);
    spawnedCharacterMeshes.add(obj);
    return e;
  }

  const playerEntity = spawnStatic('player', templates.wizard, 1.8, PLAYER_START, PLAYER_MAX_HP);
  const facingToNecro = yawQuaternion(NECROMANCER_POS.x - PLAYER_START.x, NECROMANCER_POS.z - PLAYER_START.z);
  meshes.get(playerEntity).quaternion.copy(facingToNecro);

  const necromancerEntity = spawnStatic(
    'necromancer',
    templates.necromancer,
    2.1,
    NECROMANCER_POS,
    NECROMANCER_MAX_HP,
  );
  meshes.get(necromancerEntity).quaternion.copy(
    yawQuaternion(PLAYER_START.x - NECROMANCER_POS.x, PLAYER_START.z - NECROMANCER_POS.z),
  );
  let necromancerAlive = true;
  let necromancerState = 'wandering'; // 'wandering' | 'ritual' | 'fleeing'
  let necromancerFleeTimer = 0;
  let necromancerFleeCoverTarget = null;
  let necromancerWanderTarget = null;
  let necromancerRitualTimer = 0;
  let ritualElapsed = 0;
  let ritualSpawnQueue = []; // seconds-from-ritual-start still to spawn, ascending
  let necromancerRitualsCompleted = 0; // only counts finished, not interrupted, rituals
  let necromancerWantsToFireBolt = false;
  const currentRitualSkeletons = []; // entities raised by the in-progress ritual, until they finish rising
  const sinkingSkeletons = []; // { mesh, elapsed, duration, startY } — interrupted mid-rise

  // --- Hovering health bars (skeletons only) — a Sprite billboards on its
  // own, so it just needs repositioning and repainting when hp changes. ---
  const HEALTH_BAR_W = 64;
  const HEALTH_BAR_H = 8;
  function createHealthBarSprite() {
    const canvas = document.createElement('canvas');
    canvas.width = HEALTH_BAR_W;
    canvas.height = HEALTH_BAR_H;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, transparent: true }),
    );
    sprite.scale.set(1.1, 1.1 * (HEALTH_BAR_H / HEALTH_BAR_W), 1);
    sprite.userData.ctx = ctx;
    sprite.userData.texture = texture;
    return sprite;
  }

  function updateHealthBarSprite(sprite, fraction) {
    const ctx = sprite.userData.ctx;
    ctx.clearRect(0, 0, HEALTH_BAR_W, HEALTH_BAR_H);
    ctx.fillStyle = '#200000';
    ctx.fillRect(0, 0, HEALTH_BAR_W, HEALTH_BAR_H);
    ctx.fillStyle = fraction > 0.5 ? '#4caf50' : fraction > 0.25 ? '#e0a000' : '#e53b3b';
    ctx.fillRect(1, 1, Math.max(0, (HEALTH_BAR_W - 2) * fraction), HEALTH_BAR_H - 2);
    sprite.userData.texture.needsUpdate = true;
  }

  // --- Hit flash: briefly tints whatever took damage, so splash damage that
  // doesn't kill still reads as "that landed." Needs cloneMaterials in
  // spawnSkeleton, or tinting would flash the whole shared-material swarm. ---
  const HIT_FLASH_DURATION = 0.15;
  const flashingEntities = new Map(); // Entity -> { materials: THREE.Material[], timer }

  function flashHit(entity) {
    const obj = meshes.get(entity);
    if (!obj) return;
    let entry = flashingEntities.get(entity);
    if (!entry) {
      const materials = [];
      obj.traverse((child) => {
        if (child.isMesh) materials.push(child.material);
      });
      if (materials.length === 0) return;
      for (const m of materials) if (!m.emissive) return; // material type has no emissive channel to flash
      entry = { materials, timer: 0 };
      flashingEntities.set(entity, entry);
    }
    entry.timer = HIT_FLASH_DURATION;
    for (const m of entry.materials) m.emissive.setHex(0xff3333);
  }

  function updateHitFlashes(dt) {
    for (const [entity, entry] of flashingEntities) {
      entry.timer -= dt;
      if (entry.timer <= 0) {
        for (const m of entry.materials) m.emissive.setHex(0x000000);
        flashingEntities.delete(entity);
      }
    }
  }

  let skeletonCount = 0;

  /** Raises one skeleton at the necromancer's current position, buried
   *  SKELETON_RISE_DEPTH underground (skeletonBehavior's rise phase animates
   *  it climbing out). Returns undefined if already at MAX_SKELETONS. */
  function spawnSkeleton() {
    if (skeletonCount >= MAX_SKELETONS) return undefined;
    const ns = transforms.slotOf(necromancerEntity) * transforms.stride;
    const nraw = transforms.raw;
    const jx = (Math.random() - 0.5) * 2 * SPAWN_JITTER_RADIUS;
    const jz = (Math.random() - 0.5) * 2 * SPAWN_JITTER_RADIUS;
    const pos = { x: nraw[ns] + jx, z: nraw[ns + 2] + jz };
    const groundY = groundHeight(pos.x, pos.z);
    const e = spawnStatic('skeleton', templates.skeleton, 1.7, { x: pos.x, y: groundY, z: pos.z }, SKELETON_MAX_HP, true);

    const slot = transforms.slotOf(e);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    transforms.add(e, raw[o], groundY - SKELETON_RISE_DEPTH, raw[o + 2], raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]);

    ai.add(e, {
      root: skeletonBehavior,
      blackboard: {
        attackCooldown: 0,
        riseTimer: SKELETON_RISE_DURATION,
        groundY,
        state: 'wander', // 'wander' | 'investigate' | 'chase'
        homeX: pos.x,
        homeZ: pos.z,
        wanderTarget: null,
        wanderTargetTimer: 0,
        investigateTarget: null,
        investigateTimer: 0,
        loseInterestTimer: 0,
      },
    });
    const bar = createHealthBarSprite();
    updateHealthBarSprite(bar, 1);
    healthBars.add(e, bar);
    scene.add(bar);
    skeletonCount++;
    return e;
  }

  // --- Skeleton AI: tick down attack cooldown, update perception, then act on
  // whichever of rise / chase / investigate / wander applies (mutually
  // exclusive via blackboard.state). Built from behavior-tree primitives. ---
  const skeletonBehavior = sequence(
    action((ctx) => {
      const bb = ctx.blackboard;
      bb.attackCooldown = Math.max(0, bb.attackCooldown - ctx.dt);
      if (bb.riseTimer > 0) return 'success'; // not aware of anything while still emerging

      if (skeletonCanSeePlayer(ctx.entity)) {
        bb.state = 'chase';
        bb.loseInterestTimer = 0;
      } else if (bb.state === 'chase') {
        bb.loseInterestTimer += ctx.dt;
        if (bb.loseInterestTimer >= SKELETON_LOSE_INTEREST_TIME) {
          bb.state = 'wander';
          bb.wanderTarget = null;
        }
      }
      return 'success';
    }),
    selector(
      sequence(
        condition((ctx) => ctx.blackboard.riseTimer > 0),
        action((ctx) => {
          ctx.blackboard.riseTimer -= ctx.dt;
          const t = THREE.MathUtils.clamp(1 - Math.max(0, ctx.blackboard.riseTimer) / SKELETON_RISE_DURATION, 0, 1);
          const slot = transforms.slotOf(ctx.entity);
          const o = slot * transforms.stride;
          const raw = transforms.raw;
          const y = THREE.MathUtils.lerp(ctx.blackboard.groundY - SKELETON_RISE_DEPTH, ctx.blackboard.groundY, t);
          transforms.add(ctx.entity, raw[o], y, raw[o + 2], raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]);
          // Self-report completion immediately, so currentRitualSkeletons
          // stays accurate regardless of ritual-duration tuning.
          if (ctx.blackboard.riseTimer <= 0) {
            const idx = currentRitualSkeletons.indexOf(ctx.entity);
            if (idx !== -1) currentRitualSkeletons.splice(idx, 1);
          }
          return 'success';
        }),
      ),
      sequence(
        condition((ctx) => ctx.blackboard.state === 'chase'),
        selector(
          sequence(
            condition((ctx) => distanceTo(ctx.entity, playerEntity) <= SKELETON_ATTACK_RANGE),
            action((ctx) => {
              if (ctx.blackboard.attackCooldown > 0) return 'success';
              ctx.blackboard.attackCooldown = SKELETON_ATTACK_COOLDOWN;
              world.events.emit({ type: 'damage', target: playerEntity, amount: SKELETON_ATTACK_DAMAGE });
              stats.skeletonHitsTaken++;
              return 'success';
            }),
          ),
          action((ctx) => {
            const pSlot = transforms.slotOf(playerEntity);
            if (pSlot !== -1) {
              const po = pSlot * transforms.stride;
              const raw = transforms.raw;
              steerToward(ctx.entity, raw[po], raw[po + 2], SKELETON_SPEED, ctx.dt);
            }
            return 'success';
          }),
        ),
      ),
      sequence(
        condition((ctx) => ctx.blackboard.state === 'investigate'),
        action((ctx) => {
          const bb = ctx.blackboard;
          bb.investigateTimer -= ctx.dt;
          const dist = steerToward(ctx.entity, bb.investigateTarget.x, bb.investigateTarget.z, SKELETON_INVESTIGATE_SPEED, ctx.dt);
          if (dist < 1.5 || bb.investigateTimer <= 0) {
            bb.state = 'wander';
            bb.investigateTarget = null;
            bb.wanderTarget = null;
          }
          return 'success';
        }),
      ),
      action((ctx) => {
        const bb = ctx.blackboard;
        if (!bb.wanderTarget) {
          bb.wanderTarget = {
            x: bb.homeX + (Math.random() * 2 - 1) * SKELETON_WANDER_RADIUS,
            z: bb.homeZ + (Math.random() * 2 - 1) * SKELETON_WANDER_RADIUS,
          };
          bb.wanderTargetTimer = 0;
        }
        bb.wanderTargetTimer += ctx.dt;
        const dist = steerToward(ctx.entity, bb.wanderTarget.x, bb.wanderTarget.z, SKELETON_WANDER_SPEED, ctx.dt);
        if (dist < 1 || bb.wanderTargetTimer >= SKELETON_WANDER_TARGET_TIMEOUT) bb.wanderTarget = null;
        return 'success';
      }),
    ),
  );

  function distanceTo(a, b) {
    const oa = transforms.slotOf(a) * transforms.stride;
    const ob = transforms.slotOf(b) * transforms.stride;
    const raw = transforms.raw;
    return horizontalDistance(raw[oa], raw[oa + 2], raw[ob], raw[ob + 2]);
  }

  /** Proximity alone always registers, sightline or not; farther out (up to
   *  SKELETON_VISION_RANGE) only counts with a clear line of sight. */
  function skeletonCanSeePlayer(entity) {
    const dist = distanceTo(entity, playerEntity);
    if (dist <= SKELETON_DETECT_RADIUS) return true;
    if (dist > SKELETON_VISION_RANGE) return false;
    const eSlot = transforms.slotOf(entity);
    const pSlot = transforms.slotOf(playerEntity);
    if (eSlot === -1 || pSlot === -1) return false;
    const raw = transforms.raw;
    const eo = eSlot * transforms.stride;
    const po = pSlot * transforms.stride;
    return hasLineOfSight(raw[eo], raw[eo + 2], raw[po], raw[po + 2]);
  }

  /** Pulls any wandering (not already chasing/investigating) skeleton within
   *  SKELETON_ALERT_RADIUS into investigating (x, z) — called on an ally's
   *  death so the swarm reacts even before spotting the player itself. */
  function alertNearbySkeletons(x, z, excludeEntity) {
    const nearby = spatialGrid.queryRadius(transforms, x, groundHeight(x, z), z, SKELETON_ALERT_RADIUS);
    for (let i = 0; i < nearby.length; i++) {
      const cand = nearby[i];
      if (cand === excludeEntity) continue;
      if (kinds.get(cand) !== 'skeleton') continue;
      const state = ai.get(cand);
      if (!state) continue;
      const bb = state.blackboard;
      if (bb.riseTimer > 0 || bb.state !== 'wander') continue;
      bb.state = 'investigate';
      bb.investigateTarget = { x, z };
      bb.investigateTimer = SKELETON_INVESTIGATE_TIMEOUT;
    }
  }

  const steerOut = new Vec3();
  const _steerDir = new Vec3();
  const _steerVel = new Vec3();
  /** Moves `e` toward (targetX, targetZ) at `speed`, blended with separation
   *  steering and resolved against obstacles. Returns the pre-move distance
   *  to the target, so a caller can cheaply check "did I just arrive". */
  function steerToward(e, targetX, targetZ, speed, dt) {
    const slot = transforms.slotOf(e);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const pz = raw[o + 2];

    _steerDir.set(targetX - px, 0, targetZ - pz);
    const dist = _steerDir.length();
    _steerDir.normalize();

    const neighbors = skeletonNeighborLists.get(e) ?? EMPTY_NEIGHBORS;
    separationCohesionSteer(transforms, e, neighbors, { separation: 1.2, cohesion: 0 }, steerOut);

    // Not renormalized before the yaw calc below — atan2 only cares about
    // direction, and the un-normalized sum still points the same way.
    _steerVel.set(_steerDir.x + steerOut.x, 0, _steerDir.z + steerOut.z);
    const vlen = _steerVel.length() || 1e-6;
    let nx = px + (_steerVel.x / vlen) * speed * dt;
    let nz = pz + (_steerVel.z / vlen) * speed * dt;
    ({ x: nx, z: nz } = resolveObstacles(nx, nz, SKELETON_RADIUS));
    nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 1, ARENA_HALF - 1);
    nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 1, ARENA_HALF - 1);

    transforms.add(e, nx, groundHeight(nx, nz), nz, ...quatArray(yawQuaternion(_steerVel.x, _steerVel.z, yawScratch)));
    return dist;
  }

  function quatArray(q) {
    return [q.x, q.y, q.z, q.w];
  }

  const _lookDir = new Vec3();
  /** The necromancer faces the player in every state except fleeing. Falls
   *  back to `fallback` if the player can't be found or is on top of it. */
  function necromancerLookAtPlayer(nx, nz, fallback) {
    const pSlot = transforms.slotOf(playerEntity);
    if (pSlot === -1) return fallback;
    const po = pSlot * transforms.stride;
    const raw = transforms.raw;
    _lookDir.set(raw[po] - nx, 0, raw[po + 2] - nz);
    if (_lookDir.lengthSq() < 1e-6) return fallback;
    return quatArray(yawQuaternion(_lookDir.x, _lookDir.z, yawScratch));
  }

  world.addSystem(createAiSystem(ai));

  // --- Damage / death, via the event queue (mirrors matching-game's
  // match:attempt pattern): a system emits `damage`, this does the
  // bookkeeping and cascades into `died` within the same tick. ---
  world.events.on('damage', (ev, w) => {
    const hp = health.get(ev.target);
    if (!hp) return; // already dying/despawned this tick
    hp.hp -= ev.amount;
    const kind = kinds.get(ev.target);
    if (kind === 'player') {
      stats.healthLost += ev.amount;
      sound.play(hurtSfx, { volume: 0.7, priority: 2, id: 'hurt', maxConcurrent: 2 });
      flashDamage();
    } else {
      // maxConcurrent well above the default of 1 — a splash hit can land on
      // several skeletons in one tick.
      sound.play(hitSfx, { volume: 0.35, id: 'hit', maxConcurrent: 8, queueTTL: 80 });
    }
    const bar = healthBars.get(ev.target);
    if (bar) updateHealthBarSprite(bar, Math.max(0, hp.hp / hp.max));
    if (hp.hp <= 0) {
      hp.hp = 0;
      w.events.emit({ type: 'died', entity: ev.target, kind });
    } else if (kind === 'necromancer') {
      // Starts fleeing toward the nearest cover, blended each tick in
      // updateNecromancer with the current away-from-player direction. A hit
      // mid-ritual cancels it outright (see interruptRitual).
      if (necromancerState === 'ritual') interruptRitual();
      necromancerState = 'fleeing';
      necromancerFleeTimer = 0;
      const ns = transforms.slotOf(ev.target) * transforms.stride;
      const raw = transforms.raw;
      necromancerFleeCoverTarget =
        nearestObstacle(raw[ns], raw[ns + 2], NECROMANCER_COVER_MIN_CLEARANCE) ?? nearestObstacle(raw[ns], raw[ns + 2]);
    }
  });

  world.events.on('died', (ev, w) => {
    const obj = meshes.get(ev.entity);
    const pos = obj ? obj.position.clone() : new THREE.Vector3();
    if (obj) scene.remove(obj);

    if (ev.kind === 'skeleton') {
      skeletonCount--;
      stats.skeletonsKilled++;
      const bar = healthBars.get(ev.entity);
      if (bar) scene.remove(bar);
      flashingEntities.delete(ev.entity);
      burst(pos, 0xe8e0d0, 14);
      spawnBoneShards(pos);
      sound.play(deathSfx, { volume: 0.25, id: 'skeletonDeath', maxConcurrent: 3, queueTTL: 120 });
      alertNearbySkeletons(pos.x, pos.z, ev.entity);
      w.despawn(ev.entity);
    } else if (ev.kind === 'necromancer') {
      necromancerAlive = false;
      stats.necromancerKillTime = (performance.now() - gameStartTime) / 1000;
      interruptRitual();
      burst(pos, 0x9b59ff, 60);
      sound.play(deathSfx, { volume: 0.9, priority: 2 });
      showBanner('The Necromancer has fallen!', '#b892ff');
      w.despawn(ev.entity);
    } else if (ev.kind === 'player') {
      gameOver = true;
      burst(pos, 0x66ccff, 40);
      // A held, slow-fading vignette — distinct from flashDamage()'s brief
      // per-hit pulse, gated off deathVignetteActive so the two don't fight.
      deathVignetteActive = true;
      hitFlash.style.transition = 'opacity 1.2s ease-out';
      hitFlash.style.opacity = '0.3';
      showBanner('You have fallen…', '#ff6666', 'Press R to try again');
      w.despawn(ev.entity);
      if (!isTouch) document.exitPointerLock();
    }

    // Cleared the moment both are true, whichever death makes it so.
    if (!gameOver && !levelComplete && !necromancerAlive && skeletonCount === 0) {
      stats.levelClearTime = (performance.now() - gameStartTime) / 1000;
      showCompletionScreen();
    }
  });

  function burst(pos, colorHex, count) {
    const color = new THREE.Color(colorHex);
    for (let i = 0; i < count; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = 1.5 + Math.random() * 3;
      particles.emit(
        { x: pos.x, y: pos.y + 1, z: pos.z },
        {
          x: Math.sin(phi) * Math.cos(theta) * speed,
          y: Math.abs(Math.cos(phi)) * speed,
          z: Math.sin(phi) * Math.sin(theta) * speed,
        },
        0.4 + Math.random() * 0.4,
        color,
      );
    }
  }

  // --- HUD ---
  const hud = document.createElement('div');
  hud.style.cssText =
    'position: fixed; left: 12px; bottom: 12px; z-index: 9999; width: 220px; ' +
    'font: 12px/1.4 monospace; color: #fff; pointer-events: none;';
  hud.innerHTML = `
    <div style="margin-bottom:4px;">HP</div>
    <div style="width:100%;height:10px;background:#3a1010;border-radius:3px;overflow:hidden;margin-bottom:8px;">
      <div id="hpFill" style="width:100%;height:100%;background:#e53b3b;transition:width 100ms;"></div>
    </div>
    <div style="margin-bottom:4px;">MP</div>
    <div style="width:100%;height:10px;background:#101a3a;border-radius:3px;overflow:hidden;">
      <div id="mpFill" style="width:100%;height:100%;background:#4d7cff;transition:width 100ms;"></div>
    </div>
    <div id="skelCount" style="margin-top:8px;opacity:0.8;"></div>
  `;
  document.body.appendChild(hud);
  const hpFill = hud.querySelector('#hpFill');
  const mpFill = hud.querySelector('#mpFill');
  const skelCountEl = hud.querySelector('#skelCount');

  // Centered reticle — a fixed reference point for aiming the lobbed spell.
  const reticle = document.createElement('div');
  reticle.style.cssText =
    'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9999; ' +
    'width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.75); ' +
    'box-shadow: 0 0 3px rgba(0,0,0,0.8); pointer-events: none;';
  document.body.appendChild(reticle);

  // Charge meter — hidden except while a press-and-hold cast is charging.
  const chargeBarWrap = document.createElement('div');
  chargeBarWrap.style.cssText =
    'position: fixed; top: calc(50% - 22px); left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'width: 120px; height: 6px; border-radius: 3px; background: rgba(0,0,0,0.5); overflow: hidden; ' +
    'display: none; pointer-events: none;';
  const chargeBarFill = document.createElement('div');
  chargeBarFill.style.cssText = 'width: 0%; height: 100%; background: #cf9bff;';
  chargeBarWrap.appendChild(chargeBarFill);
  document.body.appendChild(chargeBarWrap);

  const controlsHint = document.createElement('div');
  controlsHint.style.cssText =
    'position: fixed; right: 12px; bottom: 12px; z-index: 9999; ' +
    'font: 12px/1.6 monospace; color: #fff; opacity: 0.7; text-align: right; pointer-events: none;';
  controlsHint.innerHTML = isTouch
    ? 'Left stick to move<br>Drag to look &middot; tap to cast<br>Aim high/low to lob the spell'
    : 'WASD move &middot; mouse to look (click to start)<br>Click or SPACE to cast &middot; scroll to zoom<br>Aim high/low to lob the spell';
  document.body.appendChild(controlsHint);

  const bossHud = document.createElement('div');
  bossHud.style.cssText =
    'position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'width: 320px; font: 12px/1.4 monospace; color: #fff; text-align: center; pointer-events: none;';
  bossHud.innerHTML = `
    <div style="margin-bottom:4px;">NECROMANCER</div>
    <div style="width:100%;height:10px;background:#241033;border-radius:3px;overflow:hidden;">
      <div id="bossFill" style="width:100%;height:100%;background:#9b4dff;transition:width 100ms;"></div>
    </div>
  `;
  document.body.appendChild(bossHud);
  const bossFill = bossHud.querySelector('#bossFill');

  const banner = document.createElement('div');
  banner.style.cssText =
    'position: fixed; top: 40%; left: 50%; transform: translate(-50%, -50%); z-index: 10001; ' +
    'font: bold 32px/1.4 monospace; text-shadow: 0 2px 8px #000; text-align: center; ' +
    'opacity: 0; transition: opacity 400ms; pointer-events: none;';
  document.body.appendChild(banner);
  function showBanner(text, color, subtext) {
    banner.innerHTML = subtext
      ? `${text}<div style="font-size: 16px; margin-top: 8px; opacity: 0.85;">${subtext}</div>`
      : text;
    banner.style.color = color;
    banner.style.opacity = '1';
  }

  // --- Completion screen: same "freeze the sim, press R" shape as the death
  // screen, plus a stat line summary of the run. ---
  const completionScreen = document.createElement('div');
  completionScreen.style.cssText =
    'position: fixed; inset: 0; z-index: 10002; display: none; align-items: center; justify-content: center; ' +
    'background: rgba(5,5,10,0.82); font: 14px/1.5 monospace; color: #fff;';
  completionScreen.innerHTML = `
    <div style="background: rgba(24,14,36,0.92); border: 1px solid #7c4dff; border-radius: 8px; padding: 28px 40px; min-width: 300px; text-align: center;">
      <div style="font-size: 26px; font-weight: bold; color: #b892ff; margin-bottom: 18px;">Level Cleared!</div>
      <div id="statsList" style="text-align: left; display: inline-block; margin-bottom: 20px;"></div>
      <div style="opacity: 0.75;">Press R to play again</div>
    </div>
  `;
  document.body.appendChild(completionScreen);
  const statsListEl = completionScreen.querySelector('#statsList');

  function formatDuration(seconds) {
    if (seconds === null) return '—';
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(1);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  function showCompletionScreen() {
    levelComplete = true;
    if (!isTouch) document.exitPointerLock();
    const accuracy = stats.spellsShot > 0 ? Math.round((stats.directHits / stats.spellsShot) * 100) : 0;
    const rows = [
      ['Spells cast', stats.spellsShot],
      ['Direct hits', `${stats.directHits} (${accuracy}%)`],
      ['Biggest single-shot damage', Math.round(stats.mostDamageSingleShot)],
      ['Mana spent', Math.round(stats.manaUsed)],
      ['Skeletons killed', stats.skeletonsKilled],
      ['Hits taken from skeletons', stats.skeletonHitsTaken],
      ['Necromancer bolts landed', stats.necromancerBoltsHit],
      ['Health lost', Math.round(stats.healthLost)],
      ['Time to kill the necromancer', formatDuration(stats.necromancerKillTime)],
      ['Time to clear the level', formatDuration(stats.levelClearTime)],
    ];
    statsListEl.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div style="display:flex; justify-content:space-between; gap:28px; margin:4px 0;">` +
          `<span style="opacity:0.7;">${label}</span><span>${value}</span></div>`,
      )
      .join('');
    completionScreen.style.display = 'flex';
  }

  // Only a hard reload actually resets things — no menu state to return to.
  addEventListener('keydown', (e) => {
    if ((gameOver || levelComplete) && e.code === 'KeyR') location.reload();
  });

  const hitFlash = document.createElement('div');
  hitFlash.style.cssText =
    'position: fixed; inset: 0; z-index: 9998; background: #ff0000; opacity: 0; pointer-events: none; transition: opacity 60ms;';
  document.body.appendChild(hitFlash);
  let flashTimer = 0;
  let deathVignetteActive = false; // true once the player dies — see the 'died' handler
  function flashDamage() {
    if (deathVignetteActive) return;
    hitFlash.style.opacity = '0.25';
    flashTimer = 0.12;
  }

  // --- Camera + character rotation: a hand-rolled chase cam, not
  // OrbitControls — camYaw/camPitch are the single source of truth for both
  // the camera's orbit and the player's own facing, so looking around *is*
  // turning the character (the way most third-person shooters work).
  // Desktop: click to acquire pointer lock, then mouse-move rotates and a
  // click casts. Touch: drag rotates, a short tap casts. ---
  let camYaw = Math.atan2(-(NECROMANCER_POS.z - PLAYER_START.z), NECROMANCER_POS.x - PLAYER_START.x);
  // Low pitch/short distance by default — an over-the-shoulder shooter cam,
  // so the trajectory preview lines up with where the camera looks.
  let camPitch = 0.22;
  let camDistance = 5.5;

  const lookPrompt = document.createElement('div');
  lookPrompt.style.cssText =
    'position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'font: 12px/1.4 monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 4px 10px; ' +
    'border-radius: 4px; pointer-events: none;';
  lookPrompt.textContent = isTouch ? 'Drag to look · tap to cast' : 'Click to look around';
  document.body.appendChild(lookPrompt);

  gl.domElement.style.touchAction = 'none'; // otherwise touch-drag scrolls/zooms the page instead of looking

  if (!isTouch) {
    // pointerdown/up (not 'click') so a press-and-hold spans the whole
    // gesture: first press only acquires the lock, every press after starts
    // a charge, and release — even off-canvas — fires it.
    gl.domElement.addEventListener('pointerdown', () => {
      if (document.pointerLockElement !== gl.domElement) {
        gl.domElement.requestPointerLock();
      } else {
        startCharge();
      }
    });
    addEventListener('pointerup', () => releaseCharge());
    document.addEventListener('pointerlockchange', () => {
      lookPrompt.style.display = document.pointerLockElement === gl.domElement ? 'none' : '';
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== gl.domElement) return;
      camYaw -= e.movementX * MOUSE_LOOK_SENSITIVITY;
      // CAM_MIN_PITCH is near-horizontal, CAM_MAX_PITCH overhead — moving the
      // mouse up should swing toward the former, hence + not -.
      camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * MOUSE_LOOK_SENSITIVITY, CAM_MIN_PITCH, CAM_MAX_PITCH);
    });
    gl.domElement.addEventListener('wheel', (e) => {
      camDistance = THREE.MathUtils.clamp(camDistance + e.deltaY * 0.01, CAM_MIN_DISTANCE, CAM_MAX_DISTANCE);
    });
  }

  // --- Touch: virtual joystick (movement) + drag-to-look/tap-to-cast on the
  // rest of the screen, tracked by pointer id so the two never fight. ---
  const joyVec = { forward: 0, strafe: 0 }; // read by movePlayer; stays {0,0} on desktop
  if (isTouch) {
    const joyBase = document.createElement('div');
    joyBase.style.cssText =
      'position: fixed; left: 24px; bottom: 24px; width: 120px; height: 120px; z-index: 9999; ' +
      'border-radius: 50%; background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.25); touch-action: none;';
    const joyKnob = document.createElement('div');
    joyKnob.style.cssText =
      'position: absolute; left: 50%; top: 50%; width: 52px; height: 52px; margin: -26px 0 0 -26px; ' +
      'border-radius: 50%; background: rgba(255,255,255,0.35); pointer-events: none;';
    joyBase.appendChild(joyKnob);
    document.body.appendChild(joyBase);

    let joyPointerId = null;
    const _joyStick = new THREE.Vector2();
    const updateJoystick = (e) => {
      const rect = joyBase.getBoundingClientRect();
      _joyStick.set(e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
      if (_joyStick.length() > JOYSTICK_RADIUS) _joyStick.setLength(JOYSTICK_RADIUS);
      joyKnob.style.transform = `translate(${_joyStick.x}px, ${_joyStick.y}px)`;
      joyVec.strafe = _joyStick.x / JOYSTICK_RADIUS;
      joyVec.forward = -_joyStick.y / JOYSTICK_RADIUS; // stick pushed up (screen -Y) = forward
    };
    const releaseJoystick = (e) => {
      if (e.pointerId !== joyPointerId) return;
      joyPointerId = null;
      joyVec.strafe = 0;
      joyVec.forward = 0;
      joyKnob.style.transform = 'translate(0, 0)';
    };
    joyBase.addEventListener('pointerdown', (e) => {
      if (joyPointerId !== null) return;
      joyPointerId = e.pointerId;
      joyBase.setPointerCapture(e.pointerId);
      updateJoystick(e);
    });
    joyBase.addEventListener('pointermove', (e) => {
      if (e.pointerId === joyPointerId) updateJoystick(e);
    });
    joyBase.addEventListener('pointerup', releaseJoystick);
    joyBase.addEventListener('pointercancel', releaseJoystick);

    // The hold IS the charge — pressing starts it, dragging to aim while
    // held doesn't cancel it, lifting fires at whatever charge accumulated.
    let lookPointerId = null;
    let lookLastX = 0;
    let lookLastY = 0;
    gl.domElement.addEventListener('pointerdown', (e) => {
      if (lookPointerId !== null) return;
      lookPointerId = e.pointerId;
      lookLastX = e.clientX;
      lookLastY = e.clientY;
      gl.domElement.setPointerCapture(e.pointerId);
      startCharge();
    });
    gl.domElement.addEventListener('pointermove', (e) => {
      if (e.pointerId !== lookPointerId) return;
      camYaw -= (e.clientX - lookLastX) * TOUCH_LOOK_SENSITIVITY;
      camPitch = THREE.MathUtils.clamp(
        camPitch + (e.clientY - lookLastY) * TOUCH_LOOK_SENSITIVITY,
        CAM_MIN_PITCH,
        CAM_MAX_PITCH,
      );
      lookLastX = e.clientX;
      lookLastY = e.clientY;
    });
    gl.domElement.addEventListener('pointerup', (e) => {
      if (e.pointerId !== lookPointerId) return;
      lookPointerId = null;
      releaseCharge();
    });
    gl.domElement.addEventListener('pointercancel', (e) => {
      if (e.pointerId === lookPointerId) {
        lookPointerId = null;
        charging = false; // interrupted gesture — don't fire
      }
    });
  }

  /** Orbits the camera around the player at (camDistance, camYaw, camPitch),
   *  once per rendered frame independent of the fixed-step sim rate. */
  function updateCamera() {
    const slot = transforms.slotOf(playerEntity);
    if (slot === -1) return; // despawned on death — freeze the last camera pose

    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const py = raw[o + 1];
    const pz = raw[o + 2];

    const horizontal = camDistance * Math.cos(camPitch);
    const heightOffset = camDistance * Math.sin(camPitch);
    camera.position.set(px - Math.cos(camYaw) * horizontal, py + CAM_EYE_HEIGHT + heightOffset, pz + Math.sin(camYaw) * horizontal);
    camera.lookAt(px, py + CAM_EYE_HEIGHT, pz);
  }

  // --- Player state ---
  let playerHp = PLAYER_MAX_HP;
  let mana = MANA_MAX;
  let gameOver = false;
  let levelComplete = false;
  // playerFacing/forwardVec/rightVec/moveVec never touch a scene-graph
  // object either (only ever unpacked into transforms.add's raw floats or
  // read as .x/.z), so these are Quat/Vec3 too — see the vector-math note.
  const playerFacing = new Quat();
  const forwardVec = new Vec3();
  const rightVec = new Vec3();
  const moveVec = new Vec3();

  function movePlayer(dt) {
    playerFacing.setFromAxisAngle(UP, camYaw);
    // Local +X is this model's authored forward axis (see yawQuaternion's doc).
    forwardVec.set(1, 0, 0).applyQuaternion(playerFacing);
    rightVec.copy(forwardVec).cross(UP);

    let forwardAxis = joyVec.forward;
    let strafeAxis = joyVec.strafe;
    if (input.isDown('moveForward')) forwardAxis += 1;
    if (input.isDown('moveBack')) forwardAxis -= 1;
    if (input.isDown('moveRight')) strafeAxis += 1;
    if (input.isDown('moveLeft')) strafeAxis -= 1;

    moveVec.set(0, 0, 0);
    moveVec.addScaledVector(forwardVec, forwardAxis);
    moveVec.addScaledVector(rightVec, strafeAxis);

    const slot = transforms.slotOf(playerEntity);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    let px = raw[o];
    let pz = raw[o + 2];

    // Clamp to unit length rather than normalizing — a partially pushed
    // joystick should move slower, not snap to full speed.
    const moveLen = moveVec.length();
    if (moveLen > 1e-6) {
      const scale = Math.min(moveLen, 1) / moveLen;
      px += moveVec.x * scale * PLAYER_SPEED * dt;
      pz += moveVec.z * scale * PLAYER_SPEED * dt;
      ({ x: px, z: pz } = resolveObstacles(px, pz, PLAYER_RADIUS));
      px = THREE.MathUtils.clamp(px, -ARENA_HALF + 1, ARENA_HALF - 1);
      pz = THREE.MathUtils.clamp(pz, -ARENA_HALF + 1, ARENA_HALF - 1);
    }

    transforms.add(
      playerEntity,
      px,
      groundHeight(px, pz),
      pz,
      playerFacing.x,
      playerFacing.y,
      playerFacing.z,
      playerFacing.w,
    );
  }

  // --- Spell bolts: short-lived, non-entity projectiles (too churny/low-
  // identity to justify a full entity row each). Collision uses the same
  // SpatialGrid the AI queries, rebuilt fresh by world.step() each tick. ---
  const bolts = [];
  const boltGeo = new THREE.SphereGeometry(1, 12, 10); // scaled per-bolt to that shot's charge radius
  const boltColorMin = new THREE.Color(0x8a5bff); // dim, cheap tap
  const boltColorMax = new THREE.Color(0xf0e6ff); // bright near-white, full charge

  /** Fires the spell at `chargeFraction` (0..1). Cost/damage/radius/speed/
   *  gravity/range all scale with it (see the SPELL_MIN/MAX_* comment up top). */
  function castSpell(chargeFraction) {
    // Guards the desktop/touch release handlers below, which aren't gated on
    // gameOver the way the fixed-step input check is.
    if (gameOver || levelComplete) return;

    const cost = THREE.MathUtils.lerp(SPELL_MIN_COST, SPELL_MAX_COST, chargeFraction);
    if (mana < SPELL_MIN_COST) return; // not enough for even the cheapest shot
    // A charge the player can't fully afford still fires, scaled back to
    // whatever mana covers, rather than doing nothing.
    const actualCost = Math.min(cost, mana);
    const actualFraction = (actualCost - SPELL_MIN_COST) / (SPELL_MAX_COST - SPELL_MIN_COST);
    mana -= actualCost;
    stats.spellsShot++;
    stats.manaUsed += actualCost;

    const damage = THREE.MathUtils.lerp(SPELL_MIN_DAMAGE, SPELL_MAX_DAMAGE, actualFraction);
    const radius = THREE.MathUtils.lerp(SPELL_MIN_RADIUS, SPELL_MAX_RADIUS, actualFraction);
    const splashRadius = THREE.MathUtils.lerp(SPLASH_MIN_RADIUS, SPLASH_MAX_RADIUS, actualFraction);
    const splashDamage = THREE.MathUtils.lerp(SPLASH_MIN_DAMAGE, SPLASH_MAX_DAMAGE, actualFraction);

    const slot = transforms.slotOf(playerEntity);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const dir = new Vec3(1, 0, 0).applyQuaternion(playerFacing).normalize();

    // Vertical look sets the *ceiling* on launch angle (aim up for a steep
    // lob, down for flat); camPitch runs the opposite way (see the mousemove
    // comment), so this mirrors it. Scaled by actualFraction on top of that:
    // a bare tap fires flat/direct regardless of aim, and only a full
    // charge reaches the aimed lob — a weak flick shouldn't arc, only a
    // heavy throw should. Charge sets speed and gravityScale together too,
    // so a bigger charge is a heavier throw, not just a faster small one.
    const aimAngle = CAM_MIN_PITCH + CAM_MAX_PITCH - camPitch;
    const launchAngle = aimAngle * actualFraction;
    const speed = THREE.MathUtils.lerp(SPELL_MIN_SPEED, SPELL_MAX_SPEED, actualFraction);
    const gravityScale = THREE.MathUtils.lerp(SPELL_MIN_GRAVITY_SCALE, SPELL_MAX_GRAVITY_SCALE, actualFraction);
    const speedH = speed * Math.cos(launchAngle);
    const speedV = speed * Math.sin(launchAngle);
    const range = THREE.MathUtils.lerp(SPELL_MIN_RANGE, SPELL_MAX_RANGE, actualFraction);

    const mesh = new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({ color: boltColorMin.clone().lerp(boltColorMax, actualFraction) }));
    mesh.scale.setScalar(radius * 1.4); // a bit bigger than the hit-test radius, so it reads clearly
    const glow = new THREE.PointLight(0xb87fff, 2 + actualFraction * 3, 6 + actualFraction * 4);
    mesh.add(glow);
    const origin = new Vec3(raw[o] + dir.x * 0.8, raw[o + 1] + 1.1, raw[o + 2] + dir.z * 0.8);
    mesh.position.copy(origin);
    scene.add(mesh);

    bolts.push({
      mesh,
      pos: origin.clone(),
      vel: new Vec3(dir.x * speedH, speedV, dir.z * speedH),
      gravity: GRAVITY * gravityScale,
      origin,
      fraction: actualFraction,
      range,
      splashRadius,
      splashDamage,
      damage,
      radius,
    });
    sound.play(castSfx, { volume: 0.4 + actualFraction * 0.4, priority: 1 });
  }

  // --- Press-and-hold charge state machine: startCharge()/releaseCharge()
  // are the only entry points every input scheme drives. ---
  let charging = false;
  let chargeStartTime = 0;

  function startCharge() {
    if (gameOver || levelComplete || charging) return;
    charging = true;
    chargeStartTime = performance.now();
  }

  function releaseCharge() {
    if (!charging) return;
    charging = false;
    const heldSeconds = (performance.now() - chargeStartTime) / 1000;
    castSpell(THREE.MathUtils.clamp(heldSeconds / CHARGE_MAX_TIME, 0, 1));
  }

  // A glowing orb that grows at the caster's hand while charging, plus a
  // trajectory preview line — both driven by current aim, not accumulated
  // charge, since charge only scales power, not trajectory.
  const chargeOrb = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xcf9bff, transparent: true, opacity: 0.85 }),
  );
  const chargeGlow = new THREE.PointLight(0xb87fff, 0, 6);
  chargeOrb.add(chargeGlow);
  chargeOrb.visible = false;
  scene.add(chargeOrb);

  // Sized for the worst case: full charge (steepest allowed launchAngle,
  // ~1.15 rad, and heaviest gravity, 1.5x) fired straight up-range with no
  // horizontal drift to trip the range cutoff early — apex at ~0.86s, full
  // flight (up + back down to origin height) at ~1.8s. Too few samples here
  // and a steep, fully-charged preview runs out of line before it arcs back
  // down, reading as a beam shooting off the top of the screen instead of a
  // lob (undershooting this is exactly what produced that bug).
  const TRAJECTORY_SAMPLES = 40;
  const TRAJECTORY_DT = 0.06; // seconds between sampled points
  const trajectoryGeo = new THREE.BufferGeometry();
  const trajectoryPositions = new Float32Array(TRAJECTORY_SAMPLES * 3);
  trajectoryGeo.setAttribute('position', new THREE.BufferAttribute(trajectoryPositions, 3));
  trajectoryGeo.setDrawRange(0, 0);
  const trajectoryLine = new THREE.Line(
    trajectoryGeo,
    new THREE.LineBasicMaterial({ color: 0xcf9bff, transparent: true, opacity: 0.45 }),
  );
  trajectoryLine.visible = false;
  scene.add(trajectoryLine);

  const _trajPos = new Vec3();
  const _trajVel = new Vec3();
  /** Updates the charge orb, trajectory preview, and HUD charge bar together,
   *  once per rendered frame, off the current charging/chargeStartTime state. */
  function updateChargeVisuals() {
    if (!charging) {
      chargeOrb.visible = false;
      trajectoryLine.visible = false;
      chargeBarWrap.style.display = 'none';
      return;
    }

    const fraction = THREE.MathUtils.clamp((performance.now() - chargeStartTime) / 1000 / CHARGE_MAX_TIME, 0, 1);
    chargeBarWrap.style.display = '';
    chargeBarFill.style.width = `${fraction * 100}%`;

    const slot = transforms.slotOf(playerEntity);
    if (slot === -1) return; // despawned mid-charge — nothing left to aim from
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const dir = new Vec3(1, 0, 0).applyQuaternion(playerFacing);
    const originX = raw[o] + dir.x * 0.8;
    const originZ = raw[o + 2] + dir.z * 0.8;
    const originY = raw[o + 1] + 1.1;

    chargeOrb.visible = true;
    chargeOrb.position.set(originX, originY, originZ);
    chargeOrb.scale.setScalar(THREE.MathUtils.lerp(0.18, 0.42, fraction));
    chargeGlow.intensity = THREE.MathUtils.lerp(0.4, 3, fraction);

    // Same launch-angle/speed/gravity mapping castSpell would use if
    // released right now, so the preview reflects this shot's current charge.
    const aimAngle = CAM_MIN_PITCH + CAM_MAX_PITCH - camPitch;
    const launchAngle = aimAngle * fraction;
    const speed = THREE.MathUtils.lerp(SPELL_MIN_SPEED, SPELL_MAX_SPEED, fraction);
    const gravity = GRAVITY * THREE.MathUtils.lerp(SPELL_MIN_GRAVITY_SCALE, SPELL_MAX_GRAVITY_SCALE, fraction);
    const speedH = speed * Math.cos(launchAngle);
    const speedV = speed * Math.sin(launchAngle);
    const range = THREE.MathUtils.lerp(SPELL_MIN_RANGE, SPELL_MAX_RANGE, fraction);

    trajectoryLine.visible = true;
    _trajPos.set(originX, originY, originZ);
    _trajVel.set(dir.x * speedH, speedV, dir.z * speedH);
    let count = 0;
    for (let i = 0; i < TRAJECTORY_SAMPLES; i++) {
      trajectoryPositions[count * 3] = _trajPos.x;
      trajectoryPositions[count * 3 + 1] = _trajPos.y;
      trajectoryPositions[count * 3 + 2] = _trajPos.z;
      count++;
      _trajVel.y += gravity * TRAJECTORY_DT;
      _trajPos.addScaledVector(_trajVel, TRAJECTORY_DT);
      const groundY = groundHeight(_trajPos.x, _trajPos.z);
      if (_trajPos.y <= groundY || horizontalDistance(_trajPos.x, _trajPos.z, originX, originZ) > range) {
        trajectoryPositions[count * 3] = _trajPos.x;
        trajectoryPositions[count * 3 + 1] = Math.max(_trajPos.y, groundY);
        trajectoryPositions[count * 3 + 2] = _trajPos.z;
        count++;
        break;
      }
    }
    trajectoryGeo.setDrawRange(0, count);
    trajectoryGeo.attributes.position.needsUpdate = true;
  }

  function updateBolts(dt) {
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.vel.y += b.gravity * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);

      // Ends the shot: dug into the terrain, or flew far enough out to be
      // forced down regardless (so a flat/fast shot can't sail forever).
      let impact = null;
      const groundY = groundHeight(b.pos.x, b.pos.z);
      if (b.pos.y <= groundY) impact = { x: b.pos.x, y: groundY, z: b.pos.z };
      else if (horizontalDistance(b.pos.x, b.pos.z, b.origin.x, b.origin.z) > b.range) {
        impact = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
      }

      if (!impact) {
        for (let oi = 0; oi < OBSTACLES.length; oi++) {
          const ob = OBSTACLES[oi];
          const minDist = ob.radius + b.radius;
          if (
            horizontalDistanceSq(b.pos.x, b.pos.z, ob.x, ob.z) <= minDist * minDist &&
            b.pos.y <= groundHeight(ob.x, ob.z) + ob.height
          ) {
            impact = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
            break;
          }
        }
      }

      let hitEntity;
      if (!impact) {
        // Generous query radius (must cover the tallest target's full
        // height), narrowed to an actual hit by the vertical-band check below.
        const nearby = spatialGrid.queryRadius(transforms, b.pos.x, b.pos.y, b.pos.z, b.radius + 2.6);
        for (let n = 0; n < nearby.length; n++) {
          const cand = nearby[n];
          const k = kinds.get(cand);
          if (k !== 'skeleton' && k !== 'necromancer') continue;
          const cs = transforms.slotOf(cand) * transforms.stride;
          const raw = transforms.raw;
          const horiz = horizontalDistance(raw[cs], raw[cs + 2], b.pos.x, b.pos.z);
          if (horiz > b.radius + 0.8) continue;
          const targetHeight = k === 'necromancer' ? 2.1 : 1.7;
          if (b.pos.y < raw[cs + 1] - 0.1 || b.pos.y > raw[cs + 1] + targetHeight) continue;
          hitEntity = cand;
          break;
        }
      }

      if (hitEntity !== undefined) {
        world.events.emit({ type: 'damage', target: hitEntity, amount: b.damage });
        flashHit(hitEntity);
        const splashDamage = applySplash(b.pos.x, b.pos.z, b.splashRadius, b.splashDamage, hitEntity);
        stats.directHits++;
        stats.mostDamageSingleShot = Math.max(stats.mostDamageSingleShot, b.damage + splashDamage);
        burst(b.pos, 0x8a5bff, Math.round(THREE.MathUtils.lerp(10, 36, b.fraction)));
        spawnSplashRing(b.pos, b.splashRadius);
        scene.remove(b.mesh);
        bolts.splice(i, 1);
      } else if (impact) {
        const splashDamage = applySplash(impact.x, impact.z, b.splashRadius, b.splashDamage, undefined);
        if (splashDamage > 0) stats.mostDamageSingleShot = Math.max(stats.mostDamageSingleShot, splashDamage);
        burst(impact, 0x8a5bff, Math.round(THREE.MathUtils.lerp(6, 24, b.fraction)));
        spawnSplashRing(impact, b.splashRadius);
        scene.remove(b.mesh);
        bolts.splice(i, 1);
      }
    }
  }

  /** Area damage around an impact point (horizontal-only distance), falling
   *  off linearly to 0 at `radius`. `exclude` is the entity that already took
   *  a direct hit this same impact. Returns total damage applied. */
  function applySplash(x, z, radius, damage, exclude) {
    if (radius <= 0 || damage <= 0) return 0;
    let total = 0;
    const nearby = spatialGrid.queryRadius(transforms, x, groundHeight(x, z), z, radius + 3);
    for (let n = 0; n < nearby.length; n++) {
      const cand = nearby[n];
      if (cand === exclude) continue;
      const k = kinds.get(cand);
      if (k !== 'skeleton' && k !== 'necromancer') continue;
      const cs = transforms.slotOf(cand) * transforms.stride;
      const raw = transforms.raw;
      const dist = horizontalDistance(raw[cs], raw[cs + 2], x, z);
      if (dist > radius) continue;
      // Curved (pow 0.6), not linear, falloff — stays high through most of
      // the radius and drops sharply only right at the edge.
      const amount = damage * Math.pow(1 - dist / radius, 0.6);
      if (amount < 0.5) continue;
      world.events.emit({ type: 'damage', target: cand, amount });
      flashHit(cand);
      total += amount;
    }
    return total;
  }

  // --- Splash rings: a quick expanding, fading ring at an impact point,
  // tracing the actual splash-damage radius. Each ring clones the base
  // material so its opacity can fade independently of the others. ---
  const splashRings = [];
  const splashRingGeo = new THREE.RingGeometry(0.8, 1, 32);
  const splashRingBaseMat = new THREE.MeshBasicMaterial({
    color: 0xcf9bff,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  function spawnSplashRing(pos, targetRadius) {
    const mesh = new THREE.Mesh(splashRingGeo, splashRingBaseMat.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.05, pos.z);
    mesh.scale.setScalar(0.05);
    scene.add(mesh);
    splashRings.push({ mesh, age: 0, maxAge: 0.4, targetRadius });
  }

  function updateSplashRings(dt) {
    for (let i = splashRings.length - 1; i >= 0; i--) {
      const r = splashRings[i];
      r.age += dt;
      const t = Math.min(r.age / r.maxAge, 1);
      const s = THREE.MathUtils.lerp(0.05, r.targetRadius, t);
      r.mesh.scale.setScalar(s);
      r.mesh.material.opacity = 0.6 * (1 - t);
      if (t >= 1) {
        scene.remove(r.mesh);
        r.mesh.material.dispose();
        splashRings.splice(i, 1);
      }
    }
  }

  // --- Bone shards: skeleton.glb is a single merged mesh with no actual limb
  // pieces to fly apart, so this fakes a shatter — tumbling debris flung
  // outward and down, mostly long "bone" cylinders with a few small chunks. ---
  const boneShards = [];
  const boneStickGeo = new THREE.CylinderGeometry(1, 1, 1, 6); // unit cylinder — scale.set(radius, length, radius) per instance
  const boneChunkGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const boneShardMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.9 });

  function spawnBoneShards(pos, count = 7) {
    for (let i = 0; i < count; i++) {
      const isStick = Math.random() < 0.7;
      const mesh = new THREE.Mesh(isStick ? boneStickGeo : boneChunkGeo, boneShardMat);
      if (isStick) {
        const radius = 0.035 + Math.random() * 0.03;
        const length = 0.28 + Math.random() * 0.32;
        mesh.scale.set(radius, length, radius);
      } else {
        mesh.scale.setScalar(0.6 + Math.random() * 0.8);
      }
      mesh.position.set(pos.x, pos.y + 0.8, pos.z);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      scene.add(mesh);

      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 0.7); // biased outward/upward, not straight down
      const speed = 2.5 + Math.random() * 3.5;
      boneShards.push({
        mesh,
        vel: new Vec3(Math.sin(phi) * Math.cos(theta) * speed, Math.cos(phi) * speed + 1.5, Math.sin(phi) * Math.sin(theta) * speed),
        spinX: (Math.random() - 0.5) * 12,
        spinY: (Math.random() - 0.5) * 12,
        spinZ: (Math.random() - 0.5) * 12,
        age: 0,
        maxAge: 0.9 + Math.random() * 0.4,
      });
    }
  }

  function updateBoneShards(dt) {
    for (let i = boneShards.length - 1; i >= 0; i--) {
      const s = boneShards[i];
      s.age += dt;
      s.vel.y += GRAVITY * 0.4 * dt; // lighter fall than a spell bolt — small debris
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spinX * dt;
      s.mesh.rotation.y += s.spinY * dt;
      s.mesh.rotation.z += s.spinZ * dt;
      const grounded = s.mesh.position.y < groundHeight(s.mesh.position.x, s.mesh.position.z) - 1.5;
      if (s.age >= s.maxAge || grounded) {
        scene.remove(s.mesh);
        boneShards.splice(i, 1);
      }
    }
  }

  // --- Necromancer's own attack: a small bolt straight at the player's
  // position at cast time (not homing — dodgeable, like the player's own
  // spell), fired every NECROMANCER_RITUALS_PER_SPELL-th completed ritual. ---
  const necromancerBolts = [];
  const necromancerBoltGeo = new THREE.SphereGeometry(0.3, 10, 8);
  const necromancerBoltMat = new THREE.MeshBasicMaterial({ color: 0x33ff88 });

  function fireNecromancerBolt() {
    const nSlot = transforms.slotOf(necromancerEntity);
    const pSlot = transforms.slotOf(playerEntity);
    if (nSlot === -1 || pSlot === -1) return;
    const raw = transforms.raw;
    const no = nSlot * transforms.stride;
    const po = pSlot * transforms.stride;

    const origin = new Vec3(raw[no], raw[no + 1] + 1.8, raw[no + 2]); // roughly staff/head height
    // aimed at the player's torso, not their feet
    const target = new Vec3(raw[po], raw[po + 1] + 1.1, raw[po + 2]);
    const dir = target.sub(origin);
    const dist = dir.length() || 1e-6;
    dir.divideScalar(dist);

    const mesh = new THREE.Mesh(necromancerBoltGeo, necromancerBoltMat);
    const glow = new THREE.PointLight(0x33ff88, 2.5, 6);
    mesh.add(glow);
    mesh.position.copy(origin);
    scene.add(mesh);

    necromancerBolts.push({
      mesh,
      pos: origin.clone(),
      vel: dir.multiplyScalar(NECROMANCER_BOLT_SPEED),
      traveled: 0,
    });
    sound.play(necroCastSfx, { volume: 0.6, priority: 1 });
  }

  const _necroBoltTarget = new Vec3();
  function updateNecromancerBolts(dt) {
    for (let i = necromancerBolts.length - 1; i >= 0; i--) {
      const b = necromancerBolts[i];
      const step = NECROMANCER_BOLT_SPEED * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.traveled += step;
      b.mesh.position.copy(b.pos);

      let hit = false;
      const pSlot = transforms.slotOf(playerEntity);
      if (pSlot !== -1) {
        const po = pSlot * transforms.stride;
        const raw = transforms.raw;
        _necroBoltTarget.set(raw[po], raw[po + 1] + 1.1, raw[po + 2]);
        hit = b.pos.distanceTo(_necroBoltTarget) <= NECROMANCER_BOLT_HIT_RADIUS;
      }

      if (hit) {
        world.events.emit({ type: 'damage', target: playerEntity, amount: NECROMANCER_BOLT_DAMAGE });
        stats.necromancerBoltsHit++;
        burst(b.pos, 0x33ff88, 10);
        scene.remove(b.mesh);
        necromancerBolts.splice(i, 1);
      } else if (b.traveled >= NECROMANCER_BOLT_MAX_RANGE) {
        scene.remove(b.mesh);
        necromancerBolts.splice(i, 1);
      }
    }
  }

  // --- Necromancer state machine: plain game-loop state, not ECS/behavior
  // tree — it only ever drives one entity plus a few counters. ---
  let spawnTimer = 1.5; // first wave arrives quickly

  /** A handful of tries at a random point at least NECROMANCER_MIN_DISTANCE
   *  from the player; falls back to the farthest candidate tried if none clear it. */
  function pickNecromancerWanderTarget() {
    const margin = 4;
    const pSlot = transforms.slotOf(playerEntity);
    const raw = transforms.raw;
    const px = pSlot !== -1 ? raw[pSlot * transforms.stride] : 0;
    const pz = pSlot !== -1 ? raw[pSlot * transforms.stride + 2] : 0;

    let best = null;
    let bestDist = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate = {
        x: (Math.random() * 2 - 1) * (ARENA_HALF - margin),
        z: (Math.random() * 2 - 1) * (ARENA_HALF - margin),
      };
      const dist = horizontalDistance(candidate.x, candidate.z, px, pz);
      if (dist >= NECROMANCER_MIN_DISTANCE) {
        necromancerWanderTarget = candidate;
        return;
      }
      if (dist > bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    necromancerWanderTarget = best;
  }

  /** Cancels the in-progress ritual: any skeleton still mid-rise sinks back
   *  down and despawns; already-completed ones are untouched. */
  function interruptRitual() {
    for (let i = 0; i < currentRitualSkeletons.length; i++) {
      const e = currentRitualSkeletons[i];
      const state = ai.get(e);
      if (!state || state.blackboard.riseTimer <= 0) continue;
      const obj = meshes.get(e);
      const bar = healthBars.get(e);
      if (bar) scene.remove(bar);
      flashingEntities.delete(e);
      skeletonCount--;
      world.despawn(e);
      if (obj) sinkingSkeletons.push({ mesh: obj, elapsed: 0, duration: SKELETON_SINK_DURATION, startY: obj.position.y });
    }
    currentRitualSkeletons.length = 0;
  }

  function updateSinkingSkeletons(dt) {
    for (let i = sinkingSkeletons.length - 1; i >= 0; i--) {
      const s = sinkingSkeletons[i];
      s.elapsed += dt;
      const t = Math.min(s.elapsed / s.duration, 1);
      s.mesh.position.y = s.startY - t * SKELETON_RISE_DEPTH;
      if (t >= 1) {
        scene.remove(s.mesh);
        sinkingSkeletons.splice(i, 1);
      }
    }
  }

  const _wanderDir = new Vec3();
  function moveNecromancerWander(dt) {
    if (!necromancerWanderTarget) pickNecromancerWanderTarget();
    const slot = transforms.slotOf(necromancerEntity);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const pz = raw[o + 2];

    // The player closing distance always overrides the wander target; once
    // backed off, force a fresh target so it doesn't walk straight back.
    let haveDir = false;
    const pSlot = transforms.slotOf(playerEntity);
    if (pSlot !== -1) {
      const po = pSlot * transforms.stride;
      _wanderDir.set(raw[po] - px, 0, raw[po + 2] - pz);
      const distToPlayer = _wanderDir.length() || 1e-6;
      if (distToPlayer < NECROMANCER_MIN_DISTANCE) {
        _wanderDir.multiplyScalar(-1 / distToPlayer);
        necromancerWanderTarget = null;
        haveDir = true;
      }
    }

    if (!haveDir) {
      _wanderDir.set(necromancerWanderTarget.x - px, 0, necromancerWanderTarget.z - pz);
      const dist = _wanderDir.length();
      if (dist < 1.5) {
        pickNecromancerWanderTarget();
        return;
      }
      _wanderDir.divideScalar(dist);
    }

    let nx = px + _wanderDir.x * NECROMANCER_WANDER_SPEED * dt;
    let nz = pz + _wanderDir.z * NECROMANCER_WANDER_SPEED * dt;
    ({ x: nx, z: nz } = resolveObstacles(nx, nz, NECROMANCER_RADIUS));
    nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 2, ARENA_HALF - 2);
    nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 2, ARENA_HALF - 2);
    const facing = necromancerLookAtPlayer(nx, nz, [raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]]);
    transforms.add(necromancerEntity, nx, groundHeight(nx, nz), nz, ...facing);
  }

  const _fleeDir = new Vec3();
  const _fleeCover = new Vec3();
  function updateNecromancer(dt) {
    if (!necromancerAlive) return;

    // A queued bolt fires the instant a clear shot opens up — not checked
    // mid-ritual, since it's standing still concentrating on the raising.
    if (necromancerWantsToFireBolt && necromancerState !== 'ritual') {
      const nSlot = transforms.slotOf(necromancerEntity);
      const pSlot = transforms.slotOf(playerEntity);
      if (nSlot !== -1 && pSlot !== -1) {
        const raw = transforms.raw;
        const no = nSlot * transforms.stride;
        const po = pSlot * transforms.stride;
        if (hasLineOfSight(raw[no], raw[no + 2], raw[po], raw[po + 2])) {
          fireNecromancerBolt();
          necromancerWantsToFireBolt = false;
        }
      }
    }

    if (necromancerState === 'fleeing') {
      // Always measured from the most recent hit — the 'damage' handler
      // resets this to 0 on every hit, restarting the clock.
      necromancerFleeTimer += dt;
      const slot = transforms.slotOf(necromancerEntity);
      const o = slot * transforms.stride;
      const raw = transforms.raw;

      // Away-from-player is recomputed live each tick, blended with the
      // direction toward the fixed cover target picked at hit-time.
      _fleeDir.set(0, 0, 0);
      const pSlotForDir = transforms.slotOf(playerEntity);
      if (pSlotForDir !== -1) {
        const po = pSlotForDir * transforms.stride;
        _fleeDir.set(raw[o] - raw[po], 0, raw[o + 2] - raw[po + 2]).normalize();
      }
      if (necromancerFleeCoverTarget) {
        _fleeCover.set(necromancerFleeCoverTarget.x - raw[o], 0, necromancerFleeCoverTarget.z - raw[o + 2]).normalize();
        _fleeDir.set(_fleeDir.x * 0.3 + _fleeCover.x * 0.7, 0, _fleeDir.z * 0.3 + _fleeCover.z * 0.7).normalize();
      }

      let nx = raw[o] + _fleeDir.x * NECROMANCER_FLEE_SPEED * dt;
      let nz = raw[o + 2] + _fleeDir.z * NECROMANCER_FLEE_SPEED * dt;
      ({ x: nx, z: nz } = resolveObstacles(nx, nz, NECROMANCER_RADIUS));
      nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 2, ARENA_HALF - 2);
      nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 2, ARENA_HALF - 2);
      // Faces the direction it's fleeing, not the player, unlike every other state.
      transforms.add(necromancerEntity, nx, groundHeight(nx, nz), nz, ...quatArray(yawQuaternion(_fleeDir.x, _fleeDir.z, yawScratch)));

      const pSlot = transforms.slotOf(playerEntity);
      let brokeLineOfSight = false;
      if (pSlot !== -1) {
        const po = pSlot * transforms.stride;
        brokeLineOfSight = !hasLineOfSight(nx, nz, raw[po], raw[po + 2]);
      }
      const minDurationMet = necromancerFleeTimer >= NECROMANCER_FLEE_MIN_DURATION;
      if ((brokeLineOfSight && minDurationMet) || necromancerFleeTimer >= NECROMANCER_FLEE_MAX_DURATION) {
        necromancerState = 'wandering';
        pickNecromancerWanderTarget();
      }
      return;
    }

    if (necromancerState === 'ritual') {
      const slot = transforms.slotOf(necromancerEntity);
      const o = slot * transforms.stride;
      const raw = transforms.raw;
      const facing = necromancerLookAtPlayer(raw[o], raw[o + 2], [raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]]);
      transforms.add(necromancerEntity, raw[o], raw[o + 1], raw[o + 2], ...facing);

      ritualElapsed += dt;
      while (ritualSpawnQueue.length > 0 && ritualElapsed >= ritualSpawnQueue[0]) {
        ritualSpawnQueue.shift();
        const e = spawnSkeleton();
        if (e !== undefined) currentRitualSkeletons.push(e);
      }
      necromancerRitualTimer -= dt;
      if (necromancerRitualTimer <= 0) {
        currentRitualSkeletons.length = 0; // whatever's left finished rising on its own
        necromancerState = 'wandering';
        spawnTimer = NECROMANCER_SPAWN_INTERVAL;
        pickNecromancerWanderTarget();
        // Only a ritual that finished counts, not one cut short by interruptRitual.
        necromancerRitualsCompleted++;
        if (necromancerRitualsCompleted % NECROMANCER_RITUALS_PER_SPELL === 0) necromancerWantsToFireBolt = true;
      }
      return;
    }

    // wandering
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      necromancerState = 'ritual';
      necromancerRitualTimer = NECROMANCER_RITUAL_DURATION;
      ritualElapsed = 0;
      ritualSpawnQueue = [];
      for (let i = 0; i < SKELETONS_PER_WAVE; i++) ritualSpawnQueue.push(i * 0.35);
      sound.play(spawnSfx, { volume: 0.5, id: 'spawn', queueTTL: 300 });
      return;
    }
    moveNecromancerWander(dt);
  }

  // --- Mesh sync: writes every entity's current transform into its Object3D. ---
  const HEALTH_BAR_Y_OFFSET = 2.0; // above a skeleton's ~1.7-tall head
  function syncMeshes() {
    const entities = meshes.entities;
    const objs = meshes.values;
    for (let i = 0; i < entities.length; i++) {
      const slot = transforms.slotOf(entities[i]);
      if (slot === -1) continue;
      const o = slot * transforms.stride;
      const raw = transforms.raw;
      objs[i].position.set(raw[o], raw[o + 1], raw[o + 2]);
      objs[i].quaternion.set(raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]);
    }

    const barEntities = healthBars.entities;
    const bars = healthBars.values;
    for (let i = 0; i < barEntities.length; i++) {
      const slot = transforms.slotOf(barEntities[i]);
      if (slot === -1) continue;
      const o = slot * transforms.stride;
      const raw = transforms.raw;
      bars[i].position.set(raw[o], raw[o + 1] + HEALTH_BAR_Y_OFFSET, raw[o + 2]);
    }
  }

  /** Backstop cleanup: removes any spawnStatic-created mesh no longer owned
   *  by a live entity. Normal despawn paths already remove their own mesh, so
   *  this is usually a no-op — it exists against "a mesh visibly outlives its
   *  entity" regardless of exact cause. */
  function sweepOrphanedMeshes() {
    for (const obj of spawnedCharacterMeshes) {
      const e = obj.userData.ownerEntity;
      if (meshes.get(e) === obj) continue; // still the live mesh for a live entity
      if (sinkingSkeletons.some((s) => s.mesh === obj)) continue; // mid its own removal animation
      scene.remove(obj);
      spawnedCharacterMeshes.delete(obj);
    }
  }

  // --- Main loop ---
  const FIXED_DT = 1 / 60;
  const fixedStep = new FixedStep(FIXED_DT, 5);
  let last = performance.now();

  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    if (!gameOver && !levelComplete) {
      fixedStep.advance(dt, (fixedDt) => {
        input.update();

        mana = Math.min(MANA_MAX, mana + MANA_REGEN_PER_SEC * fixedDt);
        if (input.justPressed('cast')) startCharge();
        if (input.justReleased('cast')) releaseCharge();

        movePlayer(fixedDt);
        // Rebuilds the grid a tick early (world.step() below rebuilds it
        // again internally, registered via registerSpatialGrid — a small
        // redundant ~1ms rebuild, cheap next to what batching neighbor
        // queries saves) so buildNeighborLists sees this tick's positions
        // before any skeleton's steerToward runs inside world.step().
        spatialGrid.rebuild(transforms);
        spatialGrid.buildNeighborLists(transforms, SEPARATION_RADIUS, skeletonNeighborLists);
        world.step(fixedDt); // rebuilds the spatial grid, ticks skeleton AI, drains damage/death events
        updateBolts(fixedDt);
        updateNecromancer(fixedDt);
        updateNecromancerBolts(fixedDt);
      });
    }

    // Purely decorative effects keep animating every rendered frame
    // regardless of gameOver/levelComplete (on real dt, not fixed dt) — gating
    // these the same as the sim used to freeze anything mid-animation, like
    // the player's own death burst, the instant the game ended.
    updateSplashRings(dt);
    updateHitFlashes(dt);
    updateSinkingSkeletons(dt);
    updateBoneShards(dt);
    particles.update(dt);
    if (flashTimer > 0 && !deathVignetteActive) {
      flashTimer -= dt;
      if (flashTimer <= 0) hitFlash.style.opacity = '0';
    }

    syncMeshes();
    sweepOrphanedMeshes();

    const hpComp = health.get(playerEntity);
    playerHp = hpComp ? hpComp.hp : 0;
    hpFill.style.width = `${Math.max(0, (playerHp / PLAYER_MAX_HP) * 100)}%`;
    mpFill.style.width = `${(mana / MANA_MAX) * 100}%`;
    skelCountEl.textContent = `Skeletons: ${skeletonCount}/${MAX_SKELETONS}`;

    if (necromancerAlive) {
      const bossHp = health.get(necromancerEntity);
      bossFill.style.width = `${Math.max(0, ((bossHp ? bossHp.hp : 0) / NECROMANCER_MAX_HP) * 100)}%`;
    } else {
      bossHud.style.display = 'none';
    }

    updateCamera();
    updateChargeVisuals();
    gl.render(scene, camera);
    debug.tick();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
