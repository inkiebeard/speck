import type { Entity } from '../core/entity';
import type { ComponentStore } from '../core/component-store';
import type { System } from '../core/system';
import { system } from '../core/system';
import type { World } from '../core/world';
import type { BehaviorNode } from './behavior-tree';

/**
 * Per-entity AI component: a behavior tree root plus its persistent memory.
 * `B` (blackboard) is your extension point — put whatever per-entity state
 * the tree needs to remember between ticks (current target, path, timers).
 * Store it in any `ComponentStore<AiState<B>>` (`ArrayComponentStore` is the
 * usual choice, same as any other cold/heterogeneous component).
 */
export interface AiState<B = Record<string, unknown>> {
  root: BehaviorNode<AiContext<B>>;
  blackboard: B;
}

/** What every behavior tree node sees, via `createAiSystem` — the `C` type
 *  parameter `BehaviorNode<C>` is generic over, specialized to this shape. */
export interface AiContext<B = Record<string, unknown>> {
  world: World;
  entity: Entity;
  dt: number;
  blackboard: B;
}

/**
 * Ticks every entity's behavior tree root once per frame. This is the whole
 * system — it does no scheduling, no priority, no interruption; if you need
 * those, wrap or replace this function rather than extend a class. Rebuild
 * the spatial grid (via `World.registerSpatialGrid`) *before* this system
 * runs if any node queries neighbors.
 */
export function createAiSystem<B = Record<string, unknown>>(
  store: ComponentStore<AiState<B>>,
): System {
  return system((world, dt) => {
    const entities = store.entities;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const state = store.get(e);
      if (state === undefined) continue;
      state.root({ world, entity: e, dt, blackboard: state.blackboard });
    }
  });
}
