import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../shared/legacy/global-flags.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
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
import {
  legacyBuildLocalDbContainerInputs,
  type LegacyLocalDbContainerInputs,
} from "../../../shared/db-bootstrap/local-container-inputs.ts";
import {
  legacyCreateShadowDatabase,
  legacyPrepareRawShadow,
  legacyRemoveShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyUpdateDeclarativeSchemaPathsConfig,
  legacyWarnPreservedUnmanagedDeclarativeFiles,
  legacyWriteDeclarativeSchemas,
} from "../shared/legacy-pgdelta.write.ts";
import {
  legacyParseBoolEnv,
  legacyResolveDeclarativeFromArgs,
  legacyResolvePullDiffEngine,
  legacySchemaPathsTransitionWarning,
  legacyShouldUsePgDelta,
} from "../../../shared/legacy-diff-engine.ts";
import {
  legacyWarnAutoExposeDrift,
  legacyWarnAutoExposeDriftAgainstLinkedProject,
} from "../../../shared/legacy-auto-expose-drift.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import { legacyWritePgDeltaMigrations } from "../shared/legacy-pgdelta-migrations.write.ts";
import {
  type LegacyDumpOptions,
  legacyBuildSchemaDumpEnv,
} from "../../../shared/legacy-pg-dump.env.ts";
import { legacyStreamPgDump } from "../../../shared/legacy-pg-dump.run.ts";
import {
  legacyEmitPoolerFallbackWarning,
  legacyIsDirectLinkedHost,
  legacyRunWithPoolerFallback,
} from "../shared/legacy-pooler-fallback.ts";
import { legacyDumpSchemaScript } from "../../../shared/legacy-pg-dump.scripts.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";
import { legacyDebugBundleMessage, legacyFormatDebugId } from "../shared/legacy-debug-bundle.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDatabaseEndpoint,
} from "../shared/legacy-pgdelta-engine.service.ts";
import {
  type LegacyPgDeltaContext,
  legacyIsPgDeltaDebugEnabled,
  legacyResolvePgDeltaProjectId,
} from "../../../shared/legacy-pgdelta.ts";
import { legacySaveEmptyPgDeltaPullDebug } from "./pull.debug.ts";
import { legacyPrepareShadowSource } from "../shared/legacy-shadow-source.ts";
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

// Established output contract; ends with a `.`.
const DEPRECATION_LINE =
  "Flag --use-pg-delta has been deprecated, use --declarative with [experimental.pgdelta] enabled = true in your config.toml instead.";

/**
 * Explains the in-sync non-zero exit. Go prints its generic
 * `Try rerunning the command with --debug…` footer here, which reads like a
 * crash for what is really a finding; the message and exit code stay Go-identical
 * (see `docs/go-cli-divergences.md`).
 */
const IN_SYNC_SUGGESTION =
  "The remote database is already in sync with your local migrations — nothing to pull.";

/** Migration-file mode for the initial pg_dump seed. */
const MIGRATION_FILE_MODE = 0o644;

// `--experimental`'s structured-dump `db pull` mode (Go's `format.WriteStructuredSchemas`)
// stays delegated to the bundled Go binary rather than retired or ported: Go's formatter
// routes DDL through a PostgreSQL AST parser (`multigres`) with no TS equivalent.
// `--declarative` (native pg-delta export) covers the same per-object-files outcome via
// catalog introspection for schema objects, though its output tree and cluster-object
// coverage differ (see SIDE_EFFECTS.md), so this mode is on a deprecation path — the same
// decision `db diff --use-pg-schema` makes (keep delegating, flag for removal), NOT the
// same OUTPUT: Go's `db diff --use-pg-schema` prints its own experimental warning from
// inside the delegated child, so the TS parent deliberately stays silent there. Go's `db
// pull --experimental` prints nothing of the kind — this line is a TS-fork-only,
// forward-looking addition with no Go counterpart (unlike `DEPRECATION_LINE` below, which
// byte-matches pflag's `MarkDeprecated`). Printed to stderr right alongside the existing
// `--use-pg-delta` deprecation line below.
const EXPERIMENTAL_STRUCTURED_DUMP_DEPRECATION_LINE =
  "The --experimental structured-dump mode for `db pull` is deprecated and will be removed in a future release. Use --declarative instead to pull the remote schema as per-object files.";

/** Rebuilds the `db pull` argv for the Go-delegated `--experimental` structured-dump branch. */
const rebuildDelegateArgs = (flags: LegacyDbPullFlags): Array<string> => {
  const args = ["db", "pull"];
  // Called only once the parent has already decided to delegate (`legacyResolveExperimentalWithProjectEnv`'s
  // last-occurrence-wins argv rescan resolved `true`), so state it explicitly rather than
  // relying on root's own `globalArgs` forwarding: root derives `--experimental` from the
  // PARSED `LegacyExperimentalFlag` (first-occurrence-wins, e.g. `Param.ts`'s
  // `providedValues[0]`), which can disagree with the rescan on a repeated flag
  // (`--experimental=false --experimental=true` resolves `true` here but `false` there). A
  // duplicate `--experimental` is harmless — pflag's own last-`Set()`-wins rule still applies
  // in the delegated child.
  args.push("--experimental");
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
  // `--use-pg-delta` to one last-occurrence-wins variable (`cmd/db.go:531-532`), so
  // replaying only the truthy alias (e.g. forwarding `--declarative` for
  // `db pull --declarative --use-pg-delta=false`) would flip the child back to
  // declarative export. Forward an explicit `--declarative=false` when an alias was
  // passed so the child resolves migration mode deterministically. Never forward
  // `--use-pg-delta`: the parent already prints its deprecation line and Go's
  // MarkDeprecated (`cmd/db.go:533`) would re-print it. The "alias present" guard
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
  const pgDeltaEngine = yield* LegacyPgDeltaEngine;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const debug = yield* LegacyDebugFlag;
  const cliArgs = yield* CliArgs;

  // `--yes` OR `SUPABASE_YES`. The project `.env` is loaded before the migration
  // history prompt, so a `SUPABASE_YES` set only in `supabase/.env` auto-confirms
  // the native initial-migra history repair too.
  const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
  const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
  // `EXPERIMENTAL` resolves from *either* the global `--experimental` pflag or
  // `SUPABASE_EXPERIMENTAL`, with the same bound-pflag-wins-over-env precedence
  // `legacyResolveExperimentalWithProjectEnv` already implements for `db
  // reset`/declarative generate/sync — reuse it here instead of re-deriving the
  // gate. Resolved once up front, same as `yes` above; declarative mode ignores it
  // below.
  const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnv);

  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader in `legacyGetRegistryImageUrl` (the pg_dump
    // seed + migra/pg-delta diff images), reverted when this scope closes.
    yield* legacyApplyProjectEnv(projectEnv);
    const name = Option.getOrElse(flags.name, () => "remote_schema");
    // `--declarative` and the deprecated `--use-pg-delta` both bind to the same
    // `useDeclarative` outcome, so when BOTH are passed the LAST occurrence in
    // argv wins (e.g. `--declarative --use-pg-delta=false` => migration mode). The
    // parsed Options don't carry order, so for the both-present case this replays
    // the last-occurrence rule off the raw argv; OR-ing the two would instead
    // diverge on conflicting values. When only one (or neither) is present, its
    // Option value already equals its argv value, so the OR is exact.
    const useDeclarative =
      Option.isSome(flags.declarative) && Option.isSome(flags.usePgDelta)
        ? (legacyResolveDeclarativeFromArgs(cliArgs.args) ?? false)
        : Option.getOrElse(flags.declarative, () => false) ||
          Option.getOrElse(flags.usePgDelta, () => false);
    if (Option.isSome(flags.usePgDelta)) {
      yield* output.raw(`${DEPRECATION_LINE}\n`, "stderr");
    }
    // Declarative mode never delegates. Computed once here — reused below for both
    // the deprecation print and the branch that actually delegates — so the two
    // can never drift.
    const delegatesExperimentalPull = !useDeclarative && experimental;
    if (delegatesExperimentalPull) {
      yield* output.raw(`${EXPERIMENTAL_STRUCTURED_DUMP_DEPRECATION_LINE}\n`, "stderr");
    }

    // Mutually exclusive flag groups: `[db-url linked local]`, `[declarative
    // diff-engine]`, `[use-pg-delta diff-engine]`. "set" means the flag was
    // explicitly passed.
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

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new LegacyDbPullTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // `--experimental`'s structured-dump mode delegates the whole pull to the
    // bundled Go binary via `rebuildDelegateArgs`, which cannot forward a
    // TS-only flag: the delegated child re-resolves the workdir's own linked
    // ref itself (Go's `LoadProjectRef`, `internal/utils/flags/
    // project_ref.go:54-76`), so `--project-ref` would be silently dropped and
    // the child would target the wrong project — the exact wrong-project
    // hazard the guard above exists to prevent for the native paths. Passing
    // `SUPABASE_PROJECT_ID` through the child's env instead was considered and
    // rejected: that variable ALSO overrides the child's own `Config.ProjectId`
    // (and therefore its shadow/edge-runtime container labels,
    // `pkg/config/config.go:563-570`) — a coupling `--project-ref` deliberately
    // avoids (see `LegacyProjectRefResolver`'s use below). Mirrors
    // `diff.handler.ts`'s identical `--use-pg-schema` guard.
    if (Option.isSome(flags.projectRef) && delegatesExperimentalPull) {
      return yield* Effect.fail(
        new LegacyDbPullTargetFlagsError({
          message:
            "--project-ref is not supported with the --experimental structured-dump pull; use --declarative instead",
        }),
      );
    }

    // Go's `ParseDatabaseConfig` resolves the linked ref via the hard `LoadProjectRef`, THEN
    // reads the `[remotes.<ref>]`-merged config (`LoadConfig`, which prints "Loading config
    // override" unconditionally the moment a remote matches — `pkg/config/config.go:605`) —
    // and only AFTER that calls `NewDbConfigWithPassword`, which does the actual connection
    // work (TCP probe / temp-role mint over the Management API, `internal/utils/flags/
    // db_url.go:87-97`). Pre-load the ref and re-read config here, before `resolver.resolve()`
    // below, so the override print (and the merged-config validation) happen in that same
    // order. Previously this read — and its print — ran AFTER `resolve()`, so a `resolve()`
    // failure (bad password, unreachable host, network-ban lookup, …) left the user never
    // knowing which `[remotes.*]` block had matched (review: PRRT_kwDOErm0O86XHvYl). `--local`/
    // `--db-url` never merge a remote block, so only the linked path pre-resolves a ref.
    let linkedRef: string | undefined;
    if (connType === "linked") {
      const projectRefResolver = yield* LegacyProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      // Cache the ref the moment it's known, not after `toml`/`localInputs` below (both
      // fallible) resolve: the project cache should still be written even when a LATER step
      // (config validation, connection, the pull itself) fails, so this is set right after
      // the ref resolves rather than only after `toml`/`localInputs`/`resolver.resolve()` all
      // succeed (`diff.handler.ts`'s identical fix).
      linkedRefForCache = linkedRef;
    }
    const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef);
    if (toml.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${toml.appliedRemote}]\n`, "stderr");
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    // Validate native shadow inputs before target resolution performs remote side effects.
    const localInputs: Option.Option<LegacyLocalDbContainerInputs> = delegatesExperimentalPull
      ? Option.none()
      : Option.some(
          yield* legacyBuildLocalDbContainerInputs(
            spawner,
            cliConfig.workdir,
            networkIdFlag,
            runtimeInfo.platform,
            debug,
            // So the shadow's own container spec reflects the matching `[remotes.<ref>]`
            // override, same as `toml` above — see `diff.handler.ts`'s identical call site.
            connType === "linked" ? linkedRef : undefined,
            // `toml`'s OWN remote-override-key tracking (same matched block) — so a
            // remote-set bootstrap field isn't re-overridden by a conflicting `SUPABASE_*`
            // env var when deriving the shadow's container spec.
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
    const targetUrl = legacyToPostgresURL(resolved.conn);
    const ctx: LegacyPgDeltaContext = {
      // `SUPABASE_PROJECT_ID` env override wins, then config.toml's `project_id`, then
      // the workdir basename fallback, with the matched `[remotes.<ref>]` block's own
      // `project_id` (`toml.projectId`, already gated on `remoteOverrideKeys` by
      // `legacyReadDbToml`) suppressing the raw env argument on the linked path — see
      // that helper's own doc comment, and `diff.handler.ts`'s identical call site.
      projectId: legacyResolvePgDeltaProjectId(cliConfig.projectId, toml, cliConfig.workdir),
      cwd: cliConfig.workdir,
      npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
      denoVersion: toml.denoVersion,
      projectEnv: toml.projectEnv,
    };
    const formatOptions = Option.getOrElse(toml.pgDelta.formatOptions, () => "");

    // A linked direct connection may need the IPv4 transaction pooler from Docker.
    const targetEndpoint: LegacyPgDeltaDatabaseEndpoint = {
      kind: "database",
      ref: targetUrl,
      connection: resolved.conn,
      connectOptions: { isLocal: resolved.isLocal, dnsResolver },
    };
    const withPoolerFallback = <A, E extends { readonly message: string }, R>(
      directTarget: LegacyPgDeltaDatabaseEndpoint,
      attempt: (target: LegacyPgDeltaDatabaseEndpoint) => Effect.Effect<A, E, R>,
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
              // A pooler resolution failure is treated as "no fallback" (re-fail the
              // ORIGINAL diff error), not surfaced as its own error.
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
                yield* legacyEmitPoolerFallbackWarning(resolved.conn.host);
                return yield* attempt({
                  kind: "database",
                  ref: legacyToPostgresURL(pooler.value),
                  connection: pooler.value,
                  connectOptions: { isLocal: false, dnsResolver },
                });
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
    const usesPgDeltaNext = usePgDeltaDiff && pgDeltaEngine.implementation === "next";

    // Runs the Go-delegated `--experimental` structured dump (still delegated, see
    // `EXPERIMENTAL_STRUCTURED_DUMP_DEPRECATION_LINE` above for why). In machine-output
    // mode the child's stdout is captured and a structured envelope is emitted instead,
    // so scripted callers get valid JSON rather than the Go child's human output on
    // stdout (stdout is payload-only in machine mode). The child is run with a
    // non-TTY stdin (`"ignore"`) so any prompt takes its default without blocking the
    // JSON caller. The EXPERIMENTAL structured dump returns before writing a migration or
    // touching `schema_migrations`, so `remoteHistoryUpdated` is `false`; `schemaWritten`
    // stays `null` — the child owns the write and doesn't surface the path on stdout.
    const delegatePull = (
      engine: "migra" | "pg-delta",
      opts: { readonly remoteHistoryUpdated: boolean },
    ) =>
      Effect.gen(function* () {
        const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
        if (output.format !== "text") {
          yield* proxy.execCapture(rebuildDelegateArgs(flags), {
            env,
            stdin: "ignore",
            suppressChildTelemetry: true,
          });
          yield* output.success("Schema pulled.", {
            declarative: false,
            schemaWritten: null,
            remoteHistoryUpdated: opts.remoteHistoryUpdated,
            engine,
          });
          return;
        }
        yield* proxy.exec(rebuildDelegateArgs(flags), { env, suppressChildTelemetry: true });
      });

    // Connectivity check, run before dialing.
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Local vs remote keyed off the resolver's `isLocal`. The delegated
        // `--experimental` branch skips this print: the Go child's own connectivity
        // check already prints the line, so the parent printing too would double it.
        // (The parent still dials below, so a parent-side connect failure on the
        // delegate path surfaces without the line; pre-existing delegate behavior.)
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

        // Best-effort auto-expose drift check against the linked project, over the
        // session just opened — see `legacy-auto-expose-drift.ts` for the probe and
        // the warning contract. A local target pulls from a locally provisioned
        // database whose baseline the same drift poisons, so it probes the linked
        // project too (quietly skipped when the workdir isn't linked). Skipped on
        // the delegated `--experimental` path, where the Go child owns all
        // user-facing output.
        if (!delegatesExperimentalPull) {
          if (connType === "linked" && !resolved.isLocal) {
            yield* legacyWarnAutoExposeDrift(session, toml.baseline.apiAutoExposeNewTables);
          } else if (resolved.isLocal) {
            yield* legacyWarnAutoExposeDriftAgainstLinkedProject(dnsResolver);
          }
        }

        // Declarative export path.
        if (useDeclarative) {
          yield* output.raw("Preparing declarative schema export using pg-delta...\n", "stderr");
          const declarativeDirRel = legacyResolveDeclarativeDir(path, toml.pgDelta);
          const declarativeDir = path.resolve(cliConfig.workdir, declarativeDirRel);
          const exportSchema = (
            target: LegacyPgDeltaDatabaseEndpoint,
            source?: LegacyPgDeltaDatabaseEndpoint,
          ) =>
            pgDeltaEngine.exportDeclarativeSchema({
              context: ctx,
              ...(source !== undefined ? { source } : {}),
              target,
              schema: flags.schema,
              formatOptions,
              ...(connType === "linked" && linkedRef !== undefined
                ? { projectRef: linkedRef }
                : {}),
              debug: legacyIsPgDeltaDebugEnabled(),
              strictCoverage: flags.strictCoverage,
              noCache: false,
            });
          // Legacy export owns an interrupt-safe empty-shadow lifecycle; next reads the target.
          const exported =
            pgDeltaEngine.implementation === "next"
              ? yield* withPoolerFallback(targetEndpoint, (target) => exportSchema(target))
              : yield* Effect.gen(function* () {
                  const declLocalInputs = Option.getOrThrow(localInputs);
                  const resolvedDeclShadowImage = yield* declLocalInputs.resolvePostgresImage;
                  // The legacy exporter still needs the historical empty baseline. Keep it
                  // native and workflow-owned; the bundled next exporter reads only target.
                  const rawShadowInput = legacyShadowRunInputFromLocalContainerInputs(
                    declLocalInputs,
                    resolvedDeclShadowImage,
                    toml,
                    fs,
                    path,
                  );
                  return yield* Effect.acquireUseRelease(
                    legacyCreateShadowDatabase(spawner, rawShadowInput),
                    (handle) =>
                      Effect.gen(function* () {
                        const shadow = yield* legacyPrepareRawShadow(
                          spawner,
                          handle,
                          rawShadowInput,
                        );
                        return yield* withPoolerFallback(targetEndpoint, (target) =>
                          exportSchema(target, {
                            kind: "database",
                            ref: shadow.sourceUrl,
                            connectOptions: { isLocal: true, dnsResolver: "native" },
                          }),
                        );
                      }),
                    (handle) => legacyRemoveShadowDatabase(spawner, handle.containerId),
                  );
                });
          const written = yield* legacyWriteDeclarativeSchemas(
            fs,
            path,
            declarativeDir,
            exported,
          ).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
          yield* legacyWarnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
          // Preserve the legacy schema_paths workflow only when pg-delta is disabled.
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
          // Prints the config's declarative_schema_path or the relative
          // `supabase/schemas` default — never the resolved absolute directory
          // (established output contract). The json payload below keeps the
          // absolute path for machine consumers.
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

        // Only next ignores schema_paths in favor of the migrations baseline.
        if (
          !delegatesExperimentalPull &&
          usesPgDeltaNext &&
          toml.schemaPaths !== undefined &&
          toml.schemaPaths.length > 0
        ) {
          yield* output.raw(legacySchemaPathsTransitionWarning, "stderr");
        }

        // Structured dump still delegates to Go's PostgreSQL DDL formatter.
        if (delegatesExperimentalPull) {
          // The structured-dump path returns before writing a migration or touching
          // schema_migrations, so no history repair.
          yield* delegatePull(usePgDeltaDiff ? "pg-delta" : "migra", {
            remoteHistoryUpdated: false,
          });
          return;
        }

        // Migration-file path.
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
        // Initial pull, migra engine: seed the migration file with a pg_dump of the
        // remote schema, then run the migra diff below as a second pass appended to
        // the same file, which captures default privileges / managed schemas pg_dump
        // can't emit. pg-delta initial pulls skip the dump: they diff against an
        // empty shadow, which already yields the full schema.
        const seededFromDump = sync.kind === "missing" && !usePgDeltaDiff;
        // Tracks whether the pg_dump seed wrote any bytes: an empty dump + empty diff
        // is "in sync", a non-empty dump is a valid initial migration on its own.
        let seedWroteBytes = false;

        // Built above, before `resolver.resolve()` (see that build's doc comment — it's what
        // used to run here, right before the initial-dump write below, but even that was still
        // after `resolver.resolve()`/`connection.connect()`). `Option.getOrThrow` is safe here:
        // this point is only reached after the `if (delegatesExperimentalPull) { …; return; }`
        // check above already returned, so `localInputs` was always built.
        const pullLocalInputs = Option.getOrThrow(localInputs);

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
          // Default dump options: no schema filter (so the internal-schema exclude
          // list applies) and comments stripped.
          const dumpEnvOpt: LegacyDumpOptions = {
            schema: [],
            keepComments: false,
            excludeTable: [],
            columnInsert: false,
          };
          const toDumpOpenError = (cause: { readonly message: string }) =>
            new LegacyDbPullDumpError({
              message: `failed to open dump file: ${cause.message}`,
              fileOpen: true,
            });
          // Stream pg_dump → migration file, (re)truncating per attempt so a pooler
          // retry leaves only the successful attempt's bytes.
          const runSchemaDump = (target: LegacyPgConnInput) => {
            // Reset per attempt alongside the truncate, zeroing the file before the
            // pooler retry. In-sync is decided from the file on disk, so only the
            // final successful attempt's bytes count: a partial direct write that
            // then IPv6-fails must not leave this flag stuck true, or an empty pooler
            // retry would be mis-reported as a schema write.
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
                        projectEnvValues: projectEnv,
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
          // Prints this once, before the pooler-fallback retry.
          yield* output.raw("Dumping schema from remote database...\n", "stderr");
          // Container-level IPv6 → IPv4-pooler retry, shared with `db dump`. `db pull`
          // prints "Dumping…" once above, so it passes `Effect.void` for the retry
          // re-print.
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
                  linkedProjectRef: flags.projectRef,
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
        // For the initial pull (no local migrations) the schema filter is ignored.
        const diffSchema = sync.kind === "missing" ? [] : flags.schema;
        // Pooler fallback retries the complete shadow-and-diff attempt.
        const runShadowDiff = (targetEndpoint: LegacyPgDeltaDatabaseEndpoint) =>
          Effect.gen(function* () {
            yield* output.raw("Creating shadow database...\n", "stderr");
            const resolvedPullShadowImage = yield* pullLocalInputs.resolvePostgresImage;
            // Legacy may substitute a declarative target; next always uses the live target.
            const migrationMode: "legacy" | "pgdelta-next" = usesPgDeltaNext
              ? "pgdelta-next"
              : "legacy";
            const shadowInput = {
              ...legacyShadowRunInputFromLocalContainerInputs(
                pullLocalInputs,
                resolvedPullShadowImage,
                toml,
                fs,
                path,
              ),
              targetLocal: resolved.isLocal,
              usePgDelta: usePgDeltaDiff,
              migrationMode,
              // `toml.schemaPathPatterns`, NOT `pullLocalInputs.context.config.db.migrations.
              // schema_paths`: the latter is the raw `@supabase/config` field, which never
              // applies `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` — `toml` above
              // (`legacyReadDbToml`) already resolves that env override.
              schemaPaths: toml.schemaPathPatterns,
              pgDelta: toml.pgDelta,
              ctx,
            };
            // Register cleanup atomically with shadow acquisition.
            return yield* Effect.acquireUseRelease(
              legacyCreateShadowDatabase(spawner, shadowInput),
              (handle) =>
                Effect.gen(function* () {
                  const shadow = yield* legacyPrepareShadowSource(spawner, handle, shadowInput);
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
                      debug: legacyIsPgDeltaDebugEnabled(),
                      strictCoverage: flags.strictCoverage,
                    });
                  }
                  const sql = yield* legacyDiffMigra(ctx, {
                    source: shadow.sourceUrl,
                    target,
                    schema: diffSchema,
                    connectOptions:
                      shadow.targetUrlOverride === undefined
                        ? targetEndpoint.connectOptions
                        : { isLocal: true, dnsResolver },
                  });
                  return { sql, files: undefined, debug: undefined };
                }),
              (handle) => legacyRemoveShadowDatabase(spawner, handle.containerId),
            );
          });
        const diffOutcome = yield* withPoolerFallback(targetEndpoint, runShadowDiff);

        const out = diffOutcome.sql;
        const diffEmpty = out.trim().length === 0;
        // A non-initial pull with an empty diff is "in sync" and fails. The
        // initial-migra path seeded the file with a pg_dump above, so its empty second
        // pass is swallowed and falls through to the shared tail below.
        if (diffEmpty && !seededFromDump) {
          // Preserve the legacy empty-diff debug bundle contract.
          if (pgDeltaEngine.implementation === "legacy" && diffOutcome.debug !== undefined) {
            const debugDir = yield* legacySaveEmptyPgDeltaPullDebug({
              ctx,
              conn: resolved.conn,
              targetUrl,
              sourceCatalog: diffOutcome.debug.sourceSnapshot,
              pgDeltaStderr: diffOutcome.debug.stderr,
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
                  suggestion: IN_SYNC_SUGGESTION,
                }),
              );
            }
          }
          if (
            pgDeltaEngine.implementation === "next" &&
            diffOutcome.debug?.directory !== undefined
          ) {
            yield* output.raw(legacyDebugBundleMessage(diffOutcome.debug.directory), "stderr");
            return yield* Effect.fail(
              new LegacyDbPullInSyncError({
                message: `No schema changes found (debug bundle: ${diffOutcome.debug.directory})`,
                suggestion: IN_SYNC_SUGGESTION,
              }),
            );
          }
          return yield* Effect.fail(
            new LegacyDbPullInSyncError({
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
          // pg-delta: one migration file per plan unit via the shared writer. A
          // single-unit plan (the common case) keeps the exact `<ts>_<name>.sql`
          // filename; multi-unit plans append the unit name and give each file a
          // strictly increasing timestamp so execution + migration-history order stay
          // stable. The full set is collision-checked against existing migrations and
          // each file is written exclusively so a pre-existing migration is never
          // overwritten. Empty plans are handled by the `diffEmpty` in-sync branch
          // above, so `planFiles` is non-empty here.
          const planFiles = diffOutcome.files ?? [];
          const writtenUnits = yield* legacyWritePgDeltaMigrations(fs, path, {
            workdir: cliConfig.workdir,
            baseMillis: nowMillis,
            name,
            files: planFiles.map((file) => ({
              name: file.name,
              suffix: file.suffix,
              sql: file.sql,
              transactionMode: file.transactionMode,
            })),
          }).pipe(
            Effect.mapError((cause) => new LegacyDbPullWriteError({ message: cause.message })),
          );
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

          // A dump that produced nothing followed by an empty diff leaves the file
          // empty → in sync.
          if (seededFromDump && !seedWroteBytes && diffEmpty) {
            return yield* Effect.fail(
              new LegacyDbPullInSyncError({
                message: "No schema changes found",
                suggestion: IN_SYNC_SUGGESTION,
              }),
            );
          }
          writtenMigrations.push({ path: migrationPath, version: timestamp });
        }

        for (const written of writtenMigrations) {
          // Prints the workdir-relative path (established output contract).
          // Display-only — `writtenMigrations` keeps absolute paths for file I/O
          // and the json payload.
          yield* output.raw(
            `Schema written to ${legacyBold(path.relative(cliConfig.workdir, written.path))}\n`,
            "stderr",
          );
        }

        // Prompt to update the remote migration history table. Returns the default
        // (`true`) on `--yes`, on a non-interactive stdin, or on any prompt error — it
        // never fails the command.
        let remoteHistoryUpdated = false;
        const updateHistoryTitle = "Update remote migration history table?";
        // Honors `--yes`, scans piped stdin on a non-TTY before falling back to the
        // default, and otherwise prompts on a real TTY.
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
    // Scope the `SUPABASE_INTERNAL_IMAGE_REGISTRY`-from-`.env` apply above to this
    // command run: `legacyApplyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
