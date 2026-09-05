import { definePackageConfig, testProject } from "../../vitest.shared.ts";

export default definePackageConfig({
  test: {
    projects: [
      testProject("unit"),
      testProject("integration", { test: { testTimeout: 60_000 } }),
      // Every e2e file here starts a local stack, so the whole kind is
      // stack-backed (ADR 0024).
      testProject("e2e-stack", { test: { globalSetup: ["./tests/global-setup.ts"] } }),
    ],
  },
});
