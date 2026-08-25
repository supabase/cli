import { Data, Effect, type FileSystem, type Path } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { legacyWalkSqlFiles } from "../../../shared/legacy-glob.ts";
import type {
  LegacyPgDeltaExportManifest,
  LegacyPgDeltaSqlFile,
} from "./legacy-pgdelta-engine.service.ts";

const EXPORT_MANIFEST_FILE = ".pgdelta-export.json";

export class LegacyPgDeltaFilesError extends Data.TaggedError("LegacyPgDeltaFilesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

const filesError = (message: string) => new LegacyPgDeltaFilesError({ message });

function readManifestValue(doc: object, key: string): unknown {
  return Reflect.get(doc, key);
}

/** Reads a next-engine export manifest from an explicit declarative directory. */
export const LegacyReadPgDeltaExportManifest = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const manifestPath = path.join(directory, EXPORT_MANIFEST_FILE);
  const exists = yield* fs
    .exists(manifestPath)
    .pipe(
      Effect.mapError((error) => filesError(`cannot inspect export manifest: ${error.message}`)),
    );
  if (!exists) return undefined;

  const raw = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError((error) =>
        filesError(`cannot read export manifest ${manifestPath}: ${error.message}`),
      ),
    );
  const decoded = yield* Effect.try({
    try: (): unknown => JSON.parse(raw),
    catch: (cause) =>
      filesError(
        `malformed export manifest ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return yield* Effect.fail(filesError(`malformed export manifest ${manifestPath}`));
  }

  const formatVersion = readManifestValue(decoded, "formatVersion");
  const redactSecrets = readManifestValue(decoded, "redactSecrets");
  const scope = readManifestValue(decoded, "scope");
  if (
    (formatVersion !== undefined && formatVersion !== 1) ||
    typeof redactSecrets !== "boolean" ||
    (scope !== "database" && scope !== "cluster")
  ) {
    return yield* Effect.fail(
      filesError(`export manifest ${manifestPath} is missing required policy metadata`),
    );
  }

  const profile = readManifestValue(decoded, "profile");
  const baselineDigest = readManifestValue(decoded, "baselineDigest");
  const defaultOwner = readManifestValue(decoded, "defaultOwner");
  const files = readManifestValue(decoded, "files");
  const loadOrder = readManifestValue(decoded, "loadOrder");
  return {
    redactSecrets,
    scope,
    ...(typeof profile === "string" ? { profile } : {}),
    ...(typeof baselineDigest === "string" ? { baselineDigest } : {}),
    ...(typeof defaultOwner === "string" || defaultOwner === null ? { defaultOwner } : {}),
    ...(Array.isArray(files) && files.every((file) => typeof file === "string") ? { files } : {}),
    ...(Array.isArray(loadOrder) && loadOrder.every((file) => typeof file === "string")
      ? { loadOrder }
      : {}),
  } satisfies LegacyPgDeltaExportManifest;
});

/** Recursively loads path-safe `.sql` files in stable POSIX-relative order. */
export const LegacyLoadPgDeltaSqlFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const paths = yield* legacyWalkSqlFiles(fs, directory, "").pipe(
    Effect.mapError((error) =>
      filesError(
        error.reason.method === "stat"
          ? `failed to inspect declarative schema file: ${error.message}`
          : `failed to read declarative schema directory: ${error.message}`,
      ),
    ),
  );
  const files: Array<LegacyPgDeltaSqlFile> = [];
  for (const name of paths) {
    const normalized = path.normalize(name);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      return yield* Effect.fail(filesError(`unsafe declarative schema path: ${name}`));
    }
    const full = path.join(directory, name);
    const sql = yield* fs
      .readFileString(full)
      .pipe(
        Effect.mapError((error) =>
          filesError(`failed to read declarative schema file: ${error.message}`),
        ),
      );
    files.push({ name, sql });
  }
  return files;
});
