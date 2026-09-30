import { describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Path } from "effect";
import { useTempWorkdir } from "../../../../tests/helpers/command-mocks.ts";
import { initNdjsonExporter } from "./ndjson.ts";

const fsLayer = BunServices.layer;

describe("initNdjsonExporter", () => {
  const tempRoot = useTempWorkdir("supabase-ndjson-test-");

  it.live("does not fail when traces directory does not exist", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* initNdjsonExporter(path.join(tempRoot.current, "traces"));
    }).pipe(Effect.provide(fsLayer)),
  );
});
