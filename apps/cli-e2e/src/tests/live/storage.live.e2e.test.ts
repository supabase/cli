import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { testLive } from "./live-context.ts";

// Storage object round-trip against the project's real Storage API. `storage
// --linked` opens a DB connection to resolve storage config; the direct host is
// IPv6-only (unreachable from IPv4-only CI), so we `link` first (with the db
// password) to persist the IPv4 pooler connection that storage then reuses.
// The bucket is pre-seeded by live-setup; storage is gated behind --experimental.
const STORAGE_FLAGS = ["--linked", "--experimental"];
describe("storage (live --linked)", () => {
  testLive(
    "uploads, lists, and removes an object",
    async ({ run, workspace, projectRef, storageBucket, dbPassword }) => {
      const linked = await run(["link", "--project-ref", projectRef], {
        env: { SUPABASE_DB_PASSWORD: dbPassword },
      });
      expect(linked.exitCode, linked.stderr).toBe(0);

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

      // --yes: rm prompts (default No) and would otherwise skip deletion in the
      // non-TTY harness yet still exit 0.
      const rm = await run(["storage", "rm", remote, "--yes", ...STORAGE_FLAGS]);
      expect(rm.exitCode, rm.stderr).toBe(0);

      // Confirm the object is actually gone (guards against a no-op delete).
      const after = await run(["storage", "ls", `ss:///${storageBucket}/`, ...STORAGE_FLAGS]);
      expect(after.exitCode, after.stderr).toBe(0);
      expect(after.stdout).not.toContain("upload.txt");
    },
  );
});
