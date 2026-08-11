import { defineConfig, devices } from '@playwright/test';

// Runs against the *built* dist/speck.js, the same artifact the examples
// and any real consumer load — a source-level test would exercise different
// (unminified, unbundled) code paths. Two kinds of specs share this config
// and the harness at tests/perf/harness.html:
// - tests/perf/ — scaling benchmarks for hot paths (TransformStore-backed
//   systems, SpatialGrid, InstancedRenderer, PhysicsSystem). Loose ceilings
//   meant to catch a pathological regression, not ordinary run-to-run noise.
// - tests/noise/ — correctness tests for src/core/noise.ts (determinism,
//   bounded output, poissonDiskSample2D's minimum-distance guarantee).
// `npm run test:perf` / `test:noise` scope to one or the other; `npm test`
// runs both.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // perf numbers are noisy enough without also sharing a CPU across parallel workers
  workers: 1,
  retries: 0, // a flaky perf assertion should be loosened, not silently retried into a pass
  reporter: [['list']],
  timeout: 60_000, // some benchmarks (physics wasm init + thousands of bodies) run well past the 30s default
  webServer: {
    command: 'node scripts/static-server.mjs',
    url: 'http://localhost:4321/tests/perf/harness.html',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:4321',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
