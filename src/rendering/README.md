# Rendering

`InstancedRenderer` (instanced draw calls + raycast-to-entity picking),
`ParticleSystem` (a non-entity particle burst pool), `GltfLoader` (a
caching wrapper over `GLTFLoader`). Peer dep: `three`. See the top-level
README for the full API description.

## Best practices

- Group visually-identical entities under one type registered once via
  `registerType` — that's what turns N entities into one draw call per
  type, regardless of N.
- Call `sync()` every *rendered* frame after any transform/type change, not
  from inside the fixed-step callback — it's a render-side operation and
  doesn't need to run more or less often than the screen actually updates.
- For picking, resolve the globally *nearest* hit across every registered
  type's mesh, not the first type (in registration order) with any hit at
  all — see the gotcha below.
- Use `ParticleSystem` for high-churn, no-identity-needed effects (bursts,
  confetti, impact sparks) — not as a lighter-weight substitute for
  entities that need to be looked up or modified after they spawn. It has
  no `Entity` handles at all.
- With `GltfLoader`, let the URL-keyed cache do its job — call `load`/
  `instantiate` per use site rather than hand-rolling your own cache on top;
  repeated calls for the same URL already share one fetch+parse.

## Trade-offs

- Instancing buys draw-call count at the cost of per-type material/geometry
  uniformity. Entities that need genuinely unique materials per instance
  (not just a color tint) don't fit this model — `setInstanceColor` is a
  multiply-tint over the type's shared material, not a per-instance
  material swap.
- `ParticleSystem`'s fixed pool (`capacity`) silently drops `emit()` calls
  past capacity rather than growing to absorb a spike. That's bounded
  cost, deliberately, over the alternative of a burst that could grow the
  pool arbitrarily — size `capacity` to the largest burst you actually
  expect, not the common case.
- `GltfLoader.instantiate()`'s clone is a plain `Object3D.clone(true)`,
  correct for static props only. Skinned/animated meshes share bone
  bindings and need `SkeletonUtils.clone` instead (`three/examples/jsm/utils/
  SkeletonUtils.js`) — deliberately not pulled in by default so a
  static-prop-only project doesn't pay for it.

## Gotchas

- A picking loop that resolves to the first type (in loop order) with *any*
  hit, rather than the nearest hit across *all* types, will silently mispick
  under a dense or overlapping instance pile — worse at shallow viewing
  angles, where a single ray passes through many instances of different
  types. Always compare `hit.distance` across every type's raycast result
  before picking (see `raycastPick` in matching-game.js).
- `setInstanceColor`'s first call on a given mesh implicitly allocates that
  mesh's `instanceColor` buffer, which three.js zero-fills — every *other*
  instance would read as black (a `(0,0,0)` multiplier) for at least a
  frame unless back-filled to neutral immediately, which `InstancedRenderer`
  already does on that first allocation. Reimplementing instance tinting
  outside this class needs the same back-fill or you'll see a black flash.
- Any `three/examples/jsm/*` module — `GLTFLoader` included — imports
  `"three"` as a **bare specifier** internally. The page needs an import
  map (`{"imports":{"three": "<url>"}}`) even if nothing else in your own
  code imports three that way. Without it, loading fails opaquely with
  `Failed to resolve module specifier "three"` the moment the module graph
  reaches it — not at your own import line, which makes it non-obvious to
  trace back. See `examples/matching-game.html`'s import map, or
  `tests/perf/harness.html`, for the pattern.
