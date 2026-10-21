import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { runSupabaseEffect, withTempCliProject, withTempHome } from "../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;

describe("supabase __complete", () => {
  it.live(
    "migration li completes to list with a description and the NoFileComp directive",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["__complete", "migration", "li"],
          {},
        );
        expect(exitCode).toBe(0);
        const lines = stdout.trim().split("\n");
        expect(lines[0]).toBe("list\tList local files and the target database's migration history");
        expect(lines.at(-1)).toBe(":4");
      }),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "__completeNoDesc strips the description from the same candidate",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runSupabaseEffect(
          ["__completeNoDesc", "migration", "li"],
          {},
        );
        expect(exitCode).toBe(0);
        const lines = stdout.trim().split("\n");
        expect(lines[0]).toBe("list");
        expect(lines.at(-1)).toBe(":4");
      }),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "root-level flag-name completion offers --debug",
    () =>
      Effect.gen(function* () {
        const { exitCode, stdout } = yield* runSupabaseEffect(["__complete", "--d"], {});
        expect(exitCode).toBe(0);
        expect(stdout).toContain("--debug\toutput debug logs to stderr");
      }),
    E2E_TIMEOUT_MS,
  );

  it.live(
    "routes complete command paths and keeps malformed config on the legacy tree",
    () =>
      withTempHome((home) =>
        withTempCliProject("supabase-completion-routing-e2e-", (project) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            yield* fs.makeDirectory(path.join(project.dir, "supabase"), { recursive: true });
            yield* fs.writeFileString(
              path.join(project.dir, "supabase", "config.toml"),
              "[experimental\n",
            );

            const prefix = yield* runSupabaseEffect(["__complete", "start"], {
              cwd: project.dir,
              home: home.dir,
              env: {
                SUPABASE_EXPERIMENTAL_STACK: undefined,
                SUPABASE_WORKDIR: undefined,
              },
            });
            expect(prefix.exitCode).toBe(0);
            expect(prefix.stdout).toContain("start");
            expect(prefix.stderr).toBe("");

            const fallback = yield* runSupabaseEffect(
              ["__complete", "--output-format=json", "start", "--"],
              {
                cwd: project.dir,
                home: home.dir,
                env: {
                  SUPABASE_EXPERIMENTAL_STACK: undefined,
                  SUPABASE_WORKDIR: undefined,
                },
              },
            );
            expect(fallback.exitCode).toBe(0);
            expect(fallback.stdout).toContain("--ignore-health-check");
            expect(fallback.stderr).toBe("");

            const help = yield* runSupabaseEffect(["start", "--help"], {
              cwd: project.dir,
              home: home.dir,
              env: {
                SUPABASE_EXPERIMENTAL_STACK: undefined,
                SUPABASE_WORKDIR: undefined,
              },
            });
            expect(help.exitCode).toBe(0);
            expect(help.stdout).toContain("--ignore-health-check");
            expect(help.stderr).toBe("");

            const completionFailure = yield* runSupabaseEffect(
              ["__complete", "--output-format=json", "start", "--"],
              {
                cwd: project.dir,
                home: home.dir,
                env: {
                  SUPABASE_EXPERIMENTAL_STACK: "invalid",
                  SUPABASE_WORKDIR: undefined,
                },
              },
            );
            expect(completionFailure.exitCode).toBe(1);
            expect(completionFailure.stdout).toBe("");
            expect(completionFailure.stderr).toContain(
              'Invalid SUPABASE_EXPERIMENTAL_STACK="invalid" (sets experimental.stack): expected true or false.',
            );

            const invalidEnv = yield* runSupabaseEffect(["start", "--output-format=json"], {
              cwd: project.dir,
              home: home.dir,
              env: {
                SUPABASE_EXPERIMENTAL_STACK: "invalid",
                SUPABASE_WORKDIR: undefined,
              },
            });
            expect(invalidEnv.exitCode).toBe(1);
            expect(invalidEnv.stderr).toBe("");
            expect(
              yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(invalidEnv.stdout),
            ).toMatchObject({
              _tag: "Error",
              error: { code: "StackRoutingError" },
            });
          }),
        ),
      ).pipe(Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
