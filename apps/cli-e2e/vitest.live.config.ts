import { defineConfig } from "vitest/config";

// Live e2e project (ADR-0013): runs *.live.e2e.test.ts against a real backend.
// Separate from vitest.config.ts so the PR-blocking replay suite never globs
// live tests. The replay server is NOT started here — live-setup wires the CLI
// straight at the real Management API + Docker socket.
export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["**/*.live.e2e.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ["tests/live-setup.ts"],
    // Real provisioning + Docker bundling are slow; give each test plenty of room.
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Per-test flake (a single invoke/deploy blip) retries here; provisioning /
    // setup flake is handled by the CI job re-running the whole step.
    retry: 2,
  },
});
