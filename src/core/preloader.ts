/** A single unit of preload work: given a `reportProgress` callback (0..1,
 *  call it as often or as rarely as the work allows — a GLTF fetch might call
 *  it several times, a synchronous scene-setup step might just skip straight
 *  to resolving), resolves with whatever that task produces. */
export type PreloadTask<T> = (reportProgress: (fraction: number) => void) => Promise<T>;

/** A named batch of tasks to run through `Preloader.load()`. */
export type PreloadTasks = Record<string, PreloadTask<unknown>>;

export interface PreloadProgress {
  /** Weighted overall progress, 0..1. */
  fraction: number;
  /** How many of the batch's tasks have fully resolved. */
  completed: number;
  /** Total tasks in the batch. */
  total: number;
  /** Name of the task whose progress just changed, if this update was
   *  triggered by one (vs. e.g. an initial 0% emit). */
  current?: string;
}

/**
 * The preload hook: run a named batch of async setup work (GLTF/texture/audio
 * loads, procedural scene construction, anything else that has to finish
 * before the game is playable) while a UI loading screen subscribes to
 * `onProgress` for a single 0..1 number to drive a bar or spinner, decoupled
 * from *what's* loading. Not tied to any particular loader — each task is
 * just a function; wrap `GltfLoader.load`, `SoundSystem.load`, or a
 * synchronous "build the arena" step identically.
 *
 * Progress is weighted, not just "tasks completed / total": a task that
 * never calls `reportProgress` counts as 0% until it resolves (then jumps to
 * 100%), so a batch of one huge model and nine tiny ones doesn't read as
 * "90% done" the instant the nine tiny ones finish. Pass `weights` when
 * tasks are known to be very unequal in size; unweighted tasks default to 1.
 */
export class Preloader {
  private listeners: ((progress: PreloadProgress) => void)[] = [];

  /** Registers `callback` for every progress update `load()` emits. Returns
   *  an unsubscribe function. */
  onProgress(callback: (progress: PreloadProgress) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  /**
   * Runs every task in `tasks` concurrently, emitting weighted progress to
   * `onProgress` subscribers as they report, and resolves once all of them
   * have — with a result object keyed the same as `tasks`, each value typed
   * from its task's own return type.
   */
  async load<T extends PreloadTasks>(
    tasks: T,
    weights: Partial<Record<keyof T, number>> = {},
  ): Promise<{ [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
    const names = Object.keys(tasks) as (keyof T)[];
    let totalWeight = 0;
    const taskWeight = new Map<keyof T, number>();
    for (const name of names) {
      const weight = weights[name] ?? 1;
      taskWeight.set(name, weight);
      totalWeight += weight;
    }

    const fraction = new Map<keyof T, number>(names.map((name) => [name, 0]));
    const emit = (current?: keyof T): void => {
      let sum = 0;
      let completed = 0;
      for (const name of names) {
        const f = fraction.get(name) ?? 0;
        sum += f * (taskWeight.get(name) ?? 1);
        if (f >= 1) completed++;
      }
      const progress: PreloadProgress = {
        fraction: totalWeight > 0 ? sum / totalWeight : 1,
        completed,
        total: names.length,
        current: current as string | undefined,
      };
      for (const listener of this.listeners) listener(progress);
    };
    emit();

    const results = {} as { [K in keyof T]: Awaited<ReturnType<T[K]>> };
    await Promise.all(
      names.map(async (name) => {
        const result = await tasks[name]((f) => {
          fraction.set(name, Math.min(Math.max(f, 0), 1));
          emit(name);
        });
        fraction.set(name, 1);
        results[name] = result as Awaited<ReturnType<T[typeof name]>>;
        emit(name);
      }),
    );
    return results;
  }
}
