/**
 * Matching-game skeleton — shows how the pieces compose. This is a starting
 * point, not a finished game: it spawns a pile of typed items, drops them with
 * physics, renders them as instances, and wires up mouse-orbit camera control,
 * click-first-item-then-second-item matching, a score counter, and a debug
 * overlay.
 *
 * Runs straight in a browser via <script type="module">, no bundler: three
 * comes from the same CDN URL dist/speck.js was built against (so both
 * resolve to one module instance), and the engine comes from the built
 * dist/speck.js, not the TS source — this is what consuming the package for
 * real looks like. Run `npm run build` first, then serve this folder
 * statically (e.g. `npx serve examples`) and open matching-game.html.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/controls/OrbitControls.js';
// Same URL dist/speck.js resolves "@dimforge/rapier3d-compat" to internally
// (see vite.config.ts), so this is one shared module instance, not a second
// load — imported here only for the RigidBodyType enum.
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';
import {
  World,
  TransformStore,
  ArrayComponentStore,
  InstancedRenderer,
  PhysicsSystem,
  DebugOverlay,
  TweenRunner,
  FixedStep,
  SoundSystem,
  ParticleSystem,
  InputBuffer,
  Preloader,
} from '../../dist/speck.js';

/** Synthesizes a short two-tone chime, so the match cue needs no audio asset
 *  or CDN fetch — just an exponentially-decaying sum of two sine waves. */
function createChimeBuffer(context) {
  const duration = 0.35;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const freqs = [1320, 1980]; // a fifth apart, reads as a bright "ding"
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const envelope = Math.exp(-8 * t);
    let sample = 0;
    for (const f of freqs) sample += Math.sin(2 * Math.PI * f * t);
    data[i] = (sample / freqs.length) * envelope;
  }
  return buffer;
}

/** A short, soft low "tock" — deliberately distinct from the chime above, and
 *  quiet/brief, since with thousands of bodies this is going to fire a lot. */
function createNudgeBuffer(context) {
  const duration = 0.08;
  const length = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    const t = i / context.sampleRate;
    const envelope = Math.exp(-40 * t);
    data[i] = Math.sin(2 * Math.PI * 220 * t) * envelope;
  }
  return buffer;
}

/**
 * The 6 corner points of a wedge/plow shape: a triangular prism pivoting at
 * local origin and extending `length` outward along +X, `width` across Z,
 * `height` tall at its back. Cross-section (constant along X) is a right
 * triangle — flat on the ground the whole way, a vertical back wall, and a
 * sloped ramp connecting the two. That shape is *why* items get carried up
 * and over rather than jammed: the leading edge that actually meets an item
 * first is a thin, ground-level line (the ramp's low corner), never a flat
 * vertical face for something to wedge stuck against. Returned as a flat
 * [x,y,z, x,y,z, ...] array so the same points serve both the visual mesh
 * (`createWedgeGeometry`) and the physics collider (`RAPIER.ColliderDesc
 * .convexHull`) — one source of truth for the shape, so they can't drift
 * apart into a visual that doesn't match what's actually solid.
 */
function createWedgePoints(length, width, height) {
  const hw = width / 2;
  return [
    0, 0, hw, // v0: pivot end, leading bottom (the thin edge that meets items first)
    0, 0, -hw, // v1: pivot end, trailing bottom
    0, height, -hw, // v2: pivot end, trailing top
    length, 0, hw, // v3: outer end, leading bottom
    length, 0, -hw, // v4: outer end, trailing bottom
    length, height, -hw, // v5: outer end, trailing top
  ];
}

/** Builds a flat-shaded `BufferGeometry` for `createWedgePoints`' 6 points —
 *  non-indexed (each triangle gets its own unshared vertices) so
 *  `computeVertexNormals` yields one flat normal per face instead of
 *  averaging across the wedge's sharp edges. */
function createWedgeGeometry(points) {
  const at = (i) => points.slice(i * 3, i * 3 + 3);
  const triangles = [
    [0, 2, 1], // pivot-end cap
    [3, 4, 5], // outer-end cap
    [0, 1, 4], [0, 4, 3], // bottom
    [1, 2, 5], [1, 5, 4], // back wall
    [0, 3, 2], [3, 5, 2], // ramp
  ];
  const positions = new Float32Array(triangles.length * 9);
  let o = 0;
  for (const tri of triangles) {
    for (const i of tri) {
      positions.set(at(i), o);
      o += 3;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const ITEM_COUNT = 3000;
const TYPE_COUNT = 8; // suitcase, water bottle, fan, cheeseburger, ...

async function main() {
  // --- Three.js boilerplate (side-loaded, not part of the engine lib) ---
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 24, 34); // pulled back to match the larger arena below
  camera.lookAt(0, 0, 0);
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setSize(innerWidth, innerHeight);
  document.body.appendChild(gl.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));

  // --- Loading screen, driven by Preloader below: a full-screen overlay with
  // a progress bar, shown while physics/wasm init and the pile spawn (the
  // slow, blocking-shaped setup work) run, torn down the moment that
  // resolves. The engine has no opinion on what a loading screen looks like
  // — Preloader just emits 0..1 numbers — so all of this is game-side.
  const loadingEl = document.createElement('div');
  loadingEl.style.cssText =
    'position: fixed; inset: 0; z-index: 10000; display: flex; flex-direction: column; ' +
    'align-items: center; justify-content: center; gap: 12px; background: #111; ' +
    'font: 14px/1.4 monospace; color: #fff;';
  const loadingLabel = document.createElement('div');
  loadingLabel.textContent = 'Loading…';
  const barTrack = document.createElement('div');
  barTrack.style.cssText = 'width: 240px; height: 8px; border-radius: 4px; background: #333; overflow: hidden;';
  const barFill = document.createElement('div');
  barFill.style.cssText = 'width: 0%; height: 100%; background: #4363d8; transition: width 80ms linear;';
  barTrack.appendChild(barFill);
  loadingEl.append(loadingLabel, barTrack);
  document.body.appendChild(loadingEl);

  const controls = new OrbitControls(camera, gl.domElement);
  controls.target.set(0, 2, 0);
  controls.enableDamping = true;

  // --- InputBuffer: maps the physical pick/cancel controls to named actions,
  // so a keyboard player can cancel a hold (Escape) the same way a mouse
  // player releases the button, and the game loop only ever asks "was `pick`
  // released this tick" rather than juggling raw pointerup listeners itself.
  const input = new InputBuffer({
    pick: [{ device: 'mouse', button: 0 }],
    cancel: [{ device: 'keyboard', code: 'Escape' }],
  });

// --- SoundSystem: a listener attached to the camera, with a few voices and a limiter to avoid a wall of sound when many items land at once. ---
  const sound = new SoundSystem(camera, { 
    maxVoices: 6, // max simultaneous sounds
    limiter: true,  // if voices/sound emitters are all busy, drop the quietest instead of queuing
    queueTTL: 200, // if a sound can't start within this many ms, drop it
  });
  const matchChime = createChimeBuffer(sound.listener.context);
  const nudgeSound = createNudgeBuffer(sound.listener.context);
  const NUDGE_CHANCE = 0.33; // not every bump should make noise, or it'd be a wall of sound

  // Without this, camera.aspect/gl's size stay stuck at load-time dimensions
  // while the pick handler below reads innerWidth/innerHeight fresh on every
  // click — after any resize (including a devtools panel opening), that
  // mismatch alone throws raycasting off, on top of the picking bug above.
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    gl.setSize(innerWidth, innerHeight);
  });

  // --- Engine wiring ---
  const world = new World();
  const debug = new DebugOverlay(world);
  const transforms = world.registerStore('transform', new TransformStore(ITEM_COUNT));
  const types = world.registerStore('type', new ArrayComponentStore(ITEM_COUNT));
  const bodies = world.registerStore('body', new ArrayComponentStore(ITEM_COUNT));
  const tweens = new TweenRunner();
  world.registerTweenRunner(tweens);

  const renderer = new InstancedRenderer(scene);
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const palette = [0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x46f0f0, 0xf032e6];
  for (let t = 0; t < TYPE_COUNT; t++) {
    renderer.registerType(t, geo, new THREE.MeshStandardMaterial({ color: palette[t] }), ITEM_COUNT);
  }

  // A light, floaty gravity (not the arena's -20) reads better for a
  // celebratory confetti-burst than realistic falling debris would.
  const particles = new ParticleSystem(300, { size: 0.2, gravity: { x: 0, y: -4, z: 0 }, damping: 0.5 });
  scene.add(particles.points);

  // --- Arena dimensions: a floor + 4 walls (open top, invisible —
  // physics-only colliders, no visual panels), so items can't roll off the
  // edge and fall forever. Declared before the preloader tasks below since
  // both the arena and spawn-pile task need them.
  const ARENA_HALF = 40;
  const WALL_HEIGHT = 30;
  const WALL_THICKNESS = 0.5;
  const walls = [
    { pos: { x: ARENA_HALF, y: WALL_HEIGHT / 2, z: 0 }, half: { x: WALL_THICKNESS, y: WALL_HEIGHT / 2, z: ARENA_HALF } },
    { pos: { x: -ARENA_HALF, y: WALL_HEIGHT / 2, z: 0 }, half: { x: WALL_THICKNESS, y: WALL_HEIGHT / 2, z: ARENA_HALF } },
    { pos: { x: 0, y: WALL_HEIGHT / 2, z: ARENA_HALF }, half: { x: ARENA_HALF, y: WALL_HEIGHT / 2, z: WALL_THICKNESS } },
    { pos: { x: 0, y: WALL_HEIGHT / 2, z: -ARENA_HALF }, half: { x: ARENA_HALF, y: WALL_HEIGHT / 2, z: WALL_THICKNESS } },
  ];
  const SPAWN_HALF = ARENA_HALF - 3; // clearance from the walls

  // --- Preloader: the loading screen above subscribes here for one 0..1
  // number covering both of the batch's tasks (weighted — spawning ~3000
  // bodies dominates load time next to wasm init, so it counts for more of
  // the bar than `physics` does). `items` explicitly awaits `physicsReady`
  // before touching `physicsSystem`, since Preloader runs tasks concurrently
  // and has no built-in notion of one task depending on another's result.
  const preloader = new Preloader();
  preloader.onProgress(({ fraction }) => {
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  });

  // --- Sweeping wedge: a kinematic obstacle that continuously plows through
  // the pile from the arena's center, rather than the one-time settle the
  // pile would otherwise do on its own — sustained physics load and ongoing
  // motion, not just a single dramatic drop. Kinematic bodies aren't affected
  // by anything they touch (infinite mass — they push, they're never pushed
  // back), but they still drive contact-force events like any other collider,
  // so it feeds the same bump-sound wiring below for free. Its shape isn't a
  // box: see `createWedgePoints`'s doc for why a plow-shaped wedge (not a
  // flat-faced bar) is what keeps items sliding up and over instead of
  // getting jammed against it. Built directly against `physicsSystem.world`
  // and a bare `THREE.Mesh` (not through `PhysicsSystem`/`InstancedRenderer`,
  // which only know entity-driven boxes and instanced types) — `world` is
  // exposed on `PhysicsSystem` for exactly this: a custom collider shape
  // PhysicsSystem doesn't have a preset for.
  const SWEEP_LENGTH = ARENA_HALF - 4;
  const SWEEP_WIDTH = 3;
  const SWEEP_HEIGHT = 1.5;
  const SWEEP_Y = 0.15; // wedge bottom sits just above the floor collider's top surface
  const SWEEP_RADIANS_PER_SEC = -(2 * Math.PI) / 20; // one revolution every 6s; negative reads as clockwise from above with this camera

  const sweepPoints = createWedgePoints(SWEEP_LENGTH, SWEEP_WIDTH, SWEEP_HEIGHT);
  const sweepMesh = new THREE.Mesh(
    createWedgeGeometry(sweepPoints),
    new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.4, roughness: 0.35 }),
  );
  scene.add(sweepMesh);

  let sweepBody; // kinematicPositionBased RAPIER.RigidBody, created once physics exists below
  let sweepAngle = 0;
  const sweepQuat = new THREE.Quaternion();
  const sweepUp = new THREE.Vector3(0, 0.5, 0);

  let physicsSystem;
  // Steeper than real gravity (-9.81): with linear damping on every dynamic
  // body (added for pile stability, see addDynamicBox), drag opposes fall
  // speed too, so real-world gravity read as floaty. -20 makes the fall feel
  // more natural without touching the damping that keeps the pile settling.
  const physicsReady = (async () => {
    physicsSystem = await PhysicsSystem.create(bodies, { x: 0, y: -20, z: 0 });
    // { collisions: false }: this example only ever calls drainContactForces
    // (for the nudge sound), never drainCollisions — with COLLISION_EVENTS
    // left on (PhysicsSystem's old, only, default), Rapier was still doing
    // start/stop bookkeeping every step for every touching pair in a
    // 3000-body pile that nothing ever reads. contactForces stays on; that
    // channel's the one actually driving sound feedback.
    physicsSystem.addStaticGround(0, { x: ARENA_HALF, z: ARENA_HALF }, 40, { collisions: false });
    for (const wall of walls) {
      physicsSystem.addStaticBox(wall.pos, wall.half, 40, { collisions: false });
    }

    sweepBody = physicsSystem.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, SWEEP_Y, 0),
    );
    // convexHull returns null for a degenerate point set — can't happen for
    // this fixed, non-planar 6-point wedge, but the API allows it.
    const sweepColliderDesc = RAPIER.ColliderDesc.convexHull(new Float32Array(sweepPoints));
    if (sweepColliderDesc) {
      sweepColliderDesc
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS) // no COLLISION_EVENTS — see the note above
        .setContactForceEventThreshold(40);
      physicsSystem.world.createCollider(sweepColliderDesc, sweepBody);
    }
  })();

  await preloader.load(
    {
      physics: async (report) => {
        await physicsReady;
        report(1);
      },
      items: async (report) => {
        await physicsReady; // physics world + arena colliders must exist before bodies can join it
        for (let i = 0; i < ITEM_COUNT; i++) {
          const e = world.spawn();
          const x = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          const y = 5 + Math.random() * 20; // rain down into a pile
          const z = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          transforms.add(e, x, y, z);
          types.add(e, Math.floor(Math.random() * TYPE_COUNT));
          physicsSystem.addDynamicBox(e, transforms, undefined, undefined, undefined, { collisions: false });

          // Yield to the browser every 200 bodies rather than spawning all
          // 3000 in one synchronous burst — keeps the tab responsive and the
          // loading bar actually painting instead of a frozen page that
          // jumps straight from 0% to a completed scene.
          if (i % 200 === 199) {
            report((i + 1) / ITEM_COUNT);
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
        }
        report(1);
      },
    },
    { items: 8 },
  );
  const physics = physicsSystem;
  loadingEl.remove();

  // --- Score (rudimentary — a plain top-center HTML element, game-specific
  // state, so it lives here rather than in the engine) ---
  let score = 0;
  const scoreEl = document.createElement('div');
  scoreEl.style.cssText =
    'position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'font: bold 20px/1.4 monospace; color: #fff; background: rgba(0,0,0,0.6); ' +
    'padding: 4px 16px; border-radius: 4px; pointer-events: none;';
  scoreEl.textContent = 'Score: 0';
  document.body.appendChild(scoreEl);

  // --- Matching rule: two items match iff they share a type id. On a match,
  // a ~650ms self-contained animation (rise, orbit each other while spiraling
  // inward, collide) plays before both entities are actually despawned. ---
  const MATCH_ANIM_DURATION = 0.65; // seconds
  const MATCH_ORBIT_TURNS = 1.5;
  const MATCH_RISE_HEIGHT = 1.5;
  const MATCH_MIN_RADIUS = 0.8;
  const MATCH_BURST_COUNT = 128;

  world.events.on('match:attempt', (ev, w) => {
    if (types.get(ev.a) !== types.get(ev.b)) return;
    const burstColor = new THREE.Color(palette[types.get(ev.a)]);

    // Detach physics *now*, not at despawn — despawn doesn't run until the
    // animation completes below, and PhysicsSystem.update() would otherwise
    // keep calling .translation()/.rotation() on these bodies every frame in
    // between (and fight the animation's own direct writes to `transforms`).
    physics.removeBody(ev.a);
    physics.removeBody(ev.b);
    bodies.remove(ev.a);
    bodies.remove(ev.b);

    const oa = transforms.slotOf(ev.a) * transforms.stride;
    const ob = transforms.slotOf(ev.b) * transforms.stride;
    const raw = transforms.raw;
    const posA = new THREE.Vector3(raw[oa], raw[oa + 1], raw[oa + 2]);
    const posB = new THREE.Vector3(raw[ob], raw[ob + 1], raw[ob + 2]);
    const mid = posA.clone().add(posB).multiplyScalar(0.5);
    const diff = posA.clone().sub(posB);
    const startAngle = Math.atan2(diff.z, diff.x);
    const radius = Math.max(diff.length() / 2, MATCH_MIN_RADIUS);

    tweens.play({
      duration: MATCH_ANIM_DURATION,
      onUpdate(t) {
        const rise = MATCH_RISE_HEIGHT * Math.sin(t * Math.PI * 0.5); // eases up, arrives at full height at collision
        const r = radius * (1 - t); // spirals inward, exactly 0 (collision) at t=1
        const angle = startAngle + t * MATCH_ORBIT_TURNS * Math.PI * 2;
        const ox = Math.cos(angle) * r;
        const oz = Math.sin(angle) * r;
        transforms.add(ev.a, mid.x + ox, mid.y + rise, mid.z + oz);
        transforms.add(ev.b, mid.x - ox, mid.y + rise, mid.z - oz);
      },
      onComplete() {
        w.despawn(ev.a); // removes from transform/type stores (body already detached above)
        w.despawn(ev.b);
        score++;
        scoreEl.textContent = `Score: ${score}`;
        // No `id` here — each match is a distinct event the player caused,
        // not a redundant repeat, so it shouldn't dedup away if a few land in
        // the same burst. `priority: 1` (above the default 0) just means this
        // outranks lower-priority ambient/incidental cues for a voice slot if
        // this example ever adds any.
        sound.play(matchChime, { volume: 0.5, priority: 1 });

        // A confetti burst at the collision point, tinted with the matched
        // type's own color. `mid` is the *ground-level* midpoint captured
        // before the animation ran — the actual collision happens up at
        // mid.y + MATCH_RISE_HEIGHT, where the rise animation tops out, so
        // the burst originates there instead, not down at the pile.
        const burstOrigin = { x: mid.x, y: mid.y + MATCH_RISE_HEIGHT, z: mid.z };
        for (let i = 0; i < MATCH_BURST_COUNT; i++) {
          // Uniform direction over the full sphere (azimuthal angle uniform,
          // polar angle via acos(2u-1)) rather than a flat ring with a fixed
          // upward bias — a real burst scatters every which way, not just
          // up-and-out like a fountain.
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const speed = 2 + Math.random() * 3;
          const velocity = {
            x: Math.sin(phi) * Math.cos(theta) * speed,
            y: Math.cos(phi) * speed,
            z: Math.sin(phi) * Math.sin(theta) * speed,
          };
          particles.emit(burstOrigin, velocity, 0.5 + Math.random() * 0.3, burstColor);
        }
      },
    });
  });

  // --- Pick up / hold / drop ---
  // Held item is switched to a kinematic Rapier body and driven every frame
  // toward a target point derived from a *local offset captured at pickup*:
  // the vector from the camera to the item at the moment it's grabbed,
  // expressed in the camera's local frame (plus a slight upward lift).
  // Reapplying that local offset against the camera's *current* orientation
  // each frame is what keeps the item at the same bearing relative to the
  // view as the camera orbits — using the item's distance alone (a pure
  // forward offset) would instead snap it to dead-center of the view,
  // regardless of where in frame it was originally picked from. Easing
  // toward the target rather than snapping to it. Dropping hands the body
  // back to `Dynamic` from wherever it currently is, so it falls from the
  // drop point rather than jumping to wherever gravity would have carried
  // the ignored body while held.
  const HOLD_LIFT = 0.6; // slight upward nudge, camera-local
  const HOLD_FOLLOW_RATE = 10; // higher = snappier easing toward the target
  const OUTLINE_SCALE = 1.2; // a highlight ring around the item, not a recolor,
  // so the item's own type color (used to identify a match) stays untouched.

  const outline = new THREE.Mesh(
    new THREE.BoxGeometry(OUTLINE_SCALE, OUTLINE_SCALE, OUTLINE_SCALE),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9 }),
  );
  outline.visible = false;
  scene.add(outline);

  let held = null; // { entity, typeId, localOffset, currentPos: THREE.Vector3 }

  function pickUp(entity, typeId) {
    const slot = transforms.slotOf(entity);
    const o = slot * transforms.stride;
    const raw = transforms.raw;
    const currentPos = new THREE.Vector3(raw[o], raw[o + 1], raw[o + 2]);

    const localOffset = currentPos.clone().sub(camera.position);
    localOffset.applyQuaternion(camera.quaternion.clone().invert());
    localOffset.y += HOLD_LIFT;

    held = { entity, typeId, localOffset, currentPos };
    const handle = bodies.get(entity);
    if (handle) handle.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    outline.visible = true;
  }

  function drop() {
    if (!held) return;
    const handle = bodies.get(held.entity);
    if (handle) {
      handle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      handle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      handle.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    }
    outline.visible = false;
    held = null;
  }

  // --- Picking: raycast -> instanceId -> entity ---
  // OrbitControls also drives pointerdown/up on the canvas (for orbit-drag), so
  // a pick only fires on a near-stationary click, not a camera drag. Cursor
  // position is tracked here directly (InputBuffer maps buttons/keys to
  // actions, not pointer coordinates); the `pick` action itself — whether the
  // mouse button transitioned this tick — is read from `input` down in the
  // fixed-step loop below, alongside `cancel` (Escape) for dropping without
  // attempting a match.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const PICK_DRAG_THRESHOLD = 4; // px
  let downX = 0, downY = 0, curX = 0, curY = 0;
  addEventListener('pointerdown', (e) => {
    downX = e.clientX;
    downY = e.clientY;
  });
  addEventListener('pointermove', (e) => {
    curX = e.clientX;
    curY = e.clientY;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  });
  function raycastPick() {
    // Nearest hit across *all* types, not the first type (in loop order) that
    // has any hit at all — with a dense, overlapping pile, a ray from a
    // shallow angle passes through many boxes, and picking by type order
    // would frequently resolve to one behind whatever's actually under the
    // cursor. That's what read as an offset/"deadzone" at grazing angles.
    ray.setFromCamera(ndc, camera);
    let closest = null;
    for (let t = 0; t < TYPE_COUNT; t++) {
      const mesh = renderer.meshFor(t);
      if (!mesh) continue;
      const hit = ray.intersectObject(mesh)[0];
      if (hit && hit.instanceId !== undefined && (!closest || hit.distance < closest.distance)) {
        closest = { entity: renderer.entityAt(t, hit.instanceId), typeId: t, distance: hit.distance };
      }
    }
    return closest;
  }

  // --- Main loop ---
  // Physics + world.step() run on a fixed timestep via FixedStep, decoupled
  // from render rate: zero, one, or several fixed steps happen per rendered
  // frame depending on how much real time elapsed, so simulation speed (and
  // things timed against it, like the match-combine TweenRunner animation)
  // stays consistent across displays instead of tracking whatever rate
  // requestAnimationFrame happens to fire at. No render interpolation yet —
  // between fixed steps the render just shows the last simulated state, which
  // can look slightly juddery when render Hz and FIXED_DT don't divide evenly;
  // FixedStep.alpha is there for interpolation later.
  const FIXED_DT = 1 / 60;
  // maxStepsPerFrame=1 (default is 5): with 5000 dynamic bodies, if a single
  // physics step already costs more than one frame's budget, the default
  // "catch up with extra steps" behavior compounds instead of recovering —
  // each frame falls further behind, so the loop keeps trying to run more
  // steps, which makes it slower still. Capping at 1 means the simulation
  // runs in slow motion under sustained overload instead of that spiral;
  // trades real-time accuracy for framerate stability, the right call for an
  // interactive scene.
  const fixedStep = new FixedStep(FIXED_DT, 1);
  const holdTarget = new THREE.Vector3();
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    if (held) {
      // Re-project the local offset captured at pickup against the camera's
      // *current* orientation, then ease currentPos toward it (frame-rate-
      // independent exponential smoothing) rather than snapping. This is
      // render-side smoothing of a visual target, not physics, so it uses the
      // real per-frame dt rather than the fixed step below.
      holdTarget.copy(held.localOffset).applyQuaternion(camera.quaternion).add(camera.position);
      const ease = 1 - Math.exp(-HOLD_FOLLOW_RATE * dt);
      held.currentPos.lerp(holdTarget, ease);

      const handle = bodies.get(held.entity);
      if (handle) handle.body.setNextKinematicTranslation(held.currentPos);
      outline.position.copy(held.currentPos);
    }

    fixedStep.advance(dt, (fixedDt) => {
      // Resolve one tick of action state first, so pick/cancel below (and any
      // future system reading `input`) see this tick's edges rather than
      // last tick's.
      input.update();

      if (input.justReleased('pick') && Math.hypot(curX - downX, curY - downY) <= PICK_DRAG_THRESHOLD) {
        const pick = raycastPick();
        if (!held) {
          if (pick) pickUp(pick.entity, pick.typeId);
        } else {
          // Already holding one item — a hit on a second, different entity
          // attempts a match (the handler above decides if the type ids
          // actually agree). Either way, releasing `pick` drops the held item.
          if (pick && pick.entity !== held.entity) {
            world.events.emit({ type: 'match:attempt', a: held.entity, b: pick.entity });
          }
          drop();
        }
      } else if (held && input.justPressed('cancel')) {
        drop(); // Escape: put the held item down without attempting a match
      }

      // Advance the sweeping wedge's target rotation before physics.update()
      // steps the world, so this tick's step is the one that actually moves
      // it — a kinematic body only moves on the step after its "next"
      // transform is set. Translation is never touched after creation (the
      // wedge only spins in place around its pivot), so only rotation needs
      // driving here.
      sweepAngle += SWEEP_RADIANS_PER_SEC * fixedDt;
      sweepQuat.setFromAxisAngle(sweepUp, sweepAngle);
      if (sweepBody) sweepBody.setNextKinematicRotation(sweepQuat);

      physics.update(transforms, fixedDt); // step sim + copy transforms back
      if (sweepBody) {
        // Not part of `transforms`/`bodies` (it's a scene prop, not an
        // entity), so physics.update()'s copy-back doesn't touch it —
        // synced here instead, straight from the body physics.update() just
        // stepped.
        const p = sweepBody.translation();
        const q = sweepBody.rotation();
        sweepMesh.position.set(p.x, p.y, p.z);
        sweepMesh.quaternion.set(q.x, q.y, q.z, q.w);
      }
      // --- Out-of-bounds recovery: the sweeping wedge can shove an item hard
      // enough to squeeze it through a wall/floor seam (a kinematic body
      // doesn't get pushed back by what it hits, so a fast-enough contact
      // can tunnel a thin dynamic box past a thin static collider in one
      // step). Rather than let a body fall forever — dead weight sitting in
      // `bodies`/`transforms` forever, invisible below the floor — anything
      // that ends up well below the arena gets teleported back above the
      // pile to rain back in, same as its initial spawn. Held item is
      // exempt: it's off physics-driven while held, and teleporting it out
      // from under the player mid-hold would just look broken.
      const OOB_Y = -20;
      {
        const entities = transforms.entities;
        const raw = transforms.raw;
        const stride = transforms.stride;
        for (let i = 0; i < entities.length; i++) {
          const e = entities[i];
          const o = i * stride;
          if (raw[o + 1] >= OOB_Y) continue;
          if (held && e === held.entity) continue;
          const handle = bodies.get(e);
          if (!handle) continue; // mid-match-animation: no body, tween owns its position

          const x = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          const y = 5 + Math.random() * 20; // rain back down, same as initial spawn
          const z = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          handle.body.setTranslation({ x, y, z }, true);
          handle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          handle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          // Also write straight into `transforms` so this tick's render
          // shows the recovered position instead of the stale OOB one from
          // physics.update()'s copy-back above — otherwise the item would
          // flash at its out-of-bounds spot for one frame before the next
          // physics step corrects it.
          raw[o] = x; raw[o + 1] = y; raw[o + 2] = z;
        }
      }

      world.step(fixedDt); // logic systems, event drain, tweens (may emit particles via match onComplete)
      particles.update(fixedDt); // after world.step, so particles emitted this step get their first tick now, not next frame

      // Contact-force events (not just collision-start): drained once per
      // physics step (not once per rendered frame — several steps can run in
      // one frame, or zero). PhysicsSystem's default threshold (40N) is only
      // a coarse floor — it stops ordinary stacking pressure from generating
      // an event at all, but a many-layer-deep pile settling can still cross
      // it. "Should this make noise" is a stricter, separate question: only
      // a *serious* impact (SERIOUS_IMPACT_FORCE, well above ordinary
      // resting/stacking load) should ever play, and even then only 33% of
      // the time — the rest is silently dropped, not just quiet. During the
      // initial rain-down this can still evaluate a lot of candidates in a
      // handful of steps as thousands of items land — exactly the burst
      // SoundSystem's admission control exists for; louder impacts (above
      // the serious-impact floor) get a louder cue, and the voice
      // cap/limiter in SoundSystem catch whatever still overlaps.
      const SERIOUS_IMPACT_FORCE = 100;
      const HARD_HIT_FORCE = 250; // where volume scaling maxes out, tuned by ear
      physics.drainContactForces((a, b, magnitude) => {
        if (magnitude < SERIOUS_IMPACT_FORCE) return;
        if (Math.random() >= NUDGE_CHANCE) return;
        const intensity = Math.min((magnitude - SERIOUS_IMPACT_FORCE) / (HARD_HIT_FORCE - SERIOUS_IMPACT_FORCE), 1);
        // Short queueTTL (default is 200): a nudge is tied to a specific,
        // already-past instant of impact, more so than the match chime — if
        // it can't get a voice within 60ms, the moment it was for has
        // already moved on, so let it drop rather than trickle out late.
        // No `id` here (unlike earlier): with the sweeping wedge plowing
        // through the pile, several nudges landing in the same instant are
        // usually genuinely distinct impacts at different points in the
        // arena, not redundant copies of one event — an `id` dedup gate
        // (even with `maxConcurrent`) just hard-drops everything past its
        // cap instead of spreading load, which read as isolated, sparse
        // "tock"s rather than the layered crunch a continuous sweep should
        // have. `maxVoices` (6) + priority-based voice stealing is the
        // actual load balancer: it already lets a match chime (priority 1)
        // steal a voice from a lower-priority nudge when all 6 are full, so
        // nothing important gets starved without needing a second gate here.
        sound.play(nudgeSound, { volume: 0.15 + intensity * 0.35, queueTTL: 60 });
      });
    });

    renderer.sync(transforms, types); // write instance matrices
    controls.update(); // required for damping
    gl.render(scene, camera);
    debug.tick();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
