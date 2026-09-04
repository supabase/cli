import { definePackageConfig, testProject } from "../../vitest.shared.ts";

export default definePackageConfig({
  test: { projects: [testProject("unit"), testProject("integration")] },
});
