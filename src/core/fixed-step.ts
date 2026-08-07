/**
 * Decouples simulation from render rate: `advance(realDt, step)` accumulates
 * real elapsed time and invokes `step(fixedDt)` zero or more times at a fixed
 * size, so game/physics logic runs at a consistent rate regardless of display
 * Hz or frame hitches, while rendering still happens once per
 * `requestAnimationFrame` call no matter how many (or how few) fixed steps
 * ran that frame. `maxStepsPerFrame` caps the catch-up after a stall (a
 * backgrounded tab, a GC pause) — without it, a large `realDt` would demand a
 * burst of steps that itself takes longer than the frame budget, falling
 * further behind every frame after ("spiral of death"). When the cap is hit,
 * the remaining backlog is dropped rather than simulated in a burst.
 *
 * Render interpolation (blending between the last two simulated states using
 * `alpha`, so motion stays smooth even when render Hz and fixed Hz don't
 * divide evenly) is a natural next step this class supports but doesn't do —
 * `alpha` is exposed for exactly that, left for later.
 */
export class FixedStep {
  private accumulator = 0;

  /**
   * @param dt Fixed step size in seconds (e.g. `1/60`).
   * @param maxStepsPerFrame Catch-up cap per `advance()` call — see the class doc.
   */
  constructor(
    private readonly dt: number,
    private readonly maxStepsPerFrame = 5,
  ) {}

  /** Call once per rendered frame with the real elapsed time; runs `step(dt)`
   *  zero or more times to catch simulated time up to real time. */
  advance(realDt: number, step: (dt: number) => void): void {
    this.accumulator += realDt;
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxStepsPerFrame) {
      step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    if (steps === this.maxStepsPerFrame) this.accumulator = 0;
  }

  /** Fraction of a step banked but not yet simulated, in [0, 1) — for render interpolation. */
  get alpha(): number {
    return this.accumulator / this.dt;
  }
}
