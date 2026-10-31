import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

export default defineConfig({
  test: {
    passWithNoTests: true,
    include: ["**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    maxWorkers: 1,
    globalSetup: ["tests/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    sequence: {
      sequencer: class extends BaseSequencer {
        override sort(files: TestSpecification[]) {
          return Promise.resolve([...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)));
        }
      },
    },
  },
});
