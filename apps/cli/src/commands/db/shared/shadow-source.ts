/**
 * The composed shadow-provisioning shape `db diff`/`db pull` call: {@link prepareShadowSource}
 * builds on `shared/db-bootstrap/shadow-database.ts`'s primitives and adds the migra
 * `--target-local` declarative-schema branch, which applies declarative files to a second
 * database on the same shadow container instead of diffing the user's local DB directly.
 * The `--schema` flag only scopes the diff itself, never what the shadow contains.
 */

import { Effect, Result, type FileSystem, type Path } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import {
  resolveDeclarativeDir,
  resolveSeedSqlPath,
  type PgDeltaTomlConfig,
} from "../../../command-internal/db-config.toml-read.ts";
import {
  resolveUnderWorkdir,
  globPattern,
  walkSqlFiles,
  compareUtf8Bytes,
} from "../../../command-internal/glob.ts";
import type { DockerRun } from "../../../command-internal/docker-run.service.ts";
import type { ImagePrepullError } from "../../../command-internal/db-bootstrap/image-prepull.ts";
import type { HealthCheckTimeoutError } from "../../../command-internal/db-bootstrap/health-check.ts";
import { waitForShadowReady } from "../../../command-internal/db-bootstrap/health-check.ts";
import { seedGlobals } from "../../../command-internal/migration-apply.ts";
import { BAD_PATTERN_MESSAGE, pathMatch } from "../../../command-internal/path-match.ts";
import { toPostgresURL } from "../../../command-internal/postgres-url.ts";
import type { ShadowAcquiredHandle } from "../../../command-internal/db-bootstrap/shadow-cache.ts";
import {
  migrateShadowDatabase,
  migrateNextShadowDatabase,
  ShadowDbError,
  type ShadowSetupInput,
  type ShadowSourceResult,
} from "../../../command-internal/db-bootstrap/shadow-database.ts";
import type { StartSetupLocalDatabaseError } from "../../../command-internal/db-bootstrap/db-setup.ts";
import { DeclarativeShadowDbError } from "./pgdelta.errors.ts";

type Spawner = ChildProcessSpawner["Service"];

export type { ShadowSourceResult };

export interface PrepareShadowSourceInput<E> extends ShadowSetupInput<E> {
  /** The only target-derived input the shadow prep needs. */
  readonly targetLocal: boolean;
  /** Selects the shadow baseline and whether a local target may use the migra declarative override. */
  readonly migrationMode?: "legacy" | "pgdelta-next";
  /** `db.migrations.schema_paths`, unresolved (raw config value). */
  readonly schemaPaths: ReadonlyArray<string>;
  readonly pgDelta: PgDeltaTomlConfig;
}

/** Every failure {@link prepareShadowSource} can produce, beyond its own `E` (JWKS resolution). */
export type PrepareShadowSourceError =
  | ShadowDbError
  | DeclarativeShadowDbError
  | HealthCheckTimeoutError
  | StartSetupLocalDatabaseError
  | ImagePrepullError;

/**
 * The `use` phase of an `Effect.acquireUseRelease` whose `acquire` creates the shadow and
 * `release` removes it (see the `diff`/`pull` handlers). Health-wait, migration replay, and
 * the declarative-schema override for legacy local targets all run here, not in `acquire` —
 * `acquireUseRelease` runs `acquire` under an uninterruptible mask, so nesting them there
 * would swallow a SIGINT until the whole sequence finished.
 */
export const prepareShadowSource = <E>(
  spawner: Spawner,
  handle: ShadowAcquiredHandle,
  input: PrepareShadowSourceInput<E>,
): Effect.Effect<
  ShadowSourceResult,
  PrepareShadowSourceError | E,
  Output | DockerRun | RuntimeInfo | HttpClient.HttpClient | DbConnection
> =>
  Effect.gen(function* () {
    const { containerId } = handle;

    const connConfig: PgConnInput = {
      host: input.hostname,
      port: input.shadowPort,
      user: "postgres",
      password: input.password,
      database: "postgres",
    };

    yield* waitForShadowReady(spawner, containerId, connConfig, {
      timeoutSeconds: input.healthTimeoutSeconds,
      image: input.image,
    });

    // `handle` doubles as the baseline state: on a warm shadow-cache hit it already holds the
    // platform baseline (so only the template database + user migrations run); on a
    // cache-enabled cold provision it carries the snapshot step that runs between the two — see
    // `shadow-cache.ts`/`ShadowBaselineState`. An uncached acquire is always-cold.
    const migrateShadow =
      input.migrationMode === "pgdelta-next" ? migrateNextShadowDatabase : migrateShadowDatabase;
    yield* migrateShadow(
      spawner,
      {
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        projectId: input.projectId,
        container: containerId,
        networkId: input.networkId,
        connConfig,
        setup: input.setup,
      },
      handle,
    );

    const sourceUrl = toPostgresURL(connConfig);

    let targetUrlOverride: string | undefined;
    if (input.targetLocal && input.migrationMode !== "pgdelta-next") {
      const declared = yield* loadDeclaredSchemas(
        input.fs,
        input.path,
        input.workdir,
        input.schemaPaths,
        input.pgDelta,
      );
      if (declared.length > 0) {
        const overrideConn: PgConnInput = { ...connConfig, database: "contrib_regression" };
        yield* migrateBaseDatabase(input.fs, input.path, input.workdir, overrideConn, declared);
        targetUrlOverride = toPostgresURL(overrideConn);
      }
    }

    return {
      container: containerId,
      sourceUrl,
      targetUrlOverride,
    } satisfies ShadowSourceResult;
  });

/** Glob metacharacters recognized here: `*?[` only — not `\`. */
function hasConfigGlobMeta(pattern: string): boolean {
  return /[*?[]/u.test(pattern);
}

/**
 * A pattern with no matches is an error, unless it contains a glob metacharacter, in which
 * case it's merely skipped — and the skip becomes an error too if every pattern in this call
 * was skipped and the combined result is still empty. Any resulting error always propagates,
 * unlike `resolveSchemaPathFiles`'s caller, which swallows errors once some files matched.
 */
function globDeclaredSchemaPaths(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, DeclarativeShadowDbError> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const result: Array<string> = [];
    const problems: Array<string> = [];
    const skipped: Array<string> = [];

    for (const rawPattern of patterns) {
      // Non-absolute entries resolve under `supabase/` first. Slashes are normalized only
      // when `path.sep !== "/"` (Windows): on POSIX, `\` is a literal `pathMatch`/`globPattern`
      // escape character, so converting it unconditionally would silently break a pattern like
      // `foo\*.sql` (matches the literal file `foo*.sql`) by turning it into `foo/*.sql` (a
      // subdirectory glob).
      const rawResolved = resolveSeedSqlPath(path, rawPattern);
      // `matchPattern` (slash-normalized) feeds the glob/match calls below; diagnostics always
      // use `rawResolved` (untouched), so an absolute Windows entry like `C:\schemas\*.sql`
      // still reports with its original backslashes even though it matched via forward slashes.
      const matchPattern = path.sep === "/" ? rawResolved : rawResolved.replaceAll("\\", "/");
      if (pathMatch(matchPattern, "").badPattern) {
        problems.push(`failed to glob files: ${BAD_PATTERN_MESSAGE}`);
        continue;
      }
      // An empty pattern must short-circuit to zero matches: `globPattern`'s literal-pattern
      // branch resolves `""` to the workdir itself, so without this guard an empty
      // `schema_paths` entry would collect every `.sql` file in the project instead of
      // matching nothing.
      // Byte order, not JS's default UTF-16 code-unit order; see `compareUtf8Bytes`'s own doc
      // comment.
      const matches =
        matchPattern.length === 0
          ? []
          : [...(yield* globPattern(fs, path, workdir, matchPattern))].sort(compareUtf8Bytes);
      if (matches.length === 0) {
        if (hasConfigGlobMeta(rawResolved)) {
          skipped.push(rawResolved);
          continue;
        }
        // The error shows the resolved, `supabase/`-prefixed pattern (not the raw
        // caller-supplied one), and keeps `rawResolved`'s original separators rather than
        // `matchPattern`'s slashes.
        problems.push(`no files matched pattern: ${rawResolved}`);
        continue;
      }
      for (const match of matches) {
        const absMatch = resolveUnderWorkdir(path, workdir, match);
        const statResult = yield* fs.stat(absMatch).pipe(Effect.result);
        if (Result.isFailure(statResult)) {
          problems.push(`failed to stat matched file: ${statResult.failure.message}`);
          continue;
        }
        if (statResult.success.type !== "Directory") {
          if (!seen.has(match)) {
            seen.add(match);
            result.push(match);
          }
          continue;
        }
        // A walk error propagates rather than being treated as an empty match set — silently
        // ignoring an unreadable subdirectory could omit a declared schema and compare a
        // local-target diff against the wrong target.
        const sqlRelativeResult = yield* walkSqlFiles(fs, absMatch, "").pipe(Effect.result);
        if (Result.isFailure(sqlRelativeResult)) {
          problems.push(`failed to walk matched directory: ${sqlRelativeResult.failure.message}`);
          continue;
        }
        for (const relative of sqlRelativeResult.success) {
          // `cleanSchemaPath` collapses a trailing separator in `match` (e.g. a directory entry
          // configured as `"supabase/schemas/"`), so a file reached both via this walk and via
          // its own literal `schema_paths` entry dedupes to the same key instead of
          // double-applying.
          const relativeToWorkdir = cleanSchemaPath(`${match}/${relative}`);
          if (!seen.has(relativeToWorkdir)) {
            seen.add(relativeToWorkdir);
            result.push(relativeToWorkdir);
          }
        }
      }
    }

    if (result.length === 0 && skipped.length > 0) {
      for (const pattern of skipped) problems.push(`no files matched pattern: ${pattern}`);
    }
    if (problems.length > 0) {
      return yield* Effect.fail(new DeclarativeShadowDbError({ message: problems.join("\n") }));
    }
    return result;
  });
}

/**
 * Shared walk tail for both `loadDeclaredSchemas` sources: regular `.sql` files only,
 * byte-sorted (see `walkSqlFiles`'s own doc comment). Unlike `globDeclaredSchemaPaths`'s
 * directory branch, the walk root itself is checked for being a symlink and treated as
 * empty if so — this walk never follows a symlinked root. Paths are joined with the
 * injected `Path` service so results use native separators on every platform.
 */
function walkSqlFilesSorted(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dirRel: string,
  errorPrefix: string,
): Effect.Effect<ReadonlyArray<string>, DeclarativeShadowDbError> {
  return Effect.gen(function* () {
    const dirAbs = resolveUnderWorkdir(path, workdir, dirRel);
    const isSymlinkRoot = yield* fs.readLink(dirAbs).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isSymlinkRoot) return [];
    const sqlRelative = yield* walkSqlFiles(fs, dirAbs, "").pipe(
      Effect.mapError(
        (cause) => new DeclarativeShadowDbError({ message: `${errorPrefix}: ${cause.message}` }),
      ),
    );
    return sqlRelative.map((relative) => path.join(dirRel, relative));
  });
}

/**
 * A three-source priority ladder: `db.migrations.schema_paths` (when non-empty), then
 * pg-delta's declarative dir (when `[experimental.pgdelta] enabled` and the dir exists), then
 * `supabase/schemas` (when it exists), then `[]`. Each source is byte-sorted.
 */
export function loadDeclaredSchemas(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
  pgDelta: PgDeltaTomlConfig,
): Effect.Effect<ReadonlyArray<string>, DeclarativeShadowDbError> {
  return Effect.gen(function* () {
    if (schemaPaths.length > 0) {
      return yield* globDeclaredSchemaPaths(fs, path, workdir, schemaPaths);
    }
    if (pgDelta.enabled) {
      const declDirRel = resolveDeclarativeDir(path, pgDelta);
      const declDirAbs = resolveUnderWorkdir(path, workdir, declDirRel);
      // A path that exists but is a regular file is treated as "not a directory," not an
      // error, so it falls through to the `supabase/schemas` source below.
      const isDeclDir = yield* fs.stat(declDirAbs).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isDeclDir) {
        return yield* walkSqlFilesSorted(
          fs,
          path,
          workdir,
          declDirRel,
          "failed to walk declarative dir",
        );
      }
    }
    const schemasDirRel = "supabase/schemas";
    const schemasDirAbs = resolveUnderWorkdir(path, workdir, schemasDirRel);
    // A missing path or a non-directory path both resolve to "no declared schemas" (`[]`),
    // not an error — only a genuine stat failure propagates.
    const isSchemasDir = yield* fs.stat(schemasDirAbs).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(false)
            : Effect.fail(
                new DeclarativeShadowDbError({
                  message: `failed to check schemas: ${cause.message}`,
                }),
              ),
        onSuccess: (info) => Effect.succeed(info.type === "Directory"),
      }),
    );
    if (!isSchemasDir) return [];
    return yield* walkSqlFilesSorted(fs, path, workdir, schemasDirRel, "failed to walk dir");
  });
}

/**
 * Windows-only sibling of {@link cleanSchemaPath}'s segment cleaner: the length of the leading
 * "volume" a Windows path can carry — a drive letter (`C:...`, length 2) or a UNC share
 * (`//host/share`, length through the second separator). Device-path forms (`\\.\`, `\\?\`)
 * aren't realistic `schema_paths` values, so they're not handled. `path` is already
 * backslash-normalized to `/` by the caller.
 */
function windowsVolumeLen(path: string): number {
  if (path.length >= 2 && path[1] === ":") return 2;
  if (path.length < 2 || path[0] !== "/" || path[1] !== "/") return 0;
  let separators = 0;
  for (let i = 2; i < path.length; i++) {
    if (path[i] === "/") {
      separators++;
      if (separators === 2) return i;
    }
  }
  return path.length;
}

/**
 * Backslash is a path separator only on Windows; on POSIX it's a literal filename character,
 * so separator normalization is gated on the host platform. A UNC/drive-letter volume prefix
 * is split off with {@link windowsVolumeLen} before the segment-cleanup loop, since that loop
 * would otherwise collapse a UNC path's two leading empty segments (`//host/share`) like any
 * other redundant separator.
 */
export function cleanSchemaPath(
  rawPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = platform === "win32" ? rawPath.replaceAll("\\", "/") : rawPath;
  const volumeLen = platform === "win32" ? windowsVolumeLen(normalized) : 0;
  const volume = normalized.slice(0, volumeLen);
  const remainder = normalized.slice(volumeLen);
  // A bare volume with nothing after it (`\\server\share`, or `C:`) is returned untouched —
  // the segment-cleanup loop below would otherwise turn "no path left" into a bare "." and
  // lose the volume.
  if (volumeLen > 0 && remainder === "") return volume;
  const isAbsolute = remainder.startsWith("/");
  const out: Array<string> = [];
  for (const segment of remainder.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
    } else {
      out.push(segment);
    }
  }
  const joined = out.join("/");
  if (joined.length === 0) return volume + (isAbsolute ? "/" : ".");
  return volume + (isAbsolute ? "/" : "") + joined;
}

/**
 * Prints the declarative-schema file list, connects to the shadow's `contrib_regression`
 * override, then seeds the files as globals — no history row or table, unlike the
 * transactional/seed distinctions {@link seedGlobals} otherwise applies for the migra engine.
 */
function migrateBaseDatabase(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  config: PgConnInput,
  migrations: ReadonlyArray<string>,
): Effect.Effect<void, DeclarativeShadowDbError, Output | DbConnection> {
  return Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw("Creating local database from declarative schemas:\n", "stderr");
      const msg = migrations.map((m) => ` • ${bold(m)}`).join("\n");
      yield* output.raw(`${msg}\n`, "stderr");

      const dbConnection = yield* DbConnection;
      const session = yield* dbConnection
        .connect(config, { isLocal: true, dnsResolver: "native" })
        .pipe(Effect.mapError((cause) => new DeclarativeShadowDbError({ message: cause.message })));

      const absolutePaths = migrations.map((m) => resolveUnderWorkdir(path, workdir, m));
      yield* seedGlobals(
        session,
        fs,
        path,
        absolutePaths,
        (message) => new DeclarativeShadowDbError({ message }),
      ).pipe(
        // A batch runs on its own pooled connection, so failing to acquire it is a
        // connection failure, not a statement failure: it wears this seam's own error
        // class (like the `connect` mapping above) and keeps the driver's suggestion.
        Effect.catchTag("DbConnectError", (cause) =>
          Effect.fail(
            new DeclarativeShadowDbError({
              message: cause.message,
              ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
            }),
          ),
        ),
      );
    }),
  );
}
