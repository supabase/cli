import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["**/*.e2e.test.ts"],
    // Live tests are *.live.e2e.test.ts and run only via vitest.live.config.ts.
    // They also match the include glob, so exclude them here to keep the
    // PR-blocking replay suite from globbing them.
    exclude: ["**/node_modules/**", "**/*.live.e2e.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    sequence: {
      sequencer: class extends BaseSequencer {
        override async sort(files: TestSpecification[]) {
          return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
        }
      },
    },
  },
});
