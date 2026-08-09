export type InputBinding =
  | { device: 'keyboard'; code: string }
  | { device: 'mouse'; button: number }
  | { device: 'gamepad'; button: number; padIndex?: number };

export interface InputBufferOptions {
  /** How long, in ms, a press stays claimable by `consume()` after the physical
   *  event fired — the classic "jump buffer" window. Default 150. */
  bufferMs?: number;
  /** Where raw keyboard/pointer listeners attach. Default `window`. */
  target?: EventTarget;
}

interface Edge {
  physical: string;
  down: boolean;
  time: number;
}

/**
 * Action-mapped input with a press buffer, for platformer-grade
 * responsiveness and MMO-scale action counts alike: physical devices
 * (keyboard, mouse, gamepad) bind to named actions, `update()` resolves one
 * tick's worth of state from them, and `consume()` lets a system claim a
 * buffered press even if it landed a few ticks before the moment it
 * actually matters — pressing jump just before landing shouldn't be
 * dropped just because the fixed step didn't line up with the keydown.
 *
 * Keyboard/mouse are event-driven: listeners feed a per-tick edge queue, so
 * a tap faster than one fixed step still produces a `justPressed` +
 * `justReleased` pair instead of being swallowed between polls. Gamepads
 * have no button events, so they're polled once per `update()` and diffed
 * against last tick's state to synthesize the same edges. Both paths feed
 * one held/justPressed/justReleased model, so callers don't care which
 * device fired — bind several `InputBinding`s to the same action to support
 * them all at once.
 *
 * Keyboard/mouse listeners only act on `event.isTrusted` events, so a script
 * calling `dispatchEvent(new KeyboardEvent(...))` on the target can't inject
 * fake presses — raises the bar against the trivial case, but isn't a trust
 * boundary: anything with devtools/memory access can still call `isDown`/
 * `justPressed` directly or drive a real virtual HID. If input needs to hold
 * up against a determined client, validate what it produces server-side.
 *
 * Not tied to `World`/`System` — call `update(dt)` once per fixed step
 * (e.g. from a `system()` wrapper added via `world.addSystem`) before any
 * system reads state.
 */
export class InputBuffer {
  private bindings = new Map<string, InputBinding[]>();
  private physicalToActions = new Map<string, Set<string>>();
  private held = new Set<string>();
  private edges: Edge[] = [];
  private gamepadHeld = new Set<string>();

  private actionHeld = new Set<string>();
  private actionJustPressed = new Set<string>();
  private actionJustReleased = new Set<string>();
  private pressBuffer = new Map<string, number>();

  private readonly bufferMs: number;
  private readonly target: EventTarget;

  private onKeyDown: (e: Event) => void;
  private onKeyUp: (e: Event) => void;
  private onMouseDown: (e: Event) => void;
  private onMouseUp: (e: Event) => void;

  constructor(bindings: Record<string, InputBinding[]> = {}, options: InputBufferOptions = {}) {
    this.bufferMs = options.bufferMs ?? 150;
    this.target = options.target ?? window;

    for (const [action, list] of Object.entries(bindings)) {
      for (const binding of list) this.bind(action, binding);
    }

    this.onKeyDown = (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isTrusted && !ke.repeat) this.pressPhysical(`kb:${ke.code}`);
    };
    this.onKeyUp = (e) => {
      const ke = e as KeyboardEvent;
      if (ke.isTrusted) this.releasePhysical(`kb:${ke.code}`);
    };
    this.onMouseDown = (e) => {
      const pe = e as PointerEvent;
      if (pe.isTrusted) this.pressPhysical(`ms:${pe.button}`);
    };
    this.onMouseUp = (e) => {
      const pe = e as PointerEvent;
      if (pe.isTrusted) this.releasePhysical(`ms:${pe.button}`);
    };

    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.target.addEventListener('pointerdown', this.onMouseDown);
    this.target.addEventListener('pointerup', this.onMouseUp);
  }

  /** Adds a physical binding to `action` (additive — an action can have many). */
  bind(action: string, binding: InputBinding): void {
    const list = this.bindings.get(action) ?? [];
    list.push(binding);
    this.bindings.set(action, list);

    const physical = physicalId(binding);
    const actions = this.physicalToActions.get(physical) ?? new Set();
    actions.add(action);
    this.physicalToActions.set(physical, actions);
  }

  /** Removes one binding from `action`, if present. */
  unbind(action: string, binding: InputBinding): void {
    const list = this.bindings.get(action);
    if (!list) return;
    const physical = physicalId(binding);
    const idx = list.findIndex((b) => physicalId(b) === physical);
    if (idx === -1) return;
    list.splice(idx, 1);
    this.physicalToActions.get(physical)?.delete(action);
  }

  private pressPhysical(physical: string): void {
    this.held.add(physical);
    this.edges.push({ physical, down: true, time: nowMs() });
  }

  private releasePhysical(physical: string): void {
    this.held.delete(physical);
    this.edges.push({ physical, down: false, time: nowMs() });
  }

  /** Resolves one tick of action state from every physical event (and a
   *  gamepad poll) since the last call. Call this once per fixed step,
   *  before systems read `isDown`/`justPressed`/`consume`. */
  update(): void {
    this.actionJustPressed.clear();
    this.actionJustReleased.clear();
    this.pollGamepads();

    for (const edge of this.edges) {
      const actions = this.physicalToActions.get(edge.physical);
      if (!actions) continue;
      for (const action of actions) {
        if (edge.down) {
          this.actionHeld.add(action);
          this.actionJustPressed.add(action);
          this.pressBuffer.set(action, edge.time);
        } else if (!this.anyPhysicalHeld(action)) {
          this.actionHeld.delete(action);
          this.actionJustReleased.add(action);
        }
      }
    }
    this.edges.length = 0;

    const cutoff = nowMs() - this.bufferMs;
    for (const [action, time] of this.pressBuffer) {
      if (time < cutoff) this.pressBuffer.delete(action);
    }
  }

  private anyPhysicalHeld(action: string): boolean {
    const list = this.bindings.get(action);
    if (!list) return false;
    return list.some((b) => this.held.has(physicalId(b)));
  }

  private pollGamepads(): void {
    const pads = navigator.getGamepads?.();
    if (!pads) return;
    const seen = new Set<string>();
    for (const pad of pads) {
      if (!pad) continue;
      for (let i = 0; i < pad.buttons.length; i++) {
        const physical = `gp:${pad.index}:${i}`;
        const down = pad.buttons[i].pressed;
        if (down) seen.add(physical);
        const wasDown = this.gamepadHeld.has(physical);
        if (down && !wasDown) this.pressPhysical(physical);
        else if (!down && wasDown) this.releasePhysical(physical);
      }
    }
    this.gamepadHeld = seen;
  }

  /** True while any bound physical control for `action` is held. */
  isDown(action: string): boolean {
    return this.actionHeld.has(action);
  }

  /** True only on the tick `action` transitioned from up to down. */
  justPressed(action: string): boolean {
    return this.actionJustPressed.has(action);
  }

  /** True only on the tick `action` transitioned from down to up. */
  justReleased(action: string): boolean {
    return this.actionJustReleased.has(action);
  }

  /**
   * Claims a buffered press of `action` if one landed within `bufferMs` of
   * now, clearing it so it can't be consumed twice — the jump-buffer
   * pattern: check this at the moment a press would matter (e.g. on
   * landing) rather than only on the exact tick it happened.
   */
  consume(action: string): boolean {
    const time = this.pressBuffer.get(action);
    if (time === undefined) return false;
    this.pressBuffer.delete(action);
    return nowMs() - time <= this.bufferMs;
  }

  /** Removes all raw event listeners. Call when the buffer is no longer needed. */
  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('pointerdown', this.onMouseDown);
    this.target.removeEventListener('pointerup', this.onMouseUp);
  }
}

function physicalId(b: InputBinding): string {
  switch (b.device) {
    case 'keyboard':
      return `kb:${b.code}`;
    case 'mouse':
      return `ms:${b.button}`;
    case 'gamepad':
      return `gp:${b.padIndex ?? 0}:${b.button}`;
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
