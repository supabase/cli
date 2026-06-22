import { Clock, Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyAqua, legacyBold, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyIsIPv6ConnectivityError } from "../../../shared/legacy-connect-errors.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../shared/legacy-db-config.toml-read.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { legacySchemaToCsvField } from "../../../shared/legacy-schema-flags.ts";
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
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../shared/legacy-migration-file.ts";
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
  LegacyDbPullEngineConflictError,
  LegacyDbPullInSyncError,
  LegacyDbPullMigrationConflictError,
  LegacyDbPullTargetFlagsError,
  LegacyDbPullWriteError,
} from "./pull.errors.ts";
import {
  legacyListRemoteMigrations,
  legacyLoadLocalVersions,
  legacyReconcileMigrations,
  legacyUpdateMigrationHistory,
} from "./pull.sync.ts";

// pflag's `MarkDeprecated` emits `"Flag --%s has been deprecated, %s\n"` with the
// registration message verbatim (`apps/cli-go/cmd/db.go:466`), which ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/** Builds a plain Postgres URL from a resolved connection (Go's `ToPostgresURL`). */
const connToUrl = (conn: LegacyPgConnInput): string =>
  legacyToPostgresURL({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    ...(conn.options !== undefined ? { options: conn.options } : {}),
    ...(conn.runtimeParams !== undefined ? { runtimeParams: conn.runtimeParams } : {}),
    // Preserve a `--db-url` connect_timeout; Go's ToPostgresURL serializes the
    // parsed ConnectTimeout (`connect.go`), defaulting to 10 only when unset.
    ...(conn.connectTimeoutSeconds !== undefined
      ? { connectTimeoutSeconds: conn.connectTimeoutSeconds }
      : {}),
  });

/** Rebuilds the `db pull` argv for the Go-delegated branches (initial-migra / EXPERIMENTAL dump). */
const rebuildDelegateArgs = (flags: LegacyDbPullFlags): Array<string> => {
  const args = ["db", "pull"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  const pushTarget = (name: string, value: Option.Option<boolean>) => {
    // Target flags (linked/local) are selectors: Go's ParseDatabaseConfig keys off
    // `flag.Changed` before the value (`internal/utils/flags/db_url.go`), so a
    // Changed-but-false flag still selects that target. Forward whenever `Some`
    // so the delegated child resolves the same target the native path did, instead
    // of falling through to a different default.
    if (Option.isSome(value)) args.push(value.value ? `--${name}` : `--${name}=false`);
  };
  // Delegation only ever happens in MIGRATION mode — the declarative branch
  // returns before reaching the delegate call sites — so the resolved decision
  // here is always `useDeclarative === false`. Go binds `--declarative` and
  // `--use-pg-delta` to one last-occurrence-wins variable (`cmd/db.go:534-535`), so
  // replaying only the truthy alias (e.g. forwarding `--declarative` for
  // `db pull --declarative --use-pg-delta=false`) would flip the child back to
  // declarative export. Forward an explicit `--declarative=false` when an alias was
  // passed so the child resolves migration mode deterministically. Never forward
  // `--use-pg-delta`: the parent already prints its deprecation line and Go's
  // MarkDeprecated (`cmd/db.go:536`) would re-print it. The "alias present" guard
  // also keeps us clear of Go's mutually-exclusive [declarative diff-engine] group
  // (which fires on `Changed`), since an alias and `--diff-engine` can't co-occur.
  if (Option.isSome(flags.declarative) || Option.isSome(flags.usePgDelta)) {
    args.push("--declarative=false");
  }
  if (Option.isSome(flags.diffEngine)) args.push("--diff-engine", flags.diffEngine.value);
  // Re-encode each parsed schema as a CSV field so the Go child's pflag StringSlice
  // CSV parse doesn't re-split a comma-containing schema (e.g. `"tenant,one"`).
  for (const s of flags.schema) args.push("--schema", legacySchemaToCsvField(s));
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  pushTarget("linked", flags.linked);
  pushTarget("local", flags.local);
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  return args;
};

export const legacyDbPull = Effect.fn("legacy.db.pull")(function* (flags: LegacyDbPullFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const connection = yield* LegacyDbConnection;
  const seam = yield* LegacyDeclarativeSeam;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const yes = yield* LegacyYesFlag;
  const experimental = yield* LegacyExperimentalFlag;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const cliArgs = yield* CliArgs;

  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
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
    const targetUrl = connToUrl(resolved.conn);

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
              connType === "linked" &&
              !resolved.isLocal &&
              resolved.conn.host.startsWith("db.") &&
              resolved.conn.host.endsWith(`.${cliConfig.projectHost}`) &&
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
                yield* output.raw(
                  `${legacyYellow(
                    `Warning: Direct connection to ${resolved.conn.host} is unavailable because this environment does not support IPv6.\nRetrying via the IPv4 connection pooler.`,
                  )}\n`,
                  "stderr",
                );
                return yield* attempt(connToUrl(pooler.value));
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

    // Runs a Go-delegated pull (initial-migra / EXPERIMENTAL structured dump). In
    // machine-output mode the child's stdout is captured and a structured envelope
    // is emitted instead, so scripted callers get valid JSON rather than the Go
    // child's human output on stdout (CLI-1546: stdout is payload-only in machine
    // mode). The child is run with a non-TTY stdin (`"ignore"`) so the migration
    // path's "Update remote migration history table?" prompt (Go's `PromptYesNo`,
    // `internal/db/pull/pull.go:73`) takes its `true` default without blocking the
    // JSON caller. `remoteHistoryUpdated` is passed per call site because the two
    // delegated Go paths differ: the initial-migra path prompts + calls
    // `repair.UpdateMigrationTable` (so `true`), while the EXPERIMENTAL structured
    // dump returns before writing a migration or touching `schema_migrations`
    // (`pull.go:49-61`, so `false`). `schemaWritten` stays `null` — the child owns
    // the write and doesn't surface the path on stdout.
    const delegatePull = (
      engine: "migra" | "pg-delta",
      opts: { readonly remoteHistoryUpdated: boolean },
    ) =>
      Effect.gen(function* () {
        const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
        if (output.format !== "text") {
          yield* proxy.execCapture(rebuildDelegateArgs(flags), { env, stdin: "ignore" });
          yield* output.success("Schema pulled.", {
            declarative: false,
            schemaWritten: null,
            remoteHistoryUpdated: opts.remoteHistoryUpdated,
            engine,
          });
          return;
        }
        yield* proxy.exec(rebuildDelegateArgs(flags), { env });
      });

    // Connectivity check (Go's `ConnectByConfig` at the top of `pull.Run`).
    yield* Effect.scoped(
      Effect.gen(function* () {
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
          yield* output.raw(
            `Declarative schema written to ${legacyBold(declarativeDir)}\n`,
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

        // Go's `EXPERIMENTAL` structured-dump branch depends on unported `pg_dump`
        // — delegate the whole pull to Go. viper resolves `EXPERIMENTAL` from
        // *either* the global `--experimental` pflag or `SUPABASE_EXPERIMENTAL`
        // (`cmd/root.go:318-320,327,334`), so honor both forms here; the legacy
        // root only forwards `--experimental` to Go proxy argv, never into env.
        if (experimental || legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL"))) {
          // Go's structured-dump path returns before writing a migration or
          // touching schema_migrations (`pull.go:49-61`), so no history repair.
          yield* delegatePull(usePgDeltaDiff ? "pg-delta" : "migra", {
            remoteHistoryUpdated: false,
          });
          return;
        }

        // Migration-file path (Go's `pull.run`).
        const timestamp = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
        const migrationPath = legacyGetMigrationPath(path, cliConfig.workdir, timestamp, name);

        const remote = yield* legacyListRemoteMigrations(session);
        const local = yield* legacyLoadLocalVersions(
          fs,
          path,
          path.join(cliConfig.workdir, "supabase", "migrations"),
        );
        const sync = legacyReconcileMigrations(remote, local);
        if (sync.kind === "conflict") {
          return yield* Effect.fail(
            new LegacyDbPullMigrationConflictError({
              message:
                "The remote database's migration history does not match local files in supabase/migrations directory.",
              suggestion: sync.suggestion,
            }),
          );
        }
        if (sync.kind === "missing" && !usePgDeltaDiff) {
          // Initial pull with the migra engine needs `pg_dump` — delegate to Go.
          // Go's migration path prompts + updates schema_migrations on the non-TTY
          // default (`pull.go:73-76`), so the history is repaired.
          yield* delegatePull("migra", { remoteHistoryUpdated: true });
          return;
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
                  capture: debug ? { sourceCatalog, stderr: result.stderr } : undefined,
                };
              }
              const sql = yield* legacyDiffMigra(ctx, {
                source: shadow.sourceUrl,
                target: targetRef,
                schema: diffSchema,
                connectOptions: { isLocal: resolved.isLocal, dnsResolver },
              });
              return { sql, capture: undefined };
            }),
          );
        }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));

        const out = diffOutcome.sql;
        if (out.trim().length === 0) {
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
        yield* fs
          .makeDirectory(path.dirname(migrationPath), { recursive: true })
          .pipe(Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })));
        yield* fs.writeFileString(migrationPath, out).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbPullWriteError({
                message: `failed to write migration file: ${cause.message}`,
              }),
          ),
        );
        yield* output.raw(`Schema written to ${legacyBold(migrationPath)}\n`, "stderr");

        // Prompt to update the remote migration history table. Go calls
        // `PromptYesNo(ctx, "Update remote migration history table?", true)`
        // (`internal/db/pull/pull.go:73`), which returns the default (`true`) on
        // `--yes`, on a non-interactive stdin, or on any prompt error
        // (`internal/utils/console.go:74-82`) — it never fails the command.
        let remoteHistoryUpdated = false;
        const updateHistoryTitle = "Update remote migration history table?";
        const shouldUpdate = yield* Effect.gen(function* () {
          // Machine output (json/stream-json) never prompts — the non-text layers
          // report non-interactive and fail every prompt — so take Go's default.
          if (output.format !== "text") return true;
          if (yes) {
            yield* output.raw(`${updateHistoryTitle} [Y/n] y\n`, "stderr");
            return true;
          }
          // A non-interactive stdin or any prompt error falls back to the default,
          // matching Go's `PromptYesNo` returning `def` on error/timeout.
          return yield* output
            .promptConfirm(updateHistoryTitle, { defaultValue: true })
            .pipe(Effect.orElseSucceed(() => true));
        });
        if (shouldUpdate) {
          yield* legacyUpdateMigrationHistory(session, fs, path, migrationPath, timestamp);
          remoteHistoryUpdated = true;
        }

        if (output.format !== "text") {
          yield* output.success("Schema pulled.", {
            declarative: false,
            schemaWritten: migrationPath,
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
  );
});
