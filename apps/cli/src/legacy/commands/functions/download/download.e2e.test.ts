import { describe, expect, test } from "vitest";
import { makeTempHome, runSupabase } from "../../../../../tests/helpers/cli.ts";

// Argument-validation negatives for `functions download`. This validation
// lives in the Go CLI today (the legacy TS command proxies to it); a
// black-box subprocess test keeps these assertions valid through the
// eventual native TS port — it guards behavior, not implementation. Mirrors
// `deploy.e2e.test.ts`'s coverage for the sibling `--use-docker` default bug
// (CLI-1862).
//
// The mutex-conflict cases below fail before any network call (flag parsing
// / mutex validation), so no auth or linked project is required.

const E2E_TIMEOUT_MS = 30_000;
const SLUG = "download-e2e-basic";
const FAKE_TOKEN = `sbp_${"0".repeat(40)}`;
const FAKE_REF = "a".repeat(20);

describe("supabase functions download (legacy) — argument validation", () => {
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
          entrypoint: "legacy",
          home: home.dir,
          env: { HOME: home.dir, SUPABASE_ACCESS_TOKEN: FAKE_TOKEN },
        },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(/none of the others can be|mutually exclusive/i);
    });
  }

  // CLI-1862: `--use-docker` now defaults to `true` (Go parity). Before the
  // fix, that default was counted as "explicitly selected" by the mutex
  // check, so passing `--use-api` alone was incorrectly rejected as
  // conflicting with the (unpassed) `--use-docker` default. Covered in
  // `download.integration.test.ts` ("does not treat the --use-docker default
  // as conflicting with an explicit --use-api") via a mocked platform API
  // instead of here: now that the mutex check is fixed, `--use-api` alone
  // passes validation and proceeds to the native downloader, which calls the
  // real Management API with the fake token/ref — an argument-validation
  // test shouldn't depend on that network round-trip.

  // CLI-1862: the TS→Go proxy call must not forward the now-defaulted
  // `--use-docker` alongside an explicit `--legacy-bundle` — the Go binary
  // re-parses this argv itself and enforces the same mutual exclusivity, so
  // forwarding both breaks `--legacy-bundle` outright. Covered in
  // `download.integration.test.ts` ("forwards only --legacy-bundle to the Go
  // proxy...") via a mocked `LegacyGoProxy` instead of here: unlike
  // `--use-api`, `--legacy-bundle` routes to the Go binary's `RunLegacy`
  // downloader, which calls `InstallOrUpgradeDeno` before any network call
  // (`apps/cli-go/internal/functions/download/download.go`). Each e2e run
  // gets a fresh `SUPABASE_HOME`, so this would trigger a real, uncached
  // Deno download from GitHub on every run — a real cross-boundary
  // dependency this suite shouldn't take on to prove a pure TS-side routing
  // decision.
});
