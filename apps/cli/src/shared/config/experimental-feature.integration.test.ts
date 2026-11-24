import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { useTempWorkdir, withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import {
  ExperimentalFeatureFlagError,
  readExperimentalFeatureConfig,
} from "./experimental-feature.ts";

describe("readExperimentalFeatureConfig for [experimental.spark]", () => {
  const workdir = useTempWorkdir("experimental-feature-");

  const read = (feature: "spark" | "sparkDevInstance", sparkTable: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(workdir.current, "supabase"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workdir.current, "supabase", "config.toml"),
        `[experimental.spark]\n${sparkTable}\n`,
      );
      return yield* withConfigEnv(
        { SUPABASE_WORKDIR: workdir.current },
        readExperimentalFeatureConfig({ feature, args: [], cwd: workdir.current }),
      );
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("reads literal booleans", () =>
    Effect.gen(function* () {
      expect(yield* read("sparkDevInstance", "dev_instance = true")).toBe(true);
      expect(yield* read("sparkDevInstance", "enabled = true")).toBe(false);
    }),
  );

  it.effect("refuses an env(...) dev_instance instead of reading it as unset", () =>
    Effect.gen(function* () {
      const error = yield* read("sparkDevInstance", 'dev_instance = "env(MY_DEV)"').pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ExperimentalFeatureFlagError);
      expect(error.message).toContain("experimental.spark.dev_instance");
    }),
  );

  it.effect("still reads an env(...) enabled as unset (unchanged)", () =>
    Effect.gen(function* () {
      expect(yield* read("spark", 'enabled = "env(MY_SPARK)"')).toBeUndefined();
    }),
  );
});
