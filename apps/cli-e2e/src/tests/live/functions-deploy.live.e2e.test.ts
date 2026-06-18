import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { expectFunctionOk } from "./invoke.ts";
import { seedFunctions, testLive } from "./live-context.ts";

// Pilot (ADR-0013): deploy with the real CLI across the three bundler paths,
// then invoke the deployed function over HTTP and assert the body it returns.
// Each mode deploys a DISTINCT slug so the invoke proves THAT mode's deploy
// produced a running function — the shared project means a single slug could
// otherwise be served by an earlier mode's deploy. Negative/arg-validation
// cases live in apps/cli integration tests.
const MODES = [
  { name: "default", slug: "deploy-e2e-mode-default", flags: [] as string[] },
  { name: "use-api", slug: "deploy-e2e-mode-api", flags: ["--use-api"] },
  { name: "use-docker", slug: "deploy-e2e-mode-docker", flags: ["--use-docker"] },
] as const;

describe.each(MODES)("functions deploy ($name)", ({ slug, flags }) => {
  testLive("deploys and the function responds", async ({ run, invoke, workspace, projectRef }) => {
    seedFunctions(workspace.path);
    const deployed = await run([
      "functions",
      "deploy",
      slug,
      "--project-ref",
      projectRef,
      ...flags,
    ]);
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(deployed.stdout).toContain("Deployed Functions");

    const res = await invoke(slug);
    expectFunctionOk(res, slug);
  });
});

// No slug → the CLI walks every function declared under supabase/functions and
// deploys them all. Assert each declared function appears in the deploy output,
// then smoke-invoke a representative one.
testLive(
  "deploys every declared function when no slug is given",
  async ({ run, invoke, workspace, projectRef }) => {
    seedFunctions(workspace.path);
    const declared = readdirSync(join(workspace.path, "supabase", "functions"), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name);
    expect(declared.length).toBeGreaterThan(1);

    const deployed = await run(["functions", "deploy", "--project-ref", projectRef]);
    expect(deployed.exitCode, deployed.stderr).toBe(0);
    expect(deployed.stdout).toContain("Deployed Functions");

    // Each declared function must be listed in the deploy output AND respond
    // with its own {case: slug, ok: true}. A handler returns that marker only if
    // it actually executed — and for the npm/jsr/local-imports/scoped-map
    // fixtures only if their imports resolved at runtime — so this proves the
    // feature ran end-to-end, not merely that the function deployed and booted.
    for (const slug of declared) {
      expect(deployed.stdout, `expected "${slug}" in deploy output`).toContain(slug);
      expectFunctionOk(await invoke(slug), slug);
    }
  },
);
