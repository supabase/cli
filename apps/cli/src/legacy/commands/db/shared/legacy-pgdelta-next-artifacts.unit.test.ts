import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  legacyFormatPgDeltaNextDebugId,
  legacyPgDeltaNextTempPath,
  legacySavePgDeltaNextDebugArtifacts,
} from "./legacy-pgdelta-next-artifacts.ts";
import { legacyPgDeltaTempPath } from "../../../shared/legacy-pgdelta.cache.ts";

describe("pg-delta next artifact generation", () => {
  it.effect("isolates v2 artifacts from legacy catalog paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(legacyPgDeltaTempPath(path, "/project")).toBe(
        join("/project", "supabase", ".temp", "pgdelta"),
      );
      expect(legacyPgDeltaNextTempPath(path, "/project")).toBe(
        join("/project", "supabase", ".temp", "pgdelta", "v2"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("uses millisecond-resolution, operation-qualified debug ids", () => {
    expect(legacyFormatPgDeltaNextDebugId(Date.UTC(2024, 0, 2, 3, 4, 5, 678), "diff")).toBe(
      "20240102-030405-678-diff",
    );
  });

  it.effect("writes structured non-cache artifacts and metadata under v2", () => {
    const root = mkdtempSync(join(tmpdir(), "pgdelta-next-artifacts-"));
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const debugDir = yield* legacySavePgDeltaNextDebugArtifacts(
        fs,
        path,
        root,
        "20240102-030405-678-diff",
        "diff",
        {
          sourceSnapshot: '{"source":true}\n',
          desiredSnapshot: '{"desired":true}\n',
          plan: '{"plan":true}\n',
          diagnostics: [
            { origin: "source", code: "PG001", severity: "warning", message: "warning" },
          ],
        },
      );

      expect(debugDir).toBe(
        join(root, "supabase", ".temp", "pgdelta", "v2", "debug", "20240102-030405-678-diff"),
      );
      expect(JSON.parse(readFileSync(join(debugDir, "metadata.json"), "utf8"))).toEqual({
        version: 1,
        generation: "v2",
        implementation: "next",
        operation: "diff",
        cacheReusable: false,
        files: ["desired-snapshot.json", "diagnostics.json", "plan.json", "source-snapshot.json"],
      });
      expect(JSON.parse(readFileSync(join(debugDir, "diagnostics.json"), "utf8"))).toEqual([
        { origin: "source", code: "PG001", severity: "warning", message: "warning" },
      ]);
    }).pipe(
      Effect.provide(BunServices.layer),
      Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
    );
  });
});
