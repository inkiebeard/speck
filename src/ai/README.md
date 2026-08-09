# AI

Intentionally rudimentary boilerplate: behavior trees (`behavior-tree.ts`),
a per-entity tree-ticking system (`ai-system.ts`), and separation+cohesion
flocking (`flocking.ts`). Meant to be overridden per project, not used
as-is. See the top-level README for the full API description.

## Best practices

- Treat everything here as a starting skeleton. The node set, the
  scheduling in `createAiSystem`, and flocking's two-behavior scope are all
  deliberately minimal — extend or replace rather than expecting this to
  grow into a full framework on its own.
- Add new behavior-tree node types (parallel, cooldowns, decorators) as
  more functions of the same `(ctx: C) => 'success' | 'failure' | 'running'`
  shape that `sequence`/`selector`/`invert`/`action`/`condition` already
  use, rather than extending a fixed node-type enum that doesn't exist.
- Build missing steering behaviors (flocking alignment, seek, flee, ...) as
  more plain functions following `separationCohesionSteer`'s pattern
  (a `SpatialGrid` neighbor query in, a steering vector out) — call them
  from inside your own `action()` node rather than expecting them wired
  into `AiState`/`createAiSystem` automatically.

## Trade-offs

- `createAiSystem` does no scheduling or interruption — every entity's tree
  root ticks every frame, unconditionally. That's simple and predictable
  for a small-to-moderate population, but a large population of complex
  trees will want staggered/budgeted ticking (not every entity's AI needs
  to reevaluate every single frame), which isn't provided and has to be
  layered on top.
- `separationCohesionSteer` needs a velocity component this engine doesn't
  ship, by design — the engine doesn't assume one particular movement/
  velocity-integration shape for every project. Bring your own velocity
  component and read it in your own steering/movement system.

## Gotchas

- A `condition`/`action` node that throws, or has a code path that doesn't
  return one of `'success'`/`'failure'`/`'running'` (an accidental early
  `return` with no value, say), will silently break whatever
  `sequence`/`selector` composition sits above it — there's no runtime
  validation of node return values, so this fails quietly rather than
  loudly.
