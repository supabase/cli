import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  resolveYesWithProjectEnv,
} from "./global-flags.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { CliConfigKeys } from "../config/cli-config-keys.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { bold } from "./colors.ts";
import { promptYesNo } from "./prompt-yes-no.ts";
import { ipv6Suggestion, isIPv6ConnectivityError } from "./connect-errors.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { resolveDbImage } from "./db-image.ts";
import { DbConnection, type PgConnInput } from "./db-connection.service.ts";
import { loadProjectEnvValues, readDbToml, resolveDeclarativeDir } from "./db-config.toml-read.ts";
import type { DbConnType } from "./db-target-flags.ts";
import { makeDir } from "./make-dir.ts";
import { toPostgresURL } from "./postgres-url.ts";
import { buildLocalDbContainerInputs } from "./db-bootstrap/local-container-inputs.ts";
import { withShadowDatabase } from "./db-bootstrap/shadow-cache.ts";
import { shadowRunInputFromLocalContainerInputs } from "./db-bootstrap/shadow-database.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import {
  updateDeclarativeSchemaPathsConfig,
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "../commands/db/shared/pgdelta.write.ts";
import { resolvePullDiffEngine, schemaPathsTransitionWarning } from "./diff-engine.ts";
import { diffMigra } from "../commands/db/shared/migra.ts";
import { writePgDeltaMigrations } from "../commands/db/shared/pgdelta-migrations.write.ts";
import { type DumpOptions, buildSchemaDumpEnv } from "./pg-dump.env.ts";
import { dumpNetworkMode, streamPgDumpWithClient } from "./pg-dump.run.ts";
import {
  rewriteDumpHostForToolContainer,
  toolContainerUsesHostNetwork,
} from "./postgres-client.run.ts";
import {
  emitPoolerFallbackWarning,
  isDirectLinkedHost,
  runWithPoolerFallback,
} from "../commands/db/shared/pooler-fallback.ts";
import { dumpSchemaScript } from "./pg-dump.scripts.ts";
import { formatMigrationTimestamp, getMigrationPath } from "./migration-file.ts";
import { debugBundleMessage } from "../commands/db/shared/debug-bundle.ts";
import {
  PgDeltaEngine,
  type PgDeltaDatabaseEndpoint,
} from "../commands/db/shared/pgdelta-engine.service.ts";
import { type PgDeltaContext, isPgDeltaDebugEnabled } from "./pgdelta.ts";
import { prepareShadowSource } from "../commands/db/shared/shadow-source.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { stackRejectNativeDockerDiffEngine } from "./stack-local-database.ts";
import { stackPrepareShadowSource, stackWithShadowDatabase } from "./stack-shadow.ts";
import type { DbPullFlags as DbPullCommandFlags } from "../commands/db/pull/pull.command.ts";
import {
  DbPullDumpError,
  DbPullEngineConflictError,
  DbPullTargetFlagsError,
  DbPullWriteError,
} from "../commands/db/pull/pull.errors.ts";
import { DbPullInSyncError, DbPullMigrationConflictError } from "./db-pull-run.errors.ts";
import {
  listRemoteMigrations,
  loadLocalVersions,
  reconcileMigrations,
} from "./migration-history.ts";
import { updateMigrationHistory } from "../commands/db/pull/pull.sync.ts";

/**
 * `runDbPull`'s parameter type: the `db pull` command flags without the tombstoned
 * `--use-pg-delta`, so an in-process caller (`pull`) can build one without reaching into
 * `commands/db/**` directly.
 */
export type DbPullRunFlags = Omit<DbPullCommandFlags, "usePgDelta">;

/**
 * Explains the in-sync non-zero exit instead of the generic "Try rerunning the command with
 * --debug…" footer, which would read like a crash for what is really a finding.
 */
const IN_SYNC_SUGGESTION =
  "The remote database is already in sync with your local migrations — nothing to pull.";

/** Migration-file mode for the initial pg_dump seed. */
const MIGRATION_FILE_MODE = 0o644;

export type DbPullInvoke = {
  /**
   * Overrides `--yes`/`SUPABASE_YES`/`supabase/.env` resolution for an
   * in-process caller that already ran its own aggregated confirmation.
   * `undefined` keeps the existing resolution.
   */
  readonly assumeYes?: boolean;
};

export type DbPullOutcome =
  | {
      readonly kind: "declarative";
      readonly schemaWritten: string;
      readonly engine: "pg-delta";
    }
  | {
      readonly kind: "migration";
      readonly schemaFiles: ReadonlyArray<string>;
      readonly remoteHistoryUpdated: boolean;
      readonly engine: "pg-delta" | "migra";
    };

/**
 * Runs `db pull`'s target resolution and pull (declarative or migration mode)
 * without emitting the final `output.success`/"Finished" line — the caller
 * (`dbPull` for the standalone command, or an in-process orchestrator)
 * owns that emission based on the returned {@link DbPullOutcome}.
 */
export const runDbPull = Effect.fn("db.pull.run")(function* (
  flags: DbPullRunFlags,
  invoke?: DbPullInvoke,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const connection = yield* DbConnection;
  const pgDeltaEngine = yield* PgDeltaEngine;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const debug = yield* DebugFlag;
  const configValues = yield* CliConfigValues;

  // `--yes` or `SUPABASE_YES`. The project `.env` is loaded before the migration
  // history prompt, so a `SUPABASE_YES` set only in `supabase/.env` auto-confirms
  // the native initial-migra history repair too.
  const projectEnv = yield* loadProjectEnvValues(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  let linkedRefForCache: string | undefined;

  return yield* Effect.gen(function* () {
    const name = Option.getOrElse(flags.name, () => "remote_schema");
    const useDeclarative = Option.getOrElse(flags.declarative, () => false);

    // Mutually exclusive flag groups: `[db-url linked local]`, `[declarative diff-engine]`.
    // "set" means the flag was explicitly passed.
    const targetSet: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) targetSet.push("db-url");
    if (Option.isSome(flags.linked)) targetSet.push("linked");
    if (Option.isSome(flags.local)) targetSet.push("local");
    if (targetSet.length > 1) {
      return yield* new DbPullTargetFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${[...targetSet].sort().join(" ")}] were all set`,
      });
    }
    if (Option.isSome(flags.declarative) && Option.isSome(flags.diffEngine)) {
      return yield* new DbPullEngineConflictError({
        message:
          "if any flags in the group [declarative diff-engine] are set none of the others can be; [declarative diff-engine] were all set",
      });
    }

    const connType: DbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.local)
        ? "local"
        : "linked";
    yield* Effect.annotateCurrentSpan({
      "db.conn_type": connType,
      "db.pull.mode": useDeclarative ? "declarative" : "migration",
    });

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* new DbPullTargetFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      });
    }

    // Pre-load the ref and re-read config here, before `resolver.resolve()` below, so the
    // override print and merged-config validation happen before the connection attempt: a
    // `resolve()` failure (bad password, unreachable host, network-ban lookup, …) must still
    // tell the user which `[remotes.*]` block matched. `--local`/`--db-url` never merge a
    // remote block, so only the linked path pre-resolves a ref.
    let linkedRef: string | undefined;
    if (connType === "linked") {
      const projectRefResolver = yield* ProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      // Cache the ref the moment it's known, not after `toml`/`localInputs` below resolve
      // (both fallible): the project cache should still be written even when a later step
      // (config validation, connection, the pull itself) fails.
      linkedRefForCache = linkedRef;
    }
    const toml = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const resolvedConfig = yield* configValues.load({
      workdir: cliSettings.workdir,
      projectRef: Option.fromNullishOr(linkedRef),
    });

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    // Validate native shadow inputs before target resolution performs remote side effects.
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      cliSettings.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      // So the shadow's own container spec reflects the matching `[remotes.<ref>]`
      // override, same as `toml` above.
      connType === "linked" ? linkedRef : undefined,
    );

    const resolved = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password ?? Option.none(),
      linkedProjectRef: flags.projectRef,
    });
    if (linkedRef === undefined) {
      linkedRef = Option.getOrUndefined(resolved.ref ?? Option.none());
    }
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;
    const targetUrl = toPostgresURL(resolved.conn);
    const ctx: PgDeltaContext = {
      projectId: (yield* resolvedConfig.get(CliConfigKeys.projectId)).value,
      cwd: cliSettings.workdir,
      denoVersion: toml.denoVersion,
      projectEnv: toml.projectEnv,
    };
    const formatOptions = Option.getOrElse(toml.pgDelta.formatOptions, () => "");

    // A linked direct connection may need the IPv4 transaction pooler from Docker.
    const targetEndpoint: PgDeltaDatabaseEndpoint = {
      kind: "database",
      ref: targetUrl,
      connection: resolved.conn,
      connectOptions: { isLocal: resolved.isLocal, dnsResolver },
    };
    const withPoolerFallback = <A, E extends { readonly message: string }, R>(
      directTarget: PgDeltaDatabaseEndpoint,
      attempt: (target: PgDeltaDatabaseEndpoint) => Effect.Effect<A, E, R>,
    ) =>
      attempt(directTarget).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (
              isDirectLinkedHost({
                connType,
                host: resolved.conn.host,
                isLocal: resolved.isLocal,
                projectHost: cliSettings.projectHost,
              }) &&
              isIPv6ConnectivityError(error.message)
            ) {
              // A pooler resolution failure is treated as "no fallback" (re-fail the
              // original diff error), not surfaced as its own error.
              const pooler = yield* resolver
                .resolvePoolerFallback({
                  dbUrl: flags.dbUrl,
                  connType: "linked",
                  dnsResolver,
                  password: flags.password ?? Option.none(),
                  linkedProjectRef: flags.projectRef,
                })
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(pooler)) {
                yield* emitPoolerFallbackWarning(resolved.conn.host);
                return yield* attempt({
                  kind: "database",
                  ref: toPostgresURL(pooler.value),
                  connection: pooler.value,
                  connectOptions: { isLocal: false, dnsResolver },
                });
              }
            }
            return yield* Effect.fail(error);
          }),
        ),
      );

    const usePgDeltaDiff = resolvePullDiffEngine({
      engineFlagChanged: Option.isSome(flags.diffEngine),
      engine: Option.getOrElse(flags.diffEngine, () => "migra"),
      pgDeltaDefault:
        (yield* currentStackBackend).kind === "stack" ||
        (yield* resolvedConfig.get(CliConfigKeys.experimental.pgdelta.enabled)).value,
    });
    if (Option.getOrElse(flags.diffEngine, () => "pg-delta") === "migra") {
      yield* stackRejectNativeDockerDiffEngine("--diff-engine migra");
    }
    const diffEngine = usePgDeltaDiff ? "pg-delta" : "migra";
    const pgDeltaDebug = yield* isPgDeltaDebugEnabled;

    // Connectivity check, run before dialing.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(
          `Connecting to ${resolved.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(resolved.conn, {
          isLocal: resolved.isLocal,
          dnsResolver,
        });

        if (useDeclarative) {
          yield* output.raw("Preparing declarative schema export using pg-delta...\n", "stderr");
          const declarativeDirRel = resolveDeclarativeDir(path, toml.pgDelta);
          const declarativeDir = path.resolve(cliSettings.workdir, declarativeDirRel);
          const exportSchema = (target: PgDeltaDatabaseEndpoint) =>
            pgDeltaEngine.exportDeclarativeSchema({
              context: ctx,
              target,
              schema: flags.schema,
              formatOptions,
              ...(connType === "linked" && linkedRef !== undefined
                ? { projectRef: linkedRef }
                : {}),
              debug: pgDeltaDebug,
              strictCoverage: flags.strictCoverage,
            });
          const exported = yield* withPoolerFallback(targetEndpoint, (target) =>
            exportSchema(target),
          ).pipe(
            Effect.tap((result) => Effect.annotateCurrentSpan("file.count", result.files.length)),
            Effect.withSpan("db.pull.exportDeclarative"),
          );
          const written = yield* writeDeclarativeSchemas(fs, path, declarativeDir, exported).pipe(
            Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })),
          );
          yield* warnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
          // Preserve the legacy schema_paths workflow only when pg-delta is disabled.
          if (!toml.pgDelta.enabled) {
            yield* updateDeclarativeSchemaPathsConfig(
              fs,
              path,
              cliSettings.workdir,
              declarativeDirRel,
            ).pipe(Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })));
          }
          // Prints the config's declarative_schema_path or the relative `supabase/schemas`
          // default, never the resolved absolute directory (established output contract). The
          // json payload below keeps the absolute path for machine consumers.
          yield* output.raw(`Declarative schema written to ${bold(declarativeDirRel)}\n`, "stderr");
          return {
            kind: "declarative",
            schemaWritten: declarativeDir,
            engine: "pg-delta",
          } as const;
        }

        // pg-delta ignores schema_paths in favor of the migrations baseline.
        if (usePgDeltaDiff && toml.schemaPaths !== undefined && toml.schemaPaths.length > 0) {
          yield* output.raw(schemaPathsTransitionWarning, "stderr");
        }

        // Migration-file path.
        const nowMillis = yield* Clock.currentTimeMillis;
        const timestamp = formatMigrationTimestamp(nowMillis);
        const migrationPath = getMigrationPath(path, cliSettings.workdir, timestamp, name);

        const remote = yield* listRemoteMigrations(session);
        const local = yield* loadLocalVersions(
          fs,
          path,
          path.join(cliSettings.workdir, "supabase", "migrations"),
        );
        const sync = reconcileMigrations(remote, local, connType === "local");
        if (sync.kind === "conflict") {
          return yield* new DbPullMigrationConflictError({
            message:
              "The remote database's migration history does not match local files in supabase/migrations directory.",
            suggestion: sync.suggestion,
          });
        }
        // Initial pull, migra engine: seed the migration file with a pg_dump of the remote
        // schema, then run the migra diff below as a second pass appended to the same file,
        // which captures default privileges/managed schemas pg_dump can't emit. pg-delta
        // initial pulls skip the dump, since diffing against an empty shadow already yields
        // the full schema.
        const seededFromDump = sync.kind === "missing" && !usePgDeltaDiff;
        // Tracks whether the pg_dump seed wrote any bytes: an empty dump + empty diff
        // is "in sync", a non-empty dump is a valid initial migration on its own.
        let seedWroteBytes = false;

        if (seededFromDump) {
          yield* makeDir(fs, path.dirname(migrationPath)).pipe(
            Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })),
          );
          const image = (yield* resolveDbImage(
            fs,
            path,
            cliSettings.workdir,
            toml.majorVersion,
            Option.getOrUndefined(toml.orioledbVersion),
          )).image;
          // Default dump options: no schema filter (so the internal-schema exclude
          // list applies) and comments stripped.
          const dumpEnvOpt: DumpOptions = {
            schema: [],
            keepComments: false,
            excludeTable: [],
            columnInsert: false,
          };
          const toDumpOpenError = (cause: { readonly message: string }) =>
            new DbPullDumpError({
              message: `failed to open dump file: ${cause.message}`,
              fileOpen: true,
            });
          const stackBackend = (yield* currentStackBackend).kind === "stack";
          const seedNetwork = yield* dumpNetworkMode(
            Option.getOrUndefined(networkIdFlag),
            stackBackend,
            projectEnv,
          );
          const seedUsesHostNetwork =
            seedNetwork._tag === "host" || toolContainerUsesHostNetwork(seedNetwork.name);
          const seedDumpConn = (target: PgConnInput): PgConnInput =>
            stackBackend || !seedUsesHostNetwork
              ? {
                  ...target,
                  host: rewriteDumpHostForToolContainer(target.host, {
                    platform: runtimeInfo.platform,
                    usesHostNetwork: seedUsesHostNetwork,
                  }),
                }
              : target;
          // Stream pg_dump → migration file, (re)truncating per attempt so a pooler
          // retry leaves only the successful attempt's bytes.
          const runSchemaDump = (target: PgConnInput) => {
            // Reset per attempt alongside the truncate: in-sync is decided from the file on
            // disk, so only the final successful attempt's bytes count. A partial direct write
            // that then IPv6-fails must not leave this flag stuck true, or an empty pooler retry
            // would be mis-reported as a schema write.
            seedWroteBytes = false;
            return fs
              .writeFile(migrationPath, new Uint8Array(0), { mode: MIGRATION_FILE_MODE })
              .pipe(
                Effect.mapError(toDumpOpenError),
                Effect.andThen(
                  Effect.scoped(
                    Effect.gen(function* () {
                      const file = yield* fs
                        .open(migrationPath, { flag: "a" })
                        .pipe(Effect.mapError(toDumpOpenError));
                      return yield* streamPgDumpWithClient({
                        image,
                        script: dumpSchemaScript,
                        env: buildSchemaDumpEnv(seedDumpConn(target), dumpEnvOpt),
                        projectEnvValues: projectEnv,
                        client: { kind: "container" },
                        forceHostNetwork: stackBackend,
                        onStdout: (chunk) => {
                          if (chunk.length > 0) seedWroteBytes = true;
                          return file.writeAll(chunk).pipe(
                            Effect.mapError(
                              (cause) =>
                                new DbPullWriteError({
                                  message: `failed to write migration file: ${cause.message}`,
                                }),
                            ),
                          );
                        },
                      });
                    }),
                  ),
                ),
                Effect.withSpan("db.pull.dumpSchema"),
              );
          };
          // Prints this once, before the pooler-fallback retry.
          yield* output.raw("Dumping schema from remote database...\n", "stderr");
          // Container-level IPv6 → IPv4-pooler retry, shared with `db dump`. `db pull`
          // prints "Dumping…" once above, so it passes `Effect.void` for the retry
          // re-print.
          const dumpResult = yield* runWithPoolerFallback({
            result: yield* runSchemaDump(resolved.conn),
            connType,
            host: resolved.conn.host,
            isLocal: resolved.isLocal,
            projectHost: cliSettings.projectHost,
            resolvePooler: () =>
              resolver
                .resolvePoolerFallback({
                  dbUrl: flags.dbUrl,
                  connType: "linked",
                  dnsResolver,
                  password: flags.password ?? Option.none(),
                  linkedProjectRef: flags.projectRef,
                })
                .pipe(Effect.orElseSucceed(() => Option.none())),
            runWithConn: runSchemaDump,
            reprintOnRetry: Effect.void,
          });
          if (dumpResult.exitCode !== 0) {
            return yield* new DbPullDumpError({
              message: `error running container: exit ${dumpResult.exitCode}`,
              ...(isIPv6ConnectivityError(dumpResult.stderr)
                ? { suggestion: ipv6Suggestion() }
                : {}),
            });
          }
        }

        // Native diff: shadow (baseline + local migrations) vs remote → migration SQL.
        // For the initial pull (no local migrations) the schema filter is ignored.
        const diffSchema = sync.kind === "missing" ? [] : flags.schema;
        // Pooler fallback retries the complete shadow-and-diff attempt.
        const runShadowDiff = (targetEndpoint: PgDeltaDatabaseEndpoint) =>
          Effect.gen(function* () {
            yield* output.raw("Creating shadow database...\n", "stderr");
            const stackBackend = (yield* currentStackBackend).kind === "stack";
            const resolvedPullShadowImage = stackBackend
              ? "stack-ephemeral"
              : yield* localInputs.resolvePostgresImage;
            const migrationMode: "legacy" | "pgdelta-next" = usePgDeltaDiff
              ? "pgdelta-next"
              : "legacy";
            const shadowInput = {
              ...shadowRunInputFromLocalContainerInputs(
                localInputs,
                resolvedPullShadowImage,
                toml,
                fs,
                path,
              ),
              targetLocal: resolved.isLocal,
              migrationMode,
              // `toml.schemaPathPatterns` is used here, not the raw `@supabase/config` field on
              // `localInputs`, since only `toml` (via `readDbToml`) resolves the
              // `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` env override.
              schemaPaths: toml.schemaPathPatterns,
              pgDelta: toml.pgDelta,
            };
            const runDiff = (shadow: {
              readonly sourceUrl: string;
              readonly targetUrlOverride: string | undefined;
            }) =>
              Effect.gen(function* () {
                const target = shadow.targetUrlOverride ?? targetEndpoint.ref;
                yield* output.raw(
                  diffSchema.length > 0
                    ? `Diffing schemas: ${diffSchema.join(",")}\n`
                    : "Diffing schemas...\n",
                  "stderr",
                );
                if (usePgDeltaDiff) {
                  return yield* pgDeltaEngine.diffDatabase({
                    context: ctx,
                    source: {
                      kind: "database",
                      ref: shadow.sourceUrl,
                      connectOptions: { isLocal: true, dnsResolver: "native" },
                    },
                    target: {
                      kind: "database",
                      ref: target,
                      ...(shadow.targetUrlOverride === undefined
                        ? {
                            ...(targetEndpoint.connection !== undefined
                              ? { connection: targetEndpoint.connection }
                              : {}),
                            connectOptions: targetEndpoint.connectOptions,
                          }
                        : {
                            connectOptions: { isLocal: true, dnsResolver },
                          }),
                    },
                    schema: diffSchema,
                    formatOptions,
                    debug: pgDeltaDebug,
                    strictCoverage: flags.strictCoverage,
                  });
                }
                const sql = yield* diffMigra(ctx, {
                  source: shadow.sourceUrl,
                  target,
                  schema: diffSchema,
                  connectOptions:
                    shadow.targetUrlOverride === undefined
                      ? targetEndpoint.connectOptions
                      : { isLocal: true, dnsResolver },
                });
                return { sql, files: undefined, debug: undefined };
              });
            return stackBackend
              ? yield* stackWithShadowDatabase(shadowInput, (handle) =>
                  stackPrepareShadowSource(handle, shadowInput).pipe(Effect.flatMap(runDiff)),
                )
              : // `withShadowDatabase` owns the interrupt-safe lifecycle and the cache seam.
                // Webhooks policy must mirror {@link prepareShadowSource} for this mode.
                yield* withShadowDatabase(
                  spawner,
                  shadowInput,
                  (handle) =>
                    prepareShadowSource(spawner, handle, shadowInput).pipe(Effect.flatMap(runDiff)),
                  { webhooks: migrationMode === "pgdelta-next" ? "config" : "enabled" },
                );
          });
        const diffOutcome = yield* withPoolerFallback(targetEndpoint, runShadowDiff).pipe(
          Effect.tap((outcome) =>
            Effect.annotateCurrentSpan({
              "diff.empty": outcome.sql.trim().length === 0,
              "migration.count": outcome.files?.length ?? (outcome.sql.trim().length === 0 ? 0 : 1),
            }),
          ),
          Effect.withSpan("db.pull.plan", { attributes: { "db.pull.engine": diffEngine } }),
        );

        const out = diffOutcome.sql;
        const diffEmpty = out.trim().length === 0;
        // A non-initial pull with an empty diff is "in sync" and fails. The
        // initial-migra path seeded the file with a pg_dump above, so its empty second
        // pass is swallowed and falls through to the shared tail below.
        if (diffEmpty && !seededFromDump) {
          if (diffOutcome.debug?.directory !== undefined) {
            yield* output.raw(debugBundleMessage(diffOutcome.debug.directory), "stderr");
            return yield* new DbPullInSyncError({
              message: `No schema changes found (debug bundle: ${diffOutcome.debug.directory})`,
              suggestion: IN_SYNC_SUGGESTION,
            });
          }
          return yield* new DbPullInSyncError({
            message: "No schema changes found",
            suggestion: IN_SYNC_SUGGESTION,
          });
        }

        // Build the list of migration files to record in the remote history. The
        // migra engine writes exactly one file (the dump-seeded or freshly written
        // migrationPath); the pg-delta engine writes one ordered file per
        // execution-aware plan unit.
        const writtenMigrations: Array<{ path: string; version: string }> = [];
        if (usePgDeltaDiff) {
          // pg-delta: one migration file per plan unit via the shared writer. A single-unit
          // plan (the common case) keeps the exact `<ts>_<name>.sql` filename; multi-unit plans
          // append the unit name with a strictly increasing timestamp so execution and
          // migration-history order stay stable. Each file is written exclusively so a
          // pre-existing migration is never overwritten; `planFiles` is non-empty here since
          // empty plans are handled by the `diffEmpty` branch above.
          const planFiles = diffOutcome.files ?? [];
          const writtenUnits = yield* writePgDeltaMigrations(fs, path, {
            workdir: cliSettings.workdir,
            baseMillis: nowMillis,
            name,
            files: planFiles.map((file) => ({
              name: file.name,
              suffix: file.suffix,
              sql: file.sql,
              transactionMode: file.transactionMode,
            })),
          }).pipe(Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })));
          for (const unit of writtenUnits) {
            writtenMigrations.push({ path: unit.path, version: unit.version });
          }
        } else {
          if (!diffEmpty) {
            if (seededFromDump) {
              // Append the migra diff to the dump-seeded file (opened in append mode).
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(migrationPath, { flag: "a" }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new DbPullWriteError({
                          message: `failed to open migration file: ${cause.message}`,
                        }),
                    ),
                  );
                  yield* file.writeAll(new TextEncoder().encode(out)).pipe(
                    Effect.mapError(
                      (cause) =>
                        new DbPullWriteError({
                          message: `failed to write migration file: ${cause.message}`,
                        }),
                    ),
                  );
                }),
              );
            } else {
              yield* makeDir(fs, path.dirname(migrationPath)).pipe(
                Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })),
              );
              yield* fs.writeFileString(migrationPath, out).pipe(
                Effect.mapError(
                  (cause) =>
                    new DbPullWriteError({
                      message: `failed to write migration file: ${cause.message}`,
                    }),
                ),
              );
            }
          }

          // A dump that produced nothing followed by an empty diff leaves the file empty, since
          // nothing else could have written content there. Remove it before reporting in-sync,
          // or it sits on disk as a phantom local migration a later pull's history
          // reconciliation trips over — one that `--with-migration-history` cannot clear, since
          // fetching empty remote history never deletes local files.
          if (seededFromDump && !seedWroteBytes && diffEmpty) {
            yield* fs.remove(migrationPath).pipe(Effect.ignore);
            return yield* new DbPullInSyncError({
              message: "No schema changes found",
              suggestion: IN_SYNC_SUGGESTION,
            });
          }
          writtenMigrations.push({ path: migrationPath, version: timestamp });
        }

        for (const written of writtenMigrations) {
          // Prints the workdir-relative path (established output contract); `writtenMigrations`
          // itself keeps absolute paths for file I/O and the json payload.
          yield* output.raw(
            `Schema written to ${bold(path.relative(cliSettings.workdir, written.path))}\n`,
            "stderr",
          );
        }

        // Prompt to update the remote migration history table. Returns the default
        // (`true`) on `--yes`, on an empty non-interactive stdin, or on any prompt error —
        // it never fails the command.
        let remoteHistoryUpdated = false;
        const updateHistoryTitle = "Update remote migration history table?";
        // `invoke?.assumeYes` overrides this resolution entirely for an in-process
        // caller that already ran its own aggregated confirmation. Otherwise, honors
        // `--yes`, scans piped stdin on a non-TTY before falling back to the default,
        // and otherwise prompts on a real TTY.
        const shouldUpdate =
          invoke?.assumeYes !== undefined
            ? invoke.assumeYes
            : yield* promptYesNo(output, yes, updateHistoryTitle, true);
        if (shouldUpdate) {
          // The migration file(s) in `writtenMigrations` are already on disk at this point, so
          // a failure here must still report them as written: re-raise the same
          // `DbPullWriteError` `updateMigrationHistory` fails with, carrying their paths.
          yield* updateMigrationHistory(session, fs, path, writtenMigrations).pipe(
            Effect.mapError(
              (cause) =>
                new DbPullWriteError({
                  message: cause.message,
                  writtenSoFar: writtenMigrations.map((written) => written.path),
                }),
            ),
          );
          remoteHistoryUpdated = true;
        }

        return {
          kind: "migration",
          // `schemaFiles` lists every written migration path in write order (a pg-delta plan
          // writes one file per unit); `dbPull`'s emission derives the released `schemaWritten`
          // string field from its first entry.
          schemaFiles: writtenMigrations.map((written) => written.path),
          remoteHistoryUpdated,
          engine: diffEngine,
        } as const;
      }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
