import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "./global-flags.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { ProjectRefResolver } from "../config/project-ref.service.ts";
import { bold } from "./colors.ts";
import { promptYesNo } from "./prompt-yes-no.ts";
import { ipv6Suggestion, isIPv6ConnectivityError } from "./connect-errors.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import { resolveDbImage } from "./db-image.ts";
import { DbConnection, type PgConnInput } from "./db-connection.service.ts";
import {
  applyProjectEnv,
  loadProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
} from "./db-config.toml-read.ts";
import type { DbConnType } from "./db-target-flags.ts";
import { makeDir } from "./make-dir.ts";
import { toPostgresURL } from "./postgres-url.ts";
import {
  buildLocalDbContainerInputs,
  type LocalDbContainerInputs,
} from "./db-bootstrap/local-container-inputs.ts";
import { withShadowDatabase } from "./db-bootstrap/shadow-cache.ts";
import { shadowRunInputFromLocalContainerInputs } from "./db-bootstrap/shadow-database.ts";
import { LinkedProjectCache } from "../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../telemetry/telemetry-state.service.ts";
import {
  updateDeclarativeSchemaPathsConfig,
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "../commands/db/shared/pgdelta.write.ts";
import {
  parseBoolEnv,
  resolveDeclarativeFromArgs,
  resolvePullDiffEngine,
  schemaPathsTransitionWarning,
  shouldUsePgDelta,
} from "./diff-engine.ts";
import { diffMigra } from "../commands/db/shared/migra.ts";
import { writePgDeltaMigrations } from "../commands/db/shared/pgdelta-migrations.write.ts";
import { type DumpOptions, buildSchemaDumpEnv } from "./pg-dump.env.ts";
import { streamPgDump } from "./pg-dump.run.ts";
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
import { type PgDeltaContext, isPgDeltaDebugEnabled, resolvePgDeltaProjectId } from "./pgdelta.ts";
import { prepareShadowSource } from "../commands/db/shared/shadow-source.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { stackRejectNativeDockerDiffEngine } from "./stack-local-database.ts";
import { stackPrepareShadowSource, stackWithShadowDatabase } from "./stack-shadow.ts";
import type { DbPullFlags } from "../commands/db/pull/pull.command.ts";
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

// `DbPullFlags` is `runDbPull`'s own parameter type, defined alongside the standalone
// `db pull` command that also constructs it — re-exported here so an in-process caller
// (`pull`) can build one without reaching into `commands/db/**` directly.
export type { DbPullFlags };

// Established output contract; ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/**
 * Explains the in-sync non-zero exit instead of the generic "Try rerunning the command with
 * --debug…" footer, which would read like a crash for what is really a finding. See
 * `docs/go-cli-divergences.md` for the established message/exit-code contract.
 */
const IN_SYNC_SUGGESTION =
  "The remote database is already in sync with your local migrations — nothing to pull.";

/** Migration-file mode for the initial pg_dump seed. */
const MIGRATION_FILE_MODE = 0o644;

// `--experimental` without `--declarative` is a deprecated path: the in-process declarative
// export covers the same per-object-files outcome. Printed only when the experimental gate
// selected this branch, not when `--declarative` already did.
const EXPERIMENTAL_STRUCTURED_DUMP_DEPRECATION_LINE =
  "The --experimental structured-dump mode for `db pull` is deprecated and will be removed in a future release. Use --declarative instead to pull the remote schema as per-object files.";

export type DbPullInvoke = {
  /** Skip printing `Finished supabase db pull.` for callers that must not emit it. */
  readonly skipFinishedLine?: boolean;
  /**
   * Overrides `--yes`/`SUPABASE_YES`/`supabase/.env` resolution for an
   * in-process caller that already ran its own aggregated confirmation.
   * `undefined` keeps the existing resolution.
   */
  readonly assumeYes?: boolean;
  /**
   * Forces migration mode regardless of the ambient `--experimental`/`SUPABASE_EXPERIMENTAL`
   * gate, for an in-process caller (`pull`) whose dirty-guard, confirmation message, and
   * SIDE_EFFECTS.md all assume this step only ever writes into `supabase/migrations`. Without
   * this override, an ambient experimental flag would silently switch to the declarative export
   * path, writing `supabase/schemas/**` and potentially `config.toml`'s `schema_paths`
   * unguarded. `undefined` keeps the existing resolution.
   */
  readonly forceMigrationMode?: boolean;
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
  flags: DbPullFlags,
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
  const cliArgs = yield* CliArgs;

  // `--yes` or `SUPABASE_YES`. The project `.env` is loaded before the migration
  // history prompt, so a `SUPABASE_YES` set only in `supabase/.env` auto-confirms
  // the native initial-migra history repair too.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  // `EXPERIMENTAL` resolves from either the global `--experimental` flag or
  // `SUPABASE_EXPERIMENTAL`, reusing `resolveExperimentalWithProjectEnv`'s flag-over-env
  // precedence instead of re-deriving it. Resolved once, same as `yes` above; declarative mode
  // ignores it. `invoke?.forceMigrationMode` overrides this for an in-process caller that must
  // never take the declarative export path — see {@link DbPullInvoke.forceMigrationMode}.
  const experimental = invoke?.forceMigrationMode
    ? false
    : yield* resolveExperimentalWithProjectEnv(projectEnv);

  let linkedRefForCache: string | undefined;

  return yield* Effect.gen(function* () {
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `getRegistryImageUrl` (the pg_dump
    // seed + migra/pg-delta diff images), reverted when this scope closes.
    yield* applyProjectEnv(projectEnv);
    const name = Option.getOrElse(flags.name, () => "remote_schema");
    // `--declarative` and the deprecated `--use-pg-delta` both bind to the same
    // `useDeclarative` outcome. When both are passed, the last occurrence in argv wins
    // (e.g. `--declarative --use-pg-delta=false` => migration mode); since parsed Options don't
    // carry order, the both-present case replays that rule off the raw argv instead of ORing the
    // two, which would diverge on conflicting values.
    const useDeclarative =
      Option.isSome(flags.declarative) && Option.isSome(flags.usePgDelta)
        ? (resolveDeclarativeFromArgs(cliArgs.args) ?? false)
        : Option.getOrElse(flags.declarative, () => false) ||
          Option.getOrElse(flags.usePgDelta, () => false);
    if (Option.isSome(flags.usePgDelta)) {
      yield* output.raw(`${DEPRECATION_LINE}\n`, "stderr");
    }
    // Deprecated `--experimental` dump: same in-process export as `--declarative`.
    const useExperimentalExport = experimental && !useDeclarative;
    if (useExperimentalExport) {
      yield* output.raw(`${EXPERIMENTAL_STRUCTURED_DUMP_DEPRECATION_LINE}\n`, "stderr");
    }
    const useDeclarativeExport = useDeclarative || useExperimentalExport;

    // Mutually exclusive flag groups: `[db-url linked local]`, `[declarative
    // diff-engine]`, `[use-pg-delta diff-engine]`. "set" means the flag was
    // explicitly passed.
    const targetSet: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) targetSet.push("db-url");
    if (Option.isSome(flags.linked)) targetSet.push("linked");
    if (Option.isSome(flags.local)) targetSet.push("local");
    if (targetSet.length > 1) {
      return yield* Effect.fail(
        new DbPullTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${[...targetSet].sort().join(" ")}] were all set`,
        }),
      );
    }
    for (const [flagName, present] of [
      ["declarative", Option.isSome(flags.declarative)],
      ["use-pg-delta", Option.isSome(flags.usePgDelta)],
    ] as const) {
      if (present && Option.isSome(flags.diffEngine)) {
        return yield* Effect.fail(
          new DbPullEngineConflictError({
            message: `if any flags in the group [${flagName} diff-engine] are set none of the others can be; [${[flagName, "diff-engine"].sort().join(" ")}] were all set`,
          }),
        );
      }
    }

    const connType: DbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.local)
        ? "local"
        : "linked";

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbPullTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
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

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    // Validate native shadow inputs before target resolution performs remote side effects.
    const localInputs: Option.Option<LocalDbContainerInputs> = useExperimentalExport
      ? Option.none()
      : Option.some(
          yield* buildLocalDbContainerInputs(
            spawner,
            cliSettings.workdir,
            networkIdFlag,
            runtimeInfo.platform,
            debug,
            // So the shadow's own container spec reflects the matching `[remotes.<ref>]`
            // override, same as `toml` above.
            connType === "linked" ? linkedRef : undefined,
            // `toml`'s remote-override-key tracking (same matched block), so a remote-set
            // bootstrap field isn't re-overridden by a conflicting `SUPABASE_*` env var here.
            toml.remoteOverrideKeys,
          ),
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
      // Precedence: `SUPABASE_PROJECT_ID` env override, then config.toml's `project_id`, then
      // the workdir basename fallback — with the matched `[remotes.<ref>]` block's own
      // `project_id` suppressing the raw env argument on the linked path.
      projectId: resolvePgDeltaProjectId(cliSettings.projectId, toml, cliSettings.workdir),
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
        shouldUsePgDelta({
          configEnabled: toml.pgDelta.enabled,
          usePgDeltaFlag: false,
          envEnabled: parseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")),
        }),
    });
    if (Option.getOrElse(flags.diffEngine, () => "pg-delta") === "migra") {
      yield* stackRejectNativeDockerDiffEngine;
    }

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

        // Declarative export path (`--declarative` or deprecated `--experimental`).
        if (useDeclarativeExport) {
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
              debug: isPgDeltaDebugEnabled(),
              strictCoverage: flags.strictCoverage,
            });
          const exported = yield* withPoolerFallback(targetEndpoint, (target) =>
            exportSchema(target),
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
          return yield* Effect.fail(
            new DbPullMigrationConflictError({
              message:
                "The remote database's migration history does not match local files in supabase/migrations directory.",
              suggestion: sync.suggestion,
            }),
          );
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

        // `Option.getOrThrow` is safe here: this point is only reached after the
        // declarative-export branch already returned, so `localInputs` was always built.
        const pullLocalInputs = Option.getOrThrow(localInputs);

        if (seededFromDump) {
          yield* makeDir(fs, path.dirname(migrationPath)).pipe(
            Effect.mapError((cause) => new DbPullWriteError({ message: cause.message })),
          );
          const { image } = yield* resolveDbImage(
            fs,
            path,
            cliSettings.workdir,
            toml.majorVersion,
            Option.getOrUndefined(toml.orioledbVersion),
          );
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
              .pipe(Effect.mapError(toDumpOpenError))
              .pipe(
                Effect.andThen(
                  Effect.scoped(
                    Effect.gen(function* () {
                      const file = yield* fs
                        .open(migrationPath, { flag: "a" })
                        .pipe(Effect.mapError(toDumpOpenError));
                      return yield* streamPgDump({
                        image,
                        script: dumpSchemaScript,
                        env: buildSchemaDumpEnv(target, dumpEnvOpt),
                        projectEnvValues: projectEnv,
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
            return yield* Effect.fail(
              new DbPullDumpError({
                message: `error running container: exit ${dumpResult.exitCode}`,
                ...(isIPv6ConnectivityError(dumpResult.stderr)
                  ? { suggestion: ipv6Suggestion() }
                  : {}),
              }),
            );
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
              : yield* pullLocalInputs.resolvePostgresImage;
            const migrationMode: "legacy" | "pgdelta-next" = usePgDeltaDiff
              ? "pgdelta-next"
              : "legacy";
            const shadowInput = {
              ...shadowRunInputFromLocalContainerInputs(
                pullLocalInputs,
                resolvedPullShadowImage,
                toml,
                fs,
                path,
              ),
              targetLocal: resolved.isLocal,
              migrationMode,
              // `toml.schemaPathPatterns` is used here, not the raw `@supabase/config` field on
              // `pullLocalInputs`, since only `toml` (via `readDbToml`) resolves the
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
                    debug: isPgDeltaDebugEnabled(),
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
        const diffOutcome = yield* withPoolerFallback(targetEndpoint, runShadowDiff);

        const out = diffOutcome.sql;
        const diffEmpty = out.trim().length === 0;
        // A non-initial pull with an empty diff is "in sync" and fails. The
        // initial-migra path seeded the file with a pg_dump above, so its empty second
        // pass is swallowed and falls through to the shared tail below.
        if (diffEmpty && !seededFromDump) {
          if (diffOutcome.debug?.directory !== undefined) {
            yield* output.raw(debugBundleMessage(diffOutcome.debug.directory), "stderr");
            return yield* Effect.fail(
              new DbPullInSyncError({
                message: `No schema changes found (debug bundle: ${diffOutcome.debug.directory})`,
                suggestion: IN_SYNC_SUGGESTION,
              }),
            );
          }
          return yield* Effect.fail(
            new DbPullInSyncError({
              message: "No schema changes found",
              suggestion: IN_SYNC_SUGGESTION,
            }),
          );
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
            return yield* Effect.fail(
              new DbPullInSyncError({
                message: "No schema changes found",
                suggestion: IN_SYNC_SUGGESTION,
              }),
            );
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
        // (`true`) on `--yes`, on a non-interactive stdin, or on any prompt error — it
        // never fails the command.
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
          engine: usePgDeltaDiff ? "pg-delta" : "migra",
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
    // Scope the `SUPABASE_INTERNAL_IMAGE_REGISTRY`-from-`.env` apply above to this
    // command run: `applyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
