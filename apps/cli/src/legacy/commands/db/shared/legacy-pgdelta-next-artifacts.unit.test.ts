import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  legacyFormatPgDeltaNextDebugId,
  legacyPgDeltaNextTempPath,
  legacySavePgDeltaNextDebugArtifacts,
} from "./legacy-pgdelta-next-artifacts.ts";
import { legacyPgDeltaTempPath } from "../../../shared/legacy-pgdelta.cache.ts";

describe("pg-delta next artifact generation", () => {
  it.effect("writes structured non-cache artifacts and metadata under v2", () => {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pgdelta-next-artifacts-" });
      const debugId = legacyFormatPgDeltaNextDebugId(Date.UTC(2024, 0, 2, 3, 4, 5, 678), "diff");
      const debugDir = yield* legacySavePgDeltaNextDebugArtifacts(fs, path, root, debugId, "diff", {
        sourceSnapshot: '{"source":true}\n',
        desiredSnapshot: '{"desired":true}\n',
        plan: '{"plan":true}\n',
        diagnostics: [{ origin: "source", code: "PG001", severity: "warning", message: "warning" }],
      });

      expect(debugId).toBe("20240102-030405-678-diff");
      expect(legacyPgDeltaNextTempPath(path, root)).not.toBe(legacyPgDeltaTempPath(path, root));
      expect(debugDir).toBe(path.join(legacyPgDeltaNextTempPath(path, root), "debug", debugId));
      const metadata = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(path.join(debugDir, "metadata.json")),
      );
      const diagnostics = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* fs.readFileString(path.join(debugDir, "diagnostics.json")),
      );
      expect(metadata).toEqual({
        version: 1,
        generation: "v2",
        implementation: "next",
        operation: "diff",
        cacheReusable: false,
        files: ["desired-snapshot.json", "diagnostics.json", "plan.json", "source-snapshot.json"],
      });
      expect(diagnostics).toEqual([
        { origin: "source", code: "PG001", severity: "warning", message: "warning" },
      ]);
    }).pipe(Effect.provide(BunServices.layer));
  });
});
