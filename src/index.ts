// Core
export * from './core/entity';
export * from './core/sparse-set';
export * from './core/component-store';
export * from './core/event-queue';
export * from './core/system';
export * from './core/spatial-grid';
export * from './core/tween';
export * from './core/fixed-step';
export * from './core/world';
export * from './core/preloader';
export * from './core/noise';

// Components
export * from './components/transform';

// AI: behavior trees, per-entity AI system, flocking (all optional, opt-in)
export * from './ai/behavior-tree';
export * from './ai/ai-system';
export * from './ai/flocking';

// Rendering (peer dep: three)
export * from './rendering/instanced-renderer';
export * from './rendering/particle-system';
export * from './rendering/gltf-loader';

// Physics (peer dep: @dimforge/rapier3d-compat)
export * from './physics/physics-system';

// Input (browser-only, opt-in)
export * from './input/input-buffer';

// Debug (browser-only, opt-in)
export * from './debug/debug-overlay';

// Audio (peer dep: three; browser-only, opt-in)
export * from './audio/sound-system';
