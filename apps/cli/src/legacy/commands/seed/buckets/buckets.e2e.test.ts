import { BunServices } from "@effect/platform-bun";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabase } from "../../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the two
 * network-free paths of `seed buckets`:
 *  - an empty `[storage]` config is a no-op (exit 0, no stdout);
 *  - `--local --linked` is rejected by the mutually-exclusive flag check.
 * Bucket/object seeding parity is covered by the integration + unit suites.
 */
describe("supabase seed buckets (legacy)", () => {
  let projectDir: string;

  beforeAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        projectDir = yield* fs.makeTempDirectory({ prefix: "supabase-seed-buckets-e2e-" });
        const supabaseDir = path.join(projectDir, "supabase");
        yield* fs.makeDirectory(supabaseDir, { recursive: true });
        yield* fs.writeFileString(path.join(supabaseDir, "config.toml"), 'project_id = "test"\n');
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  afterAll(() =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(projectDir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );

  test("is a no-op with exit 0 when no buckets are configured", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["seed", "buckets"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout }) => {
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("");
    }),
  );

  test("rejects passing both --local and --linked", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["seed", "buckets", "--local", "--linked"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(
        "if any flags in the group [local linked] are set none of the others can be",
      );
    }),
  );

  // Go registers --linked/--local on seedCmd.PersistentFlags() (seed.go:27-29),
  // so they're accepted BEFORE the subcommand too. These two cases exercise the
  // real parser boundary, which the in-process suites bypass.
  test(
    "accepts --local before the subcommand (Go PersistentFlags)",
    { timeout: E2E_TIMEOUT_MS },
    () =>
      runSupabase(["seed", "--local", "buckets"], {
        entrypoint: "legacy",
        cwd: projectDir,
      }).then(({ exitCode, stdout, stderr }) => {
        // Parsed (no "Unrecognized flag") and routed to the local no-op path.
        expect(`${stdout}${stderr}`).not.toContain("Unrecognized flag");
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("");
      }),
  );

  test("rejects --local --linked before the subcommand", { timeout: E2E_TIMEOUT_MS }, () =>
    runSupabase(["seed", "--local", "--linked", "buckets"], {
      entrypoint: "legacy",
      cwd: projectDir,
    }).then(({ exitCode, stdout, stderr }) => {
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain(
        "if any flags in the group [local linked] are set none of the others can be",
      );
    }),
  );
});
