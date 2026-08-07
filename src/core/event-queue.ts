import type { World } from './world';

/** Base shape for any event — extend with your own fields, keyed by `type` for `on()`. */
export interface GameEvent {
  readonly type: string;
}

/** A callback registered via `EventQueue.on()`. */
export type EventHandler<E extends GameEvent = GameEvent> = (event: E, world: World) => void;

/**
 * The causality layer. Systems and handlers `emit()` events; `drain()` delivers
 * them to registered handlers. Events emitted *while* draining are collected and
 * processed in the same tick, up to `maxPasses` hops — so a match can trigger a
 * removal which triggers a settle, all within one frame, but a runaway feedback
 * loop is bounded instead of hanging. Double-buffering keeps iteration safe
 * while handlers emit, and delivery order is deterministic.
 */
export class EventQueue {
  private handlers = new Map<string, EventHandler[]>();
  private current: GameEvent[] = [];
  private next: GameEvent[] = [];

  /** Registers `handler` to run for every event of `type` delivered by `drain()`. */
  on<E extends GameEvent>(type: E['type'], handler: EventHandler<E>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as EventHandler);
    this.handlers.set(type, list);
  }

  /** Queues an event for the next `drain()` — handlers don't run synchronously. */
  emit(event: GameEvent): void {
    this.next.push(event);
  }

  /** Delivers every queued event to its registered handlers, looping to
   *  absorb events emitted by those handlers (bounded by `maxPasses`). */
  drain(world: World, maxPasses = 8): void {
    let pass = 0;
    while (this.next.length > 0 && pass < maxPasses) {
      const buf = this.current;
      this.current = this.next;
      this.next = buf;
      this.next.length = 0;

      for (let i = 0; i < this.current.length; i++) {
        const ev = this.current[i];
        const list = this.handlers.get(ev.type);
        if (!list) continue;
        for (let h = 0; h < list.length; h++) list[h](ev, world);
      }
      pass++;
    }
  }
}
