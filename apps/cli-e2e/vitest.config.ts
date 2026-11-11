import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { E2E_CONCURRENCY } from "./src/tests/env.ts";

const include = ["**/*.e2e.test.ts"];
const exclude = ["**/node_modules/**"];
/* These files share replay state no test can scope: the pg mock, and the un-prefixed Docker and stack routes. */
const serialFiles = ["src/tests/inspect.e2e.test.ts", "src/tests/stack.e2e.test.ts"];

export default defineConfig({
  test: {
    passWithNoTests: true,
    fileParallelism: E2E_CONCURRENCY > 1,
    maxWorkers: E2E_CONCURRENCY,
    maxConcurrency: E2E_CONCURRENCY,
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
    projects: [
      {
        extends: true,
        test: {
          name: "replay",
          include,
          exclude: [...exclude, ...serialFiles],
          sequence: { concurrent: E2E_CONCURRENCY > 1 },
        },
      },
      {
        extends: true,
        test: { name: "serial", include: serialFiles, exclude },
      },
    ],
  },
});
