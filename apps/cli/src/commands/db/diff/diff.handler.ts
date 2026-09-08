import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  DebugFlag,
  DnsResolverFlag,
  NetworkIdFlag,
} from "../../../command-internal/global-flags.ts";
import { GoProxy } from "../../../command-internal/go-proxy.service.ts";
import { detectGitBranch } from "../../../shared/git/git-branch.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { aqua, yellow } from "../../../command-internal/colors.ts";
import {
  applyProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
  type DbTomlValues,
} from "../../../command-internal/db-config.toml-read.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConnType } from "../../../command-internal/db-target-flags.ts";
import { getHostname } from "../../../command-internal/hostname.ts";
import { makeDir } from "../../../command-internal/make-dir.ts";
import type { PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { toPostgresURL } from "../../../command-internal/postgres-url.ts";
import { schemaToCsvField } from "../../../command-internal/schema-flags.ts";
import { findDropStatements } from "../../../command-internal/sql-split.ts";
import { buildLocalDbContainerInputs } from "../../../command-internal/db-bootstrap/local-container-inputs.ts";
import { isLocalDbRunning } from "../../../command-internal/db-bootstrap/local-db-running.ts";
import { waitForHealthyServices } from "../../../command-internal/db-bootstrap/health-check.ts";
import { withShadowDatabase } from "../../../command-internal/db-bootstrap/shadow-cache.ts";
import {
  createShadowDatabase,
  migrateShadowDatabase,
  removeShadowDatabase,
  shadowRunInputFromLocalContainerInputs,
} from "../../../command-internal/db-bootstrap/shadow-database.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  resolveDiffEngine,
  schemaPathsTransitionWarning,
  shouldUsePgDelta,
} from "../../../command-internal/diff-engine.ts";
import {
  formatMigrationTimestamp,
  getMigrationPath,
} from "../../../command-internal/migration-file.ts";
import { diffMigra } from "../shared/migra.ts";
import {
  PgDeltaEngine,
  type PgDeltaDatabaseEndpoint,
  type PgDeltaDiffResult,
  type PgDeltaEndpoint,
  type PgDeltaRenderedFile,
} from "../shared/pgdelta-engine.service.ts";
import { LoadPgDeltaSqlFiles } from "../shared/pgdelta-files.ts";
import { writePgDeltaMigrations } from "../shared/pgdelta-migrations.write.ts";
import {
  type PgDeltaContext,
  isPgDeltaDebugEnabled,
  resolvePgDeltaProjectId,
} from "../../../command-internal/pgdelta.ts";
import { prepareShadowSource } from "../shared/shadow-source.ts";
import type { DbDiffFlags } from "./diff.command.ts";
import { classifyExplicitRef, unknownTargetMessage } from "./diff.explicit.ts";
import {
  DbDiffDbNotRunningError,
  DbDiffEngineConflictError,
  DbDiffExplicitFlagsError,
  DbDiffTargetFlagsError,
  DbDiffUnknownTargetError,
  DbDiffWriteError,
} from "./diff.errors.ts";
import { diffSchemaPgAdmin } from "./pgadmin-diff.ts";

const warnDiff = `WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ${aqua("supabase db reset")} to verify that the new migration does not generate errors.`;

// `--use-pg-schema` delegates to the bundled Go binary's in-process
// `stripe/pg-schema-diff` library, which has no TS/container equivalent (see
// SIDE_EFFECTS.md). The flag is deprecated in favor of the pg-delta engine.
// This warning is additive to (and prints before) the delegated child's own
// "experimental" warning, which it still prints unchanged.
const warnPgSchemaDeprecated = `${yellow("WARNING:")} "--use-pg-schema" is deprecated. Use the default pg-delta engine or the migra engine (--use-migra) instead.`;

const declarativeBaselineAdvisory = (declarativePath: string | null) => ({
  code: "DeclarativeSchemaNotUsedAsDiffBaseline",
  severity: "info",
  message: "Declarative schema files were not used as the db diff baseline.",
  context: {
    baseline: "supabase/migrations",
    declarativePath,
    fileFlagFiltersObjects: false,
  },
});

const declarativeBaselineNote = (displayPath: string) =>
  `Note: db diff -f uses supabase/migrations as its baseline. Declarative schema files in ${displayPath} are not part of that baseline. If migrations are empty or outdated, the generated migration may include existing declarative objects. -f names the migration; it does not filter objects.\n`;

/**
 * Rebuilds the `db diff` argv for the `--use-pg-schema` delegate path — the CLI's
 * sole remaining Go delegation on this command (the in-process
 * `stripe/pg-schema-diff` library has no TS/container equivalent; `--use-pgadmin`
 * is native). Flags stay flags (the Go-proxy channel-parity rule). The explicit
 * `--from`/`--to` and engine mutex are already handled before this runs, and the
 * mutex guarantees `--use-migra`/`--use-pgadmin`/`--use-pg-delta` are all unset
 * whenever this is reached, so it just forwards `--use-pg-schema` plus the
 * target / schema / file flags the user passed.
 */
const rebuildPgSchemaDelegateArgs = (flags: DbDiffFlags): Array<string> => {
  const args = ["db", "diff", "--use-pg-schema"];
  const pushTarget = (name: string, value: Option.Option<boolean>) => {
    // Target flags (linked/local) are *selectors*: Go's ParseDatabaseConfig keys
    // off `flag.Changed` before the value (`internal/utils/flags/db_url.go`), so a
    // Changed-but-false flag still selects that target. Forward whenever `Some`
    // (emitting `--flag=false` for `Some(false)`) so the child's `flag.Changed`
    // matches the parent's `Option.isSome`; otherwise the child falls through to a
    // different default target than the one the native path resolved.
    if (Option.isSome(value)) args.push(value.value ? `--${name}` : `--${name}=false`);
  };
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  pushTarget("linked", flags.linked);
  pushTarget("local", flags.local);
  if (Option.isSome(flags.file)) args.push("--file", flags.file.value);
  if (Option.isSome(flags.output)) args.push("--output", flags.output.value);
  // Re-encode each parsed schema as a CSV field so the Go child's pflag StringSlice
  // CSV parse doesn't re-split a comma-containing schema (e.g. `"tenant,one"`).
  for (const s of flags.schema) args.push("--schema", schemaToCsvField(s));
  return args;
};

export const dbDiff = Effect.fn("db.diff")(function* (flags: DbDiffFlags) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const pgDelta = yield* PgDeltaEngine;
  const proxy = yield* GoProxy;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* DnsResolverFlag;
  const debug = yield* DebugFlag;

  // Resolved linked ref, captured so the post-run finalizer caches the project
  // (GET /v1/projects/{ref}).
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // The engine flags (`use-migra use-pgadmin use-pg-schema use-pg-delta`) and the
    // target flags (`db-url linked local`) are each mutually exclusive groups;
    // "set" means the flag was explicitly passed (`Option.isSome`).
    const engineSet: Array<string> = [];
    if (Option.isSome(flags.useMigra)) engineSet.push("use-migra");
    if (Option.isSome(flags.usePgAdmin)) engineSet.push("use-pgadmin");
    if (Option.isSome(flags.usePgSchema)) engineSet.push("use-pg-schema");
    if (Option.isSome(flags.usePgDelta)) engineSet.push("use-pg-delta");
    if (engineSet.length > 1) {
      return yield* Effect.fail(
        new DbDiffEngineConflictError({
          message: `if any flags in the group [use-migra use-pgadmin use-pg-schema use-pg-delta] are set none of the others can be; [${[...engineSet].sort().join(" ")}] were all set`,
        }),
      );
    }
    const targetSet: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) targetSet.push("db-url");
    if (Option.isSome(flags.linked)) targetSet.push("linked");
    if (Option.isSome(flags.local)) targetSet.push("local");
    if (targetSet.length > 1) {
      return yield* Effect.fail(
        new DbDiffTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${[...targetSet].sort().join(" ")}] were all set`,
        }),
      );
    }

    // Config is read lazily per path, not unconditionally up front: reading the base
    // config before the ref is known would validate fields a `[remotes.<ref>]` block
    // overrides (db.major_version, deno_version, …), which would fail a linked diff
    // that should succeed. The delegate paths forward to the Go child (which loads
    // config itself), so they read nothing here.

    // Explicit `--from`/`--to` mode: both required, always pg-delta. An empty value
    // (a shell var expanding to `""`) counts as unset — `--from "" --to ""` falls
    // through to the normal diff, while `--from x --to ""` still errors.
    const from = Option.getOrElse(flags.from, () => "");
    const to = Option.getOrElse(flags.to, () => "");
    const fromSet = from.length > 0;
    const toSet = to.length > 0;
    if (fromSet || toSet) {
      if (!fromSet || !toSet) {
        return yield* Effect.fail(
          new DbDiffExplicitFlagsError({
            message: "must set both --from and --to when using explicit diff mode",
          }),
        );
      }
      // `--project-ref` never implies `--linked` and must not be silently
      // discarded — see push.handler.ts's identical guard for the full TS-only
      // rationale. Two exceptions in explicit mode: (1) `--from linked` /
      // `--to linked` resolves a linked ref (via `resolveRef`'s "linked" case
      // below) without any `--linked`/target flag at all, so the guard must
      // NOT fire there — only when NEITHER side is the literal ref "linked"
      // (e.g. plain `--project-ref X`, or `--from local --to migrations
      // --project-ref X`, where the flag genuinely goes unused). (2) a changed
      // `--linked` (even `--linked=false`) genuinely consumes `--project-ref`
      // via the preflight below, whose `preflightConnType` keys off
      // `Option.isSome(flags.linked)` regardless of the boolean's value — so
      // the guard must not fire whenever `--linked` was explicitly set.
      if (
        Option.isSome(flags.projectRef) &&
        Option.isNone(flags.linked) &&
        classifyExplicitRef(from) !== "linked" &&
        classifyExplicitRef(to) !== "linked"
      ) {
        return yield* Effect.fail(
          new DbDiffTargetFlagsError({
            message:
              "--project-ref only applies when targeting the linked project; use it with --linked, or --from/--to linked, in explicit mode",
          }),
        );
      }
      // `mergedLinkedRef` tracks the linked ref resolved so far (preflight or
      // cascade) so the config read below + a later `migrations` catalog export
      // merge the matching `[remotes.<ref>]` override. Undefined until a linked ref
      // resolves, so a `migrations` ref resolved before any linked ref uses base.
      let mergedLinkedRef: string | undefined;
      // The FIRST migrations endpoint resolved wins: the engine provisions a single
      // migrations shadow/catalog, and resolution-order (like `mergedLinkedRef` above)
      // says only refs resolved before that point should influence it.
      let migrationsToml: DbTomlValues | undefined;
      // The preflight target resolve below validates a changed target flag
      // (`--db-url bad` fails parsing) and is STATEFUL: a changed `--linked`
      // resolves the project ref and merges `[remotes.<ref>]`, so the explicit
      // `local`/`migrations` refs and `pgDeltaFormatOptions()` below see that
      // override. `--local`/`--db-url` load base config (no merge).
      if (Option.isSome(flags.dbUrl) || Option.isSome(flags.linked) || Option.isSome(flags.local)) {
        const preflightConnType: DbConnType = Option.isSome(flags.dbUrl)
          ? "db-url"
          : Option.isSome(flags.linked)
            ? "linked"
            : "local";
        const preflight = yield* resolver.resolve({
          dbUrl: flags.dbUrl,
          connType: preflightConnType,
          dnsResolver,
          password: Option.none(),
          linkedProjectRef: flags.projectRef,
        });
        if (preflightConnType === "linked") {
          const preflightRef = Option.getOrUndefined(preflight.ref ?? Option.none());
          if (preflightRef !== undefined) {
            linkedRefForCache = preflightRef;
            mergedLinkedRef = preflightRef;
          }
        }
      }
      // Read config once, after the preflight: the `[remotes.<ref>]`-merged config
      // when a changed `--linked` resolved a ref (so base config isn't validated
      // before the merge), else the base config.
      let cfg =
        mergedLinkedRef !== undefined
          ? yield* readDbToml(fs, path, cliSettings.workdir, mergedLinkedRef)
          : yield* readDbToml(fs, path, cliSettings.workdir);
      // Each ref resolves in order; the `linked` branch re-merges the matching
      // `[remotes.<ref>]` block so a later `local` ref read and the trailing
      // `pgDeltaFormatOptions()` see the override. Thread the merged config through.
      const resolveRef = (ref: string): Effect.Effect<PgDeltaEndpoint, unknown> =>
        Effect.gen(function* () {
          switch (classifyExplicitRef(ref)) {
            case "local": {
              const connection = {
                host: getHostname(),
                port: cfg.port,
                user: "postgres",
                password: cfg.password,
                database: "postgres",
              };
              return {
                kind: "database",
                ref: toPostgresURL(connection),
                connection,
                connectOptions: { isLocal: true, dnsResolver },
              } satisfies PgDeltaDatabaseEndpoint;
            }
            case "linked": {
              const resolved = yield* resolver.resolve({
                dbUrl: Option.none(),
                connType: "linked",
                dnsResolver,
                password: Option.none(),
                linkedProjectRef: flags.projectRef,
              });
              const ref2 = Option.getOrUndefined(resolved.ref ?? Option.none());
              if (ref2 !== undefined) {
                linkedRefForCache = ref2;
                mergedLinkedRef = ref2;
                cfg = yield* readDbToml(fs, path, cliSettings.workdir, ref2);
              }
              return {
                kind: "database",
                ref: toPostgresURL(resolved.conn),
                connection: resolved.conn,
                connectOptions: { isLocal: resolved.isLocal, dnsResolver },
              } satisfies PgDeltaDatabaseEndpoint;
            }
            case "migrations":
              // Preserve resolution order: the migrations shadow/catalog config must
              // reflect only refs resolved before THIS endpoint, same contract as the
              // `projectRef` spread below.
              migrationsToml ??= cfg;
              return {
                kind: "migrations",
                // Preserve resolution order: only refs resolved before this endpoint
                // influence the migrations shadow/catalog.
                ...(mergedLinkedRef !== undefined ? { projectRef: mergedLinkedRef } : {}),
              } satisfies PgDeltaEndpoint;
            case "url":
              return {
                kind: "database",
                ref,
                // The next engine parses arbitrary explicit URLs itself. They are
                // remote by default, matching Go's TLS-safe connection path.
                connectOptions: { isLocal: false, dnsResolver },
              } satisfies PgDeltaDatabaseEndpoint;
            default:
              return yield* Effect.fail(
                new DbDiffUnknownTargetError({ message: unknownTargetMessage(ref) }),
              );
          }
        });
      const source = yield* resolveRef(from);
      const desired = yield* resolveRef(to);
      const explicitCtx: PgDeltaContext = {
        projectId: resolvePgDeltaProjectId(cliSettings.projectId, cfg, cliSettings.workdir),
        cwd: cliSettings.workdir,
        denoVersion: cfg.denoVersion,
        projectEnv: cfg.projectEnv,
      };
      const result = yield* pgDelta.diffExplicit({
        context: explicitCtx,
        toml: migrationsToml ?? cfg,
        source,
        desired,
        schema: flags.schema,
        formatOptions: Option.getOrElse(cfg.pgDelta.formatOptions, () => ""),
        debug: isPgDeltaDebugEnabled(),
        strictCoverage: flags.strictCoverage,
      });
      // Explicit-mode output: `--output` file, or stdout with no trailing newline
      // (pg-delta ends each statement `;\n`). The file write is gated on the value
      // being non-empty, so an empty value (`--output="$OUT"` with OUT unset) falls
      // through to stdout rather than writing SQL into the project directory.
      if (Option.isSome(flags.output) && flags.output.value.length > 0) {
        const target = path.resolve(cliSettings.workdir, flags.output.value);
        // Create parent dirs first, so a nested `--output tmp/diff.sql` doesn't
        // fail when `tmp/` doesn't exist yet.
        yield* makeDir(fs, path.dirname(target)).pipe(
          Effect.mapError((cause) => new DbDiffWriteError({ message: cause.message })),
        );
        yield* fs
          .writeFileString(target, result.sql)
          .pipe(Effect.mapError((cause) => new DbDiffWriteError({ message: cause.message })));
        if (output.format !== "text") {
          yield* output.success("Diff written.", {
            diff: result.sql,
            file: target,
            schemas: flags.schema,
            engine: "pg-delta",
          });
        }
        return;
      }
      if (output.format !== "text") {
        yield* output.success("Diff generated.", {
          diff: result.sql,
          file: null,
          schemas: flags.schema,
          engine: "pg-delta",
        });
        return;
      }
      yield* output.raw(result.sql);
      return;
    }

    // `--use-pg-schema` delegates to the bundled Go binary's in-process
    // pg-schema-diff library, which has no TS/container equivalent. It is an
    // explicit engine selection that does not depend on config, so it
    // short-circuits before the target resolve. Disable the child's telemetry so
    // the single `cli_command_executed` event comes from this TS command's
    // instrumentation. `--use-pgadmin` does not short-circuit here: it needs the
    // same config validation, `[remotes.<ref>]` merge print, and linked temp-role
    // mint as the other native engines, so it resolves the target via the native
    // pgadmin branch further down, which reuses this function's own target resolve.
    const usePgAdmin = Option.getOrElse(flags.usePgAdmin, () => false);
    const usePgSchema = Option.getOrElse(flags.usePgSchema, () => false);
    // The pg-schema engine delegates to the bundled Go binary, whose `db diff`
    // never registered `--project-ref` — `rebuildPgSchemaDelegateArgs` cannot
    // forward it, so the flag would be silently dropped and the child would diff
    // the workdir's own linked ref: the exact wrong-project hazard the guards
    // below exist to prevent. Fail up front instead. (`--use-pgadmin` is native
    // as of CLI-1968 and honors `--project-ref` through this function's own
    // target resolve, like every other native engine.)
    if (usePgSchema && Option.isSome(flags.projectRef)) {
      return yield* Effect.fail(
        new DbDiffTargetFlagsError({
          message: "--project-ref is not supported with --use-pg-schema",
        }),
      );
    }
    if (usePgSchema) {
      // TS-only deprecation notice, printed before delegating (in both text and
      // machine output modes — diagnostics stay stderr-only). The delegated Go
      // `db diff --use-pg-schema` still prints its own experimental warning
      // itself; this is additive, not a replacement, so don't drop it.
      yield* output.raw(`${warnPgSchemaDeprecated}\n`, "stderr");
      const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
      // In machine-output mode the child's stdout is captured and re-emitted as a
      // structured envelope, so scripted callers get valid JSON instead of the Go
      // child's raw SQL on stdout (stdout is payload-only in machine mode).
      // The delegated child owns any `--file` write, so the written migration path
      // isn't introspectable here (reported as `file: null`).
      if (output.format !== "text") {
        const captured = yield* proxy.execCapture(rebuildPgSchemaDelegateArgs(flags), {
          env,
          suppressChildTelemetry: true,
        });
        yield* output.success("Diff complete.", {
          diff: captured,
          file: null,
          schemas: flags.schema,
          engine: "pg-schema",
        });
        return;
      }
      yield* proxy.exec(rebuildPgSchemaDelegateArgs(flags), { env, suppressChildTelemetry: true });
      return;
    }

    // Native path: resolve the target, provision a live shadow source, then diff.
    const connType: DbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.linked)
        ? "linked"
        : "local";

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on a non-linked target — see push.handler.ts's identical guard
    // for the full TS-only rationale. (Explicit `--from`/`--to` mode has its own
    // earlier guard, with the `--from/--to linked` exception; this native path
    // never reaches here when explicit mode ran.)
    if (Option.isSome(flags.projectRef) && connType !== "linked") {
      return yield* Effect.fail(
        new DbDiffTargetFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // Go's `ParseDatabaseConfig` resolves the linked ref via the hard `LoadProjectRef`, THEN
    // reads the `[remotes.<ref>]`-merged config (`LoadConfig`, which prints "Loading config
    // override" unconditionally the moment a remote matches — `pkg/config/config.go:605`) —
    // and only AFTER that calls `NewDbConfigWithPassword`, which does the actual connection
    // work (TCP probe / temp-role mint over the Management API, `flags/db_url.go:87-97`).
    // Pre-load the ref and read config here, before `resolver.resolve()` below, so the
    // override print (and the merged-config validation) happen in that same order.
    // Previously this read — and its print — ran AFTER `resolve()`, so a `resolve()` failure
    // (bad password, unreachable host, network-ban lookup, …) left the user never knowing
    // which `[remotes.*]` block had matched (review: PRRT_kwDOErm0O86XHvYl, pull.handler.ts's
    // identical fix). The default `db diff` target is local/db-url, which never merges a
    // remote block, so only the linked path pre-resolves a ref.
    let linkedRef: string | undefined;
    if (connType === "linked") {
      const projectRefResolver = yield* ProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      // Cache the ref the moment it's known, not after `cfg`/`localInputs` below (both
      // fallible) resolve: the project cache should still be written even when a LATER
      // step (config validation, connection, the diff itself) fails, so this is set
      // right after the ref resolves rather than only after
      // `cfg`/`localInputs`/`resolver.resolve()` all succeed.
      linkedRefForCache = linkedRef;
    }
    const cfg = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef);
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader the pgAdmin differ's (and the migra/pg-delta
    // shadow's) own image resolver falls back to, reverted when this scope closes.
    yield* applyProjectEnv(cfg.projectEnv);
    if (cfg.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${cfg.appliedRemote}]\n`, "stderr");
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* NetworkIdFlag;
    // Built BEFORE `resolver.resolve()` below, not just before the "Creating shadow
    // database..." banner: this call performs a SECOND config load (distinct from `cfg`
    // above) and its own validation (e.g. enabled API TLS's cert/key files, read here —
    // `cfg` above only tracks their dotted keys for remote-override gating, it never reads
    // the files), which can print a warning (e.g. deprecated `[inbucket]`) or fail
    // outright. All config loading (including any warnings) should happen once, before a
    // linked target's temp-role mint over the Management API — otherwise a config broken
    // only in a field this build reads would surface after that network side effect
    // instead of before it. Only the actual Docker-image resolution below
    // (`resolvePostgresImage`, lazy until this point) is the provisioning work the
    // banner itself announces.
    const localInputs = yield* buildLocalDbContainerInputs(
      spawner,
      cliSettings.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      // So the shadow's own container spec (image/JWT secret/root key/db.settings/service
      // enabled-for-setup flags) reflects the matching `[remotes.<ref>]` override too, same
      // as `cfg` above (`readDbToml(..., linkedRef)`).
      connType === "linked" ? linkedRef : undefined,
      // `cfg`'s OWN remote-override-key tracking (same matched block) — so a remote-set
      // bootstrap field (e.g. `db.major_version`) isn't re-overridden by a conflicting
      // `SUPABASE_*` env var when deriving the shadow's container spec.
      cfg.remoteOverrideKeys,
    );

    const resolved = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: Option.none(),
      linkedProjectRef: flags.projectRef,
    });
    if (linkedRef === undefined) {
      linkedRef = Option.getOrUndefined(resolved.ref ?? Option.none());
    }
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;
    const targetUrl = toPostgresURL(resolved.conn);
    const ctx: PgDeltaContext = {
      // `SUPABASE_PROJECT_ID` env override wins, then config.toml's `project_id`, then
      // the workdir basename fallback, with the matched `[remotes.<ref>]` block's own
      // `project_id` (`cfg.projectId`, already gated on `remoteOverrideKeys` by
      // `readDbToml`) suppressing the raw env argument on the linked path — see
      // that helper's own doc comment.
      projectId: resolvePgDeltaProjectId(cliSettings.projectId, cfg, cliSettings.workdir),
      cwd: cliSettings.workdir,
      denoVersion: cfg.denoVersion,
      projectEnv: cfg.projectEnv,
    };
    const formatOptions = Option.getOrElse(cfg.pgDelta.formatOptions, () => "");

    // Engine resolution: the pg-delta config/flag gate, read from the
    // (possibly remote-merged) config.
    const pgDeltaDefault = shouldUsePgDelta({
      configEnabled: cfg.pgDelta.enabled,
      usePgDeltaFlag: Option.getOrElse(flags.usePgDelta, () => false),
    });
    const useDelta = resolveDiffEngine({
      useMigraChanged: Option.isSome(flags.useMigra),
      usePgAdmin,
      usePgSchema,
      pgDeltaDefault,
    });
    // pg-delta ignores schema_paths when building its migrations baseline.
    if (useDelta && cfg.schemaPaths !== undefined && cfg.schemaPaths.length > 0) {
      yield* output.raw(schemaPathsTransitionWarning, "stderr");
    }

    // pgAdmin's own text-mode status lines go to STDOUT, not stderr — unlike the migra/
    // pg-delta path's diagnostics below, which always go to stderr. In machine output
    // modes (json/stream-json) these are diagnostics, not payload, so they redirect to
    // STDERR instead of being dropped (the repo's stdout-payload-only invariant),
    // matching the sibling migra/pg-delta banner below, which keeps its own banner on
    // stderr in every mode.
    const emitStatus = (line: string) =>
      output.raw(`${line}\n`, output.format === "text" ? "stdout" : "stderr");

    // Shared by both branches below (pgAdmin's `shadowBase` and the migra/pg-delta
    // `shadowInput`'s own spread) — resolving the image is the actual provisioning work each
    // branch's own "Creating shadow database..." banner announces, so every call site still
    // emits its banner FIRST and only then invokes this.
    const resolveShadowRunInput = Effect.fnUntraced(function* () {
      const resolvedShadowImage = yield* localInputs.resolvePostgresImage;
      return shadowRunInputFromLocalContainerInputs(
        localInputs,
        resolvedShadowImage,
        cfg,
        fs,
        path,
      );
    });

    let diffResult: {
      readonly sql: string;
      readonly files: ReadonlyArray<PgDeltaRenderedFile> | undefined;
      readonly hazards?: PgDeltaDiffResult["hazards"];
    };
    if (usePgAdmin) {
      // The running-db check runs AFTER the config load + target resolve above, and —
      // unlike every other engine on this command — runs for `--linked`/`--db-url` too,
      // not just the local target. Uses `ctx.projectId` (already remote-merge-resolved,
      // see its own doc comment above), not the raw `cliSettings.projectId` env reader, so
      // the check reflects a resolved remote merge rather than an ungated
      // `SUPABASE_PROJECT_ID` env var.
      const running = yield* isLocalDbRunning(
        spawner,
        fs,
        path,
        cliSettings.workdir,
        ctx.projectId,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DbDiffDbNotRunningError({
              message: cause.message,
              daemonDown: cause.daemonDown,
              suggestion: cause.suggestion,
            }),
        ),
      );
      if (!running) {
        return yield* Effect.fail(
          new DbDiffDbNotRunningError({
            message: `${aqua("supabase start")} is not running.`,
          }),
        );
      }
      yield* emitStatus("Creating shadow database...");
      const shadowBase = yield* resolveShadowRunInput();
      const shadowConnConfig: PgConnInput = {
        host: shadowBase.hostname,
        port: shadowBase.shadowPort,
        user: "postgres",
        password: shadowBase.password,
        database: "postgres",
      };
      // Register cleanup atomically with shadow creation; preparation stays interruptible.
      const sql = yield* Effect.acquireUseRelease(
        createShadowDatabase(spawner, shadowBase),
        (handle) =>
          Effect.gen(function* () {
            yield* waitForHealthyServices(spawner, [handle.containerId], {
              timeoutSeconds: shadowBase.healthTimeoutSeconds,
            });
            yield* migrateShadowDatabase(spawner, {
              fs,
              path,
              workdir: cliSettings.workdir,
              projectId: shadowBase.projectId,
              container: handle.containerId,
              networkId: shadowBase.networkId,
              connConfig: shadowConnConfig,
              setup: shadowBase.setup,
            });
            yield* emitStatus("Diffing local database with current migrations...");
            return yield* diffSchemaPgAdmin({
              // `source`/`target` are INVERTED relative to the migra/pg-delta path below:
              // `source` is the USER'S db, `target` is the SHADOW.
              source: targetUrl,
              // Deliberately hardcoded, not built via `toPostgresURL`: this ignores
              // `SUPABASE_SERVICES_HOSTNAME`/`[db] password` by design — not a bug to fix.
              target: `postgresql://postgres:postgres@127.0.0.1:${shadowBase.shadowPort}/postgres`,
              schema: flags.schema,
              projectId: shadowBase.projectId,
              networkId: shadowBase.networkId,
              extraHosts: shadowBase.extraHosts,
              emitStatus,
            });
          }),
        (handle) => removeShadowDatabase(spawner, handle.containerId),
      );
      diffResult = { sql, files: undefined };
    } else {
      yield* output.raw("Creating shadow database...\n", "stderr");
      const migrationMode: "legacy" | "pgdelta-next" = useDelta ? "pgdelta-next" : "legacy";
      const shadowInput = {
        ...(yield* resolveShadowRunInput()),
        targetLocal: resolved.isLocal,
        migrationMode,
        // `cfg.schemaPathPatterns`, NOT `localInputs.context.config.db.migrations.schema_paths`:
        // the latter is the raw `@supabase/config` field, which never applies
        // `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` — `cfg` above (`readDbToml`) already
        // resolves that env override.
        schemaPaths: cfg.schemaPathPatterns,
        pgDelta: cfg.pgDelta,
      };
      // `withShadowDatabase` (`shadow-cache.ts`) owns the interrupt-safe lifecycle and the
      // cache seam — a plain create/remove pair when `SUPABASE_SHADOW_CACHE` is explicitly
      // disabled (the cache is on by default). The key's webhooks policy must mirror what
      // `prepareShadowSource` selects for this mode (legacy migrate forces `pg_net` on,
      // next follows config), or the two engines could restore each other's tars.
      diffResult = yield* withShadowDatabase(
        spawner,
        shadowInput,
        (handle) =>
          Effect.gen(function* () {
            const shadow = yield* prepareShadowSource(spawner, handle, shadowInput);
            const target = shadow.targetUrlOverride ?? targetUrl;
            yield* output.raw(
              flags.schema.length > 0
                ? `Diffing schemas: ${flags.schema.join(",")}\n`
                : "Diffing schemas...\n",
              "stderr",
            );
            if (useDelta) {
              const result = yield* pgDelta.diffDatabase({
                context: ctx,
                source: {
                  kind: "database",
                  ref: shadow.sourceUrl,
                  connectOptions: { isLocal: true, dnsResolver: "native" },
                },
                target: {
                  kind: "database",
                  ref: target,
                  ...(shadow.targetUrlOverride === undefined ? { connection: resolved.conn } : {}),
                  connectOptions: {
                    isLocal: shadow.targetUrlOverride !== undefined || resolved.isLocal,
                    dnsResolver,
                  },
                },
                schema: flags.schema,
                formatOptions,
                debug: isPgDeltaDebugEnabled(),
                strictCoverage: flags.strictCoverage,
              });
              // Keep the per-unit plan files so a multi-unit plan can be written as one
              // migration file each; `sql` stays the flattened join for stdout review +
              // machine payloads.
              return { sql: result.sql, files: result.files, hazards: result.hazards };
            }
            const sql = yield* diffMigra(ctx, {
              source: shadow.sourceUrl,
              target,
              schema: flags.schema,
              connectOptions: { isLocal: resolved.isLocal, dnsResolver },
            });
            // The migra engine has no execution-aware plan units, so it always writes a
            // single migration file.
            return { sql, files: undefined };
          }),
        { webhooks: migrationMode === "pgdelta-next" ? "config" : "enabled" },
      );
    }
    const out = diffResult.sql;

    // The pgAdmin path skips the branch banner and drop-statement scan below entirely.
    if (!usePgAdmin) {
      // Detect the branch from the resolved workdir, not the caller's CWD, so
      // `supabase --workdir … db diff` reports the project's branch, not the
      // directory the command was invoked from.
      const branch = Option.getOrElse(yield* detectGitBranch(cliSettings.workdir), () => "main");
      yield* output.raw(
        `Finished ${aqua("supabase db diff")} on branch ${aqua(branch)}.\n\n`,
        "stderr",
      );
    }

    // The file-write + drop-statement warning below is bypassed by the pgadmin path.
    const engine = usePgAdmin ? "pgadmin" : useDelta ? "pg-delta" : "migra";
    const drops: ReadonlyArray<string> = usePgAdmin
      ? []
      : diffResult.hazards !== undefined
        ? diffResult.hazards.dataLoss.map((action) => action.sql)
        : findDropStatements(out);
    const writtenFiles: Array<string> = [];
    let ignoredDeclarativeAdvisory: ReturnType<typeof declarativeBaselineAdvisory> | undefined;
    if (out.length >= 2 && useDelta && Option.isSome(flags.file) && flags.file.value.length > 0) {
      // This is an informational, best-effort probe only. Declarative files are
      // intentionally not inputs to normal db diff, so an unreadable or changing
      // directory must never turn a previously successful diff into a failure.
      const declarativeDir = resolveDeclarativeDir(path, cfg.pgDelta);
      const declarativeDirAbsolute = path.resolve(cliSettings.workdir, declarativeDir);
      const hasDeclarativeSql = yield* Effect.gen(function* () {
        if (!(yield* fs.exists(declarativeDirAbsolute))) return false;
        return (yield* LoadPgDeltaSqlFiles(fs, path, declarativeDirAbsolute)).length > 0;
      }).pipe(Effect.orElseSucceed(() => false));
      if (hasDeclarativeSql) {
        const isAbsolute = path.isAbsolute(declarativeDir);
        const displayPath = isAbsolute
          ? "the configured declarative schema directory"
          : declarativeDir.split("\\").join("/");
        ignoredDeclarativeAdvisory = declarativeBaselineAdvisory(isAbsolute ? null : displayPath);
        yield* output.raw(declarativeBaselineNote(displayPath), "stderr");
      }
    }
    if (out.length < 2) {
      yield* output.raw("No schema changes found\n", "stderr");
      // The file write is gated on the value being non-empty, so an empty
      // `--file=""` (e.g. an unset shell var) falls through to stdout rather than
      // writing a `<timestamp>_.sql` migration with no name.
    } else if (Option.isSome(flags.file) && flags.file.value.length > 0) {
      const fileName = flags.file.value;
      // Plans spanning transaction boundaries need one migration per ordered unit.
      const planFiles = diffResult.files ?? [];
      if (planFiles.length > 1) {
        const writtenUnits = yield* writePgDeltaMigrations(fs, path, {
          workdir: cliSettings.workdir,
          baseMillis: yield* Clock.currentTimeMillis,
          name: fileName,
          files: planFiles.map((file) => ({
            name:
              file.suffix !== undefined && file.suffix !== null
                ? file.suffix.replace(/^_/u, "")
                : file.name,
            sql: file.sql,
            transactionMode: file.transactionMode,
          })),
        }).pipe(Effect.mapError((cause) => new DbDiffWriteError({ message: cause.message })));
        for (const unit of writtenUnits) writtenFiles.push(unit.path);
      } else {
        const timestamp = formatMigrationTimestamp(yield* Clock.currentTimeMillis);
        const migrationPath = getMigrationPath(path, cliSettings.workdir, timestamp, fileName);
        // Create parent dirs per written path, so a nested `--file snapshots/remote`
        // name creates `<ts>_snapshots/` first.
        yield* makeDir(fs, path.dirname(migrationPath)).pipe(
          Effect.mapError((cause) => new DbDiffWriteError({ message: cause.message })),
        );
        yield* fs
          .writeFileString(migrationPath, out)
          .pipe(Effect.mapError((cause) => new DbDiffWriteError({ message: cause.message })));
        writtenFiles.push(migrationPath);
      }
      yield* output.raw(`${warnDiff}\n`, "stderr");
    } else if (output.format === "text") {
      yield* output.raw(`${out}\n`);
    }
    if (drops.length > 0) {
      yield* output.raw(
        diffResult.hazards === undefined
          ? "Found drop statements in schema diff. Please double check if these are expected:\n"
          : "Found destructive changes in schema diff. Please double check if these are expected:\n",
        "stderr",
      );
      yield* output.raw(`${yellow(drops.join("\n"))}\n`, "stderr");
    }
    if (output.format !== "text") {
      yield* output.success("Diff complete.", {
        diff: out,
        // `file` keeps the first written path for released consumers that read the
        // string field (null when nothing was written); `files` lists EVERY written
        // migration path in write order (a pg-delta plan writes one file per unit),
        // mirroring pull's `schemaFiles` so machine callers see all of them.
        file: writtenFiles[0] ?? null,
        files: writtenFiles,
        schemas: flags.schema,
        engine,
        dropStatements: drops,
        ...(ignoredDeclarativeAdvisory === undefined
          ? {}
          : { advisories: [ignoredDeclarativeAdvisory] }),
      });
    }
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
