import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const VALID_TOKEN = "sbp_" + "a".repeat(40);

describe("supabase login (legacy)", () => {
  // Golden path: --token persists the access token and reports success. The e2e
  // harness sets SUPABASE_NO_KEYRING=1, so the token lands in the isolated
  // HOME's ~/.supabase/access-token rather than the OS keyring.
  test(
    "login --token persists the token and prints the logged-in message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stdout } = await runSupabase(["login", "--token", VALID_TOKEN], {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain("You are now logged in. Happy coding!");
      expect(existsSync(join(home.dir, ".supabase", "access-token"))).toBe(true);
    },
  );

  // Non-TTY with no token cannot use the automatic flow.
  test(
    "login with no token in a non-TTY exits non-zero with the missing-token message",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      using home = makeTempHome();
      const { exitCode, stdout, stderr } = await runSupabase(["login"], {
        entrypoint: "legacy",
        home: home.dir,
        env: { HOME: home.dir },
      });
      expect(exitCode).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("Cannot use automatic login flow");
    },
  );
});
