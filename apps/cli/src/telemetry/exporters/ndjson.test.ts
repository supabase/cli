import { describe, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { initNdjsonExporter } from "./ndjson.ts";

const fsLayer = BunServices.layer;

describe("initNdjsonExporter", () => {
  it.live("does not fail when traces directory does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "supabase-ndjson-test-"));
    const tracesDir = path.join(dir, "traces");
    return Effect.gen(function* () {
      yield* initNdjsonExporter(tracesDir);
    }).pipe(
      Effect.provide(fsLayer),
      Effect.ensuring(Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
    );
  });
});
