import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../tests/helpers/cli.ts";

// Argument-validation negatives for `functions download`, mirroring
// `deploy.e2e.test.ts`. These fail before any network call, so no auth or
// linked project is required.

const E2E_TIMEOUT_MS = 30_000;
const SLUG = "download-e2e-basic";
const FAKE_TOKEN = `sbp_${"0".repeat(40)}`;
const FAKE_REF = "a".repeat(20);

describe("supabase functions download — argument validation", () => {
  const conflicts = [
    { name: "--use-api + --use-docker", flags: ["--use-api", "--use-docker"] },
    { name: "--use-api + --legacy-bundle", flags: ["--use-api", "--legacy-bundle"] },
    { name: "--use-docker + --legacy-bundle", flags: ["--use-docker", "--legacy-bundle"] },
  ] as const;

  for (const { name, flags } of conflicts) {
    test(`rejects ${name} as mutually exclusive`, { timeout: E2E_TIMEOUT_MS }, async () => {
      using home = makeTempHome();
      const { exitCode, stderr } = await runSupabase(
        ["functions", "download", SLUG, "--project-ref", FAKE_REF, ...flags],
        {
          home: home.dir,
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/none of the others can be|mutually exclusive/i);
    });
  }

  // `--use-api` alone (without --use-docker) is covered in
  // download.integration.test.ts instead, since validating it here would
  // require a real network round-trip to the Management API.

  // `--legacy-bundle` alone is covered in download.integration.test.ts
  // instead: it routes to the Go binary's downloader, which would trigger a
  // real Deno download from GitHub on every e2e run.
});
