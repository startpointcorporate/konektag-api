import { defineConfig } from 'vitest/config';

// Database integration tests: kept out of the default suite, which must run
// without external services or skipped tests.
export default defineConfig({ test: { root: '.', include: ['tests/integration/**/*.pg.ts'] } });
