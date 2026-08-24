import { describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import { initNdjsonExporter } from "./ndjson.ts";

const fsLayer = BunServices.layer;

describe("initNdjsonExporter", () => {
  it.live("does not fail when traces directory does not exist", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "supabase-ndjson-test-" });
      yield* initNdjsonExporter(`${dir}/traces`).pipe(
        Effect.ensuring(fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
    }).pipe(Effect.provide(fsLayer));
  });
});
