import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { runSupabaseEffect, withTempCliProject, withTempHome } from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  it.live("reports invalid stack feature configuration during completion", () =>
    withTempHome((home) =>
      withTempCliProject("supabase-main-routing-e2e-", (project) =>
        Effect.gen(function* () {
          const result = yield* runSupabaseEffect(["__complete", "start", "--"], {
            cwd: project.dir,
            home: home.dir,
            env: {
              SUPABASE_EXPERIMENTAL_STACK: "yes",
              SUPABASE_WORKDIR: undefined,
            },
          });

          expect(result.exitCode).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain(
            'Invalid SUPABASE_EXPERIMENTAL_STACK="yes" (sets experimental.stack): expected true or false.',
          );
        }),
      ),
    ),
  );

  it.live(
    "refuses a local Spark stack key in [experimental.spark] by name, instead of ignoring it",
    () =>
      withTempHome((home) =>
        withTempCliProject("supabase-main-spark-routing-e2e-", (project) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const configPath = path.join(project.dir, "supabase", "config.toml");
            yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
            yield* fs.writeFileString(
              configPath,
              `project_id = "routing"\n\n[experimental.spark]\nenabled = true\nexecutable = "/usr/local/bin/spark"\n`,
            );
            const result = yield* runSupabaseEffect(["start"], {
              cwd: project.dir,
              home: home.dir,
              env: {
                SUPABASE_WORKDIR: undefined,
                SUPABASE_EXPERIMENTAL_SPARK_ENABLED: undefined,
                SUPABASE_EXPERIMENTAL_STACK: undefined,
                NODE_PATH: undefined,
              },
            });

            expect(result.exitCode).toBe(1);
            expect(result.stdout).toBe("");
            expect(result.stderr).toContain("experimental.spark.executable does not exist");
            expect(result.stderr).not.toContain("SUPABASE_EXPERIMENTAL_STACK");
            expect(
              yield* fs.exists(path.join(project.dir, "supabase", ".temp", "dev-instance.json")),
              "no dev instance was started",
            ).toBe(false);
          }).pipe(Effect.provide(BunServices.layer)),
        ),
      ),
  );
});
