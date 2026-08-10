/**
 * Matching-game skeleton — shows how the pieces compose. This is a starting
 * point, not a finished game: it spawns a pile of typed items, drops them with
 * physics, renders them as instances, and wires up mouse-orbit camera control,
 * click-first-item-then-second-item matching, a score counter, and a debug
 * overlay.
 *
 * Run `npm run build` first, then serve this folder statically (e.g.
 * `npx serve examples`) and open matching-game.html.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/controls/OrbitControls.js';
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

/** Synthesizes a short two-tone chime — no audio asset needed. */
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

/** A short, soft low "tock" — deliberately distinct from the chime, and
 *  brief since thousands of bodies will trigger it a lot. */
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

/** The 6 corner points of a wedge/plow shape pivoting at local origin. A thin
 *  ground-level leading edge carries items up and over instead of jamming them. */
function createWedgePoints(length, width, height) {
  const hw = width / 2;
  return [
    0, 0, hw, // v0: pivot end, leading bottom
    0, 0, -hw, // v1: pivot end, trailing bottom
    0, height, -hw, // v2: pivot end, trailing top
    length, 0, hw, // v3: outer end, leading bottom
    length, 0, -hw, // v4: outer end, trailing bottom
    length, height, -hw, // v5: outer end, trailing top
  ];
}

/** Flat-shaded BufferGeometry for createWedgePoints' 6 points — non-indexed
 *  so computeVertexNormals yields one flat normal per face. */
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
  camera.position.set(0, 24, 34);
  camera.lookAt(0, 0, 0);
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setSize(innerWidth, innerHeight);
  document.body.appendChild(gl.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));

  // --- Loading screen, driven by Preloader below ---
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

  const input = new InputBuffer({
    pick: [{ device: 'mouse', button: 0 }],
    cancel: [{ device: 'keyboard', code: 'Escape' }],
  });

  const sound = new SoundSystem(camera, {
    maxVoices: 6,
    limiter: true, // if voices are all busy, drop the quietest instead of queuing
    queueTTL: 200,
  });
  const matchChime = createChimeBuffer(sound.listener.context);
  const nudgeSound = createNudgeBuffer(sound.listener.context);
  const NUDGE_CHANCE = 0.33; // not every bump should make noise

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

  // Lighter, floatier gravity than the arena's -20 reads better for a
  // celebratory confetti burst than realistic falling debris.
  const particles = new ParticleSystem(300, { size: 0.2, gravity: { x: 0, y: -4, z: 0 }, damping: 0.5 });
  scene.add(particles.points);

  // --- Arena: floor + 4 invisible walls so items can't roll off the edge. ---
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

  // --- Preloader: one weighted 0..1 number for both tasks. `items` awaits
  // physicsReady itself since Preloader runs tasks concurrently. ---
  const preloader = new Preloader();
  preloader.onProgress(({ fraction }) => {
    barFill.style.width = `${(fraction * 100).toFixed(1)}%`;
  });

  // --- Sweeping wedge: a kinematic obstacle plowing through the pile from
  // the arena's center. Built directly against physicsSystem.world/a bare
  // THREE.Mesh — a custom collider shape PhysicsSystem has no preset for. ---
  const SWEEP_LENGTH = ARENA_HALF - 4;
  const SWEEP_WIDTH = 3;
  const SWEEP_HEIGHT = 1.5;
  const SWEEP_Y = 0.15; // wedge bottom sits just above the floor collider's top surface
  const SWEEP_RADIANS_PER_SEC = -(2 * Math.PI) / 20; // one revolution every 6s; negative = clockwise from above

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
  // Steeper than real gravity: linear damping (added for pile stability)
  // opposes fall speed too, so real-world gravity would read as floaty.
  const physicsReady = (async () => {
    physicsSystem = await PhysicsSystem.create(bodies, { x: 0, y: -20, z: 0 });
    // collisions: false — this example only drains contactForces, and
    // COLLISION_EVENTS would cost start/stop bookkeeping nothing here reads.
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
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
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
        await physicsReady; // physics world + arena colliders must exist before bodies join it
        for (let i = 0; i < ITEM_COUNT; i++) {
          const e = world.spawn();
          const x = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          const y = 5 + Math.random() * 20; // rain down into a pile
          const z = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          transforms.add(e, x, y, z);
          types.add(e, Math.floor(Math.random() * TYPE_COUNT));
          physicsSystem.addDynamicBox(e, transforms, undefined, undefined, undefined, { collisions: false });

          // Yield to the browser every 200 bodies rather than one big
          // synchronous burst, so the loading bar actually paints.
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

  // --- Score ---
  let score = 0;
  const scoreEl = document.createElement('div');
  scoreEl.style.cssText =
    'position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'font: bold 20px/1.4 monospace; color: #fff; background: rgba(0,0,0,0.6); ' +
    'padding: 4px 16px; border-radius: 4px; pointer-events: none;';
  scoreEl.textContent = 'Score: 0';
  document.body.appendChild(scoreEl);

  // --- Matching rule: two items match iff they share a type id. On a match,
  // a ~650ms rise/orbit/collide animation plays before both despawn. ---
  const MATCH_ANIM_DURATION = 0.65; // seconds
  const MATCH_ORBIT_TURNS = 1.5;
  const MATCH_RISE_HEIGHT = 1.5;
  const MATCH_MIN_RADIUS = 0.8;
  const MATCH_BURST_COUNT = 128;

  world.events.on('match:attempt', (ev, w) => {
    if (types.get(ev.a) !== types.get(ev.b)) return;
    const burstColor = new THREE.Color(palette[types.get(ev.a)]);

    // Detach physics now, not at despawn — PhysicsSystem.update() would
    // otherwise keep writing to these bodies during the animation below.
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
        const rise = MATCH_RISE_HEIGHT * Math.sin(t * Math.PI * 0.5); // arrives at full height at collision
        const r = radius * (1 - t); // spirals inward, exactly 0 at t=1
        const angle = startAngle + t * MATCH_ORBIT_TURNS * Math.PI * 2;
        const ox = Math.cos(angle) * r;
        const oz = Math.sin(angle) * r;
        transforms.add(ev.a, mid.x + ox, mid.y + rise, mid.z + oz);
        transforms.add(ev.b, mid.x - ox, mid.y + rise, mid.z - oz);
      },
      onComplete() {
        w.despawn(ev.a);
        w.despawn(ev.b);
        score++;
        scoreEl.textContent = `Score: ${score}`;
        sound.play(matchChime, { volume: 0.5, priority: 1 });

        // Confetti burst tinted with the matched type's color, originating at
        // the collision point (mid.y + MATCH_RISE_HEIGHT), not the pile.
        const burstOrigin = { x: mid.x, y: mid.y + MATCH_RISE_HEIGHT, z: mid.z };
        for (let i = 0; i < MATCH_BURST_COUNT; i++) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1); // uniform over the full sphere, not a fixed-bias ring
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
  // Held item is a kinematic body driven toward a camera-local offset
  // captured at pickup, reapplied each frame — keeps its screen bearing
  // stable as the camera orbits, rather than snapping to view-center.
  const HOLD_LIFT = 0.6; // slight upward nudge, camera-local
  const HOLD_FOLLOW_RATE = 10; // higher = snappier easing toward the target
  const OUTLINE_SCALE = 1.2;

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
    // Nearest hit across all types, not the first type with any hit — a
    // dense, overlapping pile at a shallow angle would otherwise frequently
    // resolve to something behind whatever's actually under the cursor.
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
  // from render rate, so simulation speed stays consistent across displays.
  const FIXED_DT = 1 / 60;
  // maxStepsPerFrame=1 (default 5): with 5000 bodies, the default "catch up
  // with extra steps" would compound instead of recovering under overload.
  const fixedStep = new FixedStep(FIXED_DT, 1);
  const holdTarget = new THREE.Vector3();
  let last = performance.now();
  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    if (held) {
      // Render-side smoothing of a visual target (real dt, not the fixed step).
      holdTarget.copy(held.localOffset).applyQuaternion(camera.quaternion).add(camera.position);
      const ease = 1 - Math.exp(-HOLD_FOLLOW_RATE * dt);
      held.currentPos.lerp(holdTarget, ease);

      const handle = bodies.get(held.entity);
      if (handle) handle.body.setNextKinematicTranslation(held.currentPos);
      outline.position.copy(held.currentPos);
    }

    fixedStep.advance(dt, (fixedDt) => {
      input.update();

      if (input.justReleased('pick') && Math.hypot(curX - downX, curY - downY) <= PICK_DRAG_THRESHOLD) {
        const pick = raycastPick();
        if (!held) {
          if (pick) pickUp(pick.entity, pick.typeId);
        } else {
          if (pick && pick.entity !== held.entity) {
            world.events.emit({ type: 'match:attempt', a: held.entity, b: pick.entity });
          }
          drop();
        }
      } else if (held && input.justPressed('cancel')) {
        drop();
      }

      // Advance the wedge's target rotation before physics.update() steps
      // the world, so this tick's step is the one that moves it.
      sweepAngle += SWEEP_RADIANS_PER_SEC * fixedDt;
      sweepQuat.setFromAxisAngle(sweepUp, sweepAngle);
      if (sweepBody) sweepBody.setNextKinematicRotation(sweepQuat);

      physics.update(transforms, fixedDt); // step sim + copy transforms back
      if (sweepBody) {
        // Not part of transforms/bodies (a scene prop, not an entity), so
        // synced here straight from the body physics.update() just stepped.
        const p = sweepBody.translation();
        const q = sweepBody.rotation();
        sweepMesh.position.set(p.x, p.y, p.z);
        sweepMesh.quaternion.set(q.x, q.y, q.z, q.w);
      }
      // --- Out-of-bounds recovery: the wedge can tunnel an item through a
      // wall/floor seam; anything well below the arena rains back in instead of falling forever. ---
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
          const y = 5 + Math.random() * 20;
          const z = (Math.random() - 0.5) * 2 * SPAWN_HALF;
          handle.body.setTranslation({ x, y, z }, true);
          handle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          handle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          // Also write straight into transforms so this tick's render shows
          // the recovered position instead of the stale OOB one.
          raw[o] = x; raw[o + 1] = y; raw[o + 2] = z;
        }
      }

      world.step(fixedDt); // logic systems, event drain, tweens (may emit particles via match onComplete)
      particles.update(fixedDt); // after world.step, so particles emitted this step get their first tick now

      // Only a serious impact (well above resting/stacking load) plays, and
      // even then only 33% of the time — the rest is silently dropped.
      const SERIOUS_IMPACT_FORCE = 100;
      const HARD_HIT_FORCE = 250; // where volume scaling maxes out, tuned by ear
      physics.drainContactForces((a, b, magnitude) => {
        if (magnitude < SERIOUS_IMPACT_FORCE) return;
        if (Math.random() >= NUDGE_CHANCE) return;
        const intensity = Math.min((magnitude - SERIOUS_IMPACT_FORCE) / (HARD_HIT_FORCE - SERIOUS_IMPACT_FORCE), 1);
        // Short queueTTL: a late nudge is stale, let it drop. No `id` dedup —
        // simultaneous nudges here are usually genuinely distinct impacts.
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
