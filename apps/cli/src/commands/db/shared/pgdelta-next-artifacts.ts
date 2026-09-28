import { DateTime, Effect, type FileSystem, type Path, Schema } from "effect";

import { pgDeltaTempPath } from "../../../command-internal/pgdelta.paths.ts";
import type {
  PgDeltaNextDiagnostic,
  PgDeltaNextOperation,
} from "./pgdelta-next-adapter.service.ts";

export interface PgDeltaNextDebugArtifacts {
  readonly sourceSnapshot?: string;
  readonly desiredSnapshot?: string;
  readonly plan?: string;
  readonly diagnostics?: ReadonlyArray<PgDeltaNextDiagnostic>;
}

/** Explicit cache/artifact generation for the bundled pg-delta implementation. */
export function pgDeltaNextTempPath(path: Path.Path, workdir: string): string {
  return path.join(pgDeltaTempPath(path, workdir), "v2");
}

const PrettyJsonString = Schema.fromJsonString(Schema.Unknown, { space: 2 });

/** Millisecond-resolution id so multiple operations in one command do not collide. */
export function formatPgDeltaNextDebugId(millis: number, operation: PgDeltaNextOperation): string {
  const digits = DateTime.formatIso(DateTime.makeUnsafe(millis)).replace(/\D/gu, "").slice(0, 17);
  return `${digits.slice(0, 8)}-${digits.slice(8, 14)}-${digits.slice(14)}-${operation}`;
}

interface PgDeltaNextArtifactMetadata {
  readonly version: 1;
  readonly generation: "v2";
  readonly implementation: "next";
  readonly operation: PgDeltaNextOperation;
  readonly cacheReusable: false;
  readonly files: ReadonlyArray<string>;
}

/**
 * Writes bundled-engine debug data below the v2 generation. These files are
 * diagnostics only: they are never considered catalog-cache inputs.
 */
export const savePgDeltaNextDebugArtifacts = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  id: string,
  operation: PgDeltaNextOperation,
  artifacts: PgDeltaNextDebugArtifacts,
) {
  const debugDir = path.join(pgDeltaNextTempPath(path, workdir), "debug", id);
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
    const diagnostics = yield* Schema.encodeEffect(PrettyJsonString)(artifacts.diagnostics);
    yield* write("diagnostics.json", `${diagnostics}\n`);
  }

  const metadata: PgDeltaNextArtifactMetadata = {
    version: 1,
    generation: "v2",
    implementation: "next",
    operation,
    cacheReusable: false,
    files: [...files].sort(),
  };
  const serializedMetadata = yield* Schema.encodeEffect(PrettyJsonString)(metadata);
  yield* fs.writeFileString(path.join(debugDir, "metadata.json"), `${serializedMetadata}\n`);
  return debugDir;
});
