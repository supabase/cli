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
            const declDirExists = yield* input.fs
              .exists(declDirAbs)
              .pipe(Effect.orElseSucceed(() => false));
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
      // applies to `[db.seed] sql_paths`, the same shape.
      const pattern = legacyResolveSeedSqlPath(path, rawPattern);
      if (legacyPathMatch(pattern, "").badPattern) {
        problems.push(`failed to glob files: ${LEGACY_BAD_PATTERN_MESSAGE}`);
        continue;
      }
      const matches = [...(yield* legacyGlobPattern(fs, path, workdir, pattern))].sort();
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
        const names = yield* fs
          .readDirectory(absMatch, { recursive: true })
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        const sqlRelative = names
          .map((name) => name.replaceAll("\\", "/"))
          .filter((name) => name.endsWith(".sql"))
          .sort();
        for (const relative of sqlRelative) {
          const relativeToWorkdir = `${match}/${relative}`;
          const absEntry = legacyResolveUnderWorkdir(path, workdir, relativeToWorkdir);
          const entryStat = yield* fs.stat(absEntry).pipe(Effect.orElseSucceed(() => undefined));
          if (entryStat?.type !== "File") continue;
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
 * `apps/cli-go/internal/db/diff/diff.go:65-76,86-96`).
 */
function legacyWalkSqlFilesSorted(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  dirRel: string,
): Effect.Effect<ReadonlyArray<string>, LegacyDeclarativeShadowDbError> {
  return Effect.gen(function* () {
    const dirAbs = legacyResolveUnderWorkdir(path, workdir, dirRel);
    const names = yield* fs
      .readDirectory(dirAbs, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDeclarativeShadowDbError({ message: `failed to walk dir: ${cause.message}` }),
        ),
      );
    const sqlRelative = names
      .map((name) => name.replaceAll("\\", "/"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const result: Array<string> = [];
    for (const relative of sqlRelative) {
      const relativeToWorkdir = `${dirRel}/${relative}`;
      const absEntry = legacyResolveUnderWorkdir(path, workdir, relativeToWorkdir);
      const entryStat = yield* fs.stat(absEntry).pipe(Effect.orElseSucceed(() => undefined));
      if (entryStat?.type !== "File") continue;
      result.push(relativeToWorkdir);
    }
    return result;
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
      const exists = yield* fs.exists(declDirAbs).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        return yield* legacyWalkSqlFilesSorted(fs, path, workdir, declDirRel);
      }
    }
    const schemasDirRel = "supabase/schemas";
    const schemasDirAbs = legacyResolveUnderWorkdir(path, workdir, schemasDirRel);
    const exists = yield* fs.exists(schemasDirAbs).pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDeclarativeShadowDbError({
            message: `failed to check schemas: ${cause.message}`,
          }),
      ),
    );
    if (!exists) return [];
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
