import { definePackageConfig, testProject } from "../../vitest.shared.mts";

export default definePackageConfig({
  test: { projects: [testProject("unit"), testProject("integration")] },
});
