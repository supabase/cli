import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

interface SecretRow {
  name: string;
}

// Live secrets flow (Management API only — no Docker, no DB). The fresh per-run
// project isolates the secret; the unset at the end cleans it up. Asserts on the
// real remote outcome: the key appears in `secrets list` after set and is gone
// after unset.
describe("secrets", () => {
  testLive("set surfaces the key in list, unset removes it", async ({ run, projectRef }) => {
    const key = "LIVE_E2E_SECRET";

    const set = await run(["secrets", "set", `${key}=live-value`, "--project-ref", projectRef]);
    expect(set.exitCode, set.stderr).toBe(0);
    expect(set.stdout).toContain("Finished");

    const afterSet = await run([
      "secrets",
      "list",
      "--output",
      "json",
      "--project-ref",
      projectRef,
    ]);
    expect(afterSet.exitCode, afterSet.stderr).toBe(0);
    const setNames = (JSON.parse(afterSet.stdout) as SecretRow[]).map((s) => s.name);
    expect(setNames).toContain(key);

    const unset = await run(["secrets", "unset", key, "--project-ref", projectRef, "--yes"]);
    expect(unset.exitCode, unset.stderr).toBe(0);
    expect(unset.stdout).toContain("Finished");

    const afterUnset = await run([
      "secrets",
      "list",
      "--output",
      "json",
      "--project-ref",
      projectRef,
    ]);
    expect(afterUnset.exitCode, afterUnset.stderr).toBe(0);
    const unsetNames = (JSON.parse(afterUnset.stdout) as SecretRow[]).map((s) => s.name);
    expect(unsetNames).not.toContain(key);
  });
});
