import { readFileSync } from "node:fs";
import { definePackageConfig, testProject } from "../../vitest.shared.mts";

// `src/shared/services/dockerfile-images.ts` imports the Go CLI's Dockerfile
// with Bun's `{ type: "text" }` import attribute; Vite needs a loader for it.
function dockerfileTextPlugin() {
  return {
    name: "dockerfile-text-loader",
    load(id: string) {
      const [filePath] = id.split("?", 2);
      if (filePath?.endsWith("/Dockerfile") !== true) {
        return undefined;
      }

      return `export default ${JSON.stringify(readFileSync(filePath, "utf8"))};`;
    },
  };
}

const e2eRuntime = {
  globalSetup: ["tests/e2e-global-setup.ts"],
  setupFiles: ["tests/e2e-setup.ts"],
  testTimeout: 120_000,
  hookTimeout: 120_000,
};

export default definePackageConfig({
  plugins: [dockerfileTextPlugin()],
  test: {
    coverage: {
      exclude: [
        "tests/**",
        "scripts/**",
        "**/*.unit.test.ts",
        "**/*.integration.test.ts",
        "**/*.e2e.test.ts",
        "**/*.live.test.ts",
        "**/*.command.ts",
        "src/app.ts",
        "src/bin.ts",
        "src/index.ts",
        "src/supabase.ts",
      ],
    },
    projects: [
      testProject("unit", { test: { env: { FORCE_COLOR: "1" } } }),
      testProject("integration"),
      // Stackless e2e: black-box CLI subprocesses against an isolated temporary
      // home, safe under file-level parallelism.
      testProject("e2e", { test: e2eRuntime }),
      // Stack-backed e2e: `*.stack.e2e.test.ts` files start a local stack or
      // run Docker containers and run one at a time (ADR 0024).
      testProject("e2e-stack", { test: e2eRuntime }),
      // Live tests run against one provisioned project on the configured
      // platform. They are never part of the default unit/integration/e2e
      // loop; an explicit run fails fast when required configuration is absent.
      testProject("live", {
        test: {
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ["tests/live-global-setup.ts"],
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      }),
    ],
  },
});
