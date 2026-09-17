import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

const makeProjectDir = Effect.fnUntraced(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = yield* fs.makeTempDirectoryScoped({ prefix });
  yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(projectDir, "supabase", "config.toml"),
    'project_id = "test"\n',
  );
  return projectDir;
});

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the two
 * network-free paths of `seed buckets`:
 *  - an empty `[storage]` config is a no-op (exit 0, no stdout);
 *  - `--local --linked` is rejected by the mutually-exclusive flag check.
 * Bucket/object seeding is covered by the integration and unit suites.
 */
describe("supabase seed buckets", () => {
  it.live(
    "is a no-op with exit 0 when no buckets are configured",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-noop-");
        const { exitCode, stdout } = yield* runSupabaseEffect(["seed", "buckets"], {
          cwd: projectDir,
        });
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects passing both --local and --linked",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-both-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "buckets", "--local", "--linked"],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(
          "if any flags in the group [local linked] are set none of the others can be",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  // --linked/--local are accepted before the subcommand token too; these two
  // cases exercise the real parser boundary, which the in-process suites bypass.
  it.live(
    "accepts --local before the subcommand (Go PersistentFlags)",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-prelocal-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "--local", "buckets"],
          { cwd: projectDir },
        );
        expect(`${stdout}${stderr}`).not.toContain("Unrecognized flag");
        expect(exitCode).toBe(0);
        expect(stdout.trim()).toBe("");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects --local --linked before the subcommand",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-preboth-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "--local", "--linked", "buckets"],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(
          "if any flags in the group [local linked] are set none of the others can be",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
