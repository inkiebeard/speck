# Core

The ECS substrate everything else sits on: entities, component storage,
the event queue, `World`, `SpatialGrid`, `FixedStep`, `TweenRunner`,
`Preloader`. See the top-level README for what each piece *is* — this is
about using them well.

## Best practices

- Put hot, per-frame-streamed data (position, velocity) in a typed-array
  store (`TransformStore`, or your own following the same pattern). Put
  cold/heterogeneous data (a body handle, an AI blackboard, a type id) in
  `ArrayComponentStore`. Mixing them the other way loses the cache-locality
  `TransformStore` exists for.
- Hold the raw `Entity` handle only for the current session's live logic.
  For anything that outlives it or crosses a boundary — a save file, a
  network message, a level editor — use `EntityManager.idOf`/`entityOf`'s
  stable string id instead.
- Register systems in the order they should run; `World.step()` runs them
  in registration order, rebuilds the spatial grid (if any) before any of
  them, drains events after all of them, then advances tweens.
- Give `FixedStep` a `maxStepsPerFrame` cap for any step function with an
  expensive worst case (physics chief among them) — see its own doc for why
  the uncapped default can spiral under sustained overload.
- Keep `Preloader` task weights honest. A batch of one huge task and several
  tiny ones will read as "done" prematurely if the tiny ones are weighted
  the same as the huge one.

## Trade-offs

- The packed/dense layout (`SparseSet` + parallel arrays) pays off for
  *many, cheap* entities streamed every frame. For a smaller population
  doing heavier per-entity work, a plain `Map` is simpler and the
  cache-locality win doesn't matter as much — don't force everything through
  this layout by default.
- `SpatialGrid` rebuilds from scratch every tick rather than maintaining
  persistent structure. That's the right call for a fully-dynamic,
  roughly-uniform population (flocking, a level's active enemy set); it's
  worse than a tree for a very large, mostly-empty world where most cells
  sit unused.
- `EventQueue.drain()` resolves cascades within the same tick (bounded by
  `maxPasses`) — a match triggers a removal triggers a settle, all one
  frame. If a project needs next-tick semantics instead (e.g. to guarantee
  ordering against some other next-tick system), that's on top, not a mode
  switch this provides.

## Gotchas

- `World.despawn(e)` strips every registered store's data for `e` **before**
  emitting `entity:despawned` — a handler reacting to that event can't read
  anything the entity had. Do cleanup that needs the old data (like
  `PhysicsSystem.removeBody`) *before* calling `despawn`, not in response to
  it.
- `SpatialGrid.queryRadius` is only cheap when `radius` is in the same
  ballpark as the grid's `cellSize` — a query with a much larger radius
  scans far more cells than the "local neighbor query" case it's built for.
  A query that's effectively unbounded on one axis (e.g. "everyone below a
  given Y, regardless of X/Z") isn't a good fit for a grid at all; a flat
  scan over `TransformStore.raw` is both simpler and cheaper for that shape.
- A `Preloader` task that never calls `reportProgress` sits at 0% until it
  resolves, then jumps straight to 100% — fine alone, but visually
  misleading if it's bundled unweighted alongside tasks that do report
  incrementally.
