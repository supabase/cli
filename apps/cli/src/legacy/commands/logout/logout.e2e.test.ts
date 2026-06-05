import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

function seedTokenFile(home: string): string {
  const supaDir = join(home, ".supabase");
  mkdirSync(supaDir, { recursive: true });
  const tokenPath = join(supaDir, "access-token");
  writeFileSync(tokenPath, VALID_TOKEN, { mode: 0o600 });
  return tokenPath;
}

describe("supabase logout (legacy)", () => {
  // Deliberate Go quirk (parity note 1): under SUPABASE_NO_KEYRING=1 the profile
  // keyring delete is unsupported, so logout removes the file token yet still
  // reports "not logged in" and exits 0.
  test(
    "logout --yes removes a file token but reports not-logged-in under no-keyring",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const tokenPath = seedTokenFile(home.dir);
      const { exitCode, stderr } = await runSupabase(["logout", "--yes"], {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("You were not logged in, nothing to do.");
      expect(existsSync(tokenPath)).toBe(false);
    },
  );

  // No token at all: same not-logged-in message, exit 0.
  test(
    "logout --yes with no token reports not-logged-in and exits 0",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(["logout", "--yes"], {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("You were not logged in, nothing to do.");
    },
  );
});
