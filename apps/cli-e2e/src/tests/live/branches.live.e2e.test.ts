import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// Preview branches (workflow 3). `branches create` provisions a real branch and
// requires a paid plan; the cli-e2e test org may be on the free plan, in which
// case the CLI must surface the plan requirement rather than crash. Handle both:
// on a paid org, create → list → delete; on a free org, assert the plan-gate.
describe("branches (live)", () => {
  testLive("create + list + delete (or surface the plan gate)", async ({ run, projectRef }) => {
    const name = "e2e-branch";
    const created = await run(["branches", "create", name, "--project-ref", projectRef]);

    if (created.exitCode !== 0) {
      // Free-plan org: the command must clearly report that branching needs a
      // paid plan (not fail opaquely).
      expect(created.stderr, created.stderr).toMatch(/paid plan|upgrade|not.*support/i);
      return;
    }

    expect(created.stdout).toContain("Created preview branch");

    const listed = await run(["branches", "list", "--output", "json", "--project-ref", projectRef]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const names = (JSON.parse(listed.stdout) as Array<{ name?: string }>).map((b) => b.name);
    expect(names).toContain(name);

    const deleted = await run(["branches", "delete", name, "--project-ref", projectRef, "--yes"]);
    expect(deleted.exitCode, deleted.stderr).toBe(0);
  });
});
