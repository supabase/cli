import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import { expect } from "vitest";

import { test } from "../../../tests/helpers/live.ts";

const linkedProjectCache = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ ref: Schema.String })),
);

test("links a project and writes its workspace cache", ({
  cliEffect,
  project,
  signal,
  workspace,
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* cliEffect(["link", "--project-ref", project.ref, "--skip-pooler"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("Finished supabase link");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cache = yield* linkedProjectCache(
        yield* fs.readFileString(
          path.join(workspace.path, "supabase", ".temp", "linked-project.json"),
        ),
      );
      expect(cache.ref).toBe(project.ref);
    }).pipe(Effect.provide(BunServices.layer)),
    { signal },
  ));
