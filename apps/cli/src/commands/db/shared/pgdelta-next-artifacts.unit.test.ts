import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";

import {
  formatPgDeltaNextDebugId,
  pgDeltaNextTempPath,
  savePgDeltaNextDebugArtifacts,
} from "./pgdelta-next-artifacts.ts";
import { pgDeltaTempPath } from "../../../command-internal/pgdelta.paths.ts";

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

describe("pg-delta next artifact generation", () => {
  it.effect("writes structured non-cache artifacts and metadata under v2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "pgdelta-next-artifacts-" });
      const debugId = formatPgDeltaNextDebugId(Date.UTC(2024, 0, 2, 3, 4, 5, 678), "diff");
      const debugDir = yield* savePgDeltaNextDebugArtifacts(fs, path, root, debugId, "diff", {
        sourceSnapshot: '{"source":true}\n',
        desiredSnapshot: '{"desired":true}\n',
        plan: '{"plan":true}\n',
        diagnostics: [{ origin: "source", code: "PG001", severity: "warning", message: "warning" }],
      });
      const readJson = (file: string) =>
        fs
          .readFileString(path.join(debugDir, file))
          .pipe(Effect.flatMap(Schema.decodeEffect(UnknownFromJsonString)));

      expect(debugId).toBe("20240102-030405-678-diff");
      expect(pgDeltaNextTempPath(path, root)).not.toBe(pgDeltaTempPath(path, root));
      expect(debugDir).toBe(path.join(pgDeltaNextTempPath(path, root), "debug", debugId));
      expect(yield* readJson("metadata.json")).toEqual({
        version: 1,
        generation: "v2",
        implementation: "next",
        operation: "diff",
        cacheReusable: false,
        files: ["desired-snapshot.json", "diagnostics.json", "plan.json", "source-snapshot.json"],
      });
      expect(yield* fs.readFileString(path.join(debugDir, "metadata.json"))).toBe(`{
  "version": 1,
  "generation": "v2",
  "implementation": "next",
  "operation": "diff",
  "cacheReusable": false,
  "files": [
    "desired-snapshot.json",
    "diagnostics.json",
    "plan.json",
    "source-snapshot.json"
  ]
}
`);
      expect(yield* readJson("diagnostics.json")).toEqual([
        { origin: "source", code: "PG001", severity: "warning", message: "warning" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
