import { DateTime, Effect, Schema, type FileSystem, type Path } from "effect";

import { legacyPgDeltaTempPath } from "../../../shared/legacy-pgdelta.cache.ts";
import type {
  LegacyPgDeltaNextDiagnostic,
  LegacyPgDeltaNextOperation,
} from "./legacy-pgdelta-next-adapter.service.ts";

export interface LegacyPgDeltaNextDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
  readonly diagnostics?: ReadonlyArray<LegacyPgDeltaNextDiagnostic>;
}

/** Explicit cache/artifact generation for the bundled pg-delta implementation. */
export function legacyPgDeltaNextTempPath(path: Path.Path, workdir: string): string {
  return path.join(legacyPgDeltaTempPath(path, workdir), "v2");
}

/** Millisecond-resolution id so multiple operations in one command do not collide. */
export function legacyFormatPgDeltaNextDebugId(
  millis: number,
  operation: LegacyPgDeltaNextOperation,
): string {
  const digits = DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\D/gu, "").slice(0, 17);
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}-${digits.slice(14)}-${operation}`;
}

interface LegacyPgDeltaNextArtifactMetadata {
  readonly version: 1;
  readonly generation: "v2";
  readonly implementation: "next";
  readonly operation: LegacyPgDeltaNextOperation;
  readonly cacheReusable: false;
  readonly files: ReadonlyArray<string>;
}

/**
 * Writes bundled-engine debug data below the v2 generation. These files are
 * diagnostics only: they are never considered catalog-cache inputs.
 */
export const legacySavePgDeltaNextDebugArtifacts = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  id: string,
  operation: LegacyPgDeltaNextOperation,
  artifacts: LegacyPgDeltaNextDebugArtifacts,
) {
  const debugDir = path.join(legacyPgDeltaNextTempPath(path, workdir), "debug", id);
  yield* fs.makeDirectory(debugDir, { recursive: true });

  const files: Array<string> = [];
  const write = Effect.fnUntraced(function* (name: string, contents: string | undefined) {
    if (contents === undefined || contents.length === 0) return;
    yield* fs.writeFileString(path.join(debugDir, name), contents);
    files.push(name);
  });

  yield* write("source-snapshot.json", artifacts.sourceSnapshot);
  yield* write("desired-snapshot.json", artifacts.desiredSnapshot);
  yield* write("plan.json", artifacts.plan);
  if (artifacts.diagnostics !== undefined) {
    const diagnostics = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown, { space: 2 }),
    )(artifacts.diagnostics);
    yield* write("diagnostics.json", `${diagnostics}\n`);
  }

  const metadata: LegacyPgDeltaNextArtifactMetadata = {
    version: 1,
    generation: "v2",
    implementation: "next",
    operation,
    cacheReusable: false,
    files: [...files].sort(),
  };
  const encodedMetadata = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Unknown, { space: 2 }),
  )(metadata);
  yield* fs.writeFileString(path.join(debugDir, "metadata.json"), `${encodedMetadata}\n`);
  return debugDir;
});
