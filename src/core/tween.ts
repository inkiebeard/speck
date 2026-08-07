export interface Tween {
  /** Seconds, matching `dt` everywhere else in the engine (not ms). */
  duration: number;
  /** Called every tick this tween is running, with progress eased into [0, 1]. */
  onUpdate(t: number): void;
  /** Called once, the tick progress reaches 1 (t is not passed again). */
  onComplete?(): void;
  /** Reshapes raw linear progress before `onUpdate` sees it. Default: linear. */
  easing?(raw: number): number;
}

/**
 * Runs short, self-contained timed animations — a match-combine flourish, a
 * screen shake, a UI transition — anything that needs to interpolate state
 * over a fixed duration and then do something, without being a full `System`
 * or owning a component store. Not entity-specific: a `Tween`'s `onUpdate`
 * closure captures whatever it needs to animate (entities via a component
 * store, the camera, a DOM element, ...); the runner only tracks progress and
 * timing. Register with `World.registerTweenRunner` to have it advance every
 * `step()`, or call `update(dt)` yourself if you don't need that wiring.
 */
export class TweenRunner {
  private active: { tween: Tween; elapsed: number }[] = [];

  /** Starts running `tween` from `t = 0`. Multiple tweens can run concurrently. */
  play(tween: Tween): void {
    this.active.push({ tween, elapsed: 0 });
  }

  /** Advances every running tween by `dt` seconds; completed ones fire onComplete and stop. */
  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const entry = this.active[i];
      entry.elapsed += dt;
      const raw = Math.min(entry.elapsed / entry.tween.duration, 1);
      entry.tween.onUpdate(entry.tween.easing ? entry.tween.easing(raw) : raw);
      if (raw >= 1) {
        entry.tween.onComplete?.();
        this.active.splice(i, 1);
      }
    }
  }

  /** Number of tweens currently running. */
  get count(): number {
    return this.active.length;
  }
}

/** A couple of common reshaping curves. Add more the same way: `(raw: number) => number`. */
export const Easing = {
  linear: (t: number): number => t,
  easeOutCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
};
