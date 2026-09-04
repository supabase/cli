import { definePackageConfig, testProject } from "../../vitest.shared.ts";

export default definePackageConfig({
  test: {
    projects: [
      testProject("unit"),
      testProject("integration", { test: { testTimeout: 60_000 } }),
      testProject("e2e", {
        test: { fileParallelism: false, globalSetup: ["./tests/global-setup.ts"] },
      }),
    ],
  },
});
