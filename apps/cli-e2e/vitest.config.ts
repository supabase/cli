import { BaseSequencer, type TestSpecification } from "vitest/node";
import { definePackageConfig, testProject } from "../../vitest.shared.ts";

export default definePackageConfig({
  test: {
    // Replay fixtures are shared across files, so run them in a deterministic
    // lexicographic order. `sequence.sequencer` is a run-level option: it
    // applies to standalone runs of this package, not when the repo root loads
    // this config as a project.
    sequence: {
      sequencer: class extends BaseSequencer {
        override async sort(files: TestSpecification[]) {
          return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
        }
      },
    },
    projects: [
      testProject("e2e", {
        test: {
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ["tests/setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 30_000,
        },
      }),
    ],
  },
});
