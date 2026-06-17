import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// Storage object round-trip against the project's real Storage API
// (<ref>.<project_host>, IPv4-reachable — the live harness writes the real
// project_host so `storage --linked` resolves it). The bucket is pre-seeded by
// live-setup. Storage commands are gated behind --experimental. cp → ls → rm.
const STORAGE_FLAGS = ["--linked", "--experimental"];
describe("storage (live --linked)", () => {
  testLive("uploads, lists, and removes an object", async ({ run, workspace, storageBucket }) => {
    const local = join(workspace.path, "upload.txt");
    writeFileSync(local, "live-e2e storage payload\n");
    const remote = `ss:///${storageBucket}/upload.txt`;

    const cp = await run(["storage", "cp", local, remote, ...STORAGE_FLAGS]);
    expect(cp.exitCode, cp.stderr).toBe(0);

    // Trailing slash lists the bucket's contents (without it, ls returns the
    // bucket entry itself).
    const ls = await run(["storage", "ls", `ss:///${storageBucket}/`, ...STORAGE_FLAGS]);
    expect(ls.exitCode, ls.stderr).toBe(0);
    expect(ls.stdout).toContain("upload.txt");

    const rm = await run(["storage", "rm", remote, ...STORAGE_FLAGS]);
    expect(rm.exitCode, rm.stderr).toBe(0);
  });
});
