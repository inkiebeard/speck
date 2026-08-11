<img src="logo.webp" width="256" alt="speck logo" />

# SPECK

A tiny, data-oriented game engine layered on top of Three.js. Built to keep
~10k lightweight entities on screen at once.

Three.js and Rapier are **peer dependencies**, not bundled. The lib side-loads
alongside them.

## Module docs

This README covers architecture — what each piece *is* and how they fit
together. Each `src/` subdirectory has its own short `README.md` alongside
the code for the practical layer this one doesn't: best practices,
trade-offs, and gotchas specific to that part of the stack.

| Directory | Covers |
| --- | --- |
| [`src/core/`](src/core/README.md) | ECS core, `World`, `EventQueue`, `SpatialGrid`, `FixedStep`, `TweenRunner`, `Preloader`, `SimplexNoise` |
| [`src/components/`](src/components/README.md) | `TransformStore` |
| [`src/physics/`](src/physics/README.md) | `PhysicsSystem` (Rapier adapter) |
| [`src/rendering/`](src/rendering/README.md) | `InstancedRenderer`, `ParticleSystem`, `GltfLoader` |
| [`src/audio/`](src/audio/README.md) | `SoundSystem` |
| [`src/input/`](src/input/README.md) | `InputBuffer` |
| [`src/ai/`](src/ai/README.md) | Behavior trees, `AiState`/`createAiSystem`, flocking |
| [`src/debug/`](src/debug/README.md) | `DebugOverlay` |

## Architecture

1. **ECS core** — entities are generational integer handles (`Entity`).
   Components live in packed arrays via `SparseSet`: dense iteration,
   swap-remove, no holes. `ArrayComponentStore<T>` holds cold/heterogeneous
   data (a body handle, a type id); `TransformStore` is the hot path — one
   interleaved `Float32Array` (stride 10: position, quaternion, scale) a
   system streams straight through. `EntityManager` also mints a stable
   string id (`idOf`/`entityOf`) — use that, not the raw `Entity` handle,
   for anything that outlives a session (a save file, a network message, a
   level editor), since `Entity` packs a live slot index that can point at
   a recycled entity if persisted by hand.
2. **Event queue** (`EventQueue`) — systems `emit()`, `drain()` delivers to
   handlers. Cascades (a match → a removal → a settle) resolve within one
   tick, bounded by `maxPasses`, in deterministic order.
3. **Rendering** (`src/rendering/`)
   - `InstancedRenderer` — one `InstancedMesh` per visual type, one draw
     call per type. Tracks instanceId → entity each frame so raycast
     picking resolves back to an entity.
   - `ParticleSystem` — deliberately *not* entity-based: a flat pool of
     typed arrays rendered as one `THREE.Points`, with a small custom
     shader for real per-vertex alpha fade and soft circular points. Not
     driven by `World.step()` — call `update(dt)` yourself.
   - `GltfLoader` — caches a parsed `.gltf`/`.glb` by URL; `instantiate()`
     clones the cached scene graph cheaply per placement.
4. **Physics** (`PhysicsSystem`) — wraps a Rapier world; each tick it
   steps, then copies body transforms back into `TransformStore`.
   `removeBody(e)` before `world.despawn(e)` — despawn strips the body
   handle store too, so calling it the other way round leaves nothing to
   remove. `addStaticBox`/`addStaticGround` for fixed geometry;
   `addDynamicBox` applies non-zero damping by default (Rapier's own
   default is zero), so a resting pile actually settles instead of
   jittering forever. Collision/contact-force state comes back three ways:
   `drainCollisions`/`drainContactForces` (per-step event delivery) or
   `contactsWith`/`contactBetween` (polled, full contact manifold).
5. **Spatial index** (`SpatialGrid`) — uniform hash grid for neighbor
   queries (flocking, AI target acquisition, broad-phase). Register via
   `world.registerSpatialGrid(grid, transforms)` and `World.step()`
   rebuilds it from `TransformStore` before systems run each tick; any
   system can then call `grid.queryRadius(...)`. See "Why a grid, not a
   tree" below.
6. **AI** (`src/ai/`) — intentionally minimal, meant to be overridden:
   `BehaviorNode<C>` tree primitives (`sequence`/`selector`/`invert`,
   `action`/`condition`); `AiState<B>` + `createAiSystem` (ticks a tree +
   blackboard per entity once a frame, no scheduling/interruption);
   `separationCohesionSteer` (separation + cohesion only — alignment needs
   a velocity component this engine doesn't ship). See
   `examples/complex-entities/wizard-survival.js` for all three combined
   into skeleton enemy AI.
7. **Debug overlay** (`DebugOverlay`) — opt-in top-right `<div>` showing
   fps/frame time plus `world.entities.count` and per-store sizes
   (`World.storeSizes()`). `tick()` once per rendered frame, `destroy()`
   to remove.
8. **Tweens** (`TweenRunner`) — short, self-contained timed animations, not
   entity-specific: `play({ duration, onUpdate(t), onComplete? })`, `t`
   eased into `[0, 1]`. Register via `world.registerTweenRunner(runner)`
   (advances after events drain each `step()`) or call `update(dt)`
   yourself.
9. **Fixed-timestep loop** (`FixedStep`) — decouples simulation from render
   rate. `advance(realDt, step)` calls `step(fixedDt)` zero or more times
   at a fixed size; `maxStepsPerFrame` caps catch-up after a stall so a
   large `realDt` can't demand a burst of steps that blows the frame
   budget and falls further behind. `alpha` (fraction of a step banked but
   not yet simulated) is exposed for render interpolation, not yet wired
   up — see Roadmap.
10. **Sound** (`SoundSystem`) — thin wrapper over
    `THREE.Audio`/`AudioListener`: attaches a listener to the camera,
    resumes the `AudioContext` after the browser's autoplay policy
    suspends it, and stops overlapping cues from clipping via admission
    control — dedup by `id`, priority-based voice stealing at `maxVoices`,
    a `queueTTL` so a stale request is dropped rather than played late,
    and a master `DynamicsCompressorNode` limiter. `load(url)` /
    `play(buffer, opts)`; buffers can also be synthesized directly (no
    asset needed).
11. **Noise** (`SimplexNoise`, `fbm2D`/`fbm3D`, `poissonDiskSample2D`) —
    dependency-free, seeded procedural generation; Three.js ships none of
    this. Simplex noise (2D/3D) plus fbm layering for terrain-like
    heightmaps/density fields; `poissonDiskSample2D` for blue-noise
    placement (trees, rocks, spawn points) via Bridson's algorithm.
    Seeded through `createRng`, not `Math.random`, so output is
    reproducible from a level seed. Used by
    `examples/dynamic-lighting/logo-flight.js`; correctness covered by
    `tests/noise/`.

## Why the packed layout

A `Map<Entity, {…}>` of objects is correct but scatters each entity across
the heap; iterating thousands every frame chases pointers and stalls the
cache. The interleaved `Float32Array` is contiguous, so the CPU streams
through it directly — `SparseSet` sits on top purely for identity/packing
bookkeeping. The payoff is specific to *many entities each doing cheap
work* (the matching-game example runs `ITEM_COUNT = 3000` with full Rapier
physics on every entity). For entities doing heavier per-entity work, a
plain map is simpler and the cache-locality gains matter less.

## Why a grid, not a tree

`SpatialGrid` buckets entities into fixed-size cells and rebuilds from
scratch every tick, straight from `TransformStore.raw`. A quadtree/octree
adapts better to sparse or uneven worlds, but that adaptivity costs
pointer-heavy nodes that get inserted into, split, and rebalanced —
expensive to redo every frame when most entities move, the common case for
flocking/steering. A grid's rebuild is a single O(n) pass with no node
structure to maintain, so it's the better default for a roughly-uniform,
fully dynamic population. It loses to a tree over very large, mostly-empty
worlds where most cells sit unused — not a concern at this engine's target
scale, but worth reconsidering if the world grows sparse.

## Run

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # emits dist/speck.js + dist/**/*.d.ts
npm run example     # builds, then serves the repo root statically
```

Then open `http://localhost:<port>/examples/matching-game.html`.

## Tests

Playwright, run against the *built* `dist/speck.js` (not source — see
`playwright.config.ts`) via a shared harness that loads it as a real ES
module: `npm test` runs everything; `npm run test:perf` / `npm run
test:noise` scope to one suite. Both rebuild first (`pretest*` hooks).

- `tests/perf/` — scaling benchmarks for hot paths (`TransformStore`-backed
  systems, `SpatialGrid`, `InstancedRenderer`, `PhysicsSystem`). Loose
  ceilings meant to catch a pathological regression, not ordinary
  run-to-run noise.
- `tests/noise/` — correctness tests for `src/core/noise.ts`: determinism
  given a seed, output staying in range, and `poissonDiskSample2D`'s
  minimum-distance guarantee.

## Examples

Each runs `dist/speck.js` directly in the browser, no bundler — three (and
any `three/examples/jsm` addon it uses) resolves to a CDN URL that both the
built bundle and the example script share, so there's only one module
instance. Run `npm run build` first (examples consume `dist/`, not `src/`),
then serve the repo root and open the matching `.html` file.

- **`examples/physics/matching-game.js`** — a ~3000-entity physics
  playground. Drag-orbit the camera; click an item to pick it up (its
  Rapier body toggles `Dynamic` ↔ `KinematicPositionBased`), click a
  second to attempt a match. A match triggers a spiral-in `TweenRunner`
  animation, a synthesized chime, and a `ParticleSystem` confetti burst.
  Covers: instanced rendering + picking, the event queue, tweens,
  procedural audio, particle bursts, `FixedStep`.
- **`examples/dynamic-lighting/logo-flight.js`** — first-person flight
  over `fbm2D`-generated rolling terrain scattered with
  `poissonDiskSample2D`-placed sculptures (the engine's own logo model).
  Colored point lights wander between them using `SpatialGrid`-backed
  tangent-point obstacle avoidance. Covers: noise/terrain generation,
  `SpatialGrid`, GLTF loading.
- **`examples/complex-entities/wizard-survival.js`** — a wizard fending
  off waves of skeletons risen by a necromancer. Skeleton AI is a
  `src/ai/` behavior tree (wander → investigate → chase → attack) ticked
  by `createAiSystem`, with `separationCohesionSteer` flocking so a crowd
  doesn't stack on one tile. Covers: behavior trees, the AI system,
  flocking, the event queue for damage/death.

## Features & Roadmap

**Implemented:** generational-handle ECS core with stable external ids
(`idOf`/`entityOf`) for tooling; bounded, deterministic event cascades;
instanced rendering with raycast picking; a non-entity-based particle burst
effect; a Rapier adapter with static boundaries and explicit body cleanup;
a uniform spatial hash grid; override-first AI boilerplate (behavior
trees, `AiState`/`createAiSystem`, separation+cohesion flocking); seeded
noise/blue-noise placement primitives; a debug overlay; short timed
animations (`TweenRunner`); a fixed-timestep loop; a minimal sound wrapper
with admission control.

**Roadmap:**
- **Render interpolation.** `FixedStep.alpha` is exposed but unused —
  blend the last two simulated transform states for smooth motion when
  render Hz and `FIXED_DT` don't divide evenly.
- **Flocking alignment.** `separationCohesionSteer` deliberately omits
  it — needs a velocity component the engine doesn't ship yet.
- **Level-editor tooling.** `EntityManager.idOf`/`entityOf` were built for
  exactly this (a stable id external tools can hold instead of the raw
  `Entity` handle), but no editor exists yet.
- **rapier3d-compat → rapier3d.** Compat side-loads the wasm via
  `await RAPIER.init()` with no server config (easiest). Swap once the
  build serves the `.wasm`, for init-free/faster loads.
- **Same-tick vs next-tick cascades.** `EventQueue.drain()` currently
  resolves cascades within the tick (bounded by `maxPasses`); revisit if
  that turns out to be the wrong default for a given project.

## License

MIT — see [LICENSE](LICENSE).
