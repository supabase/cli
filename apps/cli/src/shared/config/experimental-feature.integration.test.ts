import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir, withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
  rejectUnsupportedSparkConfig,
} from "./experimental-feature.ts";
import { projectStateMode } from "./project-state-mode.ts";

describe("[experimental.spark] in the early config read", () => {
  const workdir = useTempWorkdir("experimental-feature-");

  const inProject = <A, E>(
    sparkTable: string,
    effect: (cwd: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir.current, "supabase", "config.toml"),
        `[experimental.spark]\n${sparkTable}\n`,
      );
      return yield* withConfigEnv({ SUPABASE_WORKDIR: workdir.current }, effect(workdir.current));
    }).pipe(Effect.provide(BunServices.layer));

  const read = (sparkTable: string) =>
    inProject(sparkTable, (cwd) =>
      readExperimentalFeatureConfig({ feature: "spark", args: [], cwd }),
    );

  it.effect("reads a literal enabled", () =>
    Effect.gen(function* () {
      expect(yield* read("enabled = true")).toBe(true);
      expect(yield* read("enabled = false")).toBe(false);
    }),
  );

  it.effect(
    "refuses each key of a local Spark stack by name, as a Spark error the stack routing does not raise",
    () =>
      Effect.gen(function* () {
        for (const [key, table] of [
          ["dev_instance", "enabled = true\ndev_instance = true"],
          ["executable", 'enabled = true\nexecutable = "/usr/local/bin/spark"'],
          ["studio_executable", 'studio_executable = "/opt/studio/bin/studio"'],
        ] as const) {
          const error = yield* inProject(table, (cwd) =>
            rejectUnsupportedSparkConfig({ args: [], cwd }),
          ).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
          expect(error.message).toContain(`experimental.spark.${key} does not exist`);
          expect(error.message).toContain("supabase/config.toml");
          expect(error.message).not.toContain("SUPABASE_EXPERIMENTAL_STACK");
          expect(yield* inProject(table, (cwd) => projectStateMode({ cwd }))).toBe(
            key === "studio_executable" ? "legacy" : "stack",
          );
        }
      }),
  );

  it.effect("refuses an env(...) enabled by name instead of reading it as unset", () =>
    Effect.gen(function* () {
      const table = 'enabled = "env(MY_SPARK)"';
      const error = yield* withConfigEnv(
        { MY_SPARK: "true" },
        inProject(table, (cwd) => rejectUnsupportedSparkConfig({ args: [], cwd })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      expect(error.message).toContain(
        "experimental.spark.enabled must be the literal true or false in supabase/config.toml",
      );
      expect(error.message).toContain("SUPABASE_EXPERIMENTAL_SPARK_ENABLED");
      expect(
        yield* inProject("enabled = true", (cwd) =>
          rejectUnsupportedSparkConfig({ args: [], cwd }),
        ),
      ).toBeUndefined();
    }),
  );
});
