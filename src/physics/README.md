# Physics

A thin wrapper over a Rapier world (`PhysicsSystem`). Rapier owns
simulation state; this copies transforms back into the SoA store each tick
and adapts Rapier's event/query APIs to resolve back to `Entity`s. See the
top-level README for the full API description — this is what to actually
watch out for at scale.

## Best practices

- Keep `addDynamicBox`'s non-zero default damping unless you have a
  specific reason to zero it out. It's what lets a dense pile fall asleep;
  Rapier's own default (zero drag) lets unstable resting contacts jitter
  forever, which keeps every one of those bodies in the solver's per-step
  working set indefinitely.
- Disable event channels you don't drain. `addDynamicBox`/`addStaticGround`/
  `addStaticBox` all take an `events` option (`{ collisions?, contactForces?
  }`, both default `true` for backward compatibility) — if your code only
  ever calls `drainContactForces`, pass `{ collisions: false }`. Each active
  channel costs Rapier real per-step bookkeeping for every touching pair,
  whether or not anything ever reads it.
- Reach for `physics.world` directly for anything the wrapper doesn't
  expose — a custom collider shape (a convex hull, a compound shape),
  joints, raycasts. It's public specifically for this; don't contort the
  wrapper's fixed shapes (`addDynamicBox`/`addStaticBox`, both cuboids) to
  fake something else.
- Call `removeBody(e)` *before* `world.despawn(e)`, never after or from a
  handler reacting to despawn — see the gotcha below.

## Trade-offs

- Many independent bodies (needed when entities must be independently
  interactive — pickable, matchable, individually removable) vs. fewer/
  larger colliders (cheaper narrow-phase and solver load): this is a
  per-game design call, not something the wrapper can decide for you. If
  your entities don't need independent physical identity, merging their
  geometry into fewer compound colliders (via `physics.world` directly)
  beats spreading them across more small bodies.
- `contactForceThreshold`'s default (40) is a coarse floor tuned to sit just
  above one box's own resting weight — it filters *routine* stacking
  pressure, not "this is a dramatic hit." A project wanting a stricter
  "was this a genuinely serious impact" signal should layer its own,
  higher threshold on top of `drainContactForces`'s magnitude rather than
  lower the engine-level one (which would let ordinary settling generate
  events again).
- Capping `FixedStep`'s `maxStepsPerFrame` (matching-game.js uses `1`)
  trades real-time accuracy for framerate stability once a single physics
  step already costs more than a frame's budget — the right call for an
  interactive scene that needs to keep rendering, wrong for something that
  must stay in lockstep with real elapsed time (e.g. a networked
  simulation where falling behind has to be caught up, not slowed through).

## Gotchas

- Both `collisions` and `contactForces` default to `true` on every `add*`
  call — a naive `addDynamicBox(e, transforms)` with no `events` argument
  pays for both channels even if your code only ever calls one of
  `drainCollisions`/`drainContactForces` (or neither). This is measurably
  small at moderate scale — verify with the perf suite (`tests/perf/`)
  before assuming it matters for your workload — but costs nothing to
  disable once you know which channel you actually use.
- Rapier already auto-sleeps bodies below a velocity threshold; this
  wrapper doesn't currently expose a way to tune those thresholds, so a
  project that needs different sleep behavior (settle faster or slower than
  Rapier's defaults) has to reach into `physics.world`/raw
  `RigidBodyDesc` directly rather than a `PhysicsSystem` option.
- A kinematic body (a held/picked-up item, a driven obstacle) is never
  itself pushed back by what it hits, and can — if driven hard/fast enough
  in a single step — tunnel a thin dynamic body clean through a thin static
  collider. There's no engine-side fix for this; it's an inherent limit of
  discrete (vs. continuous) collision detection. Mitigate at the game
  layer, e.g. an out-of-bounds recovery pass that teleports anything that
  ends up somewhere it structurally shouldn't be back into play (see
  matching-game.js).
- `removeBody(e)` does **not** touch the `bodies` component store — only
  the Rapier-side rigid body/collider. Call it while the store still holds
  the handle (i.e. before `world.despawn(e)`, which strips the store); doing
  it the other way round, or from an `entity:despawned` handler, leaves
  nothing to look the handle up with.
