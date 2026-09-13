import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase, stripAnsi } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

// The e2e harness points SUPABASE_HOME at the isolated home dir, so the fallback
// token file lives at <SUPABASE_HOME>/access-token.
function seedTokenFile(home: string): string {
  const tokenPath = join(home, "access-token");
  writeFileSync(tokenPath, VALID_TOKEN, { mode: 0o600 });
  return tokenPath;
}

describe("supabase logout", () => {
  // Under SUPABASE_NO_KEYRING=1, keyring delete is unsupported, so logout removes the file
  // token yet still reports "not logged in" and exits 0.
  test(
    "logout --yes removes a file token but reports not-logged-in under no-keyring",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const tokenPath = seedTokenFile(home.dir);
      const { exitCode, stderr } = await runSupabase(["logout", "--yes"], {
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("You were not logged in, nothing to do.");
      expect(existsSync(tokenPath)).toBe(false);
    },
  );

  test(
    "declining the logout prompt prints only context canceled, no --debug hint",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      seedTokenFile(home.dir);
      const { exitCode, stderr } = await runSupabase(["logout"], {
        home: home.dir,
        env: { HOME: home.dir },
        stdin: "n\n",
      });
      expect(exitCode).toBe(1);
      const lines = stripAnsi(stderr).trimEnd().split("\n");
      expect(lines.at(-1)).toBe("context canceled");
      expect(stderr).not.toContain("Try rerunning the command with --debug");
    },
  );

  test(
    "logout --yes with no token reports not-logged-in and exits 0",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(["logout", "--yes"], {
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("You were not logged in, nothing to do.");
    },
  );
});
