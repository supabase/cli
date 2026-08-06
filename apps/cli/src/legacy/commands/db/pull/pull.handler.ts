import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
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
import { legacySchemaToCsvField } from "../../../shared/legacy-schema-flags.ts";
import { legacyBuildLocalDbContainerInputs } from "../../../shared/db-bootstrap/local-container-inputs.ts";
import {
  legacyPrepareRawShadow,
  legacyRemoveShadowDatabase,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import {
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
} from "../../../shared/legacy-docker-ids.ts";
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
import {
  legacyPrepareShadowSource,
  legacyShadowRunInputFromLocalContainerInputs,
} from "../shared/legacy-shadow-source.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";
import {
  LegacyDbPullDumpError,
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
} from "../../../shared/legacy-migration-history.ts";
import { legacyUpdateMigrationHistory } from "./pull.sync.ts";

// pflag's `MarkDeprecated` emits `"Flag --%s has been deprecated, %s\n"` with the
// registration message verbatim (`apps/cli-go/cmd/db.go:466`), which ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/** Migration-file mode for the initial pg_dump seed (Go's `OpenFile(..., 0644)`). */
const MIGRATION_FILE_MODE = 0o644;

/** Rebuilds the `db pull` argv for the Go-delegated `--experimental` structured-dump branch. */
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
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const experimental = yield* LegacyExperimentalFlag;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const debug = yield* LegacyDebugFlag;
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
    // Go's `flags.LoadConfig` prints this unconditionally as part of the config load
    // itself, the moment a `[remotes.<ref>]` block matches (`pkg/config/config.go:605`)
    // — before any provisioning happens. `legacy-db-config.toml-read.ts` already surfaces
    // the matched name as `appliedRemote`; every other native command that threads a
    // linked ref through this same reader (`db reset`, `db push`, `config push`, `secrets
    // set`, `storage {mv,ls,rm,cp}`) already prints it right after the load — this one
    // (and `diff.handler.ts`'s equivalent) had dropped it.
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }
    const ctx: LegacyPgDeltaContext = {
      // Go's `UpdateDockerIds` derives `EdgeRuntimeId` from the ALREADY-sanitized
      // `Config.ProjectId` singleton (`internal/utils/config.go:57-76`, sanitized once by
      // `Config.Validate` at config-load time) — `SUPABASE_PROJECT_ID` env override wins,
      // then config.toml's `project_id`, then the workdir basename fallback
      // (`pkg/config/config.go:563-570`). `cliConfig.projectId` alone is env-only, so a
      // project that relies on `config.toml`'s `project_id` (or the workdir-basename
      // default) previously resolved to an empty project id here, mounting the WRONG
      // `supabase_edge_runtime_` Deno-cache volume — see `legacy-pgdelta.seam.layer.ts`'s
      // `ensureLocalDatabaseStarted` for the same resolution already established for this
      // command family (review: PRRT_kwDOErm0O86XAlIw).
      projectId: legacySanitizeProjectId(
        legacyResolveLocalProjectId(
          Option.getOrUndefined(cliConfig.projectId),
          Option.getOrUndefined(toml.projectId),
          cliConfig.workdir,
        ),
      ),
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

    // Runs the Go-delegated `--experimental` structured dump (still delegated; see the
    // EXPERIMENTAL branch below for why). In machine-output mode the child's stdout is
    // captured and a structured envelope is emitted instead, so scripted callers get
    // valid JSON rather than the Go child's human output on stdout (CLI-1546: stdout is
    // payload-only in machine mode). The child is run with a non-TTY stdin (`"ignore"`)
    // so any prompt takes its default without blocking the JSON caller. The EXPERIMENTAL
    // structured dump returns before writing a migration or touching `schema_migrations`
    // (`pull.go:49-61`), so `remoteHistoryUpdated` is `false`; `schemaWritten` stays
    // `null` — the child owns the write and doesn't surface the path on stdout.
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

    // viper resolves `EXPERIMENTAL` from *either* the global `--experimental`
    // pflag or `SUPABASE_EXPERIMENTAL` (`cmd/root.go:318-320,327,334`), so honor
    // both forms; the legacy root only forwards `--experimental` to Go proxy
    // argv, never into env. Resolved before connecting so the Connecting line
    // below knows whether this run delegates to the Go child. Declarative mode
    // never delegates (Go checks `usePgDelta` before `EXPERIMENTAL`,
    // `pull.go:47-50`).
    const delegatesExperimentalPull =
      !useDeclarative &&
      (experimental || legacyParseBoolEnv(toml.envLookup("SUPABASE_EXPERIMENTAL")));

    // Connectivity check (Go's `ConnectByConfig` at the top of `pull.Run`).
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Go's `ConnectByConfigStream` prints this to stderr before dialing
        // (`internal/utils/connect.go:344-348`), local vs remote keyed off
        // `utils.IsLocalDatabase` (mirrored by the resolver's `isLocal`). The
        // delegated `--experimental` branch skips it: the Go child's own
        // `ConnectByConfig` already prints the line, so the parent printing too
        // would double it. (The parent still dials below — mirroring Go's early
        // connectivity check — so a parent-side connect failure on the delegate
        // path surfaces without the line; pre-existing delegate behavior.)
        if (!delegatesExperimentalPull) {
          yield* output.raw(
            `Connecting to ${resolved.isLocal ? "local" : "remote"} database...\n`,
            "stderr",
          );
        }
        const session = yield* connection.connect(resolved.conn, {
          isLocal: resolved.isLocal,
          dnsResolver,
        });

        // Declarative export path (Go's `pullDeclarativePgDelta`).
        if (useDeclarative) {
          yield* output.raw("Preparing declarative schema export using pg-delta...\n", "stderr");
          const declarativeDirRel = legacyResolveDeclarativeDir(path, toml.pgDelta);
          const declarativeDir = path.resolve(cliConfig.workdir, declarativeDirRel);
          const declSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const declRuntimeInfo = yield* RuntimeInfo;
          const declNetworkIdFlag = yield* LegacyNetworkIdFlag;
          const declLocalInputs = yield* legacyBuildLocalDbContainerInputs(
            declSpawner,
            cliConfig.workdir,
            declNetworkIdFlag,
            declRuntimeInfo.platform,
            debug,
            // So the shadow's own container spec reflects the matching `[remotes.<ref>]`
            // override, same as `toml` above — see `diff.handler.ts`'s identical call site.
            connType === "linked" ? linkedRef : undefined,
            // `toml`'s OWN remote-override-key tracking (same matched block) — so a
            // remote-set bootstrap field isn't re-overridden by a conflicting `SUPABASE_*`
            // env var when deriving the shadow's container spec.
            toml.remoteOverrideKeys,
          );
          const resolvedDeclShadowImage = yield* declLocalInputs.resolvePostgresImage;
          // `legacyPrepareRawShadow` needs none of the `setup`/declarative-branch fields the
          // adapter also returns (a bare shadow never runs `MigrateShadowDatabase`) — its own
          // input type (`LegacyShadowConnectionInput`) is structurally narrower, so the extra
          // fields are simply never read.
          //
          // `Effect.acquireUseRelease`, NOT a separate `yield* legacyPrepareRawShadow(...)`
          // followed by a later `.pipe(Effect.ensuring(...))` (see this file's migration-path
          // call site below, and `diff.handler.ts`'s identical call site, for the full
          // rationale): the latter shape leaves a gap between the shadow's successful creation
          // and the `Effect.ensuring` finalizer actually being attached, where a fiber interrupt
          // would skip `legacyRemoveShadowDatabase` and leak the shadow container + its staged
          // secret directory. `acquireUseRelease` registers the release finalizer in the same
          // uninterruptible continuation the acquire resolves into, matching Go's `defer
          // DockerRemove` immediately after successful preparation (review: PRRT_kwDOErm0O86XEuqJ).
          const exported = yield* Effect.acquireUseRelease(
            legacyPrepareRawShadow(
              declSpawner,
              legacyShadowRunInputFromLocalContainerInputs(
                declLocalInputs,
                resolvedDeclShadowImage,
                toml,
                fs,
                path,
              ),
            ),
            (shadow) =>
              withPoolerFallback(targetUrl, (targetRef) =>
                legacyDeclarativeExportPgDelta(ctx, {
                  sourceRef: shadow.sourceUrl,
                  targetRef,
                  schema: flags.schema,
                  formatOptions,
                }),
              ),
            (shadow) =>
              legacyRemoveShadowDatabase(declSpawner, {
                containerId: shadow.container,
                secretDirId: shadow.secretDirId,
                workdir: cliConfig.workdir,
              }),
          );
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

        // Go's `EXPERIMENTAL` structured-dump branch (`pull.go:49-61`) stays
        // delegated to Go. pg_dump itself is now native (used by the initial-migra
        // path below), but this branch also calls `format.WriteStructuredSchemas`
        // (`cli-go/internal/migration/format/format.go:99`), which parses every
        // dumped statement with a PostgreSQL DDL AST parser (`multigres`, ~50 node
        // types) to route objects into structured files. No Postgres DDL parser
        // exists in TS yet, so porting it is tracked separately; until then the
        // experimental path delegates the whole pull to Go.
        if (delegatesExperimentalPull) {
          // Go's structured-dump path returns before writing a migration or
          // touching schema_migrations (`pull.go:49-61`), so no history repair.
          yield* delegatePull(usePgDeltaDiff ? "pg-delta" : "migra", {
            remoteHistoryUpdated: false,
          });
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
        const pullSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const pullRuntimeInfo = yield* RuntimeInfo;
        const pullNetworkIdFlag = yield* LegacyNetworkIdFlag;
        const pullLocalInputs = yield* legacyBuildLocalDbContainerInputs(
          pullSpawner,
          cliConfig.workdir,
          pullNetworkIdFlag,
          pullRuntimeInfo.platform,
          debug,
          // So the shadow's own container spec reflects the matching `[remotes.<ref>]`
          // override, same as `toml` above — see `diff.handler.ts`'s identical call site.
          connType === "linked" ? linkedRef : undefined,
          // `toml`'s OWN remote-override-key tracking (same matched block) — so a
          // remote-set bootstrap field isn't re-overridden by a conflicting `SUPABASE_*`
          // env var when deriving the shadow's container spec.
          toml.remoteOverrideKeys,
        );
        // Go's `diffRemoteSchema` retries the ENTIRE `diff.DiffDatabase` call — shadow
        // provisioning included — against the pooler config on an IPv6 failure, not
        // just the diff step (`internal/db/pull/pull.go:176-190`): `DiffDatabase`
        // prints "Creating shadow database..." and runs `PrepareShadowSource` before
        // ever touching the remote/target connection (`internal/db/diff/diff.go:211-
        // 217`), so a pooler retry re-prints the creation/diff banners and provisions
        // + tears down a second, fresh shadow. Mirror that observable behavior by
        // wrapping the full prepare-shadow-then-diff operation in the retried
        // closure — each attempt gets its own shadow and its own teardown — instead
        // of provisioning one shadow and only retrying the diff engine against it.
        const runShadowDiff = (targetRef: string) =>
          Effect.gen(function* () {
            // Go's `DiffDatabase` emits these to stderr before provisioning + diffing
            // (`internal/db/diff/diff.go:212,223-226`); `legacyPrepareShadowSource`
            // doesn't print its own banner, so the pull handler emits it itself to
            // match the migration-style `db pull` output.
            yield* output.raw("Creating shadow database...\n", "stderr");
            // Resolved AFTER the banner, inside the retried closure — Go's
            // `CreateShadowDatabase` → `utils.DockerStart` (where the postgres image is
            // resolved/pulled) runs inside `PrepareShadowSource`, which is itself called
            // after `DiffDatabase` prints "Creating shadow database..." above, and is
            // re-run fresh on every pooler-retry attempt (see the comment above). Resolving
            // it earlier, outside this closure (as `diff.handler.ts`'s sibling call site does
            // NOT do — it also resolves after its own banner), would both print nothing on an
            // image-resolution failure before the banner and skip re-resolving it on retry.
            const resolvedPullShadowImage = yield* pullLocalInputs.resolvePostgresImage;
            // Mirror Go's `DiffDatabase` → `PrepareShadowSource(ctx, schema,
            // utils.IsLocalDatabase(config), …)` (`internal/db/diff/diff.go:213`): a
            // local target with declarative schema files gets a second
            // `contrib_regression` shadow returned as the target override.
            //
            // `Effect.acquireUseRelease`, NOT a separate `yield* legacyPrepareShadowSource(...)`
            // followed by a later `.pipe(Effect.ensuring(...))` (see `diff.handler.ts`'s
            // identical call site for the full rationale): the latter shape leaves a gap
            // between the shadow's successful creation and the `Effect.ensuring` finalizer
            // actually being attached, where a fiber interrupt would skip
            // `legacyRemoveShadowDatabase` and leak the shadow container + its staged secret
            // directory. `acquireUseRelease` registers the release finalizer in the same
            // uninterruptible continuation the acquire resolves into, matching Go's `defer
            // DockerRemove` immediately after successful preparation (review: PRRT_kwDOErm0O86XDr4Y).
            return yield* Effect.acquireUseRelease(
              legacyPrepareShadowSource(pullSpawner, {
                ...legacyShadowRunInputFromLocalContainerInputs(
                  pullLocalInputs,
                  resolvedPullShadowImage,
                  toml,
                  fs,
                  path,
                ),
                targetLocal: resolved.isLocal,
                usePgDelta: usePgDeltaDiff,
                // `toml.schemaPathPatterns`, NOT `pullLocalInputs.context.config.db.migrations.
                // schema_paths`: the latter is the raw `@supabase/config` field, which never
                // applies `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` (`@supabase/config` has no
                // viper-`AutomaticEnv` equivalent) — `toml` above (`legacyReadDbToml`) already
                // resolves that env override the same way Go's `utils.Config.Db.Migrations.
                // SchemaPaths` does (review: PRRT_kwDOErm0O86XDr4S).
                schemaPaths: toml.schemaPathPatterns,
                pgDelta: toml.pgDelta,
                ctx,
              }),
              (shadow) =>
                Effect.gen(function* () {
                  // Use the declarative target override when present (Go substitutes it
                  // for the diff target, `diff.go:196-197`); for remote pulls it's
                  // undefined, so this is this attempt's resolved target URL.
                  const target = shadow.targetUrlOverride ?? targetRef;
                  yield* output.raw(
                    diffSchema.length > 0
                      ? `Diffing schemas: ${diffSchema.join(",")}\n`
                      : "Diffing schemas...\n",
                    "stderr",
                  );
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
                      targetRef: target,
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
                    target,
                    schema: diffSchema,
                    connectOptions: { isLocal: resolved.isLocal, dnsResolver },
                  });
                  return { sql, files: undefined, capture: undefined };
                }),
              (shadow) =>
                legacyRemoveShadowDatabase(pullSpawner, {
                  containerId: shadow.container,
                  secretDirId: shadow.secretDirId,
                  workdir: cliConfig.workdir,
                }),
            );
          });
        const diffOutcome = yield* withPoolerFallback(targetUrl, runShadowDiff);

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
