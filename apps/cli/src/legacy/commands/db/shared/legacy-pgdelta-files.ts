import { Data, Effect, type FileSystem, Option, type Path } from "effect";

import type {
  LegacyPgDeltaExportManifest,
  LegacyPgDeltaSqlFile,
} from "./legacy-pgdelta-engine.service.ts";
import { legacyResolveSqlGlobFiles } from "../../../shared/legacy-seed-ops.ts";

const EXPORT_MANIFEST_FILE = ".pgdelta-export.json";

class LegacyPgDeltaFilesError extends Data.TaggedError("LegacyPgDeltaFilesError")<{
  readonly message: string;
}> {}

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
  return {
    redactSecrets,
    scope,
    ...(typeof profile === "string" ? { profile } : {}),
    ...(typeof baselineDigest === "string" ? { baselineDigest } : {}),
    ...(typeof defaultOwner === "string" || defaultOwner === null ? { defaultOwner } : {}),
    ...(Array.isArray(files) && files.every((file) => typeof file === "string") ? { files } : {}),
  } satisfies LegacyPgDeltaExportManifest;
});

/** Recursively loads path-safe `.sql` files in stable POSIX-relative order. */
export const LegacyLoadPgDeltaSqlFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
) {
  const pending = [directory];
  const paths: Array<{ readonly full: string; readonly name: string }> = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const entries = yield* fs
      .readDirectory(current)
      .pipe(
        Effect.mapError((error) =>
          filesError(`failed to read declarative schema directory: ${error.message}`),
        ),
      );
    for (const entry of entries) {
      const full = path.join(current, entry);
      const stat = yield* fs
        .stat(full)
        .pipe(
          Effect.mapError((error) =>
            filesError(`failed to inspect declarative schema file: ${error.message}`),
          ),
        );
      if (stat.type === "Directory") {
        pending.push(full);
        continue;
      }
      if (path.extname(entry).toLowerCase() !== ".sql") continue;

      const name = path.relative(directory, full).split("\\").join("/");
      const normalized = path.normalize(name);
      if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
        return yield* Effect.fail(filesError(`unsafe declarative schema path: ${name}`));
      }
      paths.push({ full, name });
    }
  }

  paths.sort((left, right) => left.name.localeCompare(right.name));
  const files: Array<LegacyPgDeltaSqlFile> = [];
  for (const file of paths) {
    const sql = yield* fs
      .readFileString(file.full)
      .pipe(
        Effect.mapError((error) =>
          filesError(`failed to read declarative schema file: ${error.message}`),
        ),
      );
    files.push({ name: file.name, sql });
  }
  return files;
});

/** Loads `[db.migrations].schema_paths` in configured pattern/application order. */
export const LegacyLoadPgDeltaSqlPaths = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
) {
  const resolved = yield* legacyResolveSqlGlobFiles(fs, path, patterns, workdir);
  if (resolved.files.length === 0) {
    return yield* Effect.fail(
      filesError(
        Option.isSome(resolved.warning)
          ? resolved.warning.value
          : "no declarative schema files matched schema_paths",
      ),
    );
  }
  const files: Array<LegacyPgDeltaSqlFile> = [];
  for (const file of resolved.files) {
    const full = path.isAbsolute(file) ? file : path.join(workdir, file);
    const sql = yield* fs
      .readFileString(full)
      .pipe(
        Effect.mapError((error) =>
          filesError(`failed to read declarative schema file: ${error.message}`),
        ),
      );
    files.push({ name: file.split("\\").join("/"), sql });
  }
  return files;
});
