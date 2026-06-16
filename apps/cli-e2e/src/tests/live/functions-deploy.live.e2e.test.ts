import { describe, expect } from "vitest";
import { expectFunctionOk } from "./invoke.ts";
import { testLive } from "./live-context.ts";

// Pilot (ADR-0013): deploy deploy-e2e-basic with the real CLI across the three
// bundler paths, then invoke the deployed function over HTTP and assert the body
// it returns. Negative/arg-validation cases live in apps/cli integration tests.
const MODES = [
  { name: "default", flags: [] as string[] },
  { name: "use-api", flags: ["--use-api"] },
  { name: "use-docker", flags: ["--use-docker"] },
] as const;

describe.each(MODES)("functions deploy ($name)", ({ flags }) => {
  testLive(
    "deploys deploy-e2e-basic and the function responds",
    async ({ run, invoke, projectRef }) => {
      const deployed = await run([
        "functions",
        "deploy",
        "deploy-e2e-basic",
        "--project-ref",
        projectRef,
        ...flags,
      ]);
      expect(deployed.exitCode, deployed.stderr).toBe(0);
      expect(deployed.stdout).toContain("Deployed Functions");

      const res = await invoke("deploy-e2e-basic");
      expectFunctionOk(res, "deploy-e2e-basic");
    },
  );
});
