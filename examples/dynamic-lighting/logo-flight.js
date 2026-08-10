/**
 * Logo flight — a dynamic-lighting showcase. Every sculpture is the
 * engine's own logo.glb model, scattered across rolling terrain with a
 * first-person flight camera. Five FIELD_LIGHTS and two ROVER_LIGHTS wander
 * between sculptures using tangent-point steering around the engine's own
 * SpatialGrid (see buildObstacleAvoidance), with no static orbits.
 *
 * Run `npm run build` first, then serve the repo root statically and open
 * logo-flight.html.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import {
  InputBuffer,
  FixedStep,
  World,
  TransformStore,
  ArrayComponentStore,
  SpatialGrid,
  GltfLoader,
} from '../../dist/speck.js';

// --- Flight tuning ---------------------------------------------------------

const FLY_FORWARD_SPEED = 22;
const FLY_STRAFE_SPEED = 14;
const FLY_VERTICAL_SPEED = 14;
const FLY_RESPONSIVENESS = 3.5; // rate in a 1-exp(-k*dt) lerp, so response is frame-rate independent
const MOUSE_LOOK_SENSITIVITY = 0.0022;
const PITCH_LIMIT = 1.4; // radians, just short of straight up/down

// --- Landscape layout --------------------------------------------------

const TERRAIN_SIZE = 700;
const TERRAIN_HALF = TERRAIN_SIZE / 2;
const TERRAIN_SEGMENTS = 110;
const LOGO_COUNT = 100;
const SCATTER_MARGIN = 0.92; // sculptures only spawn within this fraction of the terrain extent

const GIANT_COUNT = 5;
const GIANT_SCALE_RANGE = [30, 50];
const NORMAL_SCALE_RANGE = [1.5, 12];

// Giants sit at a fixed center+corners layout so they read as deliberate
// landmarks. Only works for GIANT_COUNT === 5.
const CORNER_OFFSET = 130;
const GIANT_FIXED_POSITIONS = [
  { x: 0, z: 0 },
  { x: CORNER_OFFSET, z: CORNER_OFFSET },
  { x: CORNER_OFFSET, z: -CORNER_OFFSET },
  { x: -CORNER_OFFSET, z: CORNER_OFFSET },
  { x: -CORNER_OFFSET, z: -CORNER_OFFSET },
];
// Target footprint radius/height every placement is scaled to hit (see
// loadGlbTemplate, which measures the model's real proportions).
const FOOTPRINT_RADIUS_FACTOR = 1.6;
const OBSTACLE_HEIGHT_FACTOR = 1.6;
const PLACEMENT_PADDING = 3;
const PLACEMENT_ATTEMPTS = 150;

// Real PointLight per drop block, deliberately weak (a "field of embers") —
// FIELD_LIGHTS/ROVER_LIGHTS are the scene's dominant light sources. Scaled
// by instance `scale`. Never shadow-casting (100 of those is a non-starter).
const DROP_LIGHT_INTENSITY = 3.5;
const DROP_LIGHT_DISTANCE = 7;

/** Rolling hills shared by the terrain mesh, sculpture placement, and the
 *  flight camera's ground-clearance clamp. */
function terrainHeight(x, z) {
  return Math.sin(x * 0.045) * 2.2 + Math.cos(z * 0.05) * 2.0 + Math.sin((x + z) * 0.02) * 1.4;
}

const GLB_URL = './logo.glb';

const GROUND_CLEARANCE = 3;
const MAX_ALTITUDE = 55; // deliberately low — a terrain-hugging flight, not a high overview
const BOUNDARY_XZ = TERRAIN_HALF + 40;

// height is relative to local terrain height, not world altitude, so each
// light hugs whatever hill it's currently crossing.
const FIELD_LIGHTS = [
  { color: 0xff3355, speed: 10, height: 9, intensity: 90, distance: 140, markerRadius: 1.1, shadow: true },
  { color: 0x33ccff, speed: 8, height: 13, intensity: 90, distance: 140, markerRadius: 1.1, shadow: false },
  { color: 0x66ff44, speed: 12, height: 7, intensity: 90, distance: 140, markerRadius: 1.1, shadow: true },
  { color: 0xffaa22, speed: 9, height: 15, intensity: 90, distance: 140, markerRadius: 1.1, shadow: false },
  { color: 0xcc55ff, speed: 11, height: 10, intensity: 90, distance: 140, markerRadius: 1.1, shadow: true },
];

// Wander only between the 5 giants, slower and much larger — the terrain's
// grand-tour showpiece lights.
const ROVER_LIGHTS = [
  { color: 0xfff2cf, speed: 4, height: 20, intensity: 260, distance: 320, markerRadius: 3.2 },
  { color: 0xcfe8ff, speed: 3.4, height: 24, intensity: 260, distance: 320, markerRadius: 3.2 },
];
const WAYPOINT_ARRIVAL_DISTANCE = 4;
// Arrival is measured from a destination's avoidance edge, not its
// (unreachable, solid-geometry) center.
const DESTINATION_ARRIVAL_MARGIN = 6;

// --- Wanderer obstacle avoidance (see buildObstacleAvoidance) --------------

const AVOIDANCE_CLEARANCE = 10;
const AVOIDANCE_LOOKAHEAD = 100; // SpatialGrid broad-phase query radius
const AVOIDANCE_CELL_SIZE = 60;
// Minimum gap a new detour point must keep from ones already visited this
// trip (see chooseDetourPoint) — stops ping-ponging between two close points.
const MIN_DETOUR_SEPARATION = AVOIDANCE_CLEARANCE * 2;
const RECENT_DETOURS_LIMIT = 6; // reset whenever a new destination is picked
// Growth per consecutive "both candidates too close to history" result,
// capped so a wanderer can't spiral into a wastefully huge search radius.
const AVOID_ESCALATION_STEP = MIN_DETOUR_SEPARATION;
const MAX_AVOID_ESCALATION = 150;

const isTouch = matchMedia('(pointer: coarse)').matches;

function createStarfield(count, minRadius, maxRadius) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = THREE.MathUtils.lerp(minRadius, maxRadius, Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.15,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0.8,
  });
  return new THREE.Points(geo, mat);
}

function buildTerrain() {
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x171826, roughness: 0.95, metalness: 0.05 });
  return new THREE.Mesh(geo, mat);
}

/** The two tangent points from external point (px, pz) to circle (cx, cz,
 *  r). Returns null if (px, pz) is inside the circle. */
function tangentPointsOnCircle(px, pz, cx, cz, r) {
  const dx = px - cx;
  const dz = pz - cz;
  const d = Math.hypot(dx, dz);
  if (d <= r) return null;
  const angleToPoint = Math.atan2(dz, dx);
  const halfAngle = Math.acos(r / d);
  return [
    { x: cx + r * Math.cos(angleToPoint + halfAngle), z: cz + r * Math.sin(angleToPoint + halfAngle) },
    { x: cx + r * Math.cos(angleToPoint - halfAngle), z: cz + r * Math.sin(angleToPoint - halfAngle) },
  ];
}

/** Picks which tangent point (see tangentPointsOnCircle) to detour to,
 *  excluding ones too close to recentDetours to stop ping-ponging. Returns
 *  { point, escalate }; escalate flags when both candidates were too close
 *  to history, so the caller should widen the search radius next time. */
function chooseDetourPoint(px, pz, cx, cz, r, desiredX, desiredZ, recentDetours) {
  const candidates = tangentPointsOnCircle(px, pz, cx, cz, r);
  if (!candidates) return null;

  function turnScore(point) {
    const tx = point.x - px;
    const tz = point.z - pz;
    const len = Math.hypot(tx, tz) || 1e-6;
    return (tx / len) * desiredX + (tz / len) * desiredZ; // 1 = no turn, -1 = doubling back
  }
  function nearestHistoryDist(point) {
    let min = Infinity;
    for (const p of recentDetours) min = Math.min(min, Math.hypot(point.x - p.x, point.z - p.z));
    return min;
  }

  const clearOfHistory = candidates.filter((c) => nearestHistoryDist(c) >= MIN_DETOUR_SEPARATION);
  if (clearOfHistory.length > 0) {
    clearOfHistory.sort((a, b) => turnScore(b) - turnScore(a));
    return { point: clearOfHistory[0], escalate: false };
  }
  const fallback = nearestHistoryDist(candidates[0]) >= nearestHistoryDist(candidates[1]) ? candidates[0] : candidates[1];
  return { point: fallback, escalate: true };
}

/** Indexes every placed sculpture's footprint into the engine's SpatialGrid
 *  and returns findBlocker(x, y, z, dirX, dirZ, maxDist) — called only when
 *  a wanderer needs a new detour, not every frame. Height-aware: an
 *  obstacle only blocks if the wanderer's altitude is below its top. */
function buildObstacleAvoidance(footprints) {
  const world = new World();
  const transforms = world.registerStore('transform', new TransformStore(footprints.length));
  const footprintStore = world.registerStore('footprint', new ArrayComponentStore(footprints.length)); // { radius, groundY, height }
  const spatialGrid = new SpatialGrid(AVOIDANCE_CELL_SIZE);

  for (const fp of footprints) {
    const e = world.spawn();
    transforms.add(e, fp.x, fp.groundY + fp.height / 2, fp.z, 0, 0, 0, 1);
    footprintStore.add(e, { radius: fp.radius, groundY: fp.groundY, height: fp.height });
  }
  spatialGrid.rebuild(transforms); // footprints never move, so this only runs once

  const candidates = []; // reused across calls
  const stats = { queries: 0, lastCandidates: 0, totalCandidates: 0 };

  function findBlocker(x, y, z, dirX, dirZ, maxDist) {
    spatialGrid.queryRadius(transforms, x, y, z, AVOIDANCE_LOOKAHEAD, candidates);
    stats.queries++;
    stats.lastCandidates = candidates.length;
    stats.totalCandidates += candidates.length;

    let nearest = null;
    let nearestT = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const entity = candidates[i];
      const fp = footprintStore.get(entity);
      if (y >= fp.groundY + fp.height + AVOIDANCE_CLEARANCE) continue; // flying above it
      const slot = transforms.slotOf(entity);
      const o = slot * transforms.stride;
      const raw = transforms.raw;
      const cx = raw[o];
      const cz = raw[o + 2];
      const avoidRadius = fp.radius + AVOIDANCE_CLEARANCE;

      const toObstacleX = cx - x;
      const toObstacleZ = cz - z;
      const t = THREE.MathUtils.clamp(toObstacleX * dirX + toObstacleZ * dirZ, 0, maxDist);
      const closestX = x + dirX * t;
      const closestZ = z + dirZ * t;
      const perpDist = Math.hypot(cx - closestX, cz - closestZ);
      if (perpDist >= avoidRadius) continue; // ray passes clear of it
      if (t < nearestT) {
        nearestT = t;
        nearest = { x: cx, z: cz, avoidRadius };
      }
    }
    return nearest;
  }

  return { findBlocker, stats };
}

// GLTFLoader sanitizes node names on parse (dots are the AnimationClip
// track-path separator), so "Cube.004" in the authored file becomes
// "Cube004" here.
const GLB_DROP_NODE_NAME = 'Cube004';
const GLB_GREY_NODE_NAMES = ['Cube', 'Cube001', 'Cube002', 'Cube003'];

/** Loads logo.glb once and measures its footprint radius/base height from
 *  its actual geometry, so buildLogoInstances can scale instances
 *  correctly. Strips embedded lights (Blender exports watts, wildly too
 *  strong for three.js's punctual-light units). */
async function loadGlbTemplate() {
  const loader = new GltfLoader();
  const gltf = await loader.load(GLB_URL);
  const template = gltf.scene;

  const lights = [];
  template.traverse((child) => {
    if (child.isLight) lights.push(child);
  });
  for (const light of lights) light.parent.remove(light);

  const greyBox = new THREE.Box3();
  for (const name of GLB_GREY_NODE_NAMES) {
    const node = template.getObjectByName(name);
    if (node) greyBox.expandByObject(node);
  }
  const radius = Math.max(
    Math.hypot(greyBox.min.x, greyBox.min.z),
    Math.hypot(greyBox.min.x, greyBox.max.z),
    Math.hypot(greyBox.max.x, greyBox.min.z),
    Math.hypot(greyBox.max.x, greyBox.max.z),
  );

  return { template, radius, baseY: greyBox.min.y, animations: gltf.animations };
}

/** Places LOGO_COUNT clones of logo.glb across the terrain: GIANT_COUNT
 *  giants at a fixed layout, everyone else rejection-sampled into the open
 *  ground around them. Each instance plays its own phase-offset bounce
 *  animation and carries a real PointLight on its green drop block. Returns
 *  allPositions (every sculpture) and giantPositions (just the 5 giants). */
async function buildLogoInstances(scene) {
  const glb = await loadGlbTemplate();

  const dropLights = new Array(LOGO_COUNT);
  for (let i = 0; i < LOGO_COUNT; i++) {
    const light = new THREE.PointLight(0x7ed321, DROP_LIGHT_INTENSITY, DROP_LIGHT_DISTANCE, 2);
    scene.add(light);
    dropLights[i] = light;
  }

  const giantPositions = [];
  const placements = new Array(LOGO_COUNT); // { x, z, scale, yaw }
  const placedFootprints = []; // { x, z, radius, groundY, height }

  function pushFootprint(x, z, scale) {
    const fp = {
      x,
      z,
      radius: scale * FOOTPRINT_RADIUS_FACTOR,
      groundY: terrainHeight(x, z),
      height: scale * OBSTACLE_HEIGHT_FACTOR,
    };
    placedFootprints.push(fp);
    return fp;
  }

  for (let g = 0; g < GIANT_COUNT; g++) {
    const pos = GIANT_FIXED_POSITIONS[g];
    const scale = THREE.MathUtils.lerp(GIANT_SCALE_RANGE[0], GIANT_SCALE_RANGE[1], Math.random());
    const yaw = Math.random() * Math.PI * 2;
    placements[g] = { x: pos.x, z: pos.z, scale, yaw };
    giantPositions.push(pushFootprint(pos.x, pos.z, scale));
  }

  for (let idx = GIANT_COUNT; idx < LOGO_COUNT; idx++) {
    const scale = THREE.MathUtils.lerp(NORMAL_SCALE_RANGE[0], NORMAL_SCALE_RANGE[1], Math.random());
    const radius = scale * FOOTPRINT_RADIUS_FACTOR;
    // Rejection-sample up to PLACEMENT_ATTEMPTS times, tracking the
    // least-overlapping attempt as a fallback rather than the last one
    // tried (an overlapping fallback used to read as a broken sculpture).
    let x = 0;
    let z = 0;
    let bestX = 0;
    let bestZ = 0;
    let bestClearance = -Infinity;
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      x = (Math.random() - 0.5) * TERRAIN_SIZE * SCATTER_MARGIN;
      z = (Math.random() - 0.5) * TERRAIN_SIZE * SCATTER_MARGIN;
      let clearance = Infinity;
      for (const f of placedFootprints) {
        clearance = Math.min(clearance, Math.hypot(x - f.x, z - f.z) - (radius + f.radius + PLACEMENT_PADDING));
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        bestX = x;
        bestZ = z;
      }
      if (clearance >= 0) break;
    }
    placements[idx] = { x: bestX, z: bestZ, scale, yaw: Math.random() * Math.PI * 2 };
    pushFootprint(bestX, bestZ, scale);
  }

  const glbInstances = []; // { mixer, greenNode, lightIndex } per instance

  for (let idx = 0; idx < LOGO_COUNT; idx++) {
    const { x, z, scale, yaw } = placements[idx];
    const y = terrainHeight(x, z);
    dropLights[idx].intensity = DROP_LIGHT_INTENSITY * scale;
    dropLights[idx].distance = DROP_LIGHT_DISTANCE * scale;

    const instance = glb.template.clone(true);
    const normScale = (scale * FOOTPRINT_RADIUS_FACTOR) / glb.radius;
    instance.position.set(x, y - glb.baseY * normScale, z);
    instance.rotation.y = yaw;
    instance.scale.setScalar(normScale);
    instance.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    scene.add(instance);

    const greenNode = instance.getObjectByName(GLB_DROP_NODE_NAME);
    let mixer = null;
    if (greenNode && glb.animations.length > 0) {
      const clip = glb.animations[0];
      mixer = new THREE.AnimationMixer(instance);
      mixer.clipAction(clip).play();
      mixer.update(Math.random() * clip.duration); // desync so the field doesn't bounce in lockstep
    }
    glbInstances.push({ mixer, greenNode, lightIndex: idx });
  }

  const tmpWorldPos = new THREE.Vector3();

  function updateDropBlocks(dt) {
    for (const glbInstance of glbInstances) {
      if (!glbInstance.mixer) continue;
      glbInstance.mixer.update(dt);
      glbInstance.greenNode.updateWorldMatrix(true, false);
      glbInstance.greenNode.getWorldPosition(tmpWorldPos);
      dropLights[glbInstance.lightIndex].position.copy(tmpWorldPos);
    }
  }

  return { updateDropBlocks, giantPositions, allPositions: placedFootprints, footprints: placedFootprints };
}

async function main() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000005);
  const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.1, 1200);
  const gl = new THREE.WebGLRenderer({ antialias: true });
  gl.setSize(innerWidth, innerHeight);
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(gl.domElement);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    gl.setSize(innerWidth, innerHeight);
  });

  // No hemisphere/ambient fill — FIELD_LIGHTS/ROVER_LIGHTS/headlight are the
  // scene's only illumination, intentionally.
  const starlight = new THREE.DirectionalLight(0x8fa5ff, 0.1);
  starlight.position.set(60, 90, 40);
  scene.add(starlight, starlight.target);
  scene.add(createStarfield(2600, 450, 820));

  const terrain = buildTerrain();
  terrain.receiveShadow = true;
  scene.add(terrain);
  const { updateDropBlocks, giantPositions, allPositions, footprints } = await buildLogoInstances(scene);
  const { findBlocker, stats: avoidanceStats } = buildObstacleAvoidance(footprints);

  function pickNextIndex(positions, excludeIndex) {
    if (positions.length <= 1) return 0;
    let next;
    do {
      next = Math.floor(Math.random() * positions.length);
    } while (next === excludeIndex);
    return next;
  }
  /** Spawns a wanderer just outside positions[startIndex]'s avoidance edge
   *  (never at its center, which is a degenerate zero-vector case for the
   *  avoidance math) with an initial destination already picked. */
  function createWanderer(spec, positions, startIndex) {
    const start = positions[startIndex] ?? { x: 0, z: 0, radius: 0 };
    const spawnDist = (start.radius ?? 0) + AVOIDANCE_CLEARANCE + 5;
    const spawnAngle = Math.random() * Math.PI * 2;
    const spawnX = start.x + Math.cos(spawnAngle) * spawnDist;
    const spawnZ = start.z + Math.sin(spawnAngle) * spawnDist;

    const light = new THREE.PointLight(spec.color, spec.intensity, spec.distance, 2);
    if (spec.shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(512, 512);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 80;
    }
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(spec.markerRadius, 16, 12),
      new THREE.MeshBasicMaterial({ color: spec.color }),
    );
    const group = new THREE.Group();
    group.add(light, marker);
    group.position.set(spawnX, terrainHeight(spawnX, spawnZ) + spec.height, spawnZ);
    scene.add(group);
    return {
      spec,
      group,
      targetIndex: pickNextIndex(positions, startIndex),
      detour: null,
      recentDetours: [],
      avoidEscalation: 0,
    };
  }
  const fieldLights = FIELD_LIGHTS.map((spec, i) => createWanderer(spec, allPositions, i % allPositions.length));
  const roverLights = ROVER_LIGHTS.map((spec, i) => createWanderer(spec, giantPositions, i % giantPositions.length));

  // First-person, no visible ship. headlight rides on the camera as a
  // forward-facing SpotLight (target-based direction, not rotation) so the
  // player is a moving light source too.
  scene.add(camera);
  const headlight = new THREE.SpotLight(0xbfe8ff, 600, 130, 0.45, 0.15, 2);
  headlight.position.set(0, -0.3, -1); // slightly ahead of and below the eye
  const headlightTarget = new THREE.Object3D();
  headlightTarget.position.set(0, -0.3, -20);
  camera.add(headlightTarget);
  headlight.target = headlightTarget;
  headlight.castShadow = true;
  headlight.shadow.mapSize.set(1024, 1024);
  headlight.shadow.camera.near = 0.5;
  headlight.shadow.camera.far = 130;
  camera.add(headlight);

  const startZ = TERRAIN_HALF * 0.7;
  const flyPos = new THREE.Vector3(0, terrainHeight(0, startZ) + 16, startZ);
  let yaw = 0;
  let pitch = -0.18;
  camera.position.copy(flyPos);

  // --- HUD ---
  const hud = document.createElement('div');
  hud.style.cssText =
    'position: fixed; top: 12px; left: 12px; z-index: 9999; font: 13px/1.5 monospace; ' +
    'color: #cfe; background: rgba(0,0,0,0.45); padding: 8px 12px; border-radius: 6px; pointer-events: none;';
  hud.textContent = 'speck — logo flight';
  document.body.appendChild(hud);

  const lookPrompt = document.createElement('div');
  lookPrompt.style.cssText =
    'position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 9999; ' +
    'font: 12px/1.4 monospace; color: #fff; background: rgba(0,0,0,0.5); padding: 4px 10px; ' +
    'border-radius: 4px; pointer-events: none; text-align: center;';
  lookPrompt.textContent = isTouch
    ? 'Desktop only — WASD + mouse-look to fly'
    : 'Click to fly · WASD move · mouse look · Space/Shift up/down';
  document.body.appendChild(lookPrompt);

  const totalLightCount = FIELD_LIGHTS.length + LOGO_COUNT + ROVER_LIGHTS.length + 1;
  const shadowLightCount = FIELD_LIGHTS.filter((spec) => spec.shadow).length + 1;
  const debugEl = document.createElement('div');
  debugEl.style.cssText =
    'position: fixed; top: 12px; right: 12px; z-index: 9999; font: 12px/1.5 monospace; ' +
    'color: #0f0; background: rgba(0,0,0,0.5); padding: 6px 10px; border-radius: 4px; ' +
    'pointer-events: none; white-space: pre; text-align: right;';
  document.body.appendChild(debugEl);

  const input = new InputBuffer({
    moveForward: [{ device: 'keyboard', code: 'KeyW' }],
    moveBack: [{ device: 'keyboard', code: 'KeyS' }],
    moveLeft: [{ device: 'keyboard', code: 'KeyA' }],
    moveRight: [{ device: 'keyboard', code: 'KeyD' }],
    moveUp: [{ device: 'keyboard', code: 'Space' }],
    moveDown: [{ device: 'keyboard', code: 'ShiftLeft' }, { device: 'keyboard', code: 'ShiftRight' }],
  });

  if (!isTouch) {
    gl.domElement.addEventListener('pointerdown', () => {
      if (document.pointerLockElement !== gl.domElement) gl.domElement.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      lookPrompt.style.display = document.pointerLockElement === gl.domElement ? 'none' : '';
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== gl.domElement) return;
      yaw -= e.movementX * MOUSE_LOOK_SENSITIVITY;
      pitch = THREE.MathUtils.clamp(pitch - e.movementY * MOUSE_LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
    });
  }

  const velocity = new THREE.Vector3();
  const forwardVec = new THREE.Vector3();
  const rightVec = new THREE.Vector3();
  const targetVelocity = new THREE.Vector3();
  const flyQuat = new THREE.Quaternion();

  function updateFlight(dt) {
    flyQuat.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    forwardVec.set(0, 0, -1).applyQuaternion(flyQuat);
    rightVec.set(1, 0, 0).applyQuaternion(flyQuat);

    let fwdInput = 0;
    let strafeInput = 0;
    let vertInput = 0;
    if (input.isDown('moveForward')) fwdInput += 1;
    if (input.isDown('moveBack')) fwdInput -= 1;
    if (input.isDown('moveRight')) strafeInput += 1;
    if (input.isDown('moveLeft')) strafeInput -= 1;
    if (input.isDown('moveUp')) vertInput += 1;
    if (input.isDown('moveDown')) vertInput -= 1;

    targetVelocity
      .copy(forwardVec)
      .multiplyScalar(fwdInput * FLY_FORWARD_SPEED)
      .addScaledVector(rightVec, strafeInput * FLY_STRAFE_SPEED)
      .addScaledVector({ x: 0, y: 1, z: 0 }, vertInput * FLY_VERTICAL_SPEED);

    velocity.lerp(targetVelocity, 1 - Math.exp(-FLY_RESPONSIVENESS * dt));
    flyPos.addScaledVector(velocity, dt);
    flyPos.x = THREE.MathUtils.clamp(flyPos.x, -BOUNDARY_XZ, BOUNDARY_XZ);
    flyPos.z = THREE.MathUtils.clamp(flyPos.z, -BOUNDARY_XZ, BOUNDARY_XZ);
    const minY = terrainHeight(flyPos.x, flyPos.z) + GROUND_CLEARANCE;
    flyPos.y = THREE.MathUtils.clamp(flyPos.y, minY, MAX_ALTITUDE);

    camera.position.copy(flyPos);
    camera.quaternion.copy(flyQuat);
  }

  /** Steers each wanderer toward its destination or active detour,
   *  re-checking findBlocker every step and replacing the detour the
   *  instant something new is in the way. recentDetours stops that from
   *  turning into a back-and-forth loop between two nearby points. */
  function updateWanderers(list, positions, dt) {
    for (const wanderer of list) {
      const target = positions[wanderer.targetIndex];
      const pos = wanderer.group.position;

      if (!wanderer.detour) {
        const tdx = target.x - pos.x;
        const tdz = target.z - pos.z;
        if (Math.hypot(tdx, tdz) < target.radius + AVOIDANCE_CLEARANCE + DESTINATION_ARRIVAL_MARGIN) {
          wanderer.targetIndex = pickNextIndex(positions, wanderer.targetIndex);
          wanderer.recentDetours.length = 0;
          wanderer.avoidEscalation = 0;
          continue;
        }
      }

      let aim = wanderer.detour ?? target;
      let dx = aim.x - pos.x;
      let dz = aim.z - pos.z;
      let dist = Math.hypot(dx, dz);
      if (wanderer.detour && dist < WAYPOINT_ARRIVAL_DISTANCE) {
        wanderer.detour = null;
        aim = target;
        dx = aim.x - pos.x;
        dz = aim.z - pos.z;
        dist = Math.hypot(dx, dz) || 1e-6;
      }
      const desiredX = dx / dist;
      const desiredZ = dz / dist;

      const blocker = findBlocker(pos.x, pos.y, pos.z, desiredX, desiredZ, dist);
      if (blocker) {
        const searchRadius = blocker.avoidRadius + wanderer.avoidEscalation;
        const result = chooseDetourPoint(pos.x, pos.z, blocker.x, blocker.z, searchRadius, desiredX, desiredZ, wanderer.recentDetours);
        if (result) {
          wanderer.detour = result.point;
          wanderer.avoidEscalation = result.escalate
            ? Math.min(wanderer.avoidEscalation + AVOID_ESCALATION_STEP, MAX_AVOID_ESCALATION)
            : 0;
        } else {
          // No valid tangent (pos already inside the search circle) — just head straight away.
          const awayLen = Math.hypot(pos.x - blocker.x, pos.z - blocker.z) || 1e-6;
          wanderer.detour = {
            x: pos.x + ((pos.x - blocker.x) / awayLen) * searchRadius,
            z: pos.z + ((pos.z - blocker.z) / awayLen) * searchRadius,
          };
          wanderer.avoidEscalation = 0;
        }
        wanderer.recentDetours.push(wanderer.detour);
        if (wanderer.recentDetours.length > RECENT_DETOURS_LIMIT) wanderer.recentDetours.shift();
        aim = wanderer.detour;
        dx = aim.x - pos.x;
        dz = aim.z - pos.z;
        dist = Math.hypot(dx, dz) || 1e-6;
      }

      const step = Math.min(dist, wanderer.spec.speed * dt);
      const x = pos.x + (dx / dist) * step;
      const z = pos.z + (dz / dist) * step;
      pos.set(x, terrainHeight(x, z) + wanderer.spec.height, z);
    }
  }

  // --- Main loop ---
  const FIXED_DT = 1 / 60;
  const fixedStep = new FixedStep(FIXED_DT, 5);
  let last = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  let fpsTimer = 0;

  function frame(now) {
    const dt = (now - last) / 1000;
    last = now;

    fixedStep.advance(dt, (fixedDt) => {
      input.update();
      updateFlight(fixedDt);
      updateWanderers(fieldLights, allPositions, fixedDt);
      updateWanderers(roverLights, giantPositions, fixedDt);
    });

    updateDropBlocks(dt); // decorative-only, runs on real dt not the fixed step

    gl.render(scene, camera);

    fpsAcc += dt;
    fpsFrames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      const fps = Math.round(fpsFrames / fpsAcc);
      const info = gl.info.render;
      debugEl.textContent =
        `${fps} fps\n` +
        `${info.calls} calls  ${(info.triangles / 1000).toFixed(1)}k tris\n` +
        `${totalLightCount} lights  ${shadowLightCount} shadowed\n` +
        `avoid queries ${avoidanceStats.queries}  last ${avoidanceStats.lastCandidates}  Σ ${avoidanceStats.totalCandidates}`;
      fpsAcc = 0;
      fpsFrames = 0;
      fpsTimer = 0;
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
