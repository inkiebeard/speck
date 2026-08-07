import { writeFileSync } from 'node:fs';

// dist/speck.js is what a relative import (the examples, or any CDN-style
// consumer) pulls in directly. TypeScript only consults package.json's
// "types" field for bare/package-name imports resolved through "exports" —
// a relative import of dist/speck.js instead needs a co-located
// dist/speck.d.ts with the same basename, or it falls back to inferring
// types from the bundled JS itself (Rollup-mangled names, everything `any`,
// no doc comments). This just re-exports the real declarations tsc already
// emitted into dist/index.d.ts.
writeFileSync(new URL('../dist/speck.d.ts', import.meta.url), "export * from './index';\n");
