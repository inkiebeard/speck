import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity } from '../core/entity';
import { ArrayComponentStore } from '../core/component-store';
import { TransformStore } from '../components/transform';

/** The component `addDynamicBox` stores per entity — a handle into Rapier's own state. */
export interface BodyHandle {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

/**
 * Which event channels a collider should report — both default `true`
 * (matching Rapier's own event cost being opt-in per collider, but every
 * `add*` here turning both on unconditionally until this option existed).
 * Each channel Rapier tracks isn't free: `collisions` costs it start/stop
 * bookkeeping on every touching pair every step, `contactForces` costs it a
 * force sum + threshold check per contact every step — both keep being paid
 * every step for every contact regardless of whether anything ever reads
 * them. Turn off whichever channel a caller's `drainCollisions`/
 * `drainContactForces` usage doesn't actually drain — cheap in isolation,
 * but adds up across thousands of resting contacts in a settled pile.
 */
export interface ColliderEvents {
  collisions?: boolean;
  contactForces?: boolean;
}

function activeEvents(events: ColliderEvents | undefined): RAPIER.ActiveEvents {
  let flags = 0;
  if (events?.collisions ?? true) flags |= RAPIER.ActiveEvents.COLLISION_EVENTS;
  if (events?.contactForces ?? true) flags |= RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS;
  return flags;
}

/**
 * Wraps a Rapier world. The RigidBody component is just a handle into Rapier
 * (an ArrayComponentStore<BodyHandle>) — Rapier owns the simulation state, we
 * own the presentation state. Each tick: step Rapier, then copy every body's
 * translation + rotation back into the SoA TransformStore, which the renderer
 * then reads. That copy-back is the whole integration.
 *
 * Uses @dimforge/rapier3d-compat so the wasm side-loads via `await RAPIER.init()`
 * with no bundler/server config. For production, swap to @dimforge/rapier3d
 * (init-free, faster load) once your build serves the .wasm.
 */
export class PhysicsSystem {
  /** The underlying Rapier world, for anything this wrapper doesn't expose
   *  (creating joints, raycasts, custom colliders, ...). */
  world!: RAPIER.World;
  private events!: RAPIER.EventQueue;
  private colliderEntity = new Map<number, Entity>();

  private constructor(private bodies: ArrayComponentStore<BodyHandle>) {}

  /** Initializes Rapier's wasm and creates the world. Await once, up front,
   *  before adding any bodies. */
  static async create(
    bodies: ArrayComponentStore<BodyHandle>,
    gravity: { x: number; y: number; z: number } = { x: 0, y: -9.81, z: 0 },
  ): Promise<PhysicsSystem> {
    await RAPIER.init();
    const sys = new PhysicsSystem(bodies);
    sys.world = new RAPIER.World(gravity);
    sys.events = new RAPIER.EventQueue(true);
    return sys;
  }

  /**
   * Create a dynamic box body seeded from the entity's current transform.
   * Rapier's own body defaults have zero linear/angular damping, i.e. no drag
   * — fine for a single falling box, but a dense pile of thousands can jitter
   * on unstable resting contacts indefinitely with nothing to bleed that
   * energy off, which means those bodies never fall asleep and stay in the
   * solver's working set every step, forever. Some damping by default (not
   * zero) is what lets a pile actually settle and sleep.
   *
   * `contactForceThreshold` (default 40, at unit density/size) is a coarse
   * floor, not a "this is a serious hit" cutoff — it's chosen to sit above
   * one box's own resting weight (~half its mass × gravity per supporting
   * contact, ~5N for a 1×1×1 box) so ordinary stacking pressure doesn't
   * generate contact-force events at all, saving the cost of drain callers
   * having to filter it back out themselves. It's still low enough that
   * routine settling in a many-layer-deep pile can cross it. A caller that
   * wants to react only to *genuinely* forceful impacts (a bump sound that
   * should stay quiet for a pile just being a pile) should apply its own,
   * stricter magnitude check on top of `drainContactForces`'s output — see
   * the matching-game walkthrough for exactly that.
   */
  addDynamicBox(
    e: Entity,
    transforms: TransformStore,
    half: { x: number; y: number; z: number } = { x: 0.5, y: 0.5, z: 0.5 },
    damping: { linear: number; angular: number } = { linear: 0.4, angular: 0.6 },
    contactForceThreshold = 40,
    events?: ColliderEvents,
  ): void {
    const slot = transforms.slotOf(e);
    const raw = transforms.raw;
    const o = slot * transforms.stride;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(raw[o], raw[o + 1], raw[o + 2])
      .setLinearDamping(damping.linear)
      .setAngularDamping(damping.angular);
    const body = this.world.createRigidBody(desc);
    const colliderDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setActiveEvents(activeEvents(events))
      .setContactForceEventThreshold(contactForceThreshold);
    const collider = this.world.createCollider(colliderDesc, body);
    this.bodies.add(e, { body, collider });
    this.colliderEntity.set(collider.handle, e);
  }

  /** A fixed, thin box collider spanning `halfExtents` at height `y` — the
   *  common case of `addStaticBox` for a flat floor. */
  addStaticGround(
    y = 0,
    halfExtents: { x: number; z: number } = { x: 50, z: 50 },
    contactForceThreshold = 40,
    events?: ColliderEvents,
  ): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, y, 0));
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, 0.1, halfExtents.z)
      .setActiveEvents(activeEvents(events))
      .setContactForceEventThreshold(contactForceThreshold);
    this.world.createCollider(desc, body);
  }

  /** A fixed box collider anywhere — walls, a ceiling, an arbitrary boundary.
   *  `addStaticGround` is just this shape specialized to a thin floor. */
  addStaticBox(
    position: { x: number; y: number; z: number },
    half: { x: number; y: number; z: number },
    contactForceThreshold = 40,
    events?: ColliderEvents,
  ): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z),
    );
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setActiveEvents(activeEvents(events))
      .setContactForceEventThreshold(contactForceThreshold);
    this.world.createCollider(desc, body);
  }

  /**
   * Removes the entity's rigid body (and its collider) from the Rapier world.
   * Doesn't touch the `bodies` store — that's `World.despawn`'s job via the
   * generic sink cleanup. Call this *before* `world.despawn(e)`, while the
   * store still has the handle; call order is what makes the ownership
   * boundary between engine and physics explicit, rather than hiding the
   * cleanup behind an event handler that would run after the handle is
   * already gone (`World.despawn` strips every store, including this one,
   * before `entity:despawned` is even emitted).
   */
  removeBody(e: Entity): void {
    const handle = this.bodies.get(e);
    if (handle === undefined) return;
    this.colliderEntity.delete(handle.collider.handle);
    this.world.removeRigidBody(handle.body);
  }

  /**
   * Step the simulation by `dt`, then write body transforms back into the SoA
   * store. Call this with a *fixed* `dt` (see `FixedStep`) rather than a raw
   * per-frame delta — Rapier's stability assumptions hold for a consistent
   * timestep, and a step size that varies with render framerate makes the
   * simulation's rate depend on display Hz, not real time.
   */
  update(transforms: TransformStore, dt: number): void {
    this.world.timestep = dt;
    this.world.step(this.events);

    // `entities`/`values` are index-aligned by construction (ArrayComponentStore
    // keeps its data array parallel to the same SparseSet dense order) — walking
    // both in lockstep gets this tick's handle directly, rather than the
    // `bodies.get(e)` this used to do, which re-derives the same slot from `e`
    // through another sparse lookup this loop already has for free.
    const entities = this.bodies.entities;
    const handles = this.bodies.values;
    const raw = transforms.raw;
    const stride = transforms.stride;

    for (let i = 0; i < entities.length; i++) {
      const slot = transforms.slotOf(entities[i]);
      if (slot === -1) continue;

      const p = handles[i].body.translation();
      const q = handles[i].body.rotation();
      const o = slot * stride;
      raw[o] = p.x; raw[o + 1] = p.y; raw[o + 2] = p.z;
      raw[o + 3] = q.x; raw[o + 4] = q.y; raw[o + 5] = q.z; raw[o + 6] = q.w;
    }
  }

  /**
   * Delivers collision-*start* events from the step `update()` just ran (stop
   * events are ignored — "two things began touching" is the useful signal
   * for reactive effects like a bump sound; "stopped touching" rarely is).
   * Each side is resolved to the entity that owns it, where there is one —
   * static geometry (a wall, the ground) and anything already despawned this
   * frame resolve to `undefined`, so a caller only wanting entity-vs-entity
   * bumps should check both sides, and one wanting *any* bump (walls
   * included) should check either. Call after `update()`.
   */
  drainCollisions(onCollision: (a: Entity | undefined, b: Entity | undefined) => void): void {
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      onCollision(this.colliderEntity.get(h1), this.colliderEntity.get(h2));
    });
  }

  /**
   * Delivers contact-*force* events from the step `update()` just ran: pairs
   * whose summed contact force exceeded the `contactForceThreshold` set when
   * their colliders were created (`addDynamicBox`/`addStaticBox`/
   * `addStaticGround`, default 40). Unlike `drainCollisions` ("these two
   * touched"), this gives a magnitude — use it to scale a reactive effect by
   * impact strength (a bump sound's volume, a screen shake) instead of
   * firing it uniformly for every contact, and to filter out routine
   * resting/settling contact (a box's own weight on the pile below it) from
   * genuine impacts, which the threshold does before this ever fires.
   */
  drainContactForces(onForce: (a: Entity | undefined, b: Entity | undefined, magnitude: number) => void): void {
    this.events.drainContactForceEvents((event) => {
      onForce(this.colliderEntity.get(event.collider1()), this.colliderEntity.get(event.collider2()), event.totalForceMagnitude());
    });
  }

  /** Resolves a raw Rapier collider handle (as returned by the narrow-phase
   *  queries below) back to the entity that owns it, where there is one. */
  entityOfCollider(handle: number): Entity | undefined {
    return this.colliderEntity.get(handle);
  }

  /**
   * Every collider currently touching `e`'s, as raw collider handles —
   * resolve via `entityOfCollider`, or pass to `world.contactPair`/
   * `contactBetween` for the full manifold. A poll, not an event: call it
   * when you need it (e.g. once per tick for entities a `SpatialGrid` query
   * already narrowed down), not every tick for everything. Not used by
   * `drainCollisions`/`drainContactForces` above or anywhere in this engine
   * — a hook for projects with more bespoke collision-response needs than
   * "these touched" or "how hard."
   */
  contactsWith(e: Entity, onContact: (otherCollider: number) => void): void {
    const handle = this.bodies.get(e);
    if (handle === undefined) return;
    this.world.contactPairsWith(handle.collider, (other) => onContact(other.handle));
  }

  /**
   * The full contact manifold between two specific entities, if they're
   * currently touching: per-contact-point positions (local to each
   * collider), the shared contact normal, and per-point impulses — enough
   * for bespoke response (sparks at the exact contact point, deflection
   * based on normal). See `contactsWith` for the "who is e touching" half of
   * this; combine the two to go from "some collider handle" to "the full
   * geometry of my contact with that specific entity."
   */
  contactBetween(
    a: Entity,
    b: Entity,
    onContact: (manifold: RAPIER.TempContactManifold, flipped: boolean) => void,
  ): void {
    const ha = this.bodies.get(a);
    const hb = this.bodies.get(b);
    if (ha === undefined || hb === undefined) return;
    this.world.contactPair(ha.collider, hb.collider, onContact);
  }
}
