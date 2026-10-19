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
 *  - `--remote` combined with a deprecated selector alias is rejected by the shared target selector.
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
    "rejects passing both --local and --remote",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-both-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "buckets", "--local", "--remote"],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(
          "Only one of --remote, --linked, --db-url and --local can be set; got --remote and --local.",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  // Selector flags are accepted before the subcommand token too; these two
  // cases exercise the real parser boundary, which the in-process suites bypass.
  it.live(
    "accepts the deprecated --local before the subcommand and warns it is not needed",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-prelocal-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "--local", "buckets"],
          { cwd: projectDir },
        );
        expect(`${stdout}${stderr}`).not.toContain("Unrecognized flag");
        expect(`${stdout}${stderr}`).toContain(
          "--local isn't needed (local is the default) and will be removed in v4: supabase seed buckets",
        );
        expect(exitCode).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects --local --remote before the subcommand",
    () =>
      Effect.gen(function* () {
        const projectDir = yield* makeProjectDir("supabase-seed-buckets-e2e-preboth-");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["seed", "--local", "--remote", "buckets"],
          { cwd: projectDir },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain(
          "Only one of --remote, --linked, --db-url and --local can be set; got --remote and --local.",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
