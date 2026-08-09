# Input

`InputBuffer`: action-mapped keyboard/mouse/gamepad input with a press
buffer, for platformer-grade responsiveness and MMO-scale action counts
alike. See the top-level README (and the class's own doc comment) for the
full API description.

## Best practices

- Call `update()` exactly once per fixed step, before anything reads
  `isDown`/`justPressed`/`justReleased`/`consume` — state is only coherent
  immediately after `update()` runs; reading it before the first call, or
  more than once between calls, gives stale or repeated results.
- Use `consume(action)` (not `justPressed`) for anything that benefits from
  input buffering — a jump that should still register if pressed slightly
  before landing. Use `justPressed`/`justReleased` for checks that only
  ever matter on the exact tick the transition happened.
- Bind multiple physical controls to one action name for cross-device
  support (keyboard *and* gamepad both mapped to `"jump"`, say) freely —
  the buffer already collapses simultaneous or rapid presses of the same
  action into one logical press per tick, so this doesn't cause double
  firing. See the class doc for why.

## Trade-offs

- The `isTrusted` filter on keyboard/mouse listeners raises the bar against
  naively injected synthetic events (a script calling `dispatchEvent`), but
  it is not a real trust boundary — anything with devtools/memory access
  can still call `isDown`/`justPressed` directly, or drive a real virtual
  HID. If input needs to hold up against a determined client, validate what
  it produces server-side; nothing client-side can guarantee this.
- `bufferMs` trades "a slightly early press still counts" against "a stale
  press might fire something later than intended." Tune it per action — a
  jump buffer wants to stay short (~100–150ms); a buffer meant to smooth
  over occasional dropped frames can afford to be longer.

## Gotchas

- Gamepad state is **polled** once per `update()` call, not event-driven —
  if `update()` isn't called every fixed step (e.g. skipped while the game
  is paused), gamepad button transitions between the last and next call are
  collapsed into whatever the state happens to be at the next call, not
  queued individually the way keyboard/mouse edges are.
- `justPressed`/`justReleased` are true for exactly one tick — the one the
  transition happened on. A system that doesn't run every tick (gated
  behind some other condition) can miss the transition outright. Use
  `consume()` instead if the check might not happen on the exact tick the
  press occurred.
