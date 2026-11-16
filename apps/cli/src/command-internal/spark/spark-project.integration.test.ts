import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { mockCommandSettings, withConfigEnv } from "../../../tests/helpers/command-mocks.ts";
import { SparkUnsupportedError, sparkUnsupported, withSparkBackend } from "./spark-project.ts";

const projectWith = (config: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-spark-project-" });
    yield* fs.makeDirectory(path.join(root, "supabase"), { recursive: true });
    yield* fs.writeFileString(path.join(root, "supabase", "config.toml"), config);
    return root;
  });

const dispatch = (root: string) =>
  withConfigEnv(
    {},
    withSparkBackend(Effect.succeed("postgres"), sparkUnsupported("db dump")).pipe(
      Effect.provide(mockCommandSettings({ workdir: root })),
    ),
  );

describe("withSparkBackend", () => {
  it.live("fails a command Spark does not implement with a clear message in a Spark project", () =>
    Effect.gen(function* () {
      const root = yield* projectWith('project_id = "p"\n[experimental.spark]\nenabled = true\n');

      const error = yield* dispatch(root).pipe(Effect.flip);

      expect(error).toBeInstanceOf(SparkUnsupportedError);
      expect(error.message).toBe(
        "`supabase db dump` is not supported on the experimental Spark backend (no Postgres runs locally).",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("runs the Postgres command when the project has not opted into Spark", () =>
    Effect.gen(function* () {
      const root = yield* projectWith('project_id = "p"\n');

      expect(yield* dispatch(root)).toBe("postgres");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
