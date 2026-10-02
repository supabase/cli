import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

const withStorageProject = <A, E, R>(
  prefix: string,
  use: (projectDir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectDir = yield* fs.makeTempDirectoryScoped({ prefix });
    yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(projectDir, "supabase", "config.toml"),
      'project_id = "test"\n',
    );
    return yield* use(projectDir);
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Golden-path e2e for `storage`: the compiled binary and `--linked`/`--local` flag
 * parsing. Object list/copy/move/remove behavior is covered by the integration and
 * unit suites, which don't need a live local stack.
 */
describe("supabase storage", () => {
  it.live(
    "lists the four subcommands in --help",
    () =>
      withStorageProject("supabase-storage-e2e-help-", (projectDir) =>
        Effect.gen(function* () {
          const { exitCode, stdout } = yield* runSupabaseEffect(["storage", "--help"], {
            cwd: projectDir,
          });
          expect(exitCode).toBe(0);
          for (const sub of ["ls", "cp", "mv", "rm"]) {
            expect(stdout).toContain(sub);
          }
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects passing both --local and --linked",
    () =>
      withStorageProject("supabase-storage-e2e-mutex-", (projectDir) =>
        Effect.gen(function* () {
          // The experimental gate runs before the mutex check, so --experimental must be
          // set here to reach the mutex check at all.
          const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
            ["storage", "ls", "--local", "--linked", "ss:///", "--experimental"],
            { cwd: projectDir },
          );
          expect(exitCode).toBe(1);
          expect(`${stdout}${stderr}`).toContain(
            "if any flags in the group [linked local] are set none of the others can be",
          );
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "rejects storage subcommands without --experimental",
    () =>
      withStorageProject("supabase-storage-e2e-gate-", (projectDir) =>
        Effect.gen(function* () {
          const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
            ["storage", "ls", "ss:///", "--local"],
            { cwd: projectDir },
          );
          expect(exitCode).toBe(1);
          expect(`${stdout}${stderr}`).toContain(
            "must set the --experimental flag to run this command",
          );
        }),
      ),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "accepts --local after the subcommand token",
    () =>
      withStorageProject("supabase-storage-e2e-local-", (projectDir) =>
        Effect.gen(function* () {
          // --linked/--local are per-leaf flags, not global ones — Effect CLI requires
          // unique global-flag names tree-wide and `seed` already owns those names.
          const { stdout, stderr } = yield* runSupabaseEffect(
            ["storage", "ls", "ss:///", "--local", "--experimental"],
            { cwd: projectDir },
          );
          const combined = `${stdout}${stderr}`;
          expect(combined).not.toContain("Unrecognized flag");
          expect(combined).not.toContain("must set the --experimental flag");
        }),
      ),
    E2E_TIMEOUT_MS,
  );
});
