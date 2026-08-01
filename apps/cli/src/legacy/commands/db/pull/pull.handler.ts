import { Clock, Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyAqua, legacyBold } from "../../../shared/legacy-colors.ts";
import { legacyPromptYesNo } from "../../../../shared/legacy/legacy-prompt-yes-no.ts";
import {
  legacyIpv6Suggestion,
  legacyIsIPv6ConnectivityError,
} from "../../../shared/legacy-connect-errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { legacyResolveDbImage } from "../../../shared/legacy-db-image.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyApplyProjectEnv,
  legacyLoadProjectEnv,
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyMakeDir } from "../../../shared/legacy-make-dir.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyUpdateDeclarativeSchemaPathsConfig,
  legacyWriteDeclarativeSchemas,
} from "../shared/legacy-pgdelta.write.ts";
import {
  legacyParseBoolEnv,
  legacyResolveDeclarativeFromArgs,
  legacyResolvePullDiffEngine,
  legacyShouldUsePgDelta,
} from "../shared/legacy-diff-engine.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import { legacyWritePgDeltaMigrations } from "../shared/legacy-pgdelta-migrations.write.ts";
import { type LegacyDumpOptions, legacyBuildSchemaDumpEnv } from "../shared/legacy-pg-dump.env.ts";
import { legacyStreamPgDump } from "../shared/legacy-pg-dump.run.ts";
import {
  legacyEmitPoolerFallbackWarning,
  legacyIsDirectLinkedHost,
  legacyRunWithPoolerFallback,
} from "../shared/legacy-pooler-fallback.ts";
import { legacyDumpSchemaScript } from "../shared/legacy-pg-dump.scripts.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";
import { legacyFormatDebugId } from "../shared/legacy-debug-bundle.ts";
import {
  type LegacyPgDeltaContext,
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
  legacyExportCatalogPgDelta,
  legacyIsPgDeltaDebugEnabled,
} from "../shared/legacy-pgdelta.ts";
import { legacySaveEmptyPgDeltaPullDebug } from "./pull.debug.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import {
  LegacyDbPullDumpError,
  LegacyDbPullEngineConflictError,
  LegacyDbPullExperimentalRetiredError,
  LegacyDbPullInSyncError,
  LegacyDbPullMigrationConflictError,
  LegacyDbPullTargetFlagsError,
  LegacyDbPullWriteError,
} from "./pull.errors.ts";
import {
  legacyListRemoteMigrations,
  legacyLoadLocalVersions,
  legacyReconcileMigrations,
} from "../../../shared/legacy-migration-history.ts";
import { legacyUpdateMigrationHistory } from "./pull.sync.ts";

// pflag's `MarkDeprecated` emits `"Flag --%s has been deprecated, %s\n"` with the
// registration message verbatim (`apps/cli-go/cmd/db.go:466`), which ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/** Migration-file mode for the initial pg_dump seed (Go's `OpenFile(..., 0644)`). */
const MIGRATION_FILE_MODE = 0o644;

// `--experimental`'s structured-dump `db pull` mode (Go's `format.WriteStructuredSchemas`)
// has been retired (CLI-1957): see `LegacyDbPullExperimentalRetiredError` for why. Printed
// to stderr in place of the removed Go delegation.
const EXPERIMENTAL_STRUCTURED_DUMP_RETIRED_MESSAGE =
  "The --experimental structured-dump mode for `db pull` has been removed. Use `db pull --declarative` instead to pull the remote schema as per-object files.";

export const legacyDbPull = Effect.fn("legacy.db.pull")(function* (flags: LegacyDbPullFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const seam = yield* LegacyDeclarativeSeam;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const cliArgs = yield* CliArgs;

  // `--yes` OR `SUPABASE_YES` (Go's `viper.GetBool("YES")`, root.go:318-320). Go
  // loads the project `.env` via `loadNestedEnv` inside `ParseDatabaseConfig`
  // (config.go:701) before `PromptYesNo`, so a `SUPABASE_YES` set only in
  // `supabase/.env` auto-confirms the native initial-migra history repair too.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);

  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `legacyGetRegistryImageUrl` (the pg_dump
    // seed + migra/pg-delta diff images), reverted when this scope closes. Go's
    // `loadNestedEnv` `os.Setenv`s the project `.env` before the dump runs.
    yield* legacyApplyProjectEnv(projectEnv);
    const name = Option.getOrElse(flags.name, () => "remote_schema");
    // `--declarative` and the deprecated `--use-pg-delta` both bind to the same
    // `useDeclarative` variable in Go (`cmd/db.go:534-535`), so when BOTH are
    // passed the LAST occurrence in argv wins (e.g. `--declarative
    // --use-pg-delta=false` => migration mode). The parsed Options don't carry
    // order, so for the both-present case we replay pflag's last-occurrence rule
    // off the raw argv; OR-ing the two would instead diverge on conflicting
    // values. When only one (or neither) is present, its Option value already
    // equals its argv value, so the OR is exact.
    const useDeclarative =
      Option.isSome(flags.declarative) && Option.isSome(flags.usePgDelta)
        ? (legacyResolveDeclarativeFromArgs(cliArgs.args) ?? false)
        : Option.getOrElse(flags.declarative, () => false) ||
          Option.getOrElse(flags.usePgDelta, () => false);
    if (Option.isSome(flags.usePgDelta)) {
      yield* output.raw(`${DEPRECATION_LINE}\n`, "stderr");
    }

    // cobra mutex groups: `[db-url linked local]`, `[declarative diff-engine]`,
    // `[use-pg-delta diff-engine]` (`cmd/db.go:472-474`). "set" = pflag `Changed`.
    const targetSet: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) targetSet.push("db-url");
    if (Option.isSome(flags.linked)) targetSet.push("linked");
    if (Option.isSome(flags.local)) targetSet.push("local");
    if (targetSet.length > 1) {
      return yield* Effect.fail(
        new LegacyDbPullTargetFlagsError({
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
          new LegacyDbPullEngineConflictError({
            message: `if any flags in the group [${flagName} diff-engine] are set none of the others can be; [${[flagName, "diff-engine"].sort().join(" ")}] were all set`,
          }),
        );
      }
    }

    // Go resolves `EXPERIMENTAL` from *either* the global `--experimental` pflag or
    // `SUPABASE_EXPERIMENTAL` (`cmd/root.go:318-320,327,334`), with the same
    // bound-pflag-wins-over-env precedence `legacyResolveExperimentalWithProjectEnv`
    // already implements for `db reset`/declarative generate/sync — reuse it here
    // instead of re-deriving the gate. Declarative mode never reaches this branch
    // (Go checks `usePgDelta` before `EXPERIMENTAL`, `pull.go:47-50`). This mode used
    // to delegate the whole pull to Go for `format.WriteStructuredSchemas` (see
    // `LegacyDbPullExperimentalRetiredError`); it now fails fast, before resolving a
    // database connection, instead — checked ahead of `resolver.resolve()` (which can
    // mint a temp login role and open real pooler connections) rather than after it.
    const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnv);
    if (!useDeclarative && experimental) {
      return yield* Effect.fail(
        new LegacyDbPullExperimentalRetiredError({
          message: EXPERIMENTAL_STRUCTURED_DUMP_RETIRED_MESSAGE,
        }),
      );
    }

    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.local)
        ? "local"
        : "linked";
    const resolved = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: flags.password ?? Option.none(),
    });
    const linkedRef = Option.getOrUndefined(resolved.ref ?? Option.none());
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;
    const targetUrl = legacyToPostgresURL(resolved.conn);

    // Reload config with the resolved linked ref so a matching `[remotes.<ref>]`
    // block merges before the engine/format/runtime/declarative paths are read —
    // Go loads config after `LoadProjectRef` on the linked path
    // (`internal/utils/flags/db_url.go:87-97`). `--local`/`--db-url` never merge a
    // remote block, so only the linked path passes the ref.
    const toml = yield* legacyReadDbToml(
      fs,
      path,
      cliConfig.workdir,
      connType === "linked" ? linkedRef : undefined,
    );
    const ctx: LegacyPgDeltaContext = {
      projectId: Option.getOrElse(cliConfig.projectId, () => ""),
      cwd: cliConfig.workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
    };
    const formatOptions = Option.getOrElse(toml.pgDelta.formatOptions, () => "");

    // Container-level pooler fallback (Go's `PoolerFallbackConfig`,
    // `internal/db/dump/pooler_fallback.go`, wired into `diffRemoteSchema` and
    // `pullDeclarativePgDelta`, `internal/db/pull/pull.go`). A linked pull can reach
    // the direct host from the CLI process (so the resolver returned the direct
    // conn) yet fail from inside the edge-runtime container on an IPv6-only Docker
    // network. When the differ/export error classifies as an IPv6 connectivity
    // failure, retry once through the project's IPv4 transaction pooler, reusing the
    // same shadow source. Gated to the `--linked` path with a direct
    // `db.<ref>.<host>` connection (Go's `PoolerFallbackEligible` +
    // `ProjectRefFromDirectDbHost`). The error message embeds the container stderr
    // (edge-runtime/migra errors wrap it), which is what Go classifies.
    const withPoolerFallback = <A, E extends { readonly message: string }, R>(
      directTarget: string,
      attempt: (targetRef: string) => Effect.Effect<A, E, R>,
    ) =>
      attempt(directTarget).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (
              legacyIsDirectLinkedHost({
                connType,
                host: resolved.conn.host,
                isLocal: resolved.isLocal,
                projectHost: cliConfig.projectHost,
              }) &&
              legacyIsIPv6ConnectivityError(error.message)
            ) {
              // Go's `PoolerFallbackConfig` returns `ok=false` on ANY resolution
              // error and the caller then surfaces the ORIGINAL diff error, so a
              // resolution failure is treated as "no fallback" (re-fail original).
              const pooler = yield* resolver
                .resolvePoolerFallback({
                  dbUrl: flags.dbUrl,
                  connType: "linked",
                  dnsResolver,
                  password: flags.password ?? Option.none(),
                })
                .pipe(Effect.orElseSucceed(() => Option.none()));
              if (Option.isSome(pooler)) {
                yield* legacyEmitPoolerFallbackWarning(resolved.conn.host);
                return yield* attempt(legacyToPostgresURL(pooler.value));
              }
            }
            return yield* Effect.fail(error);
          }),
        ),
      );

    const usePgDeltaDiff = legacyResolvePullDiffEngine({
      engineFlagChanged: Option.isSome(flags.diffEngine),
      engine: Option.getOrElse(flags.diffEngine, () => "migra"),
      pgDeltaDefault: legacyShouldUsePgDelta({
        configEnabled: toml.pgDelta.enabled,
        usePgDeltaFlag: false,
        envEnabled: legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")),
      }),
    });

    // Connectivity check (Go's `ConnectByConfig` at the top of `pull.Run`).
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Go's `ConnectByConfigStream` prints this to stderr before dialing
        // (`internal/utils/connect.go:344-348`), local vs remote keyed off
        // `utils.IsLocalDatabase` (mirrored by the resolver's `isLocal`).
        yield* output.raw(
          `Connecting to ${resolved.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* connection.connect(resolved.conn, {
          isLocal: resolved.isLocal,
          dnsResolver,
        });

        // Declarative export path (Go's `pullDeclarativePgDelta`).
        if (useDeclarative) {
          yield* output.raw("Preparing declarative schema export using pg-delta...\n", "stderr");
          const declarativeDirRel = legacyResolveDeclarativeDir(path, toml.pgDelta);
          const declarativeDir = path.resolve(cliConfig.workdir, declarativeDirRel);
          const shadow = yield* seam.provisionShadow({
            mode: "declarative",
            targetLocal: false,
            usePgDelta: true,
            schema: flags.schema,
            // Linked path only: merge the same `[remotes.<ref>]` override into the
            // shadow baseline (Go builds the shadow from the remote-merged config).
            projectRef: connType === "linked" ? linkedRef : undefined,
          });
          const exported = yield* withPoolerFallback(targetUrl, (targetRef) =>
            legacyDeclarativeExportPgDelta(ctx, {
              sourceRef: shadow.sourceUrl,
              targetRef,
              schema: flags.schema,
              formatOptions,
            }),
          ).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));
          yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, exported).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
          // Go's WriteDeclarativeSchemas also points [db.migrations] schema_paths at
          // the declarative dir, but only when pg-delta is *disabled* in config
          // (declarative.go:260-268, gated on IsPgDeltaEnabled which reads the config
          // value). db pull --declarative does not force-enable pg-delta
          // (cmd/db.go:180-182), so unlike generate/sync this branch is reachable:
          // without it, subsequent db reset/db diff keep reading supabase/migrations
          // and ignore the files just pulled.
          if (!toml.pgDelta.enabled) {
            yield* legacyUpdateDeclarativeSchemaPathsConfig(
              fs,
              path,
              cliConfig.workdir,
              declarativeDirRel,
            ).pipe(
              Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
            );
          }
          // Go prints `utils.GetDeclarativeDir()` verbatim (`pull.go:119`): the
          // config's declarative_schema_path or the relative `supabase/database`
          // default — never the resolved absolute directory. The json payload
          // below keeps the absolute path for machine consumers.
          yield* output.raw(
            `Declarative schema written to ${legacyBold(declarativeDirRel)}\n`,
            "stderr",
          );
          if (output.format !== "text") {
            yield* output.success("Declarative schema pulled.", {
              declarative: true,
              schemaWritten: declarativeDir,
              remoteHistoryUpdated: false,
              engine: "pg-delta",
            });
          } else {
            yield* output.raw(`Finished ${legacyAqua("supabase db pull")}.\n`);
          }
          return;
        }

        // Migration-file path (Go's `pull.run`).
        const nowMillis = yield* Clock.currentTimeMillis;
        const timestamp = legacyFormatMigrationTimestamp(nowMillis);
        const migrationPath = legacyGetMigrationPath(path, cliConfig.workdir, timestamp, name);

        const remote = yield* legacyListRemoteMigrations(session);
        const local = yield* legacyLoadLocalVersions(
          fs,
          path,
          path.join(cliConfig.workdir, "supabase", "migrations"),
        );
        const sync = legacyReconcileMigrations(remote, local, connType === "local");
        if (sync.kind === "conflict") {
          return yield* Effect.fail(
            new LegacyDbPullMigrationConflictError({
              message:
                "The remote database's migration history does not match local files in supabase/migrations directory.",
              suggestion: sync.suggestion,
            }),
          );
        }
        // Initial pull, migra engine (Go's `run` → `assertRemoteInSync` returns
        // `errMissing`): seed the migration file with a pg_dump of the remote schema
        // (`dumpRemoteSchema`, `pull.go:144-158`), then run the migra diff below as a
        // second pass appended to the same file (`diffRemoteSchema(ctx, nil, …)`),
        // which captures default privileges / managed schemas pg_dump can't emit.
        // pg-delta initial pulls skip the dump (`pull.go:126` `if !usePgDeltaDiff`):
        // they diff against an empty shadow, which already yields the full schema.
        const seededFromDump = sync.kind === "missing" && !usePgDeltaDiff;
        // Tracks whether the pg_dump seed wrote any bytes, for Go's
        // `ensureMigrationWritten` (`pull.go:68,263-268`): an empty dump + empty diff
        // is "in sync", a non-empty dump is a valid initial migration on its own.
        let seedWroteBytes = false;
        if (seededFromDump) {
          yield* legacyMakeDir(fs, path.dirname(migrationPath)).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
          const image = yield* legacyResolveDbImage(
            fs,
            path,
            cliConfig.workdir,
            toml.majorVersion,
            Option.getOrUndefined(toml.orioledbVersion),
          );
          // Go's `migration.DumpSchema` default options: no schema filter (so the
          // internal-schema exclude list applies) and comments stripped (`EXTRA_SED`).
          const dumpEnvOpt: LegacyDumpOptions = {
            schema: [],
            keepComments: false,
            excludeTable: [],
            columnInsert: false,
          };
          const toDumpOpenError = (cause: { readonly message: string }) =>
            new LegacyDbPullDumpError({ message: `failed to open dump file: ${cause.message}` });
          // Stream pg_dump → migration file, (re)truncating per attempt so a pooler
          // retry leaves only the successful attempt's bytes (Go's `resetOutput`).
          const runSchemaDump = (target: LegacyPgConnInput) => {
            // Reset per attempt alongside the truncate, mirroring Go's `resetOutput`
            // (`pooler_fallback.go:98-113`) which zeroes the file before the pooler
            // retry. Go decides in-sync from the file on disk (`hasMigrationContent`,
            // `pull.go:251-268`), so only the final successful attempt's bytes count: a
            // partial direct write that then IPv6-fails must not leave this flag stuck
            // true, or an empty pooler retry would be mis-reported as a schema write.
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
                      return yield* legacyStreamPgDump({
                        image,
                        script: legacyDumpSchemaScript,
                        env: legacyBuildSchemaDumpEnv(target, dumpEnvOpt),
                        onStdout: (chunk) => {
                          if (chunk.length > 0) seedWroteBytes = true;
                          return file.writeAll(chunk).pipe(
                            Effect.mapError(
                              (cause) =>
                                new LegacyDbPullWriteError({
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
          // Go's `dumpRemoteSchema` prints this once, before `RunWithPoolerFallback`.
          yield* output.raw("Dumping schema from remote database...\n", "stderr");
          // Container-level IPv6 → IPv4-pooler retry (Go's `dump.RunWithPoolerFallback`),
          // shared with `db dump`. `db pull` prints "Dumping…" once above, so it passes
          // `Effect.void` for the retry re-print (Go prints it outside the retried closure).
          const dumpResult = yield* legacyRunWithPoolerFallback({
            result: yield* runSchemaDump(resolved.conn),
            connType,
            host: resolved.conn.host,
            isLocal: resolved.isLocal,
            projectHost: cliConfig.projectHost,
            resolvePooler: () =>
              resolver
                .resolvePoolerFallback({
                  dbUrl: flags.dbUrl,
                  connType: "linked",
                  dnsResolver,
                  password: flags.password ?? Option.none(),
                })
                .pipe(Effect.orElseSucceed(() => Option.none())),
            runWithConn: runSchemaDump,
            reprintOnRetry: Effect.void,
          });
          if (dumpResult.exitCode !== 0) {
            return yield* Effect.fail(
              new LegacyDbPullDumpError({
                message: `error running container: exit ${dumpResult.exitCode}`,
                ...(legacyIsIPv6ConnectivityError(dumpResult.stderr)
                  ? { suggestion: legacyIpv6Suggestion() }
                  : {}),
              }),
            );
          }
        }

        // Native diff: shadow (baseline + local migrations) vs remote → migration SQL.
        // For the initial pull (no local migrations) the schema filter is ignored,
        // matching Go's `diffRemoteSchema(ctx, nil, …)`.
        const diffSchema = sync.kind === "missing" ? [] : flags.schema;
        // Go's `DiffDatabase` emits these to stderr before provisioning + diffing
        // (`internal/db/diff/diff.go:189,234-237`); the shadow seam doesn't, so the
        // pull handler emits them itself to match the migration-style `db pull` output.
        yield* output.raw("Creating shadow database...\n", "stderr");
        const shadow = yield* seam.provisionShadow({
          mode: "diff",
          // Mirror Go's `DiffDatabase` → `PrepareShadowSource(ctx, schema,
          // utils.IsLocalDatabase(config), …)` (`internal/db/diff/diff.go:190`):
          // a local target with declarative schema files gets a second
          // `contrib_regression` shadow returned as the target override.
          targetLocal: resolved.isLocal,
          usePgDelta: usePgDeltaDiff,
          schema: diffSchema,
          // Linked path only: merge the same `[remotes.<ref>]` override into the
          // shadow baseline (Go builds the shadow from the remote-merged config).
          projectRef: connType === "linked" ? linkedRef : undefined,
        });
        const diffOutcome = yield* Effect.gen(function* () {
          // Use the declarative target override when present (Go substitutes it
          // for the diff target, `diff.go:196-197`); for remote pulls it's
          // undefined, so this is the direct target URL as before.
          const target = shadow.targetUrlOverride ?? targetUrl;
          yield* output.raw(
            diffSchema.length > 0
              ? `Diffing schemas: ${diffSchema.join(",")}\n`
              : "Diffing schemas...\n",
            "stderr",
          );
          return yield* withPoolerFallback(target, (targetRef) =>
            // Wrap the engine choice in a gen so both branches' error/requirement
            // channels unify into one `Effect` the helper can retry generically.
            Effect.gen(function* () {
              if (usePgDeltaDiff) {
                // With PGDELTA_DEBUG set, capture the shadow baseline catalog so an
                // empty diff can be inspected later (Go's DiffDatabase,
                // `internal/db/diff/diff.go:205-214`); a failed export only warns.
                const debug = legacyIsPgDeltaDebugEnabled();
                const sourceCatalog = debug
                  ? yield* legacyExportCatalogPgDelta(ctx, {
                      targetRef: shadow.sourceUrl,
                      role: "postgres",
                    }).pipe(
                      Effect.catch((error) =>
                        output
                          .raw(
                            `Warning: failed to export shadow pg-delta catalog: ${error.message}\n`,
                            "stderr",
                          )
                          .pipe(Effect.as(undefined)),
                      ),
                    )
                  : undefined;
                const result = yield* legacyDiffPgDelta(ctx, {
                  sourceRef: shadow.sourceUrl,
                  targetRef,
                  schema: diffSchema,
                  formatOptions,
                });
                return {
                  sql: result.sql,
                  files: result.files,
                  capture: debug ? { sourceCatalog, stderr: result.stderr } : undefined,
                };
              }
              const sql = yield* legacyDiffMigra(ctx, {
                source: shadow.sourceUrl,
                target: targetRef,
                schema: diffSchema,
                connectOptions: { isLocal: resolved.isLocal, dnsResolver },
              });
              return { sql, files: undefined, capture: undefined };
            }),
          );
        }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));

        const out = diffOutcome.sql;
        const diffEmpty = out.trim().length === 0;
        // A non-initial pull with an empty diff is "in sync" and fails (Go's
        // `diffRemoteSchema`). The initial-migra path seeded the file with a pg_dump
        // above, so its empty second pass is swallowed (`swallowInitialInSync`,
        // `pull.go:256-261`) and falls through to the shared tail below.
        if (diffEmpty && !seededFromDump) {
          // Go saves a pg-delta debug bundle and embeds its path in the in-sync
          // error when PGDELTA_DEBUG is set (`internal/db/pull/pull.go:176-185`); a
          // bundle-save failure falls through to the plain in-sync error.
          if (diffOutcome.capture !== undefined) {
            const debugDir = yield* legacySaveEmptyPgDeltaPullDebug({
              ctx,
              conn: resolved.conn,
              targetUrl,
              sourceCatalog: diffOutcome.capture.sourceCatalog,
              pgDeltaStderr: diffOutcome.capture.stderr,
              id: legacyFormatDebugId(yield* Clock.currentTimeMillis),
              fs,
              path,
              workdir: cliConfig.workdir,
            }).pipe(
              Effect.catch((error) =>
                output
                  .raw(
                    `Warning: failed to save pg-delta debug bundle: ${error.message}\n`,
                    "stderr",
                  )
                  .pipe(Effect.as(undefined)),
              ),
            );
            if (debugDir !== undefined) {
              return yield* Effect.fail(
                new LegacyDbPullInSyncError({
                  message: `No schema changes found (debug bundle: ${debugDir})`,
                }),
              );
            }
          }
          return yield* Effect.fail(
            new LegacyDbPullInSyncError({ message: "No schema changes found" }),
          );
        }

        // Build the list of migration files to record in the remote history. The
        // migra engine writes exactly one file (the dump-seeded or freshly written
        // migrationPath); the pg-delta engine writes one ordered file per
        // execution-aware plan unit.
        const writtenMigrations: Array<{ path: string; version: string }> = [];
        if (usePgDeltaDiff) {
          // pg-delta: one migration file per plan unit via the shared writer. A
          // single-unit plan (the common case) keeps the exact `<ts>_<name>.sql`
          // filename; multi-unit plans append the unit name and give each file a
          // strictly increasing timestamp so execution + migration-history order stay
          // stable. The full set is collision-checked against existing migrations and
          // each file is written exclusively so a pre-existing migration is never
          // overwritten. Mirrors Go's `WritePgDeltaMigrations`
          // (`internal/db/diff/pgdelta_migrations.go`). Empty plans are handled by the
          // `diffEmpty` in-sync branch above, so `planFiles` is non-empty here.
          const planFiles = diffOutcome.files ?? [];
          const writtenUnits = yield* legacyWritePgDeltaMigrations(fs, path, {
            workdir: cliConfig.workdir,
            baseMillis: nowMillis,
            name,
            files: planFiles.map((file) => ({ name: file.name, sql: file.sql })),
          }).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
          for (const unit of writtenUnits) {
            writtenMigrations.push({ path: unit.path, version: unit.version });
          }
        } else {
          if (!diffEmpty) {
            if (seededFromDump) {
              // Append the migra diff to the dump-seeded file (Go's `diffRemoteSchema`
              // opens the migration file `O_APPEND`, `pull.go:191`).
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* fs.open(migrationPath, { flag: "a" }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new LegacyDbPullWriteError({
                          message: `failed to open migration file: ${cause.message}`,
                        }),
                    ),
                  );
                  yield* file.writeAll(new TextEncoder().encode(out)).pipe(
                    Effect.mapError(
                      (cause) =>
                        new LegacyDbPullWriteError({
                          message: `failed to write migration file: ${cause.message}`,
                        }),
                    ),
                  );
                }),
              );
            } else {
              yield* legacyMakeDir(fs, path.dirname(migrationPath)).pipe(
                Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
              );
              yield* fs.writeFileString(migrationPath, out).pipe(
                Effect.mapError(
                  (cause) =>
                    new LegacyDbPullWriteError({
                      message: `failed to write migration file: ${cause.message}`,
                    }),
                ),
              );
            }
          }

          // Go's `ensureMigrationWritten` (`pull.go:68,263-268`): a dump that produced
          // nothing followed by an empty diff leaves the file empty → in sync.
          if (seededFromDump && !seedWroteBytes && diffEmpty) {
            return yield* Effect.fail(
              new LegacyDbPullInSyncError({ message: "No schema changes found" }),
            );
          }
          writtenMigrations.push({ path: migrationPath, version: timestamp });
        }

        for (const written of writtenMigrations) {
          // Go prints the workdir-relative path (`pull.go:76`): `GetMigrationPath`
          // joins the relative `utils.MigrationsDir` and Go chdirs into the
          // workdir. Display-only — `writtenMigrations` keeps absolute paths for
          // file I/O and the json payload.
          yield* output.raw(
            `Schema written to ${legacyBold(path.relative(cliConfig.workdir, written.path))}\n`,
            "stderr",
          );
        }

        // Prompt to update the remote migration history table. Go calls
        // `PromptYesNo(ctx, "Update remote migration history table?", true)`
        // (`internal/db/pull/pull.go:73`), which returns the default (`true`) on
        // `--yes`, on a non-interactive stdin, or on any prompt error
        // (`internal/utils/console.go:74-82`) — it never fails the command.
        let remoteHistoryUpdated = false;
        const updateHistoryTitle = "Update remote migration history table?";
        // Go's `PromptYesNo(ctx, title, true)` (`internal/db/pull/pull.go:73`): honors
        // `--yes`, scans piped stdin on a non-TTY before falling back to the default
        // (`console.go:64-82`), and otherwise prompts on a real TTY.
        const shouldUpdate = yield* legacyPromptYesNo(output, yes, updateHistoryTitle, true);
        if (shouldUpdate) {
          yield* legacyUpdateMigrationHistory(session, fs, path, writtenMigrations);
          remoteHistoryUpdated = true;
        }

        if (output.format !== "text") {
          yield* output.success("Schema pulled.", {
            declarative: false,
            // `schemaWritten` keeps the first written path for released consumers that
            // read the string field; `schemaFiles` lists EVERY written migration path
            // in write order (a pg-delta plan writes one file per unit), so machine
            // callers see all of them, not just the first.
            schemaWritten: writtenMigrations[0]?.path ?? migrationPath,
            schemaFiles: writtenMigrations.map((written) => written.path),
            remoteHistoryUpdated,
            engine: usePgDeltaDiff ? "pg-delta" : "migra",
          });
        } else {
          yield* output.raw(`Finished ${legacyAqua("supabase db pull")}.\n`);
        }
      }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
    // Scope the `SUPABASE_INTERNAL_IMAGE_REGISTRY`-from-`.env` apply below to this
    // command run: `legacyApplyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
