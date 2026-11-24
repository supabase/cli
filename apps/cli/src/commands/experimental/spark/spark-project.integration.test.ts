import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir, withConfigEnv } from "../../../../tests/helpers/command-mocks.ts";
import { ExperimentalFeatureFlagError } from "../../../shared/config/experimental-feature.ts";
import { resolveSparkEnabled } from "./spark-project.ts";

describe("resolveSparkEnabled", () => {
  const workdir = useTempWorkdir("spark-project-");

  const resolveWith = (sparkTable: string, env: Record<string, string> = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir.current, "supabase", "config.toml"),
        `[experimental.spark]\n${sparkTable}\n`,
      );
      return yield* withConfigEnv(
        { SUPABASE_WORKDIR: workdir.current, ...env },
        resolveSparkEnabled({ args: ["status"], cwd: workdir.current }),
      );
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("reads a literal enabled from the project config", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith("enabled = true")).toBe(true);
      expect(yield* resolveWith("enabled = false")).toBe(false);
    }),
  );
  it.effect("refuses experimental.stack together with experimental.spark.enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir.current, "supabase", "config.toml"),
        "[experimental]\nstack = true\n\n[experimental.spark]\nenabled = true\n",
      );
      const error = yield* withConfigEnv(
        { SUPABASE_WORKDIR: workdir.current },
        resolveSparkEnabled({ args: ["status"], cwd: workdir.current }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      expect(error.message).toContain("experimental.spark.enabled and experimental.stack");
      expect(error.message).toContain("SUPABASE_EXPERIMENTAL_STACK");
    }).pipe(Effect.provide(BunServices.layer)),
  );


  it.effect("refuses an env(...) enabled by name instead of reading it as unset", () =>
    Effect.gen(function* () {
      const error = yield* resolveWith('enabled = "env(MY_SPARK)"', { MY_SPARK: "true" }).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      expect(error.message).toContain(
        "experimental.spark.enabled must be the literal true or false in supabase/config.toml",
      );
      expect(error.message).toContain("SUPABASE_EXPERIMENTAL_SPARK_ENABLED");
    }),
  );
});
