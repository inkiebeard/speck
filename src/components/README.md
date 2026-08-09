# Components

`TransformStore`: the one hot-path component every other system (physics,
rendering, spatial queries) reads or writes every frame — position,
quaternion, and scale interleaved into one `Float32Array` at stride 10.

## Best practices

- Use `TransformStore` for any entity a renderer/physics/movement system
  streams every frame. Don't add ad-hoc position fields to a cold
  `ArrayComponentStore` component when this already exists and every other
  system already expects to find position/rotation/scale here.
- Read `raw`/`stride`/`slotOf` directly in your own hot loops rather than
  going through per-field getters — that's the whole point of exposing the
  typed array; a getter/setter per field would reintroduce the overhead
  this store exists to avoid.

## Trade-offs

- The fixed 10-float stride (position, quaternion, scale) is what makes
  this a true SoA hot path — cheap to add a field an entity doesn't happen
  to need (unused scale on a 2D-feeling game, say), expensive/awkward to
  store something that varies wildly in shape per entity type. A component
  that isn't "where/how big/which way is this thing" belongs in its own
  `ArrayComponentStore`, not bolted onto this one.

## Gotchas

- `TransformStore.add(e, ...)` **overwrites the whole row** — position,
  rotation, and scale together — even if you only meant to update one
  field. Calling it with only position args resets rotation/scale back to
  their defaults (identity rotation, unit scale), silently discarding
  whatever was set before. If you only want to move an entity, read the
  existing values out of `raw` at its slot first and pass them straight
  back through for the fields you're not changing.
