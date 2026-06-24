import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// `link` is the backbone of workflows 1-3. --skip-pooler keeps it
// Management-API-only (no IPv6-only DB connection): it validates the ref and
// writes the linked-project cache into the workspace's supabase/.temp.
describe("link (live)", () => {
  testLive("links the project so ref-less commands resolve it", async ({ run, projectRef }) => {
    const linked = await run(["link", "--project-ref", projectRef, "--skip-pooler"]);
    expect(linked.exitCode, linked.stderr).toBe(0);
    expect(linked.stdout).toContain("Finished supabase link");

    // No --project-ref and no SUPABASE_PROJECT_ID env: a remote command must now
    // resolve the ref from the link written above.
    const listed = await run(["secrets", "list", "--output", "json"], {
      env: { SUPABASE_PROJECT_ID: "" },
    });
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(Array.isArray(JSON.parse(listed.stdout))).toBe(true);
  });
});
