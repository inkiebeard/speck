import type { World } from '../core/world';

export interface DebugOverlayOptions {
  /** Where to append the overlay element. Default `document.body`. */
  parent?: HTMLElement;
  /** How many frames to average frame time over. */
  sampleSize?: number;
}

/**
 * A small top-right text overlay: fps/frame time plus entity counts, sourced
 * from `world.entities.count` and `world.storeSizes()`. Browser-only, opt-in —
 * nothing in `World`/`step()` touches this. Call `tick()` once per rendered
 * frame (e.g. right before `renderer.render(...)`); call `destroy()` to
 * remove it. This is deliberately just text in a `<div>`, not a full stats
 * pane — swap it for something else (a canvas graph, a full devtools panel)
 * by reading the same `World.storeSizes()`/`entities.count` introspection.
 */
export class DebugOverlay {
  private el: HTMLDivElement;
  private sampleSize: number;
  private frameTimes: number[] = [];
  private lastFrameStart = performance.now();

  /** Creates and appends the overlay element immediately — nothing else needs
   *  to run before `tick()` is called for the first time. */
  constructor(private world: World, options: DebugOverlayOptions = {}) {
    this.sampleSize = options.sampleSize ?? 60;
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position: fixed; top: 8px; right: 8px; z-index: 9999; ' +
      'font: 12px/1.4 monospace; color: #0f0; background: rgba(0,0,0,0.6); ' +
      'padding: 6px 8px; border-radius: 4px; white-space: pre; pointer-events: none;';
    (options.parent ?? document.body).appendChild(this.el);
  }

  /** Updates the fps/entity/store-size text. Call once per rendered frame. */
  tick(): void {
    const now = performance.now();
    const dt = now - this.lastFrameStart;
    this.lastFrameStart = now;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > this.sampleSize) this.frameTimes.shift();

    let sum = 0;
    for (let i = 0; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    const avgMs = sum / this.frameTimes.length;

    const lines = [`${(1000 / avgMs).toFixed(0)} fps  ${avgMs.toFixed(2)} ms`, `entities: ${this.world.entities.count}`];
    for (const [name, size] of this.world.storeSizes()) {
      lines.push(`  ${name}: ${size}`);
    }
    this.el.textContent = lines.join('\n');
  }

  /** Removes the overlay element from the page. */
  destroy(): void {
    this.el.remove();
  }
}
