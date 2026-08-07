/**
 * Minimal behavior tree. A node is just a function from some context `C` to a
 * status — there's no base class to subclass and no built-in context shape.
 * `C` is the extension point: define whatever your game's AI needs to see
 * (world, entity, dt, blackboard, spatial grid, whatever) and every node you
 * write, custom or composed from `sequence`/`selector` below, shares it.
 */
export type NodeStatus = 'success' | 'failure' | 'running';

export type BehaviorNode<C> = (ctx: C) => NodeStatus;

/** Wraps a plain function as a node. Purely for readability at call sites. */
export function action<C>(fn: (ctx: C) => NodeStatus): BehaviorNode<C> {
  return fn;
}

/** A node that never runs long: true -> success, false -> failure. */
export function condition<C>(fn: (ctx: C) => boolean): BehaviorNode<C> {
  return (ctx) => (fn(ctx) ? 'success' : 'failure');
}

/** Runs children in order; stops at the first non-success. */
export function sequence<C>(...nodes: BehaviorNode<C>[]): BehaviorNode<C> {
  return (ctx) => {
    for (const node of nodes) {
      const status = node(ctx);
      if (status !== 'success') return status;
    }
    return 'success';
  };
}

/** Runs children in order; stops at the first non-failure. */
export function selector<C>(...nodes: BehaviorNode<C>[]): BehaviorNode<C> {
  return (ctx) => {
    for (const node of nodes) {
      const status = node(ctx);
      if (status !== 'failure') return status;
    }
    return 'failure';
  };
}

/** Inverts success/failure; passes running through. */
export function invert<C>(node: BehaviorNode<C>): BehaviorNode<C> {
  return (ctx) => {
    const status = node(ctx);
    if (status === 'success') return 'failure';
    if (status === 'failure') return 'success';
    return status;
  };
}

/**
 * More node types (parallel, repeat-until-failure, decorators with cooldowns,
 * a proper blackboard-driven "running" resume across ticks) are deliberately
 * not included — add them the same way these are built: a function of shape
 * `BehaviorNode<C>` that calls its children.
 */
