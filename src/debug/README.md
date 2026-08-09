# Debug

`DebugOverlay`: a small top-right `<div>` showing fps/frame time plus
`world.entities.count` and per-store sizes. Browser-only, opt-in — nothing
runs unless you construct one.

## Best practices

- Treat `World.storeSizes()`/`entities.count` as the actual extension
  point, not the `<div>` itself. Once plain text stops being enough (you
  want a graph, or a full devtools-style panel), read the same two
  accessors from your own UI rather than trying to grow this class into
  one.

## Trade-offs

- Plain text in a `<div>` vs. a real stats framework: zero setup and zero
  dependencies, at the cost of no historical graphing — the fps number is
  only a rolling average over `sampleSize` frames (default 60), not a
  chart you can look back through.

## Gotchas

- Call `tick()` once per **rendered** frame, not once per fixed step. A
  fixed step can run zero, one, or several times per rendered frame
  depending on how much real time elapsed — calling `tick()` from inside a
  fixed-step callback instead of the outer render loop will make the fps
  number lie (either inflated or deflated depending on how many fixed
  steps happened to run that frame).
