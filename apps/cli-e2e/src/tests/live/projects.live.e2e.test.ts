import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// projects create/delete are exercised implicitly by live-setup (it provisions
// and tears down the per-run project). Here we cover the read paths against the
// real Management API: the fresh project shows up in `projects list`, and
// `projects api-keys` returns its keys.
describe("projects (live)", () => {
  testLive(
    "list includes the project and api-keys returns the anon key",
    async ({ run, projectRef }) => {
      const listed = await run(["projects", "list", "--output", "json"]);
      expect(listed.exitCode, listed.stderr).toBe(0);
      const refs = (JSON.parse(listed.stdout) as Array<{ id?: string; ref?: string }>).map(
        (p) => p.ref ?? p.id,
      );
      expect(refs).toContain(projectRef);

      const keys = await run([
        "projects",
        "api-keys",
        "--project-ref",
        projectRef,
        "--output",
        "json",
      ]);
      expect(keys.exitCode, keys.stderr).toBe(0);
      const names = (JSON.parse(keys.stdout) as Array<{ name?: string }>).map((k) => k.name);
      expect(names).toContain("anon");
    },
  );
});
