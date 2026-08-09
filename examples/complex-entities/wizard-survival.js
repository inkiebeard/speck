/**
 * Wizard survival — a basic player controller (wizard.glb) fighting off a
 * necromancer (necromancer.glb) that periodically raises a swarm of
 * skeletons (skeleton.glb, capped at 100 concurrently alive), which seek the
 * player out and attack in melee. The player fights back with a mana-gated
 * spell bolt: mana drains per cast and regenerates over time, so the
 * "recharge" is the mana pool refilling, not a fixed cooldown timer.
 *
 * Shows the engine's GLTF loader, AI (behavior trees + the per-entity AI
 * system + separation steering off SpatialGrid), the event queue for
 * damage/death, InputBuffer for WASD + cast, and Preloader for the loading
 * screen — all without physics, unlike the examples/physics demo.
 *
 * Runs straight in a browser via <script type="module">, no bundler: three
 * comes from the same CDN URL dist/speck.js was built against, and the
 * engine comes from the built dist/speck.js, not the TS source. Run
 * `npm run build` first, then serve the repo root statically and open
 * wizard-survival.html.
 */
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
    const envelope = Math.sin(Math.PI * (t / duration)); // fades in and out
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
    data[i] = (Math.random() * 2 - 1) * envelope * 0.5; // short noise crack
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
    const freq = 300 * Math.exp(-3 * t); // falling tone
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

/** The necromancer's own bolt — a falling, slightly dissonant two-tone
 *  sting, deliberately darker than the player's rising castSfx sweep so the
 *  two casters read as distinct threats by ear alone. */
function createNecromancerCastBuffer(context) {
  const duration = 0.4;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const freqs = [220, 233]; // a minor second apart — deliberately dissonant
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const sweep = 1 - 0.4 * (t / duration); // falling pitch, opposite of the player's rising cast
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
const PLAYER_RADIUS = 0.5; // collision radius against obstacles

// Camera: a chase cam orbiting the player at (CAM_DISTANCE, CAM_YAW, CAM_PITCH)
// — yaw doubles as the player's own facing (mouse/touch-look turns the
// character directly, the way most third-person shooters work), so there's
// no separate "turn to face travel direction" smoothing to tune here.
const CAM_MIN_DISTANCE = 3;
const CAM_MAX_DISTANCE = 16;
const CAM_MIN_PITCH = -0.15;
const CAM_MAX_PITCH = 1.15;
const CAM_EYE_HEIGHT = 1.4;
const MOUSE_LOOK_SENSITIVITY = 0.0024; // radians per pixel of pointer-locked mouse movement
const TOUCH_LOOK_SENSITIVITY = 0.0055; // radians per pixel of touch-drag
const JOYSTICK_RADIUS = 45; // px

const MANA_MAX = 100;
const MANA_REGEN_PER_SEC = 14; // this is the spell's "recharge"
// Press-and-hold power-up: charge fraction 0..1 ramps linearly over
// CHARGE_MAX_TIME and lerps cost/damage/radius/speed between their MIN/MAX
// pair — a quick tap still fires (at MIN, cheaply, a short weak toss), a
// full hold trades more mana for a bigger, harder-hitting, farther-flying
// bolt. Angle (from camPitch) still shapes the arc on top of that — a flat
// full-power throw goes long and low, a steep one lobs shorter and higher —
// so both how hard and where you aim change the shot's actual range.
const CHARGE_MAX_TIME = 1.1;
const SPELL_MIN_COST = 12;
const SPELL_MAX_COST = 42;
const SPELL_MIN_DAMAGE = 15;
const SPELL_MAX_DAMAGE = 55;
const SPELL_MIN_RADIUS = 0.35;
const SPELL_MAX_RADIUS = 0.75;
const SPELL_MIN_SPEED = 15; // total launch speed at zero charge — a weak flick, short range even flat-aimed
const SPELL_MAX_SPEED = 34; // total launch speed at full charge — split into horizontal/vertical by camPitch, see castSpell
const SPELL_MAX_RANGE = 45; // horizontal distance from the cast point, past which a still-airborne bolt is forced down
const GRAVITY = -24; // heavier than Earth's — reads as a weighty lob, not a floaty toss
// A bigger charge doesn't just move faster, it's a bigger/heavier mass of
// energy (see SPELL_MIN/MAX_RADIUS) — scaling how hard gravity pulls it down
// too is what actually sells that weight, rather than just a same-shaped
// arc that happens to go farther. A minimal-charge bolt is light enough to
// fly comparatively flat/quick; a full-charge one visibly sags under itself.
const SPELL_MIN_GRAVITY_SCALE = 0.65;
const SPELL_MAX_GRAVITY_SCALE = 1.5;
// Splash on impact (ground, obstacle, or a direct hit) — horizontal-only
// distance from the impact point, with damage falling off linearly to 0 at
// the edge, so a bigger charge doesn't just hit harder but also punishes a
// tighter cluster of skeletons. Scales with the same charge fraction as
// everything else in castSpell. MIN_RADIUS is deliberately well past
// SEPARATION_RADIUS (skeletons packed into a swarm routinely end up closer
// together than their own separation steering "wants") so even a quick,
// uncharged tap reliably catches a crowded neighbor, not just the target
// standing exactly at the impact point.
const SPLASH_MIN_RADIUS = 2.4;
const SPLASH_MAX_RADIUS = 5.5;
const SPLASH_MIN_DAMAGE = 14;
const SPLASH_MAX_DAMAGE = 42;

// The necromancer cycles through three states (see updateNecromancer):
// 'wandering' the arena at large — steering away the instant the player
// closes within NECROMANCER_MIN_DISTANCE rather than ever letting itself get
// caught at close range — until its spawn timer runs out, at which point it
// plants itself and enters 'ritual' — standing still while a wave of
// skeletons rises out of the ground around it — for NECROMANCER_RITUAL_
// DURATION, then resumes wandering. Any non-lethal hit interrupts whatever
// it's doing and switches it to 'fleeing'; a hit mid-ritual also cancels
// that ritual (see interruptRitual) rather than letting it finish. Fleeing
// itself runs until line of sight to the player actually breaks (behind an
// obstacle — see hasLineOfSight) *and* at least NECROMANCER_FLEE_MIN_DURATION
// has passed since the most recent hit (a hit mid-flee resets the clock, not
// just extends it — see the 'damage' handler), capped by
// NECROMANCER_FLEE_MAX_DURATION so it can't get stuck running forever in the
// open with nothing to duck behind. It faces the player continuously in
// every state *except* fleeing, where it faces the direction it's actually
// running instead (backing away while watching its target makes sense for
// repositioning, not for a panicked retreat). Every NECROMANCER_RITUALS_PER_
// SPELL-th completed ritual
// (interrupted ones don't count) queues up a bolt at the player, but it only
// actually fires once there's a clear line of sight — see
// necromancerWantsToFireBolt — which can land on the same tick the ritual
// ends or much later, whenever a shot actually opens up.
const NECROMANCER_MAX_HP = 600;
const NECROMANCER_SPAWN_INTERVAL = 3.5; // how long it wanders between rituals
const NECROMANCER_RITUAL_DURATION = 2.2; // must exceed the last skeleton's spawn offset + its own rise time
const NECROMANCER_WANDER_SPEED = 3.5;
const SKELETONS_PER_WAVE = 3;
const MAX_SKELETONS = 100;
const SPAWN_JITTER_RADIUS = 4;
const NECROMANCER_RADIUS = 1.1; // collision radius against obstacles
const NECROMANCER_FLEE_SPEED = 5.5;
const NECROMANCER_FLEE_MIN_DURATION = 2; // won't stop fleeing on a LOS break before this, timed from the *last* hit
const NECROMANCER_FLEE_MAX_DURATION = 15; // safety cap if it can never break line of sight
const NECROMANCER_MIN_DISTANCE = 14; // never wanders closer than this to the player — see moveNecromancerWander
const NECROMANCER_COVER_MIN_CLEARANCE = 6; // ignores obstacles it's already this close to when picking flee cover — see nearestObstacle
const NECROMANCER_RITUALS_PER_SPELL = 2;
const NECROMANCER_BOLT_SPEED = 22;
const NECROMANCER_BOLT_DAMAGE = 10;
const NECROMANCER_BOLT_MAX_RANGE = 60;
const NECROMANCER_BOLT_HIT_RADIUS = 1.1;

// Each skeleton runs its own small perception state machine (see
// skeletonBehavior): 'wander' near where it rose until it actually notices
// the player — close enough (SKELETON_DETECT_RADIUS) regardless of sightline,
// or farther but in the clear (SKELETON_VISION_RANGE + hasLineOfSight) —
// at which point it 'chase's. Losing track of the player (out of both
// ranges) for SKELETON_LOSE_INTEREST_TIME drops it back to wandering rather
// than chasing a memory forever. A nearby ally dying pulls any *wandering*
// (not already chasing/investigating) skeleton within SKELETON_ALERT_RADIUS
// into 'investigate'ing the spot — see alertNearbySkeletons — so a swarm
// reacts to losses even before spotting the player itself.
const SKELETON_MAX_HP = 30;
const SKELETON_SPEED = 3.2;
const SKELETON_WANDER_SPEED = 1.4;
const SKELETON_INVESTIGATE_SPEED = 2.4;
const SKELETON_ATTACK_RANGE = 1.7;
const SKELETON_ATTACK_DAMAGE = 6;
const SKELETON_ATTACK_COOLDOWN = 1.1;
const SEPARATION_RADIUS = 1.6;
const SKELETON_DETECT_RADIUS = 6; // always notices the player this close, sightline or not
const SKELETON_VISION_RANGE = 16; // notices farther out too, but only with a clear line of sight
const SKELETON_LOSE_INTEREST_TIME = 4; // seconds of no detection before giving up a chase
const SKELETON_WANDER_RADIUS = 8; // roams within this of where it rose
// steerToward only clears wanderTarget on arrival (distance < 1) — a target
// picked on the far side of an obstacle it can't route around otherwise
// never counts as "arrived" and resolveObstacles fights it to a standstill
// every tick, forever (this is what "a skeleton is just standing there doing
// nothing" bug reports turned out to be). Forcing a fresh target after this
// long regardless of whether it arrived bounds how long any one pick can
// leave it stuck — worst case it just keeps retrying every few seconds.
const SKELETON_WANDER_TARGET_TIMEOUT = 6;
const SKELETON_ALERT_RADIUS = 10; // how far a death draws wandering allies to investigate
const SKELETON_INVESTIGATE_TIMEOUT = 5; // give up and resume wandering if nothing's found by then
// A freshly-raised skeleton spends this long climbing out of the ground
// (see the skeletonBehavior rise phase) before it can move/attack on its
// own — buried this deep at the start so it's fully hidden below the
// terrain, not just poking up at spawn.
const SKELETON_RISE_DURATION = 1.1;
const SKELETON_RISE_DEPTH = 1.9;
const SKELETON_SINK_DURATION = 0.5; // how fast an interrupted (still-rising) skeleton sinks back down and despawns
const SKELETON_RADIUS = 0.4; // collision radius against obstacles

const GRID_CELL_SIZE = 3;

// Static circular obstacles scattered across the arena — block movement and
// spell bolts alike, give the skeleton swarm something to path around, and
// give the player cover from line of sight. Hand-placed (not randomized) so
// they never block the player/necromancer starting spots or the skeleton
// spawn jitter radius around the necromancer, and never overlap each other.
// `type` (default 'rock' when omitted) picks both the geometry/texture used
// to build it (see the obstacle mesh loop) and nothing about the collision
// logic below — pillars are still just a circle+height like every rock, so
// they block movement and spell bolts exactly the same way for free.
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

/** Gentle analytic rolling terrain (no heightmap asset) — shared by the
 *  ground mesh's own vertex displacement and every entity/obstacle's Y
 *  placement, so characters sit on the bumps instead of floating above or
 *  clipping into them. Amplitude stays small (~±0.7) so it reads as "small
 *  variations," not hills that would fight movement/AI, which are otherwise
 *  purely 2D (XZ) in this example. */
function groundHeight(x, z) {
  return Math.sin(x * 0.15) * 0.22 + Math.cos(z * 0.13) * 0.22 + Math.sin((x + z) * 0.05) * 0.28;
}

/** Pushes (x, z) out of any `OBSTACLES` entry it's currently overlapping —
 *  simple circle-vs-circle resolution, not real physics, which is all a
 *  static, non-moving obstacle set needs. Used by every ground-bound mover
 *  (player, skeletons, the fleeing necromancer) so the rocks are actually
 *  solid instead of just decoration.
 *
 *  Runs a few passes, not one: a single pass resolves each obstacle
 *  independently, so pushing clear of obstacle A can shove a point straight
 *  into obstacle B (most likely for a point already wedged between two
 *  close-together obstacles, e.g. near the paired pillars) — one pass alone
 *  leaves it still overlapping B. A handful of passes converges instead of
 *  leaving a mover visibly stuck oscillating between two solids every frame. */
function resolveObstacles(x, z, radius) {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < OBSTACLES.length; i++) {
      const ob = OBSTACLES[i];
      const dx = x - ob.x;
      const dz = z - ob.z;
      const minDist = ob.radius + radius;
      const distSq = dx * dx + dz * dz;
      if (distSq < minDist * minDist && distSq > 1e-8) {
        const dist = Math.sqrt(distSq);
        const push = minDist - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }
  }
  return { x, z };
}

/** Whether the segment (x1,z1)-(x2,z2) passes within `radius` of (cx,cz) —
 *  closest-point-on-segment-to-circle-center, the standard segment/circle test. */
function segmentIntersectsCircle(x1, z1, x2, z2, cx, cz, radius) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-8 ? ((cx - x1) * dx + (cz - z1) * dz) / len2 : 0;
  t = THREE.MathUtils.clamp(t, 0, 1);
  const px = x1 + t * dx;
  const pz = z1 + t * dz;
  const ddx = px - cx;
  const ddz = pz - cz;
  return ddx * ddx + ddz * ddz <= radius * radius;
}

/** Horizontal-only line of sight between two points, blocked by any
 *  `OBSTACLES` entry the straight line between them passes through — used
 *  to decide when the fleeing necromancer has actually found cover, not
 *  just put distance between itself and the player (see updateNecromancer).
 *  Ignores height entirely: every obstacle is tall enough (>=2.2, well
 *  above both entities' own height) to fully occlude at this game's scale,
 *  so a 2D check is enough without needing a real raycast. */
function hasLineOfSight(x1, z1, x2, z2) {
  for (let i = 0; i < OBSTACLES.length; i++) {
    const ob = OBSTACLES[i];
    if (segmentIntersectsCircle(x1, z1, x2, z2, ob.x, ob.z, ob.radius)) return false;
  }
  return true;
}

/** Nearest OBSTACLES entry to (x, z) — the fleeing necromancer biases its
 *  run toward this rather than straight away from the player, so it's
 *  actually seeking cover, not just retreating in the open. `minClearance`
 *  excludes anything whose edge is already closer than that (distance to
 *  center minus its own radius) — without it, a hit landed while already
 *  standing next to a rock just picks that same rock as "cover", and the
 *  necromancer never actually goes anywhere, just hugs it. */
function nearestObstacle(x, z, minClearance = 0) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < OBSTACLES.length; i++) {
    const ob = OBSTACLES[i];
    const dist = Math.hypot(ob.x - x, ob.z - z);
    if (dist - ob.radius < minClearance) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = ob;
    }
  }
  return best;
}

/** Wraps a cloned GLTF scene in a Group, scaled to `targetHeight` and
 *  centered on X/Z with its base sitting at local y=0 — so every model,
 *  regardless of its authored scale/pivot, can be positioned uniformly by
 *  just setting the returned Group's position/quaternion.
 *
 *  `Object3D.clone(true)` deep-clones the node hierarchy but deliberately
 *  *not* geometry/materials — every clone shares the same material instance
 *  by default, which is normally the cheap, correct thing (see the class
 *  doc on GltfLoader). `cloneMaterials: true` opts a specific instance out
 *  of that sharing, so its color can be tinted (e.g. a hit flash) without
 *  every other instance of the same model flashing too — pass it only for
 *  instances that actually need independent per-instance material state. */
function normalizedInstance(template, targetHeight, cloneMaterials = false) {
  const model = template.clone(true);
  if (cloneMaterials) {
    model.traverse((child) => {
      if (child.isMesh) child.material = child.material.clone();
    });
  }
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

// atan2(dx, dz) would be the right formula if the models' authored "forward"
// pointed down +Z, but wizard/necromancer/skeleton all face down +X at
// identity rotation instead (visually confirmed: at yaw 0 they render in
// right-profile, not front-on) — atan2(-dz, dx) rotates that +X-facing pose
// to point at (dx, dz) instead.
function yawQuaternion(dx, dz, out = new THREE.Quaternion()) {
  const yaw = Math.atan2(-dz, dx);
  return out.setFromAxisAngle(UP, yaw);
}

const UP = new THREE.Vector3(0, 1, 0);

// Coarse-pointer devices (touch/stylus without a mouse) get the virtual
// joystick + drag-to-look + tap-to-cast controls instead of keyboard/mouse.
const isTouch = matchMedia('(pointer: coarse)').matches;

async function main() {
  // --- Three.js boilerplate ---
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a12, 0.014);
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setSize(innerWidth, innerHeight);
  document.body.appendChild(gl.domElement);

  scene.add(new THREE.HemisphereLight(0x8899cc, 0x201814, 1.1));
  const sun = new THREE.DirectionalLight(0xffe8c8, 1.4);
  sun.position.set(20, 30, 10);
  scene.add(sun);

  // Ground + obstacle meshes are built further down, once the Preloader has
  // actually loaded their textures (see just after loadingEl.remove()) —
  // they used to be built here, before those textures existed.

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

  // --- Load the 3 GLB templates once; every instance clones from these ---
  const gltf = new GltfLoader();
  const preloader = new Preloader();
  preloader.onProgress(({ fraction }) => {
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  });

  const textureLoader = new THREE.TextureLoader();
  /** Configures a loaded texture for tiling across a surface much bigger
   *  than the source image (ground, a tall pillar) — repeat counts are
   *  chosen per-use below, this just sets the shared bits every tiled
   *  texture in the scene needs (wrap mode + correct color-managed decode). */
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
        const [ground, stone, marble, pillar] = await Promise.all([
          textureLoader.loadAsync('./ground-texture.jpg'),
          textureLoader.loadAsync('./stone-texture.jpg'),
          textureLoader.loadAsync('./marble-stone-texture.jpg'),
          textureLoader.loadAsync('./pillar-texture.jpg'),
        ]);
        report(1);
        return { ground, stone, marble, pillar };
      },
    },
    { templates: 5, textures: 1 }, // GLBs are ~10-15MB each vs a few hundred KB per texture
  );
  loadingEl.remove();

  // Bake the "lie flat" rotation into the geometry itself (rather than the
  // Mesh's .rotation) so position.y below is already the up axis — displacing
  // it per-vertex with the same groundHeight() every entity/obstacle uses for
  // its own Y is what keeps everything sitting on the bumps instead of
  // floating above or clipping into them.
  const groundGeo = new THREE.PlaneGeometry(ARENA_HALF * 2.4, ARENA_HALF * 2.4, 60, 60);
  groundGeo.rotateX(-Math.PI / 2);
  const groundPos = groundGeo.attributes.position;
  for (let i = 0; i < groundPos.count; i++) {
    groundPos.setY(i, groundHeight(groundPos.getX(i), groundPos.getZ(i)));
  }
  groundGeo.computeVertexNormals();
  // One tile roughly every 6 world units, so the texture doesn't obviously
  // repeat within a single glance but also doesn't blur out at this scale.
  const groundMat = new THREE.MeshStandardMaterial({
    map: tileable(textures.ground, (ARENA_HALF * 2.4) / 6, (ARENA_HALF * 2.4) / 6),
    roughness: 1,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  scene.add(ground);

  // Obstacle meshes: rocks (DodecahedronGeometry, a plain built-in three.js
  // primitive standing in for a boulder — no rock asset on hand) alternate
  // between the two stone textures for a bit of variety across the field;
  // pillars (CylinderGeometry) get the dedicated pillar texture. Geometry is
  // shared per type (only scale/rotation/position differ per instance) —
  // materials aren't, since each needs its own texture repeat/rotation.
  // Every obstacle is sunk partway into the terrain (rather than placed
  // exactly on the surface) so an imperfect base-to-ground fit never shows
  // as a gap.
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
      scene.add(mesh);
    }
  }

  // --- Run stats, shown on the completion screen once the level is fully
  // cleared (necromancer dead and every skeleton it raised gone too — see
  // the 'died' handler's clear check). Timers are measured from here, not
  // from page load, so asset loading doesn't count against the player. ---
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
  // Every character mesh spawnStatic ever creates, tagged with which entity
  // it belongs to — the input to sweepOrphanedMeshes' unconditional cleanup,
  // see its own doc comment for why this exists on top of the normal
  // 'died'/interruptRitual removal paths.
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
  let necromancerFleeTimer = 0; // elapsed time this flee, set by the 'damage' handler below
  let necromancerFleeCoverTarget = null; // fixed obstacle to make for, picked once per flee — see the 'damage' handler
  let necromancerWanderTarget = null;
  let necromancerRitualTimer = 0;
  let ritualElapsed = 0;
  let ritualSpawnQueue = []; // seconds-from-ritual-start still to spawn, ascending
  let necromancerRitualsCompleted = 0; // counts only rituals that finished, not interrupted ones — see updateNecromancer
  let necromancerWantsToFireBolt = false; // queued by a ritual completion, fired the instant line of sight opens — see updateNecromancer
  const currentRitualSkeletons = []; // entities raised by the in-progress ritual, until they finish rising
  const sinkingSkeletons = []; // { mesh, elapsed, duration, startY } — interrupted mid-rise, see interruptRitual

  // --- Hovering health bars (skeletons only — the necromancer already has
  // its own HUD boss bar, and the player has the HP bar). A THREE.Sprite
  // always billboards to face the camera on its own, so unlike the
  // character mesh it's parented under, it doesn't need any manual
  // per-frame facing logic — just repositioning (see syncMeshes) and
  // repainting its canvas texture when hp actually changes (not every
  // frame). ---
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
  // lands but doesn't kill still reads as "that landed" instead of nothing
  // visibly happening. Needs its own material per instance (cloneMaterials
  // in spawnSkeleton) — every skeleton shares one material by default (see
  // normalizedInstance's doc), so tinting it directly would flash the whole
  // swarm at once instead of just the one hit. ---
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

  /** Raises one skeleton at the necromancer's *current* position (it
   *  wanders now, so this can't be the fixed NECROMANCER_POS anymore),
   *  buried SKELETON_RISE_DEPTH underground — the skeletonBehavior rise
   *  phase below animates it climbing out over SKELETON_RISE_DURATION.
   *  Returns the new entity, or undefined if already at MAX_SKELETONS. */
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
        homeX: pos.x, // wanders within SKELETON_WANDER_RADIUS of where it rose, not the whole arena
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

  // --- Skeleton AI: tick down its attack cooldown, update what it's aware of
  // (see the SKELETON_DETECT/VISION/LOSE_INTEREST comment up top), then act
  // on whichever of rise / chase / investigate / wander currently applies —
  // rise always wins (can't do anything else mid-emergence), the rest are
  // mutually exclusive via ctx.blackboard.state. Built from the engine's
  // behavior-tree primitives to actually exercise them, rather than one big
  // bespoke function. ---
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
          bb.state = 'wander'; // lost track of it — back to roaming, not still chasing a memory
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
          // Self-report completion the instant it happens, rather than
          // leaving interruptRitual to assume (from ritual-duration timing
          // margins alone) that anything still in currentRitualSkeletons by
          // the time the ritual ends must have finished. Keeps that array
          // an accurate "still pending" list regardless of tuning changes.
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
              if (ctx.blackboard.attackCooldown > 0) return 'success'; // still recovering, stand and wait
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
            bb.state = 'wander'; // arrived and found nothing, or gave up — either way, back to roaming
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
        // Cleared on arrival (a fresh target next tick reads as a brief idle
        // beat) or after SKELETON_WANDER_TARGET_TIMEOUT regardless — see its
        // comment for why the timeout matters as more than just a fallback.
        if (dist < 1 || bb.wanderTargetTimer >= SKELETON_WANDER_TARGET_TIMEOUT) bb.wanderTarget = null;
        return 'success';
      }),
    ),
  );

  function distanceTo(a, b) {
    const oa = transforms.slotOf(a) * transforms.stride;
    const ob = transforms.slotOf(b) * transforms.stride;
    const raw = transforms.raw;
    const dx = raw[oa] - raw[ob];
    const dz = raw[oa + 2] - raw[ob + 2];
    return Math.hypot(dx, dz);
  }

  /** Proximity alone (SKELETON_DETECT_RADIUS) always registers, sightline or
   *  not — something that close would be heard/sensed regardless. Farther
   *  out (up to SKELETON_VISION_RANGE), it only counts with a clear line of
   *  sight, same obstacle-blocking check the necromancer's flee AI uses. */
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

  /** Pulls any *wandering* (not already chasing or investigating something
   *  else) skeleton within SKELETON_ALERT_RADIUS of (x, z) into investigating
   *  that spot — called on an ally's death (see the 'died' handler) so a
   *  swarm reacts to losses even before any of them have personally spotted
   *  the player. Skeletons already chasing/investigating are left alone —
   *  stale secondhand info shouldn't pull them off a live one. */
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

  const steerOut = { x: 0, y: 0, z: 0 };
  /** Moves `e` toward (targetX, targetZ) at `speed`, blended with separation
   *  steering off neighbors and resolved against obstacles — the one
   *  movement primitive wander/investigate/chase all share, just with
   *  different targets and speeds. Returns the *pre-move* distance to the
   *  target, so a caller can cheaply check "did I just arrive". */
  function steerToward(e, targetX, targetZ, speed, dt) {
    const slot = transforms.slotOf(e);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const pz = raw[o + 2];

    let dx = targetX - px;
    let dz = targetZ - pz;
    const dist = Math.hypot(dx, dz) || 1e-6;
    dx /= dist;
    dz /= dist;

    separationCohesionSteer(spatialGrid, transforms, e, SEPARATION_RADIUS, { separation: 1.2, cohesion: 0 }, steerOut);

    const vx = dx + steerOut.x;
    const vz = dz + steerOut.z;
    const vlen = Math.hypot(vx, vz) || 1e-6;
    let nx = px + (vx / vlen) * speed * dt;
    let nz = pz + (vz / vlen) * speed * dt;
    ({ x: nx, z: nz } = resolveObstacles(nx, nz, SKELETON_RADIUS));
    nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 1, ARENA_HALF - 1);
    nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 1, ARENA_HALF - 1);

    transforms.add(e, nx, groundHeight(nx, nz), nz, ...quatArray(yawQuaternion(vx, vz)));
    return dist;
  }

  function quatArray(q) {
    return [q.x, q.y, q.z, q.w];
  }

  /** The necromancer faces the player continuously, in every state,
   *  independent of whichever way it's actually moving (backing away while
   *  still watching its target). Falls back to `fallback` (its current
   *  rotation) if the player can't be found or is essentially on top of it
   *  (a zero-length look vector would otherwise feed NaN into yawQuaternion)
   *  rather than snapping to some arbitrary direction. */
  function necromancerLookAtPlayer(nx, nz, fallback) {
    const pSlot = transforms.slotOf(playerEntity);
    if (pSlot === -1) return fallback;
    const po = pSlot * transforms.stride;
    const raw = transforms.raw;
    const dx = raw[po] - nx;
    const dz = raw[po + 2] - nz;
    if (dx * dx + dz * dz < 1e-6) return fallback;
    return quatArray(yawQuaternion(dx, dz));
  }

  world.addSystem(createAiSystem(ai));

  // --- Damage / death, via the event queue (mirrors the matching-game's
  // match:attempt pattern): a system or AI node just emits `damage`; this
  // handles the bookkeeping, and cascades into `died` within the same tick. ---
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
      // maxConcurrent well above the old default of 1 — a single splash hit
      // can land on several skeletons in the same tick, and deduping down
      // to one voice made everything past the first hit silent.
      sound.play(hitSfx, { volume: 0.35, id: 'hit', maxConcurrent: 8, queueTTL: 80 });
    }
    const bar = healthBars.get(ev.target);
    if (bar) updateHealthBarSprite(bar, Math.max(0, hp.hp / hp.max));
    if (hp.hp <= 0) {
      hp.hp = 0;
      w.events.emit({ type: 'died', entity: ev.target, kind });
    } else if (kind === 'necromancer') {
      // Starts fleeing toward the nearest obstacle at the moment it was hit
      // (actually seeking cover, not just retreating), blended each tick in
      // updateNecromancer with the *current* away-from-player direction —
      // recomputed live off the player's live position there, not fixed
      // here, so it keeps reacting if the player moves during the chase
      // instead of committing to whatever was true at this one instant. The
      // cover target itself does stay fixed for the flee's duration (picked
      // here, once) so it doesn't dither between obstacles of similar
      // distance. Overwrites any flee already in progress with a fresh one,
      // so a second hit mid-flee redirects/resets it. A hit mid-ritual
      // cancels it outright (see interruptRitual) rather than letting
      // already-summoned-but-still-rising skeletons finish.
      if (necromancerState === 'ritual') interruptRitual();
      necromancerState = 'fleeing';
      necromancerFleeTimer = 0; // now counts up — elapsed flee time, checked against NECROMANCER_FLEE_MAX_DURATION
      const ns = transforms.slotOf(ev.target) * transforms.stride;
      const raw = transforms.raw;
      // Ignores whatever it's already standing next to (see nearestObstacle's
      // minClearance) — getting hit while already hugging a rock should send
      // it running somewhere else, not "cover" behind the same rock it's
      // already at. Falls back to the unrestricted nearest if literally
      // nothing clears the threshold (a very obstacle-sparse spot).
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
      interruptRitual(); // sink+despawn anyone still mid-rise when its source was destroyed
      burst(pos, 0x9b59ff, 60);
      sound.play(deathSfx, { volume: 0.9, priority: 2 });
      showBanner('The Necromancer has fallen!', '#b892ff');
      w.despawn(ev.entity);
    } else if (ev.kind === 'player') {
      gameOver = true;
      burst(pos, 0x66ccff, 40);
      // A held, deliberately slow-fading-in vignette behind the death
      // screen — distinct from the brief per-hit flashDamage() pulse (that
      // one still clears itself on its own short timer; this one stays
      // until a restart, gated off that timer via deathVignetteActive so
      // the two don't fight over hitFlash's opacity).
      deathVignetteActive = true;
      hitFlash.style.transition = 'opacity 1.2s ease-out';
      hitFlash.style.opacity = '0.3';
      showBanner('You have fallen…', '#ff6666', 'Press R to try again');
      w.despawn(ev.entity);
    }

    // The level is "cleared" the moment both are true, whichever death (this
    // one or an earlier one) happens to be the one that makes it so — e.g.
    // mopping up the last skeleton after the necromancer's already dead, or
    // the reverse if it happened to die with none of its skeletons left.
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

  // A small centered reticle, mainly so aiming the now-arcing/lobbed spell
  // (and reading the trajectory preview against it) has a fixed reference
  // point on screen instead of just "wherever the camera happens to point".
  const reticle = document.createElement('div');
  reticle.style.cssText =
    'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9999; ' +
    'width: 6px; height: 6px; border-radius: 50%; background: rgba(255,255,255,0.75); ' +
    'box-shadow: 0 0 3px rgba(0,0,0,0.8); pointer-events: none;';
  document.body.appendChild(reticle);

  // Charge meter — hidden except while a press-and-hold cast is charging
  // (see updateChargeVisuals). Sits just above the reticle so it reads as
  // "this is what that hold is building toward."
  const chargeBarWrap = document.createElement('div');
  chargeBarWrap.style.cssText =
    'position: fixed; top: calc(50% - 22px); left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'width: 120px; height: 6px; border-radius: 3px; background: rgba(0,0,0,0.5); overflow: hidden; ' +
    'display: none; pointer-events: none;';
  const chargeBarFill = document.createElement('div');
  chargeBarFill.style.cssText = 'width: 0%; height: 100%; background: #cf9bff;';
  chargeBarWrap.appendChild(chargeBarFill);
  document.body.appendChild(chargeBarWrap);

  // Discoverability for the controls — nothing else on screen tells the
  // player how to move/cast, and the two schemes are quite different.
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

  // --- Completion screen: shown once the level is fully cleared (see the
  // 'died' handler's shared clear-check), same "freeze the sim, press R to
  // restart" shape as the death screen, plus a stat line summary of the run. ---
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

  // Only a hard page reload actually resets things here — spawned meshes,
  // Rapier-free but still-live timers/AI state, HUD DOM, etc. would all need
  // individual teardown otherwise, and this example has no "menu" state to
  // return to anyway.
  addEventListener('keydown', (e) => {
    if ((gameOver || levelComplete) && e.code === 'KeyR') location.reload();
  });

  const hitFlash = document.createElement('div');
  hitFlash.style.cssText =
    'position: fixed; inset: 0; z-index: 9998; background: #ff0000; opacity: 0; pointer-events: none; transition: opacity 60ms;';
  document.body.appendChild(hitFlash);
  let flashTimer = 0;
  let deathVignetteActive = false; // true once the player dies — see the 'died' handler; keeps the countdown below from clearing its opacity
  function flashDamage() {
    if (deathVignetteActive) return; // don't stomp the held death vignette with a brief per-hit pulse
    hitFlash.style.opacity = '0.25';
    flashTimer = 0.12;
  }

  // --- Camera + character rotation: a hand-rolled chase cam instead of
  // OrbitControls, because OrbitControls only ever turns the *camera* around
  // a fixed target while dragging — it has no idea a "player" exists, so it
  // can't also turn the character, and requires a button held the whole
  // time. Here `camYaw`/`camPitch` are the single source of truth for both:
  // the camera orbits the player at that yaw/pitch, and the player's own
  // facing is set to `camYaw` directly every frame, so looking around *is*
  // turning the character (the way most third-person shooters work) rather
  // than something the character does independently on its own schedule.
  //
  // Desktop: click the canvas to acquire the Pointer Lock API — once locked,
  // every mouse move (not just while a button is held) rotates the camera,
  // and a plain click casts the spell. Touch: dragging anywhere but the
  // joystick rotates the camera directly (no lock concept on touchscreens);
  // a short drag-free tap casts instead.
  let camYaw = Math.atan2(-(NECROMANCER_POS.z - PLAYER_START.z), NECROMANCER_POS.x - PLAYER_START.x);
  // Closer to the player's own eye line by default (low pitch, short
  // distance) rather than the far-overhead angle a bigger camDistance/pitch
  // would give — reads as an over-the-shoulder shooter cam, which also
  // makes the trajectory preview/reticle actually line up with where the
  // camera is looking instead of a bird's-eye view floating well above it.
  let camPitch = 0.22;
  let camDistance = 5.5;

  // top: 52px, below the boss health bar (top: 16px + its own ~34px height),
  // so the two never overlap.
  const lookPrompt = document.createElement('div');
  lookPrompt.style.cssText =
    'position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'font: 12px/1.4 monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 4px 10px; ' +
    'border-radius: 4px; pointer-events: none;';
  lookPrompt.textContent = isTouch ? 'Drag to look · tap to cast' : 'Click to look around';
  document.body.appendChild(lookPrompt);

  gl.domElement.style.touchAction = 'none'; // otherwise touch-drag scrolls/zooms the page instead of looking

  if (!isTouch) {
    // pointerdown/up (not 'click') so a press-and-hold actually spans the
    // whole gesture: the first press (unlocked) only acquires the lock and
    // fires nothing; every press after that starts a charge, and release —
    // wherever the mouse ends up, even off the canvas — fires it. Listening
    // on window for pointerup (not gl.domElement) is what makes "release
    // after the cursor left the canvas" still register instead of stranding
    // the charge active forever.
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
      // CAM_MIN_PITCH is the near-horizontal end (camera low, close behind
      // the player) and CAM_MAX_PITCH the overhead end (camera high, looking
      // steeply down) — moving the mouse up should swing toward the former
      // (the camera "looks up" relative to its overhead extreme), hence +,
      // not -, since movementY is negative for an upward mouse move.
      camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * MOUSE_LOOK_SENSITIVITY, CAM_MIN_PITCH, CAM_MAX_PITCH);
    });
    gl.domElement.addEventListener('wheel', (e) => {
      camDistance = THREE.MathUtils.clamp(camDistance + e.deltaY * 0.01, CAM_MIN_DISTANCE, CAM_MAX_DISTANCE);
    });
  }

  // --- Touch: virtual joystick (movement) + drag-to-look/tap-to-cast on the
  // rest of the screen. Two independent pointers, tracked by id so a thumb
  // on the joystick doesn't fight a thumb looking around. ---
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
    const updateJoystick = (e) => {
      const rect = joyBase.getBoundingClientRect();
      let dx = e.clientX - (rect.left + rect.width / 2);
      let dy = e.clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist > JOYSTICK_RADIUS) {
        dx = (dx / dist) * JOYSTICK_RADIUS;
        dy = (dy / dist) * JOYSTICK_RADIUS;
      }
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
      joyVec.strafe = dx / JOYSTICK_RADIUS;
      joyVec.forward = -dy / JOYSTICK_RADIUS; // stick pushed up (screen -Y) = forward
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

    // Look + charge: any drag on the canvas itself (the joystick is a
    // separate, higher element, so pointer events there never reach this
    // listener). The hold IS the charge — pressing down starts it, dragging
    // to aim while held doesn't cancel it, and lifting fires at whatever
    // charge accumulated, same "press and hold" gesture as a quick tap
    // (which just fires at ~0 charge).
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
      // Same sign convention as the desktop mousemove handler above — see its comment.
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
        charging = false; // interrupted gesture (e.g. an OS gesture took over) — don't fire
      }
    });
  }

  /** Orbits the camera around the player at (camDistance, camYaw, camPitch)
   *  and points it at the player's eye height — called once per rendered
   *  frame, independent of the fixed-step sim rate, so looking around stays
   *  smooth even when several sim steps (or zero) run in a given frame. */
  function updateCamera() {
    const slot = transforms.slotOf(playerEntity);
    if (slot === -1) return; // despawned on death (see the 'died' handler) — freeze the last camera pose

    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const py = raw[o + 1]; // the player's own Y already tracks groundHeight(px, pz) — see movePlayer
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
  const playerFacing = new THREE.Quaternion();
  const forwardVec = new THREE.Vector3();
  const rightVec = new THREE.Vector3();
  const moveVec = new THREE.Vector3();

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

    // Clamp to unit length rather than always normalizing — a partially
    // pushed joystick should move slower, not snap to full speed.
    const moveLen = moveVec.length();
    if (moveLen > 1e-6) {
      const scale = Math.min(moveLen, 1) / moveLen;
      px += moveVec.x * scale * PLAYER_SPEED * dt;
      pz += moveVec.z * scale * PLAYER_SPEED * dt;
      ({ x: px, z: pz } = resolveObstacles(px, pz, PLAYER_RADIUS));
      px = THREE.MathUtils.clamp(px, -ARENA_HALF + 1, ARENA_HALF - 1);
      pz = THREE.MathUtils.clamp(pz, -ARENA_HALF + 1, ARENA_HALF - 1);
    }

    // The character always faces the way the camera looks (see the class
    // comment above `camYaw`) — movement is a strafe relative to that, not
    // something that turns the character on its own.
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

  // --- Spell bolts: a handful of short-lived, non-entity projectiles (same
  // reasoning as ParticleSystem — too churny/low-identity to justify a full
  // Entity/TransformStore row each). Collision uses the same SpatialGrid the
  // AI queries, rebuilt fresh by world.step() each tick. ---
  const bolts = [];
  // A unit sphere, scaled per-bolt at creation to that shot's charge-scaled
  // radius (see castSpell) — geometry itself never changes after that, so
  // one shared instance is enough regardless of how many different sizes are
  // in flight at once.
  const boltGeo = new THREE.SphereGeometry(1, 12, 10);
  const boltColorMin = new THREE.Color(0x8a5bff); // dim, cheap tap
  const boltColorMax = new THREE.Color(0xf0e6ff); // bright near-white, full charge

  /** Fires the spell at `chargeFraction` (0..1, from how long cast was held
   *  — see startCharge/releaseCharge). Cost/damage/radius all scale with it;
   *  launch speed/arc don't (see the SPELL_MIN/MAX_* comment up top). */
  function castSpell(chargeFraction) {
    // Guards against the desktop pointerdown / touch release handlers below,
    // which aren't gated on gameOver the way the fixed-step input check is
    // — without this, a post-death release would read the despawned
    // player's (now invalid) transform slot.
    if (gameOver || levelComplete) return;

    const cost = THREE.MathUtils.lerp(SPELL_MIN_COST, SPELL_MAX_COST, chargeFraction);
    if (mana < SPELL_MIN_COST) return; // not even enough for the cheapest possible shot — fizzle silently
    // A charge the player can't fully afford still fires, just scaled back
    // to whatever mana actually covers, rather than doing nothing after a
    // hold — spend-what-you-have instead of all-or-nothing.
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
    // Local +X is this model's authored forward axis (see yawQuaternion's doc).
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(playerFacing).normalize();

    // Vertical look sets the launch angle, like winding up a catapult: aim
    // the camera up for a steep, high lob, or down for a flatter, more
    // direct shot. camPitch itself runs the opposite way (it's the camera's
    // orbit elevation, which *increases* toward its overhead/looking-down
    // extreme — see the mousemove handler's comment), so the launch angle
    // mirrors it around the same [CAM_MIN_PITCH, CAM_MAX_PITCH] range.
    // Charge sets both how hard it's thrown (speed — farther/faster the
    // longer it was held) and, via gravityScale, how heavily it's pulled
    // back down — a bigger charge is a bigger mass of energy, not just a
    // faster-moving copy of a small one. Both combine with launchAngle to
    // decide the actual arc/range; there's no fixed baseline either sums to.
    const launchAngle = CAM_MIN_PITCH + CAM_MAX_PITCH - camPitch;
    const speed = THREE.MathUtils.lerp(SPELL_MIN_SPEED, SPELL_MAX_SPEED, actualFraction);
    const gravityScale = THREE.MathUtils.lerp(SPELL_MIN_GRAVITY_SCALE, SPELL_MAX_GRAVITY_SCALE, actualFraction);
    const speedH = speed * Math.cos(launchAngle);
    const speedV = speed * Math.sin(launchAngle);

    const mesh = new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({ color: boltColorMin.clone().lerp(boltColorMax, actualFraction) }));
    mesh.scale.setScalar(radius * 1.4); // a bit bigger than the hit-test radius, so it reads clearly at a glance
    const glow = new THREE.PointLight(0xb87fff, 2 + actualFraction * 3, 6 + actualFraction * 4);
    mesh.add(glow);
    // Spawn a little ahead of the player's own body (not inside it) and
    // waist-high, so the bolt is visible leaving the caster instead of
    // popping into view a moment later from inside the wizard mesh.
    const originX = raw[o] + dir.x * 0.8;
    const originZ = raw[o + 2] + dir.z * 0.8;
    const originY = raw[o + 1] + 1.1;
    mesh.position.set(originX, originY, originZ);
    scene.add(mesh);

    bolts.push({
      mesh,
      x: originX,
      y: originY,
      z: originZ,
      vx: dir.x * speedH,
      vy: speedV,
      vz: dir.z * speedH,
      gravity: GRAVITY * gravityScale,
      originX,
      originZ,
      fraction: actualFraction,
      splashRadius,
      splashDamage,
      damage,
      radius,
    });
    sound.play(castSfx, { volume: 0.4 + actualFraction * 0.4, priority: 1 });
  }

  // --- Press-and-hold charge state machine: startCharge()/releaseCharge()
  // are the only entry points every input scheme (keyboard Space, desktop
  // pointer-lock click, touch hold) drives — see the input wiring above and
  // the charge-visuals update in the main loop below. ---
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

  // A small glowing orb that grows at the caster's hand while charging, plus
  // a semi-transparent line tracing where a shot fired *right now* would
  // land — both driven by the current aim (camPitch/playerFacing), not by
  // how much charge has built up yet, since charge only scales power, not
  // trajectory (see the SPELL_MIN/MAX_* comment up top). Neither is a
  // TweenRunner animation or an entity — just plain THREE objects toggled
  // visible/invisible and repositioned every rendered frame.
  const chargeOrb = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xcf9bff, transparent: true, opacity: 0.85 }),
  );
  const chargeGlow = new THREE.PointLight(0xb87fff, 0, 6);
  chargeOrb.add(chargeGlow);
  chargeOrb.visible = false;
  scene.add(chargeOrb);

  const TRAJECTORY_SAMPLES = 26;
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

  /** Called once per rendered frame (see the main loop) — updates the charge
   *  orb, the trajectory preview line, and the HUD charge bar together, all
   *  off the same `charging`/`chargeStartTime` state. */
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
    if (slot === -1) return; // despawned mid-charge (died while holding) — nothing left to aim from
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(playerFacing);
    const originX = raw[o] + dir.x * 0.8;
    const originZ = raw[o + 2] + dir.z * 0.8;
    const originY = raw[o + 1] + 1.1;

    chargeOrb.visible = true;
    chargeOrb.position.set(originX, originY, originZ);
    chargeOrb.scale.setScalar(THREE.MathUtils.lerp(0.18, 0.42, fraction));
    chargeGlow.intensity = THREE.MathUtils.lerp(0.4, 3, fraction);

    // Same launch-angle/speed/gravity mapping as castSpell would use if
    // released right now — see its comment — so the preview actually
    // reflects where *this* shot, at its current charge, would land, and
    // visibly stretches/sags further as the hold continues.
    const launchAngle = CAM_MIN_PITCH + CAM_MAX_PITCH - camPitch;
    const speed = THREE.MathUtils.lerp(SPELL_MIN_SPEED, SPELL_MAX_SPEED, fraction);
    const gravity = GRAVITY * THREE.MathUtils.lerp(SPELL_MIN_GRAVITY_SCALE, SPELL_MAX_GRAVITY_SCALE, fraction);
    const speedH = speed * Math.cos(launchAngle);
    const speedV = speed * Math.sin(launchAngle);

    trajectoryLine.visible = true;
    let x = originX;
    let y = originY;
    let z = originZ;
    let vx = dir.x * speedH;
    let vy = speedV;
    let vz = dir.z * speedH;
    let count = 0;
    for (let i = 0; i < TRAJECTORY_SAMPLES; i++) {
      trajectoryPositions[count * 3] = x;
      trajectoryPositions[count * 3 + 1] = y;
      trajectoryPositions[count * 3 + 2] = z;
      count++;
      vy += gravity * TRAJECTORY_DT;
      x += vx * TRAJECTORY_DT;
      y += vy * TRAJECTORY_DT;
      z += vz * TRAJECTORY_DT;
      const groundY = groundHeight(x, z);
      if (y <= groundY || Math.hypot(x - originX, z - originZ) > SPELL_MAX_RANGE) {
        trajectoryPositions[count * 3] = x;
        trajectoryPositions[count * 3 + 1] = Math.max(y, groundY);
        trajectoryPositions[count * 3 + 2] = z;
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
      b.vy += b.gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.mesh.position.set(b.x, b.y, b.z);

      // Ends the shot this tick — either dug into the terrain (arced back
      // down) or flew far enough out that it's forced down regardless, so a
      // very flat/fast shot can't sail on forever waiting for gravity to
      // eventually win.
      let impact = null;
      const groundY = groundHeight(b.x, b.z);
      if (b.y <= groundY) impact = { x: b.x, y: groundY, z: b.z };
      else if (Math.hypot(b.x - b.originX, b.z - b.originZ) > SPELL_MAX_RANGE) impact = { x: b.x, y: b.y, z: b.z };

      if (!impact) {
        for (let oi = 0; oi < OBSTACLES.length; oi++) {
          const ob = OBSTACLES[oi];
          const dx = b.x - ob.x;
          const dz = b.z - ob.z;
          const minDist = ob.radius + b.radius;
          if (dx * dx + dz * dz <= minDist * minDist && b.y <= groundHeight(ob.x, ob.z) + ob.height) {
            impact = { x: b.x, y: b.y, z: b.z };
            break;
          }
        }
      }

      let hitEntity;
      if (!impact) {
        // Generous query radius (has to cover the tallest target's full
        // height above its ground point, not just b.radius) — narrowed to an
        // actual hit by the horizontal + vertical-band check below, so a
        // bolt still high in its arc passes over someone instead of
        // "hitting" them from several units up.
        const nearby = spatialGrid.queryRadius(transforms, b.x, b.y, b.z, b.radius + 2.6);
        for (let n = 0; n < nearby.length; n++) {
          const cand = nearby[n];
          const k = kinds.get(cand);
          if (k !== 'skeleton' && k !== 'necromancer') continue;
          const cs = transforms.slotOf(cand) * transforms.stride;
          const raw = transforms.raw;
          const horiz = Math.hypot(raw[cs] - b.x, raw[cs + 2] - b.z);
          if (horiz > b.radius + 0.8) continue;
          const targetHeight = k === 'necromancer' ? 2.1 : 1.7;
          if (b.y < raw[cs + 1] - 0.1 || b.y > raw[cs + 1] + targetHeight) continue;
          hitEntity = cand;
          break;
        }
      }

      if (hitEntity !== undefined) {
        world.events.emit({ type: 'damage', target: hitEntity, amount: b.damage });
        flashHit(hitEntity);
        const splashDamage = applySplash(b.x, b.z, b.splashRadius, b.splashDamage, hitEntity);
        stats.directHits++;
        stats.mostDamageSingleShot = Math.max(stats.mostDamageSingleShot, b.damage + splashDamage);
        burst({ x: b.x, y: b.y, z: b.z }, 0x8a5bff, Math.round(THREE.MathUtils.lerp(10, 36, b.fraction)));
        spawnSplashRing({ x: b.x, y: b.y, z: b.z }, b.splashRadius);
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

  /** Area damage around an impact point (horizontal-only distance — a
   *  ground-hugging blast, not a sphere), falling off linearly to 0 at
   *  `radius`. `exclude` is the entity that already took a direct hit this
   *  same impact, if any, so it doesn't also get splashed on top of that.
   *  Returns the total amount actually applied, for stats.mostDamageSingleShot. */
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
      const dist = Math.hypot(raw[cs] - x, raw[cs + 2] - z);
      if (dist > radius) continue;
      // Curved, not linear, falloff (pow 0.6) — keeps damage meaningfully
      // high through most of the radius and only drops off sharply right at
      // the edge, so a splash reads as "everyone nearby got hit hard," not
      // "only the exact center did."
      const amount = damage * Math.pow(1 - dist / radius, 0.6);
      if (amount < 0.5) continue;
      world.events.emit({ type: 'damage', target: cand, amount });
      flashHit(cand);
      total += amount;
    }
    return total;
  }

  // --- Splash rings: a quick expanding, fading ring of "energy" at an
  // impact point, tracing the actual splash-damage radius rather than just
  // an arbitrary decorative flourish. Plain array + per-frame update, same
  // churny-non-entity reasoning as ParticleSystem/bolts — each ring gets its
  // own cloned material purely so its opacity can fade independently of
  // every other ring currently animating. ---
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

  // --- Bone shards: skeleton.glb is a single merged mesh (one node, one
  // primitive, no skin/bones — checked directly against the file), so there
  // are no actual limb pieces to fly apart on death. This fakes a shatter
  // instead, the same "plausible placeholder geometry" approach already used
  // for the rock/pillar obstacles: a handful of tumbling debris (bone tint)
  // flung outward and down, not a real fracture of the 143k-vertex mesh.
  // Mostly long slender "bone" cylinders — the shape that actually reads as
  // a skeleton breaking apart — with a minority of small chunks mixed in for
  // variety, rather than every piece being identically stick-shaped. Same
  // plain-array-of-plain-objects reasoning as splashRings/bolts. ---
  const boneShards = [];
  const boneStickGeo = new THREE.CylinderGeometry(1, 1, 1, 6); // unit cylinder — scale.set(radius, length, radius) per instance
  const boneChunkGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const boneShardMat = new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.9 });

  function spawnBoneShards(pos, count = 7) {
    for (let i = 0; i < count; i++) {
      const isStick = Math.random() < 0.7; // mostly long bones, a few chunkier bits
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
      const phi = Math.acos(Math.random() * 0.7); // biased outward/upward, not straight down through the floor
      const speed = 2.5 + Math.random() * 3.5;
      boneShards.push({
        mesh,
        vx: Math.sin(phi) * Math.cos(theta) * speed,
        vy: Math.cos(phi) * speed + 1.5,
        vz: Math.sin(phi) * Math.sin(theta) * speed,
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
      s.vy += GRAVITY * 0.4 * dt; // lighter fall than a spell bolt — small debris, not a lead weight
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
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
  // position at the moment it's cast (not homing — a real, dodgeable
  // straight line, same "visible tell, can be sidestepped" shape as the
  // player's spell), fired every NECROMANCER_RITUALS_PER_SPELL-th completed
  // ritual (see updateNecromancer). Same non-entity churny-projectile
  // reasoning as the player's bolts array. ---
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

    const originX = raw[no];
    const originY = raw[no + 1] + 1.8; // roughly staff/head height
    const originZ = raw[no + 2];
    const dx = raw[po] - originX;
    const dy = raw[po + 1] + 1.1 - originY; // aimed at the player's torso, not their feet
    const dz = raw[po + 2] - originZ;
    const dist = Math.hypot(dx, dy, dz) || 1e-6;

    const mesh = new THREE.Mesh(necromancerBoltGeo, necromancerBoltMat);
    const glow = new THREE.PointLight(0x33ff88, 2.5, 6);
    mesh.add(glow);
    mesh.position.set(originX, originY, originZ);
    scene.add(mesh);

    necromancerBolts.push({
      mesh,
      x: originX,
      y: originY,
      z: originZ,
      vx: (dx / dist) * NECROMANCER_BOLT_SPEED,
      vy: (dy / dist) * NECROMANCER_BOLT_SPEED,
      vz: (dz / dist) * NECROMANCER_BOLT_SPEED,
      traveled: 0,
    });
    sound.play(necroCastSfx, { volume: 0.6, priority: 1 });
  }

  function updateNecromancerBolts(dt) {
    for (let i = necromancerBolts.length - 1; i >= 0; i--) {
      const b = necromancerBolts[i];
      const step = NECROMANCER_BOLT_SPEED * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      b.traveled += step;
      b.mesh.position.set(b.x, b.y, b.z);

      let hit = false;
      const pSlot = transforms.slotOf(playerEntity);
      if (pSlot !== -1) {
        const po = pSlot * transforms.stride;
        const raw = transforms.raw;
        const dist = Math.hypot(raw[po] - b.x, raw[po + 1] + 1.1 - b.y, raw[po + 2] - b.z);
        hit = dist <= NECROMANCER_BOLT_HIT_RADIUS;
      }

      if (hit) {
        world.events.emit({ type: 'damage', target: playerEntity, amount: NECROMANCER_BOLT_DAMAGE });
        stats.necromancerBoltsHit++;
        burst({ x: b.x, y: b.y, z: b.z }, 0x33ff88, 10);
        scene.remove(b.mesh);
        necromancerBolts.splice(i, 1);
      } else if (b.traveled >= NECROMANCER_BOLT_MAX_RANGE) {
        scene.remove(b.mesh);
        necromancerBolts.splice(i, 1);
      }
    }
  }

  // --- Necromancer state machine: plain game-loop state, not an ECS system
  // or behavior tree — it only ever drives one entity and touches counters
  // plus the spawn helper, nothing generic enough to justify either. ---
  let spawnTimer = 1.5; // first wave arrives quickly

  /** A handful of tries at a random point at least NECROMANCER_MIN_DISTANCE
   *  from the player, so a fresh wander target doesn't just walk it straight
   *  back into close range — falls back to whichever candidate ended up
   *  farthest if none clear the threshold (a small/cornered arena position),
   *  rather than looping indefinitely. */
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
      const dist = Math.hypot(candidate.x - px, candidate.z - pz);
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

  /** Cancels the in-progress ritual: any skeleton it already raised that
   *  hasn't finished climbing out of the ground yet sinks back down and is
   *  despawned (a completed rise, riseTimer <= 0, is already independent and
   *  unaffected — only the interrupted-mid-animation ones are pulled). */
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

  function moveNecromancerWander(dt) {
    if (!necromancerWanderTarget) pickNecromancerWanderTarget();
    const slot = transforms.slotOf(necromancerEntity);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const px = raw[o];
    const pz = raw[o + 2];

    // The player closing distance always overrides the wander target — it
    // never gets to just stroll toward wherever it was already headed while
    // the player is right there. Once it's backed off, force a fresh target
    // (pickNecromancerWanderTarget already biases away from the player) so
    // it doesn't immediately walk straight back the moment this check clears.
    let dx;
    let dz;
    const pSlot = transforms.slotOf(playerEntity);
    if (pSlot !== -1) {
      const po = pSlot * transforms.stride;
      const toPlayerX = raw[po] - px;
      const toPlayerZ = raw[po + 2] - pz;
      const distToPlayer = Math.hypot(toPlayerX, toPlayerZ) || 1e-6;
      if (distToPlayer < NECROMANCER_MIN_DISTANCE) {
        dx = -toPlayerX / distToPlayer;
        dz = -toPlayerZ / distToPlayer;
        necromancerWanderTarget = null;
      }
    }

    if (dx === undefined) {
      let tx = necromancerWanderTarget.x - px;
      let tz = necromancerWanderTarget.z - pz;
      const dist = Math.hypot(tx, tz);
      if (dist < 1.5) {
        pickNecromancerWanderTarget();
        return;
      }
      dx = tx / dist;
      dz = tz / dist;
    }

    let nx = px + dx * NECROMANCER_WANDER_SPEED * dt;
    let nz = pz + dz * NECROMANCER_WANDER_SPEED * dt;
    ({ x: nx, z: nz } = resolveObstacles(nx, nz, NECROMANCER_RADIUS));
    nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 2, ARENA_HALF - 2);
    nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 2, ARENA_HALF - 2);
    const facing = necromancerLookAtPlayer(nx, nz, [raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]]);
    transforms.add(necromancerEntity, nx, groundHeight(nx, nz), nz, ...facing);
  }

  function updateNecromancer(dt) {
    if (!necromancerAlive) return;

    // A queued bolt (see the ritual branch below) fires the instant a clear
    // shot opens up, whichever tick that turns out to be — checked here
    // rather than only at the moment the ritual ends, since it can take
    // wandering/fleeing around obstacles for a while before line of sight
    // actually lines up. Not checked mid-ritual: it's standing still
    // concentrating on the raising, not also lining up a shot.
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
      // elapsed time *this* flee — always measured from the most recent
      // hit, never the first: the 'damage' handler resets this to 0 on
      // every hit, so a hit at 1.8s into an existing flee restarts the
      // clock rather than topping up whatever was left.
      necromancerFleeTimer += dt;
      const slot = transforms.slotOf(necromancerEntity);
      const o = slot * transforms.stride;
      const raw = transforms.raw;

      // Away-from-player is recomputed here every tick from the player's
      // *current* position — not a direction frozen at hit-time — so it
      // keeps adjusting if the player moves during the flee instead of
      // committing to whatever was true the instant it got hit. Blended
      // with the direction toward the fixed cover target (picked once, in
      // the 'damage' handler) so it's generally still making for the same
      // patch of cover rather than beelining straight away in the open.
      let dirX = 0;
      let dirZ = 0;
      const pSlotForDir = transforms.slotOf(playerEntity);
      if (pSlotForDir !== -1) {
        const po = pSlotForDir * transforms.stride;
        const toPlayerX = raw[po] - raw[o];
        const toPlayerZ = raw[po + 2] - raw[o + 2];
        const toPlayerLen = Math.hypot(toPlayerX, toPlayerZ) || 1e-6;
        dirX = -toPlayerX / toPlayerLen;
        dirZ = -toPlayerZ / toPlayerLen;
      }
      if (necromancerFleeCoverTarget) {
        let cx = necromancerFleeCoverTarget.x - raw[o];
        let cz = necromancerFleeCoverTarget.z - raw[o + 2];
        const clen = Math.hypot(cx, cz) || 1e-6;
        cx /= clen;
        cz /= clen;
        const blendX = dirX * 0.3 + cx * 0.7;
        const blendZ = dirZ * 0.3 + cz * 0.7;
        const blend = Math.hypot(blendX, blendZ) || 1e-6;
        dirX = blendX / blend;
        dirZ = blendZ / blend;
      }

      let nx = raw[o] + dirX * NECROMANCER_FLEE_SPEED * dt;
      let nz = raw[o + 2] + dirZ * NECROMANCER_FLEE_SPEED * dt;
      ({ x: nx, z: nz } = resolveObstacles(nx, nz, NECROMANCER_RADIUS));
      nx = THREE.MathUtils.clamp(nx, -ARENA_HALF + 2, ARENA_HALF - 2);
      nz = THREE.MathUtils.clamp(nz, -ARENA_HALF + 2, ARENA_HALF - 2);
      // Faces the direction it's fleeing, not the player, unlike every other
      // state — it's running, not watching over its shoulder.
      transforms.add(necromancerEntity, nx, groundHeight(nx, nz), nz, ...quatArray(yawQuaternion(dirX, dirZ)));

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
      // Stands still — see the class comment above NECROMANCER_MAX_HP — while
      // its skeletons rise on a staggered schedule (spawnSkeleton itself
      // reads the necromancer's current position, so this works from
      // wherever it happened to be standing when the ritual started). Still
      // faces the player throughout, same as every other state.
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
        currentRitualSkeletons.length = 0; // whatever's left in here finished rising on its own
        necromancerState = 'wandering';
        spawnTimer = NECROMANCER_SPAWN_INTERVAL;
        pickNecromancerWanderTarget();
        // Only a ritual that actually finished counts — one cut short by
        // interruptRitual (the player fighting back mid-raise) shouldn't
        // still build toward the attack it's being interrupted to prevent.
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

  /** Unconditional cleanup pass: removes any spawnStatic-created mesh that's
   *  no longer the current mesh of a live entity — i.e. anything visible in
   *  the scene that none of the engine's own entity/ai/healthbar counts (see
   *  DebugOverlay) actually account for. Every normal despawn path already
   *  removes its own mesh (the 'died' handler, interruptRitual's sink), so
   *  in the common case this finds nothing and is a cheap no-op; it exists
   *  as a backstop against the specific "a mesh visibly outlives its entity"
   *  failure mode — whatever exact sequence causes that, this guarantees it
   *  can't persist past one frame instead of needing that sequence found and
   *  fixed precisely. A mesh mid-interruptRitual sink is deliberately still
   *  owned by nothing (its entity is already despawned) but isn't an orphan
   *  — it's excluded via the sinkingSkeletons check below. */
  function sweepOrphanedMeshes() {
    for (const obj of spawnedCharacterMeshes) {
      const e = obj.userData.ownerEntity;
      if (meshes.get(e) === obj) continue; // still the live mesh for a live entity
      if (sinkingSkeletons.some((s) => s.mesh === obj)) continue; // mid its own intentional removal animation
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
        world.step(fixedDt); // rebuilds the spatial grid, ticks skeleton AI, drains damage/death events
        updateBolts(fixedDt);
        updateNecromancer(fixedDt);
        updateNecromancerBolts(fixedDt);
      });
    }

    // Purely decorative — particles, splash rings, sinking/interrupted
    // skeletons, bone shards, the damage-taken screen flash — keep animating
    // every rendered frame regardless of gameOver/levelComplete, using real
    // dt rather than fixed dt (nothing here feeds back into gameplay, so
    // fixed-timestep determinism doesn't matter for it). Gating these the
    // same as the sim meant anything mid-animation at the exact moment the
    // game ended — most visibly the player's own death burst — froze
    // permanently instead of finishing: a handful of light-blue particles
    // stuck hanging in the air a few inches from the death spot, having
    // gotten exactly one fixed step of motion before the freeze.
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
