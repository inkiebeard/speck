# Audio

`SoundSystem`, a minimal wrapper over `THREE.Audio`/`AudioListener` with
admission control (dedup, priority, TTL, a limiter) so a burst of
simultaneous plays can't sum past clipping. See the top-level README for
the full API description.

## Best practices

- Give a cue an `id` when repeats of it in a tight window are genuinely
  redundant — a generic "something bumped" cue. Leave `id` off when every
  instance is a distinct, meaningful event worth its own sound — a match/
  score chime shouldn't dedup away just because two land close together.
- Reach for `maxConcurrent` (not a hand-rolled queue-length check) when a
  cue is expected to legitimately overlap from several simultaneous
  sources — several genuinely distinct impacts landing in the same instant,
  say. `id` + `maxConcurrent: 1` (the default) is a hard "only one at a
  time" gate; the actual load balancer for "many sounds, don't let it
  become a wall of noise" is `maxVoices` + priority-based stealing, not
  this gate.
- Set `queueTTL` short for a cue tied to a specific, already-past instant
  (an impact) — better dropped than played noticeably late. Leave it at the
  default (or longer) for a cue where a slightly delayed play still reads
  fine (ambient, incidental).
- Use `priority` when what you actually want is "this class of sound always
  wins a voice slot over that class" — a match chime outranking an ambient
  bump, say — rather than trying to get the same effect by tuning `id`/
  `maxConcurrent` on the lower-priority cue.

## Trade-offs

- `id` + `maxConcurrent` as a hard admission gate vs. `maxVoices` +
  priority as a load balancer: the gate is cheap and exactly right for
  genuine duplicate suppression, but it drops everything past its cap
  outright instead of spreading load across available voices. For a cue
  expected to have many simultaneous, meaningfully-distinct instances,
  skip `id` entirely and let the voice pool's own priority-based admission
  do the balancing — capping at a gate below `maxVoices` can make a
  continuous, spatially-varied effect (many impacts across a wide area)
  read as sparse individual sounds instead of a layered texture.
- The limiter (a master `DynamicsCompressorNode`) is a last-resort safety
  net against clipping, not a substitute for admission control — relying on
  it alone instead of tuning `maxVoices`/priority/dedup will avoid audible
  clipping but can still read as a wall of noise under sustained load.

## Gotchas

- Browser autoplay policy: `SoundSystem` defers to the first user gesture
  automatically (listening for `keydown`/`pointerdown` to resume the
  `AudioContext`), but until that gesture fires, `play()` calls made before
  it silently produce no audible sound — nothing throws. Don't mistake
  that for a bug, especially under headless/automated testing where no real
  gesture ever occurs.
- A request sharing an existing `id` counts against `maxConcurrent`
  whether the existing ones are currently *playing* or merely *queued*. A
  burst that fills the queue with `maxConcurrent` not-yet-sounding requests
  will drop further same-`id` requests even though zero voices are actually
  in use for that id yet.
