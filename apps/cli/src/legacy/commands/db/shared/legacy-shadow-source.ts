/**
 * The composed shadow-database shapes `db diff`/`db pull` actually call — Go's
 * `PrepareShadowSource`/`PrepareRawShadow` (`apps/cli-go/internal/db/diff/shadow.go`), built
 * on top of `shared/db-bootstrap/shadow-database.ts`'s lower-level primitives plus the
 * `--target-local` declarative-schema branch (Go's `loadDeclaredSchemas`/
 * `shouldApplyDeclarativeWithPgDelta`/`migrateBaseDatabase`, `internal/db/diff/diff.go:52-115,
 * 261-274`) and pg-delta's declarative apply engine (`legacy-pgdelta.apply.ts`).
 *
 * Go's `PrepareShadowSource(ctx, schema []string, targetLocal, usePgDelta bool, fsys,
 * options...)` takes a `schema` parameter that is NEVER referenced anywhere in the function
 * body (verified by reading the whole function) — dead code in Go itself, making `db __shadow
 * --schema` a no-op. Deliberately NOT ported here: there is nothing to port.
 */

import { Effect, Option, Result, type FileSystem, type Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import type { GlobalFlag } from "effect/unstable/cli";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../../shared/output/output.service.ts";
import type { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import type { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyResolveDeclarativeDir,
  legacyResolveSeedSqlPath,
  type LegacyPgDeltaTomlConfig,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyDbConfigLoadError } from "../../../shared/legacy-db-config.errors.ts";
import { legacyResolveUnderWorkdir, legacyGlobPattern } from "../../../shared/legacy-glob.ts";
import type { LegacyDockerRun } from "../../../shared/legacy-docker-run.service.ts";
import type { LegacyImagePrepullError } from "../../../shared/containers/image-prepull.ts";
import type { LegacyHealthCheckTimeoutError } from "../../../shared/containers/health-check.ts";
import { legacyWaitForHealthyServices } from "../../../shared/containers/health-check.ts";
import { legacySeedGlobals } from "../../../shared/legacy-migration-apply.ts";
import { LEGACY_BAD_PATTERN_MESSAGE, legacyPathMatch } from "../../../shared/legacy-path-match.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import type { LegacyLocalDbContainerInputs } from "../../../shared/db-bootstrap/local-container-inputs.ts";
import type { LegacyVaultSecret } from "../../../shared/legacy-vault.ts";
import {
  legacyCreateShadowDatabase,
  legacyMigrateShadowDatabase,
  legacyRemoveShadowDatabase,
  LegacyShadowDbError,
  type LegacyShadowConnectionInput,
  type LegacyShadowDbSetupInput,
  type LegacyShadowSourceResult,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import type { LegacyStartSetupLocalDatabaseError } from "../../../shared/db-bootstrap/db-setup.ts";
import {
  LegacyDeclarativeApplyError,
  legacyApplyDeclarativePgDelta,
} from "./legacy-pgdelta.apply.ts";
import { LegacyDeclarativeShadowDbError } from "./legacy-pgdelta.errors.ts";
import type { LegacyPgDeltaContext } from "./legacy-pgdelta.ts";

type Spawner = ChildProcessSpawner["Service"];

export type { LegacyShadowSourceResult };

/**
 * Adapts {@link LegacyLocalDbContainerInputs} (`local-container-inputs.ts`, the SAME
 * config/image/JWKS resolution prelude `db start`/`db reset` share) plus the caller's own
 * already-loaded `config.toml` slice into {@link LegacyShadowConnectionInput}
 * (`shadow-database.ts`) — every field {@link legacyPrepareShadowSource}/
 * `legacyPrepareRawShadow` (`shadow-database.ts`) need EXCEPT the diff/pull-specific ones
 * (`targetLocal`/`usePgDelta`/`schemaPaths`/`pgDelta`/`ctx`/`setup`, left to each call site).
 * Hoisted here so `db diff`/`db pull` don't each declare an identical ~20-field object literal.
 *
 * On `db diff --linked`/`db pull` (linked), the caller passes its own resolved ref straight
 * through to {@link legacyBuildLocalDbContainerInputs} (its own `projectRef` parameter — see
 * that function's doc comment), which threads it into `legacyLoadLocalProjectContext` ->
 * `loadProjectConfig({ projectRef })`. So the shadow's OWN container config (image, JWT
 * secret, root key, `db.settings`, service enabled-for-setup flags, sourced from
 * `localInputs.context.config`/`postgresSpecBase`) reflects the matching `[remotes.<ref>]`
 * override, same as `toml` (the caller's own `legacyReadDbToml(..., linkedRef)` result,
 * which feeds `pgDelta`/vault/`apiAutoExposeNewTables` below) — matching Go's own uniform
 * remote-merge on the linked path (`LoadConfig` seeds `flags.ProjectRef` before every field
 * read). The two config reads still go through independent remote-merge implementations
 * (`@supabase/config`'s `applyRemoteOverride` for `localInputs.context.config`;
 * `legacy-db-config.toml-read.ts`'s own TOML-based merge for `toml`) rather than a single
 * shared decode — unifying those is a larger, out-of-scope refactor, not a per-command gap.
 */
export function legacyShadowRunInputFromLocalContainerInputs(
  localInputs: LegacyLocalDbContainerInputs,
  resolvedImage: string,
  toml: {
    readonly shadowPort: number;
    readonly password: string;
    readonly baseline: { readonly apiAutoExposeNewTables: Option.Option<boolean> };
    readonly vault: ReadonlyArray<LegacyVaultSecret>;
  },
  fs: FileSystem.FileSystem,
  path: Path.Path,
): Omit<
  LegacyPrepareShadowSourceInput<LegacyDbConfigLoadError>,
  "targetLocal" | "usePgDelta" | "schemaPaths" | "pgDelta" | "ctx"
> {
  const { postgresSpecBase } = localInputs;
  return {
    db: {
      major_version: postgresSpecBase.db.major_version,
      settings: postgresSpecBase.db.settings,
    },
    experimental: postgresSpecBase.experimental,
    jwtSecret: postgresSpecBase.jwtSecret,
    jwtExpiry: postgresSpecBase.jwtExpiry,
    networkId: localInputs.networkId,
    image: resolvedImage,
    configImage: postgresSpecBase.configImage,
    rootKey: postgresSpecBase.rootKey,
    shadowPort: toml.shadowPort,
    projectId: localInputs.context.projectId,
    isBitbucketPipeline: localInputs.containerOpts.isBitbucketPipeline,
    workdir: localInputs.containerOpts.workdir,
    extraHosts: localInputs.containerOpts.extraHosts,
    fs,
    path,
    hostname: localInputs.context.hostname,
    password: toml.password,
    healthTimeoutSeconds: localInputs.dbHealthTimeoutSeconds,
    setup: {
      majorVersion: localInputs.setup.majorVersion,
      config: localInputs.setup.config,
      dbUrl: localInputs.setup.dbUrl,
      jwtSecret: localInputs.setup.jwtSecret,
      jwks: localInputs.setup.jwks,
      apiUrl: localInputs.setup.apiUrl,
      authExternalUrl: localInputs.setup.authExternalUrl,
      siteUrl: localInputs.setup.siteUrl,
      anonKey: localInputs.setup.anonKey,
      serviceRoleKey: localInputs.setup.serviceRoleKey,
      storageTargetMigration: localInputs.setup.storageTargetMigration,
      realtimeEnabledForSetup: localInputs.setup.realtimeEnabledForSetup,
      storageEnabledForSetup: localInputs.setup.storageEnabledForSetup,
      authEnabledForSetup: localInputs.setup.authEnabledForSetup,
      serviceVersionOverrides: localInputs.setup.serviceVersionOverrides,
      projectEnvValues: localInputs.setup.projectEnvValues,
      apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
      vault: toml.vault,
    },
  };
}

export interface LegacyPrepareShadowSourceInput<E> extends LegacyShadowConnectionInput {
  readonly setup: LegacyShadowDbSetupInput<E>;
  /** Go's `utils.IsLocalDatabase(config)` — the only target-derived input the shadow prep needs. */
  readonly targetLocal: boolean;
  /** Selects the declarative-apply engine for the local-declared branch, matching `DiffDatabase`. */
  readonly usePgDelta: boolean;
  /** `db.migrations.schema_paths`, RAW (unresolved) — Go's `Config.Db.Migrations.SchemaPaths` pre-`config.go:976-979`-resolution form. */
  readonly schemaPaths: ReadonlyArray<string>;
  readonly pgDelta: LegacyPgDeltaTomlConfig;
  /** Ambient pg-delta edge-runtime context, only read on the pg-delta declarative-apply sub-branch. */
  readonly ctx: LegacyPgDeltaContext;
}

/** Every failure {@link legacyPrepareShadowSource} can produce, beyond its own `E` (JWKS resolution). */
export type LegacyPrepareShadowSourceError =
  | LegacyShadowDbError
  | LegacyDeclarativeShadowDbError
  | LegacyHealthCheckTimeoutError
  | LegacyStartSetupLocalDatabaseError
  | LegacyImagePrepullError
  | LegacyDeclarativeApplyError;

/**
 * Port of Go's `PrepareShadowSource` (`apps/cli-go/internal/db/diff/shadow.go:37-91`):
 * create -> health-wait -> `MigrateShadowDatabase` (platform baseline + local migrations +
 * the `contrib_regression` template database) -> build the diff-source config -> when
 * `targetLocal`, the declarative-schema override branch. On ANY failure after creation the
 * shadow container is removed (Go's `ok`-sentinel + `defer` pattern); `Effect.onError` mirrors
 * this exactly (fires on a typed failure OR an interrupt, matching Go's defer running
 * regardless of *how* the function returns early) rather than `Effect.tapError` (which never
 * sees a pure interrupt).
 */
export const legacyPrepareShadowSource = <E>(
  spawner: Spawner,
  input: LegacyPrepareShadowSourceInput<E>,
): Effect.Effect<
  LegacyShadowSourceResult,
  LegacyPrepareShadowSourceError | E,
  | Output
  | LegacyDockerRun
  | RuntimeInfo
  | HttpClient.HttpClient
  | LegacyDbConnection
  | LegacyEdgeRuntimeScript
  | GlobalFlag.Setting.Identifier<"debug">
> =>
  Effect.gen(function* () {
    const { containerId, secretDirId } = yield* legacyCreateShadowDatabase(spawner, input);

    return yield* Effect.gen(function* () {
      yield* legacyWaitForHealthyServices(spawner, [containerId], {
        timeoutSeconds: input.healthTimeoutSeconds,
      });

      const connConfig: LegacyPgConnInput = {
        host: input.hostname,
        port: input.shadowPort,
        user: "postgres",
        password: input.password,
        database: "postgres",
      };
      yield* legacyMigrateShadowDatabase(spawner, {
        fs: input.fs,
        path: input.path,
        workdir: input.workdir,
        container: containerId,
        networkId: input.networkId,
        connConfig,
        setup: input.setup,
      });

      const sourceUrl = legacyToPostgresURL(connConfig);

      let targetUrlOverride: string | undefined;
      if (input.targetLocal) {
        const declared = yield* legacyLoadDeclaredSchemas(
          input.fs,
          input.path,
          input.workdir,
          input.schemaPaths,
          input.pgDelta,
        );
        if (declared.length > 0) {
          const overrideConn: LegacyPgConnInput = { ...connConfig, database: "contrib_regression" };
          const useDeclarativePgDelta = legacyShouldApplyDeclarativeWithPgDelta(
            input.path,
            input.usePgDelta,
            input.schemaPaths,
            input.pgDelta,
          );
          let appliedViaPgDelta = false;
          if (useDeclarativePgDelta) {
            const declDirRel = legacyResolveDeclarativeDir(input.path, input.pgDelta);
            const declDirAbs = legacyResolveUnderWorkdir(input.path, input.workdir, declDirRel);
            // Go's `afero.DirExists` (`shadow.go:72`) — a non-directory path is treated as
            // absent here too, same reasoning as `legacyLoadDeclaredSchemas` below.
            const declDirExists = yield* input.fs.stat(declDirAbs).pipe(
              Effect.map((info) => info.type === "Directory"),
              Effect.orElseSucceed(() => false),
            );
            if (declDirExists) {
              yield* legacyApplyDeclarativePgDelta(input.ctx, {
                fs: input.fs,
                declarativeDirAbs: declDirAbs,
                target: legacyToPostgresURL(overrideConn),
              });
              appliedViaPgDelta = true;
            }
          }
          if (!appliedViaPgDelta) {
            yield* legacyMigrateBaseDatabase(
              input.fs,
              input.path,
              input.workdir,
              overrideConn,
              declared,
            );
          }
          targetUrlOverride = legacyToPostgresURL(overrideConn);
        }
      }

      return {
        container: containerId,
        secretDirId,
        sourceUrl,
        targetUrlOverride,
      } satisfies LegacyShadowSourceResult;
    }).pipe(
      Effect.onError(() =>
        legacyRemoveShadowDatabase(spawner, {
          containerId,
          secretDirId,
          workdir: input.workdir,
        }),
      ),
    );
  });

/** Go's `pkg/config.hasGlobMeta` (`config.go:211-213`) — `*?[` only, NOT `io/fs.hasMeta`'s broader set (which also counts `\`). */
function legacyHasConfigGlobMeta(pattern: string): boolean {
  return /[*?[]/u.test(pattern);
}

/**
 * Go's `sort.Strings` compares byte-wise over each string's UTF-8 encoding; JS's default
 * `Array.prototype.sort()` instead compares UTF-16 CODE UNITS, which diverges from byte/codepoint
 * order for a supplementary-plane character (encoded as a surrogate pair, code units
 * `0xD800`-`0xDBFF` + `0xDC00`-`0xDFFF`) alongside a BMP private-use character (`0xE000`-
 * `0xFFFF`): JS ranks the surrogate pair BEFORE the private-use character (`0xD800 < 0xE000`),
 * while Go's UTF-8 byte order — which preserves Unicode codepoint order — ranks the
 * supplementary-plane codepoint (`>= U+10000 > U+FFFF`) AFTER it. Verified empirically:
 * `["a\u{1F600}.sql","a.sql"].sort()` (default) disagrees with `Buffer.compare` on the
 * same two strings' UTF-8 bytes. Used for every `sort.Strings` this module ports so a schema
 * directory with such filenames applies in the same order Go would.
 */
function legacyCompareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Manual, no-follow-symlink directory walk shared by `legacyGlobDeclaredSchemaPaths` (Go's
 * `walkMatchedDir`/`fs.WalkDir`) and `legacyWalkSqlFilesSorted` (Go's `afero.Walk`). Both Go
 * walkers are `Lstat`-based and therefore never descend into a symlinked directory —
 * `io/fs.WalkDir`'s doc comment: "WalkDir does not follow symbolic links found in directories,
 * but if root itself is a symbolic link, its target will be walked"; `afero.walk` confirms the
 * same via its own `lstatIfPossible` call (`github.com/spf13/afero/path.go`), which reports a
 * symlinked subdirectory's `IsDir()` as false so the recursive `walk` call returns without
 * descending. Effect's `FileSystem.readDirectory(dir, { recursive: true })` is instead backed by
 * Node's recursive `fs.readdir` (`NodeFileSystem.ts`'s `readDirectory` passes `options` straight
 * to `fs.promises.readdir`), which DOES follow symlinked subdirectories — verified empirically: a
 * directory containing a symlink to an external directory has the external directory's files
 * appear in the recursive listing. Left uncorrected, a schema directory symlinking outside the
 * configured schema tree would leak external `.sql` files into a local-target diff/pull that Go
 * would never have picked up. Walking manually here, one `fs.readDirectory(dir)` (non-recursive)
 * per level, and testing each entry with `readLink` BEFORE `stat` (the same no-follow-detector
 * idiom as `cp.handler.ts`'s `walkUploadDir`) — skipping a symlinked directory entirely, exactly
 * like Lstat-based Go — reproduces that behavior. Both Go walkers also finish with a plain
 * `sort.Strings` over the complete set of collected paths (`config.go:186`,
 * `internal/db/diff/diff.go:75,95`), which is a full lexicographic sort over full relative paths,
 * NOT merely a per-directory-level sort — so the final `.sort()` below is required even though
 * entries are already read in sorted order at each level; it uses {@link legacyCompareUtf8Bytes},
 * not JS's default comparator, to match Go's byte order — see that function's own doc comment.
 * A per-entry `fs.stat` failure (permission denied, I/O error, a concurrent filesystem change
 * between `readDirectory` and `stat`) is NOT swallowed: both Go walkers pass the entry's error to
 * their callback, which returns it and aborts the whole walk — silently treating it as "file
 * absent" here could build an incomplete declarative target instead.
 */
function legacyWalkRegularSqlFilesNoFollow(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  rootAbs: string,
): Effect.Effect<ReadonlyArray<string>, PlatformError> {
  return Effect.gen(function* () {
    const result: Array<string> = [];

    const visit = (dirAbs: string, dirRel: string): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        const names = [...(yield* fs.readDirectory(dirAbs))].sort();
        for (const name of names) {
          const entryAbs = path.join(dirAbs, name);
          const entryRel = dirRel === "" ? name : `${dirRel}/${name}`;
          const isSymlink = yield* fs.readLink(entryAbs).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (isSymlink) continue;
          const entryStat = yield* fs.stat(entryAbs);
          if (entryStat.type === "Directory") {
            yield* visit(entryAbs, entryRel);
          } else if (entryStat.type === "File" && entryRel.endsWith(".sql")) {
            result.push(entryRel);
          }
        }
      });

    yield* visit(rootAbs, "");
    return result.sort(legacyCompareUtf8Bytes);
  });
}

/**
 * Port of Go's `Glob.SQLFiles(fsys, WithSkipEmptyGlobs(), WithErrorOnAllSkippedGlobs())`
 * (`apps/cli-go/pkg/config/config.go:119-192`), the exact option combination
 * `loadDeclaredSchemas`'s `schema_paths` branch uses. Deliberately separate from
 * `legacy-migrate-and-seed.ts`'s `legacyResolveSchemaPathFiles` (Go's SAME `Glob.SQLFiles`
 * with ZERO options, `applySchemaFiles`) — the two option sets are genuinely different: a
 * per-pattern "no files matched" is unconditionally an error here UNLESS the pattern
 * contains a glob metacharacter (`skipEmptyGlobs`), in which case it's only converted back
 * into an error when EVERY pattern ended up skipped and the combined result is still empty
 * (`errorOnAllSkippedGlobs`) — and, unlike `applySchemaFiles`'s caller (which swallows any
 * collected errors once `len(declared) > 0`), `loadDeclaredSchemas`'s caller propagates
 * ANY error unconditionally, regardless of whether other patterns matched.
 */
function legacyGlobDeclaredSchemaPaths(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  patterns: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, LegacyDeclarativeShadowDbError> {
  return Effect.gen(function* () {
    const seen = new Set<string>();
    const result: Array<string> = [];
    const problems: Array<string> = [];
    const skipped: Array<string> = [];

    for (const rawPattern of patterns) {
      // Go's `config.go:976-979`: a non-empty, non-absolute `schema_paths` entry is resolved
      // under `supabase/` (via `path.Join`, which also cleans the result) at config-load
      // time — `legacyResolveSeedSqlPath` already implements the identical resolution Go
      // applies to `[db.seed] sql_paths`, the same shape. Go's `Glob.files` then normalizes
      // to forward slashes immediately before globbing (`fs.Glob(fsys,
      // filepath.ToSlash(pattern))`, `config.go:145`) — an absolute Windows entry such as
      // `C:\repo\schema.sql` must become `C:/repo/schema.sql` before `legacyPathMatch`/
      // `legacyGlobPattern` (which only recognize `/` as a segment separator) ever see it.
      // Mirrors `legacy-seed-ops.ts`'s identical `toSlash` step for `[db.seed] sql_paths`.
      const pattern = legacyResolveSeedSqlPath(path, rawPattern).replaceAll("\\", "/");
      if (legacyPathMatch(pattern, "").badPattern) {
        problems.push(`failed to glob files: ${LEGACY_BAD_PATTERN_MESSAGE}`);
        continue;
      }
      // Go's `sort.Strings(matches)` (`config.go:154`) — byte order, not JS's default UTF-16
      // code-unit order; see `legacyCompareUtf8Bytes`'s own doc comment.
      const matches = [...(yield* legacyGlobPattern(fs, path, workdir, pattern))].sort(
        legacyCompareUtf8Bytes,
      );
      if (matches.length === 0) {
        if (legacyHasConfigGlobMeta(pattern)) {
          skipped.push(pattern);
          continue;
        }
        // Go always resolves `SchemaPaths` (`config.go:976-979`) before this error can fire
        // (resolution happens at config-load time, ahead of any glob), so the error must show
        // the RESOLVED, `supabase/`-prefixed pattern, matching the all-skipped-globs branch
        // below — not the raw, caller-supplied one.
        problems.push(`no files matched pattern: ${pattern}`);
        continue;
      }
      for (const match of matches) {
        const absMatch = legacyResolveUnderWorkdir(path, workdir, match);
        const statResult = yield* fs.stat(absMatch).pipe(Effect.result);
        if (Result.isFailure(statResult)) {
          problems.push(`failed to stat matched file: ${match}`);
          continue;
        }
        if (statResult.success.type !== "Directory") {
          if (!seen.has(match)) {
            seen.add(match);
            result.push(match);
          }
          continue;
        }
        // Go's `walkMatchedDir` (`pkg/config/config.go:194-211`) propagates ANY `fs.WalkDir`
        // error (e.g. a permission-denied or I/O-erroring subdirectory) as `failed to walk
        // matched directory: <err>` — it does NOT treat an unreadable directory as an empty
        // match set, since silently doing so can omit declared schemas and compare a
        // local-target diff against the wrong target. `legacyWalkRegularSqlFilesNoFollow` also
        // matches Go's no-follow-symlink walk semantics — see its doc comment.
        const sqlRelativeResult = yield* legacyWalkRegularSqlFilesNoFollow(fs, path, absMatch).pipe(
          Effect.result,
        );
        if (Result.isFailure(sqlRelativeResult)) {
          problems.push(`failed to walk matched directory: ${match}`);
          continue;
        }
        for (const relative of sqlRelativeResult.success) {
          const relativeToWorkdir = `${match}/${relative}`;
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
      return yield* Effect.fail(
        new LegacyDeclarativeShadowDbError({ message: problems.join("\n") }),
      );
    }
    return result;
  });
}

/**
 * Port of Go's `afero.Walk` + regular-`.sql`-file filter + `sort.Strings` (the shared tail of
 * both `loadDeclaredSchemas`'s pg-delta-declarative-dir and `SchemasDir` branches,
 * `apps/cli-go/internal/db/diff/diff.go:65-76,86-96`). `legacyWalkRegularSqlFilesNoFollow` also
 * matches Go's no-follow-symlink walk semantics — see its doc comment.
 *
 * The walk ROOT itself is checked for being a symlink here, unlike `legacyGlobDeclaredSchemaPaths`'s
 * directory branch (Go's `fs.WalkDir`, whose own doc comment says "if root itself is a symbolic
 * link, its target will be walked" — so a symlinked `schema_paths` match is deliberately followed,
 * matching `legacyWalkRegularSqlFilesNoFollow`'s existing never-checks-its-own-root behavior).
 * `afero.Walk` is the opposite: its `Walk(fs, root, walkFn)` entry point `Lstat`s the root BEFORE
 * ever calling `walkFn`, so a symlinked root is treated as a non-directory and produces zero files
 * silently, never descending into the target — verified against `afero`'s own source
 * (`path.go`'s `Walk`/`lstatIfPossible`). The PRECEDING `fs.stat`-based existence check in
 * `legacyLoadDeclaredSchemas` (which follows symlinks, matching Go's `afero.DirExists` — also
 * `fs.Stat`-based) can't substitute for this: existence and walkability are different checks in
 * Go, and only the latter uses `Lstat`.
 *
 * Paths are joined with the injected `Path` service (not a literal `/` template) so a symlink-free
 * result matches Go's own `filepath.Join`-built path on every platform — on Windows this yields
 * native backslashes (Go's `afero.Walk` never calls `filepath.ToSlash` on this branch, unlike
 * `walkMatchedDir`'s `schema_paths` branch, which does), and `path.join` normalizes ANY `/`
 * `legacyWalkRegularSqlFilesNoFollow`'s own relative-path construction produced internally, not
 * just the outer `dirRel`/`relative` join (verified: `path.win32.join("supabase/database",
 * "sub/dir/file.sql")` returns `"supabase\\database\\sub\\dir\\file.sql"`, not a mixed-separator
 * string) — on POSIX this is a no-op (`path.posix.join` is byte-identical to the old template).
 */
function legacyWalkSqlFilesSorted(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dirRel: string,
): Effect.Effect<ReadonlyArray<string>, LegacyDeclarativeShadowDbError> {
  return Effect.gen(function* () {
    const dirAbs = legacyResolveUnderWorkdir(path, workdir, dirRel);
    const isSymlinkRoot = yield* fs.readLink(dirAbs).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (isSymlinkRoot) return [];
    const sqlRelative = yield* legacyWalkRegularSqlFilesNoFollow(fs, path, dirAbs).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDeclarativeShadowDbError({ message: `failed to walk dir: ${cause.message}` }),
      ),
    );
    return sqlRelative.map((relative) => path.join(dirRel, relative));
  });
}

/**
 * Port of Go's `loadDeclaredSchemas` (`apps/cli-go/internal/db/diff/diff.go:52-101`): a
 * three-source priority ladder — `db.migrations.schema_paths` (when non-empty) ->
 * pg-delta's declarative dir (when `[experimental.pgdelta] enabled` AND the dir exists) ->
 * `supabase/schemas` (when it exists) -> `[]`. Each source is `sort.Strings`-ordered.
 */
export function legacyLoadDeclaredSchemas(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  schemaPaths: ReadonlyArray<string>,
  pgDelta: LegacyPgDeltaTomlConfig,
): Effect.Effect<ReadonlyArray<string>, LegacyDeclarativeShadowDbError> {
  return Effect.gen(function* () {
    if (schemaPaths.length > 0) {
      return yield* legacyGlobDeclaredSchemaPaths(fs, path, workdir, schemaPaths);
    }
    if (pgDelta.enabled) {
      const declDirRel = legacyResolveDeclarativeDir(path, pgDelta);
      const declDirAbs = legacyResolveUnderWorkdir(path, workdir, declDirRel);
      // Go's `afero.DirExists` (`diff.go:63`) — a path that exists but is a regular file is
      // "not a directory" (`err == nil && exists` is false), not an error, so it falls through
      // to the `supabase/schemas` source below rather than being walked as a directory.
      const isDeclDir = yield* fs.stat(declDirAbs).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
      if (isDeclDir) {
        return yield* legacyWalkSqlFilesSorted(fs, path, workdir, declDirRel);
      }
    }
    const schemasDirRel = "supabase/schemas";
    const schemasDirAbs = legacyResolveUnderWorkdir(path, workdir, schemasDirRel);
    // Same `afero.DirExists` semantics as above (`diff.go:80`): a missing path or a path that
    // exists but isn't a directory both resolve to "no declared schemas" (`[]`), not an error —
    // only a genuine stat failure (permission denied, I/O error) propagates.
    const isSchemasDir = yield* fs.stat(schemasDirAbs).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(false)
            : Effect.fail(
                new LegacyDeclarativeShadowDbError({
                  message: `failed to check schemas: ${cause.message}`,
                }),
              ),
        onSuccess: (info) => Effect.succeed(info.type === "Directory"),
      }),
    );
    if (!isSchemasDir) return [];
    return yield* legacyWalkSqlFilesSorted(fs, path, workdir, schemasDirRel);
  });
}

/** Go's `cleanSchemaPath` (`apps/cli-go/internal/db/diff/diff.go:117-119`): `filepath.ToSlash(filepath.Clean(path))`. */
function legacyCleanSchemaPath(rawPath: string): string {
  const isAbsolute = rawPath.startsWith("/");
  const out: Array<string> = [];
  for (const segment of rawPath.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
    } else {
      out.push(segment);
    }
  }
  const joined = out.join("/");
  if (joined.length === 0) return isAbsolute ? "/" : ".";
  return isAbsolute ? `/${joined}` : joined;
}

/**
 * Port of Go's `shouldApplyDeclarativeWithPgDelta` (`apps/cli-go/internal/db/diff/diff.go:
 * 103-115`): `usePgDelta` false -> false; zero `schema_paths` -> true; more than one
 * `schema_paths` entry -> false; exactly one entry -> true only when it resolves (Go's
 * `config.go:976-979` resolution, matching `legacyResolveSeedSqlPath`) to the SAME cleaned
 * path as the effective declarative dir.
 */
export function legacyShouldApplyDeclarativeWithPgDelta(
  path: Path.Path,
  usePgDelta: boolean,
  schemaPaths: ReadonlyArray<string>,
  pgDelta: LegacyPgDeltaTomlConfig,
): boolean {
  if (!usePgDelta) return false;
  if (schemaPaths.length === 0) return true;
  if (schemaPaths.length !== 1) return false;
  const resolvedSchema = legacyCleanSchemaPath(legacyResolveSeedSqlPath(path, schemaPaths[0]!));
  const declDir = legacyCleanSchemaPath(legacyResolveDeclarativeDir(path, pgDelta));
  return resolvedSchema === declDir;
}

/**
 * Port of Go's `migrateBaseDatabase` (`apps/cli-go/internal/db/diff/diff.go:261-274`): prints
 * the declarative-schema file list, connects to `config` (the shadow's `contrib_regression`
 * override), then seeds `migrations` as globals (Go's `migration.SeedGlobals` — no history
 * row, no history table, WITHOUT the migra-engine schema files' own transactional/seed
 * distinctions {@link legacySeedGlobals} already reproduces for every other caller of it).
 */
function legacyMigrateBaseDatabase(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  config: LegacyPgConnInput,
  migrations: ReadonlyArray<string>,
): Effect.Effect<void, LegacyDeclarativeShadowDbError, Output | LegacyDbConnection> {
  return Effect.scoped(
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw("Creating local database from declarative schemas:\n", "stderr");
      const msg = migrations.map((m) => ` • ${legacyBold(m)}`).join("\n");
      yield* output.raw(`${msg}\n`, "stderr");

      const dbConnection = yield* LegacyDbConnection;
      const session = yield* dbConnection
        .connect(config, { isLocal: true, dnsResolver: "native" })
        .pipe(
          Effect.mapError(
            (cause) => new LegacyDeclarativeShadowDbError({ message: cause.message }),
          ),
        );

      const absolutePaths = migrations.map((m) => legacyResolveUnderWorkdir(path, workdir, m));
      yield* legacySeedGlobals(
        session,
        fs,
        path,
        absolutePaths,
        (message) => new LegacyDeclarativeShadowDbError({ message }),
      );
    }),
  );
}
