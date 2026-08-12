import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  LegacyDebugFlag,
  LegacyDnsResolverFlag,
  LegacyNetworkIdFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import {
  legacyApplyProjectEnv,
  legacyReadDbToml,
} from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import { legacyMakeDir } from "../../../shared/legacy-make-dir.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { legacySchemaToCsvField } from "../../../shared/legacy-schema-flags.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import { legacyBuildLocalDbContainerInputs } from "../../../shared/db-bootstrap/local-container-inputs.ts";
import { legacyIsLocalDbRunning } from "../../../shared/db-bootstrap/local-db-running.ts";
import { legacyWaitForHealthyServices } from "../../../shared/db-bootstrap/health-check.ts";
import {
  legacyCreateShadowDatabase,
  legacyMigrateShadowDatabase,
  legacyRemoveShadowDatabase,
  legacyShadowRunInputFromLocalContainerInputs,
} from "../../../shared/db-bootstrap/shadow-database.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyParseBoolEnv,
  legacyResolveDiffEngine,
  legacyShouldUsePgDelta,
} from "../../../shared/legacy-diff-engine.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import { legacyResolveMigrationsCatalogRef } from "../../../shared/legacy-pgdelta.cache.ts";
import { legacyWritePgDeltaMigrations } from "../shared/legacy-pgdelta-migrations.write.ts";
import {
  type LegacyPgDeltaContext,
  legacyDiffPgDelta,
  legacyExportCatalogPgDelta,
  legacyIsPgDeltaDebugEnabled,
  legacyResolvePgDeltaProjectId,
} from "../../../shared/legacy-pgdelta.ts";
import { legacyPrepareShadowSource } from "../shared/legacy-shadow-source.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";
import { legacyClassifyExplicitRef, legacyUnknownTargetMessage } from "./diff.explicit.ts";
import {
  LegacyDbDiffDbNotRunningError,
  LegacyDbDiffEngineConflictError,
  LegacyDbDiffExplicitFlagsError,
  LegacyDbDiffTargetFlagsError,
  LegacyDbDiffUnknownTargetError,
  LegacyDbDiffWriteError,
} from "./diff.errors.ts";
import { legacyDiffSchemaPgAdmin } from "./legacy-pgadmin-diff.ts";

// Go's `warnDiff` (`apps/cli-go/internal/db/diff/pgadmin.go:17`), shown after a
// `--file` migration is written.
const warnDiff = `WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ${legacyAqua("supabase db reset")} to verify that the new migration does not generate errors.`;

// TS-only deprecation notice (CLI-1960): `--use-pg-schema` wraps the in-process
// Go library `stripe/pg-schema-diff` (`apps/cli-go/internal/db/diff/pgschema.go`),
// which has no TS/container equivalent — a keep-in-Go exception, not a pending
// port (see SIDE_EFFECTS.md). The flag itself is now deprecated in favor of the
// pg-delta engine. This is additive to (and prints before) Go's own
// "experimental" warning (`cmd/db.go:121`), which the delegated child still
// prints unchanged. No removal timeline is promised: actual removal is out of
// scope for CLI-1960.
const warnPgSchemaDeprecated = `${legacyYellow("WARNING:")} "--use-pg-schema" is deprecated. Use the pg-delta engine ([experimental.pgdelta] enabled = true / --use-pg-delta) or the default migra engine instead.`;

/**
 * Rebuilds the `db diff` argv for the `--use-pg-schema` delegate path — the CLI's
 * sole remaining Go delegation on this command (CLI-1960's keep-in-Go exception:
 * the in-process `stripe/pg-schema-diff` library has no TS/container equivalent;
 * `--use-pgadmin` is native as of CLI-1968). Flags stay flags (the Go-proxy
 * channel-parity rule). The explicit `--from`/`--to` and engine mutex are already
 * handled before this runs, and the mutex guarantees `--use-migra`/`--use-pgadmin`/
 * `--use-pg-delta` are all unset whenever this is reached, so it just forwards
 * `--use-pg-schema` plus the target / schema / file flags the user passed.
 */
const rebuildPgSchemaDelegateArgs = (flags: LegacyDbDiffFlags): Array<string> => {
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
  for (const s of flags.schema) args.push("--schema", legacySchemaToCsvField(s));
  return args;
};

export const legacyDbDiff = Effect.fn("legacy.db.diff")(function* (flags: LegacyDbDiffFlags) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const debug = yield* LegacyDebugFlag;

  // Resolved linked ref, captured so the post-run finalizer caches the project
  // (GET /v1/projects/{ref}) — Go's `ensureProjectGroupsCached` (cmd/root.go:214).
  let linkedRefForCache: string | undefined;

  yield* Effect.gen(function* () {
    // cobra `MarkFlagsMutuallyExclusive` runs before RunE. The engine group
    // (`use-migra use-pgadmin use-pg-schema use-pg-delta`) and the target group
    // (`db-url linked local`); "set" follows pflag `Changed` (Option `Some`).
    const engineSet: Array<string> = [];
    if (Option.isSome(flags.useMigra)) engineSet.push("use-migra");
    if (Option.isSome(flags.usePgAdmin)) engineSet.push("use-pgadmin");
    if (Option.isSome(flags.usePgSchema)) engineSet.push("use-pg-schema");
    if (Option.isSome(flags.usePgDelta)) engineSet.push("use-pg-delta");
    if (engineSet.length > 1) {
      return yield* Effect.fail(
        new LegacyDbDiffEngineConflictError({
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
        new LegacyDbDiffTargetFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${[...targetSet].sort().join(" ")}] were all set`,
        }),
      );
    }

    // Config is read lazily per path, NOT unconditionally up front: Go loads config
    // exactly once in PreRun and, on the linked path, only AFTER resolving the ref —
    // so it validates the remote-merged config (`config.go` merges `[remotes.<ref>]`
    // before `Validate`). Reading the base config here would validate fields a
    // `[remotes.<ref>]` block overrides (db.major_version, deno_version, …) before
    // the ref is known, failing a linked diff that Go accepts. The delegate paths
    // forward to the Go child (which loads config itself), so they read nothing.

    // Explicit `--from`/`--to` mode (Go's `db.go:102-109`): both required, always
    // pg-delta. Go gates on `len(diffFrom) > 0 || len(diffTo) > 0`, so an empty
    // value (a shell var expanding to `""`) counts as unset — `--from "" --to ""`
    // falls through to the normal diff, while `--from x --to ""` still errors.
    const from = Option.getOrElse(flags.from, () => "");
    const to = Option.getOrElse(flags.to, () => "");
    const fromSet = from.length > 0;
    const toSet = to.length > 0;
    if (fromSet || toSet) {
      if (!fromSet || !toSet) {
        return yield* Effect.fail(
          new LegacyDbDiffExplicitFlagsError({
            message: "must set both --from and --to when using explicit diff mode",
          }),
        );
      }
      // `--project-ref` never implies `--linked` and must not be silently
      // discarded — see push.handler.ts's identical guard for the full TS-only
      // rationale. Exception for explicit mode: `--from linked` / `--to linked`
      // resolves a linked ref (via `resolveRef`'s "linked" case below) without
      // any `--linked`/target flag at all, so the guard must NOT fire there —
      // only when NEITHER side is the literal ref "linked" (e.g. plain
      // `--project-ref X`, or `--from local --to migrations --project-ref X`,
      // where the flag genuinely goes unused).
      if (
        Option.isSome(flags.projectRef) &&
        legacyClassifyExplicitRef(from) !== "linked" &&
        legacyClassifyExplicitRef(to) !== "linked"
      ) {
        return yield* Effect.fail(
          new LegacyDbDiffTargetFlagsError({
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
      // Go runs `ParseDatabaseConfig` in the root PersistentPreRunE for every
      // `db diff` (`cmd/root.go:118`), before RunE dispatches to RunExplicit
      // (`cmd/db.go:107`). It validates a changed target flag (`--db-url bad` fails
      // parsing) AND is STATEFUL: a changed `--linked` runs `LoadProjectRef` +
      // `LoadConfig`, leaving `utils.Config` remote-merged, so the explicit
      // `local`/`migrations` refs and `pgDeltaFormatOptions()` see the linked
      // project's `[remotes.<ref>]` overrides (`db_url.go:87-93` →
      // `config_path.go:11-12`). `--local`/`--db-url` load base config (no merge).
      if (Option.isSome(flags.dbUrl) || Option.isSome(flags.linked) || Option.isSome(flags.local)) {
        const preflightConnType: LegacyDbConnType = Option.isSome(flags.dbUrl)
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
      // Read config once, AFTER the preflight: the `[remotes.<ref>]`-merged config
      // when a changed `--linked` resolved a ref (so base config isn't validated
      // before the merge, matching Go's stateful pre-run), else the base config.
      let cfg =
        mergedLinkedRef !== undefined
          ? yield* legacyReadDbToml(fs, path, cliConfig.workdir, mergedLinkedRef)
          : yield* legacyReadDbToml(fs, path, cliConfig.workdir);
      // Go resolves each ref in order (`explicit.go:21-25`); the `linked` branch
      // runs `LoadConfig(ref)` (`explicit.go:78-86`), re-merging the matching
      // `[remotes.<ref>]` block so a later `local` ref read and the trailing
      // `pgDeltaFormatOptions()` see the override. Thread the merged config through.
      const resolveRef = (ref: string) =>
        Effect.gen(function* () {
          switch (legacyClassifyExplicitRef(ref)) {
            case "local":
              return legacyToPostgresURL({
                host: legacyGetHostname(),
                port: cfg.port,
                user: "postgres",
                password: cfg.password,
                database: "postgres",
              });
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
                cfg = yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref2);
              }
              return legacyToPostgresURL(resolved.conn);
            }
            case "migrations": {
              // Native (CLI-1959 cache mechanics; CLI-1956 native shadow provisioning
              // — see `legacyResolveMigrationsCatalogRef`'s doc comment): mirrors Go's
              // `resolveMigrationsCatalogRef` (`explicit.go:88-126`) exactly. The
              // pg-delta context AND the shadow's own container spec (`cfg` below,
              // passed through to `legacyResolveMigrationsCatalogRef`'s `toml`
              // parameter) are built from whatever `cfg` is current at this point in
              // the cascade (possibly re-merged by an earlier "linked" ref above),
              // matching Go's stateful pre-run.
              const migrationsCtx: LegacyPgDeltaContext = {
                projectId: legacyResolvePgDeltaProjectId(
                  cliConfig.projectId,
                  cfg,
                  cliConfig.workdir,
                ),
                cwd: cliConfig.workdir,
                npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
                denoVersion: cfg.denoVersion,
                projectEnv: cfg.projectEnv,
              };
              // Pass the linked ref only if one resolved earlier in the cascade, so
              // the shadow merges the same remote override Go's in-process
              // migrations catalog sees (`explicit.go:88-126`). Absent otherwise →
              // base config, matching Go's resolution order.
              return yield* legacyResolveMigrationsCatalogRef(
                fs,
                path,
                migrationsCtx,
                cfg,
                mergedLinkedRef !== undefined ? { projectRef: mergedLinkedRef } : {},
              );
            }
            case "url":
              return ref;
            default:
              return yield* Effect.fail(
                new LegacyDbDiffUnknownTargetError({ message: legacyUnknownTargetMessage(ref) }),
              );
          }
        });
      const sourceRef = yield* resolveRef(from);
      const targetRef = yield* resolveRef(to);
      const explicitCtx: LegacyPgDeltaContext = {
        projectId: legacyResolvePgDeltaProjectId(cliConfig.projectId, cfg, cliConfig.workdir),
        cwd: cliConfig.workdir,
        npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
        denoVersion: cfg.denoVersion,
        projectEnv: cfg.projectEnv,
      };
      const result = yield* legacyDiffPgDelta(explicitCtx, {
        sourceRef,
        targetRef,
        schema: flags.schema,
        formatOptions: Option.getOrElse(cfg.pgDelta.formatOptions, () => ""),
      });
      // Explicit-mode output: `--output` file (Go's `writeOutput`) or stdout
      // (Go's `fmt.Print`, no trailing newline — pg-delta ends each statement `;\n`).
      // Go gates the file write on `len(outputPath) > 0` (`explicit.go`), so an
      // empty value (`--output="$OUT"` with OUT unset) falls through to stdout
      // rather than writing SQL into the project directory.
      if (Option.isSome(flags.output) && flags.output.value.length > 0) {
        const target = path.resolve(cliConfig.workdir, flags.output.value);
        // Create parent dirs first, matching Go's `writeOutput` → `utils.WriteFile`
        // (`internal/db/diff/explicit.go`, `internal/utils/misc.go`), so a nested
        // `--output tmp/diff.sql` doesn't fail when `tmp/` doesn't exist yet.
        yield* legacyMakeDir(fs, path.dirname(target)).pipe(
          Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })),
        );
        yield* fs
          .writeFileString(target, result.sql)
          .pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
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

    // `--use-pg-schema` delegates to the bundled Go binary (Go's `DiffPgSchema` is not
    // ported — CLI-1960 keep-in-Go exception). It is an explicit engine selection that
    // does not depend on config, so it short-circuits before the target resolve.
    // Disable the child's telemetry so the single `cli_command_executed` event comes
    // from this TS command's instrumentation. `--use-pgadmin` no longer short-circuits
    // here (CLI-1968): unlike `--use-pg-schema`, Go resolves the target in the root
    // `PersistentPreRunE` *before* `RunPgAdmin` ever runs (`cmd/db.go:110` →
    // `cmd/db.go:115`), so config validation, the `[remotes.<ref>]` merge print, and
    // the linked temp-role mint all still happen for `--use-pgadmin` — see the native
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
        new LegacyDbDiffTargetFlagsError({
          message: "--project-ref is not supported with --use-pg-schema",
        }),
      );
    }
    if (usePgSchema) {
      // CLI-1960: TS-only deprecation notice, printed before delegating (in both
      // text and machine output modes — diagnostics stay stderr-only per CLI-1546).
      // The delegated Go `db diff --use-pg-schema` still prints its own experimental
      // warning itself in its RunE (`cmd/db.go`); this is additive, not a
      // replacement, so don't drop it.
      yield* output.raw(`${warnPgSchemaDeprecated}\n`, "stderr");
      const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
      // In machine-output mode the child's stdout is captured and re-emitted as a
      // structured envelope, so scripted callers get valid JSON instead of the Go
      // child's raw SQL on stdout (CLI-1546: stdout is payload-only in machine mode).
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
    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
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
        new LegacyDbDiffTargetFlagsError({
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
      const projectRefResolver = yield* LegacyProjectRefResolver;
      linkedRef = yield* projectRefResolver.loadProjectRef(flags.projectRef);
      // Cache the ref the moment it's known, not after `cfg`/`localInputs` below (both
      // fallible) resolve — Go's `ensureProjectGroupsCached` (`cmd/root.go:212-233`) reads the
      // GLOBAL `flags.ProjectRef` singleton `LoadProjectRef` sets as a side effect, and runs
      // unconditionally after `rootCmd.ExecuteC()` regardless of whether the command itself
      // errored (`cmd/root.go:169-175` never checks `err` before calling it) — so Go caches a
      // resolved ref even when a LATER step (config validation, connection, the diff itself)
      // fails. Setting `linkedRefForCache` here, right after the ref resolves, reproduces that
      // instead of only doing so after `cfg`/`localInputs`/`resolver.resolve()` all succeed.
      linkedRefForCache = linkedRef;
    }
    const cfg = yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef);
    // Make an allowlisted `supabase/.env` registry override visible to the
    // synchronous `process.env` reader the pgAdmin differ's (and the migra/pg-delta
    // shadow's) own image resolver falls back to, reverted when this scope closes.
    // Go's `loadNestedEnv` `os.Setenv`s the project `.env` during config load
    // (`pkg/config/config.go:788-791`), before `GetRegistry()`
    // (`internal/utils/docker.go:221-231,244-246`) ever reads it — unlike every
    // other native engine on this command, `db diff` never applied project env
    // until now.
    yield* legacyApplyProjectEnv(cfg.projectEnv);
    if (cfg.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${cfg.appliedRemote}]\n`, "stderr");
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeInfo = yield* RuntimeInfo;
    const networkIdFlag = yield* LegacyNetworkIdFlag;
    // Built BEFORE `resolver.resolve()` below, not just before the "Creating shadow
    // database..." banner: this call performs a SECOND config load
    // (`legacyLoadLocalProjectContext`'s `@supabase/config` read, distinct from `cfg`
    // above) and its own validation (e.g. enabled API TLS's cert/key files, read here —
    // `cfg` above only tracks their dotted keys for remote-override gating, it never reads
    // the files), which can print a warning (e.g. deprecated `[inbucket]`) or fail
    // outright. Go's `flags.LoadConfig` does ALL config loading (including any warnings)
    // once, in the root `PersistentPreRunE`, strictly before `NewDbConfigWithPassword` —
    // `resolver.resolve()`'s own parity target, see that call's doc comment above — or
    // `DiffDatabase` ever prints "Creating shadow database..." (`internal/db/diff/
    // diff.go:212`) run. Previously this validation ran AFTER `resolver.resolve()` (a
    // linked target's temp-role mint over the Management API), so a config broken only in
    // a field this build reads surfaced after that network side effect instead of before
    // it, unlike Go (review: PRRT_kwDOErm0O86XIUK1, pull.handler.ts's identical fix). Only
    // the actual Docker-image resolution below (`resolvePostgresImage`, lazy until this
    // point) is the provisioning work the banner itself announces.
    const localInputs = yield* legacyBuildLocalDbContainerInputs(
      spawner,
      cliConfig.workdir,
      networkIdFlag,
      runtimeInfo.platform,
      debug,
      // So the shadow's own container spec (image/JWT secret/root key/db.settings/service
      // enabled-for-setup flags) reflects the matching `[remotes.<ref>]` override too, same
      // as `cfg` above (`legacyReadDbToml(..., linkedRef)`) — Go remote-merges the WHOLE
      // config uniformly on the linked path (`LoadConfig` seeds `flags.ProjectRef` before
      // every field read).
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
    const targetUrl = legacyToPostgresURL(resolved.conn);
    const ctx: LegacyPgDeltaContext = {
      // `legacyResolvePgDeltaProjectId` mirrors Go's `UpdateDockerIds`, which derives
      // `EdgeRuntimeId` from the ALREADY-sanitized `Config.ProjectId` singleton
      // (`internal/utils/config.go:57-76`, sanitized once by `Config.Validate` at
      // config-load time): `SUPABASE_PROJECT_ID` env override wins, then config.toml's
      // `project_id`, then the workdir basename fallback (`pkg/config/config.go:563-570`),
      // with the matched `[remotes.<ref>]` block's own `project_id` (`cfg.projectId`,
      // already gated on `remoteOverrideKeys` by `legacyReadDbToml`) suppressing the raw env
      // argument on the linked path — see that helper's own doc comment (review:
      // PRRT_kwDOErm0O86XAlIw, PRRT_kwDOErm0O86XI1w8).
      projectId: legacyResolvePgDeltaProjectId(cliConfig.projectId, cfg, cliConfig.workdir),
      cwd: cliConfig.workdir,
      npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
      denoVersion: cfg.denoVersion,
      projectEnv: cfg.projectEnv,
    };
    const formatOptions = Option.getOrElse(cfg.pgDelta.formatOptions, () => "");

    // Engine resolution (Go's `db.go:110`): the pg-delta env/config/flag gate,
    // read from the (possibly remote-merged) config.
    const pgDeltaDefault = legacyShouldUsePgDelta({
      configEnabled: cfg.pgDelta.enabled,
      usePgDeltaFlag: Option.getOrElse(flags.usePgDelta, () => false),
      envEnabled: legacyParseBoolEnv(cfg.envLookup("SUPABASE_EXPERIMENTAL_PG_DELTA")),
    });
    const useDelta = legacyResolveDiffEngine({
      useMigraChanged: Option.isSome(flags.useMigra),
      usePgAdmin,
      usePgSchema,
      pgDeltaDefault,
    });

    // pgAdmin's own text-mode status lines go to STDOUT, not stderr: only Go's NON-TTY
    // `fakeProgram` prints StatusMsg via `fmt.Println` (`tea.go:57-70`) — on a TTY Go instead
    // runs the real `bubbletea` renderer (ephemeral repainted frames, with no TS equivalent
    // and not a parity target; non-TTY is) — unlike the migra/pg-delta path's
    // `fmt.Fprintln(os.Stderr, …)` diagnostics below. In machine output modes (json/stream-json)
    // these are diagnostics, not payload, so they redirect to STDERR instead of being dropped —
    // the repo's stdout-payload-only invariant (CLI-1546), matching the sibling migra/pg-delta
    // banner below, which keeps its own banner on stderr in every mode.
    const emitStatus = (line: string) =>
      output.raw(`${line}\n`, output.format === "text" ? "stdout" : "stderr");

    // Shared by both branches below (pgAdmin's `shadowBase` and the migra/pg-delta
    // `shadowInput`'s own spread) — resolving the image is the actual provisioning work each
    // branch's own "Creating shadow database..." banner announces, so every call site still
    // emits its banner FIRST and only then invokes this (preserved, verified-parity ordering).
    const resolveShadowRunInput = Effect.fnUntraced(function* () {
      const resolvedShadowImage = yield* localInputs.resolvePostgresImage;
      return legacyShadowRunInputFromLocalContainerInputs(
        localInputs,
        resolvedShadowImage,
        cfg,
        fs,
        path,
      );
    });

    let diffResult: {
      readonly sql: string;
      readonly files: ReadonlyArray<{ readonly name: string; readonly sql: string }> | undefined;
    };
    if (usePgAdmin) {
      // Go's `RunPgAdmin` (`pgadmin.go:49-63`): `AssertSupabaseDbIsRunning` runs AFTER the
      // config load + target resolve above, and — unlike every other engine on this command —
      // runs for `--linked`/`--db-url` too, not just the local target. `ctx.projectId`
      // (already remote-merge-resolved, see its own doc comment above), not the raw
      // `cliConfig.projectId` env reader: Go's `UpdateDockerIds` runs AFTER the linked
      // remote merge, so `DbId` derives from the resolved `Config.ProjectId` singleton,
      // not the ungated `SUPABASE_PROJECT_ID` env var (`config_path.go:10-15`,
      // `pkg/config/config.go:604-610`, `internal/utils/config.go:57-65`).
      const running = yield* legacyIsLocalDbRunning(
        spawner,
        fs,
        path,
        cliConfig.workdir,
        ctx.projectId,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbDiffDbNotRunningError({
              message: cause.message,
              daemonDown: cause.daemonDown,
              suggestion: cause.suggestion,
            }),
        ),
      );
      if (!running) {
        return yield* Effect.fail(
          new LegacyDbDiffDbNotRunningError({
            message: `${legacyAqua("supabase start")} is not running.`,
          }),
        );
      }
      yield* emitStatus("Creating shadow database...");
      const shadowBase = yield* resolveShadowRunInput();
      const shadowConnConfig: LegacyPgConnInput = {
        host: shadowBase.hostname,
        port: shadowBase.shadowPort,
        user: "postgres",
        password: shadowBase.password,
        database: "postgres",
      };
      // Same `acquireUseRelease` rationale as the migra/pg-delta branch below: `acquire` is
      // ONLY container creation (uninterruptible, matching Go's `defer DockerRemove`
      // immediately after a successful `DockerStart`); the health-wait + migrate + diff run
      // inside the interruptible `use` phase, mirroring Go's own single cancellable `ctx`
      // (review: PRRT_kwDOErm0O86XMrID). `acquire` here is ONLY `legacyCreateShadowDatabase` —
      // NOT `legacyPrepareShadowSource` (no `--target-local` declarative-schema branch, no
      // `targetUrlOverride`, no pg-delta apply: Go's `pgadmin.go` calls `MigrateShadowDatabase`
      // directly, never `PrepareShadowSource`).
      const sql = yield* Effect.acquireUseRelease(
        legacyCreateShadowDatabase(spawner, shadowBase),
        (handle) =>
          Effect.gen(function* () {
            yield* legacyWaitForHealthyServices(spawner, [handle.containerId], {
              timeoutSeconds: shadowBase.healthTimeoutSeconds,
            });
            yield* legacyMigrateShadowDatabase(spawner, {
              fs,
              path,
              workdir: cliConfig.workdir,
              projectId: shadowBase.projectId,
              container: handle.containerId,
              networkId: shadowBase.networkId,
              connConfig: shadowConnConfig,
              setup: shadowBase.setup,
            });
            yield* emitStatus("Diffing local database with current migrations...");
            return yield* legacyDiffSchemaPgAdmin({
              // Go's `source`/`target` are INVERTED relative to the migra/pg-delta path
              // below: `source` is the USER'S db, `target` is the SHADOW (`pgadmin.go:85-86`).
              source: targetUrl,
              // A raw `Sprintf`, not `legacyToPostgresURL` — Go hardcodes `127.0.0.1` and
              // `postgres:postgres`, ignoring `SUPABASE_SERVICES_HOSTNAME`/`[db] password`
              // (`pgadmin.go:86`, deliberate Go parity, not a bug to fix).
              target: `postgresql://postgres:postgres@127.0.0.1:${shadowBase.shadowPort}/postgres`,
              schema: flags.schema,
              projectId: shadowBase.projectId,
              networkId: shadowBase.networkId,
              extraHosts: shadowBase.extraHosts,
              emitStatus,
            });
          }),
        (handle) => legacyRemoveShadowDatabase(spawner, handle.containerId),
      );
      diffResult = { sql, files: undefined };
    } else {
      yield* output.raw("Creating shadow database...\n", "stderr");
      const shadowInput = {
        ...(yield* resolveShadowRunInput()),
        targetLocal: resolved.isLocal,
        usePgDelta: useDelta,
        // `cfg.schemaPathPatterns`, NOT `localInputs.context.config.db.migrations.schema_paths`:
        // the latter is the raw `@supabase/config` field, which never applies
        // `SUPABASE_DB_MIGRATIONS_SCHEMA_PATHS` (`@supabase/config` has no viper-`AutomaticEnv`
        // equivalent) — `cfg` above (`legacyReadDbToml`) already resolves that env override the
        // same way Go's `utils.Config.Db.Migrations.SchemaPaths` does (review: PRRT_kwDOErm0O86XDr4S).
        schemaPaths: cfg.schemaPathPatterns,
        pgDelta: cfg.pgDelta,
        ctx,
      };
      // `Effect.acquireUseRelease`, NOT a separate `yield* legacyCreateShadowDatabase(...)`
      // followed by a later `.pipe(Effect.ensuring(...))`: the latter shape leaves a real gap
      // between the shadow's successful creation and the `Effect.ensuring` finalizer actually
      // being attached — a fiber interrupt landing in that gap (between the two `yield*`
      // statements) would skip `legacyRemoveShadowDatabase` entirely, leaking the live shadow
      // container and leaving the shadow port occupied. `acquireUseRelease` closes that:
      // `acquire` runs inside an `uninterruptibleMask`, and the release finalizer is registered
      // in the SAME uninterruptible continuation `acquire` resolves into, matching Go's `defer
      // DockerRemove` immediately after successful creation (review: PRRT_kwDOErm0O86XDr4Y).
      // This does NOT make removal unconditional, though — see `legacyCreateShadowDatabase`'s
      // own doc comment (`shadow-database.ts`) for the still-present, deliberate-Go-parity leak
      // window when `acquire` itself fails partway through (a `docker create` success followed
      // by a `docker cp`/`docker start` failure).
      //
      // `acquire` here is ONLY `legacyCreateShadowDatabase` (container creation) — NOT the
      // health-wait/migrate/declarative-apply `legacyPrepareShadowSource` performs. Those run
      // inside the `use` phase below instead, where a SIGINT can still interrupt them (matching
      // Go's single cancellable `ctx` threaded through the equivalent calls); passing all of
      // `legacyPrepareShadowSource` as `acquire` made that whole sequence uninterruptible too,
      // since `acquireUseRelease`'s `uninterruptibleMask` has no `restore` around `acquire` —
      // see `legacy-shadow-source.ts`'s own doc comment on `legacyPrepareShadowSource` for the
      // full rationale (review: PRRT_kwDOErm0O86XMrID).
      diffResult = yield* Effect.acquireUseRelease(
        legacyCreateShadowDatabase(spawner, shadowInput),
        (handle) =>
          Effect.gen(function* () {
            const shadow = yield* legacyPrepareShadowSource(spawner, handle, shadowInput);
            const target = shadow.targetUrlOverride ?? targetUrl;
            yield* output.raw(
              flags.schema.length > 0
                ? `Diffing schemas: ${flags.schema.join(",")}\n`
                : "Diffing schemas...\n",
              "stderr",
            );
            if (useDelta) {
              // With PGDELTA_DEBUG set, export the shadow's baseline catalog before diffing
              // (Go's `DiffDatabase`, `internal/db/diff/diff.go:228-244`, shared by `db diff`
              // AND `db pull`) — the snapshot itself is unused here (unlike `db pull`'s
              // `legacySaveEmptyPgDeltaPullDebug`, `db diff` has no debug-bundle consumer for
              // it); a failed export only warns and the diff continues.
              if (legacyIsPgDeltaDebugEnabled()) {
                yield* legacyExportCatalogPgDelta(ctx, {
                  targetRef: shadow.sourceUrl,
                  role: "postgres",
                }).pipe(
                  Effect.catch((error) =>
                    output.raw(
                      `Warning: failed to export shadow pg-delta catalog: ${error.message}\n`,
                      "stderr",
                    ),
                  ),
                );
              }
              const result = yield* legacyDiffPgDelta(ctx, {
                sourceRef: shadow.sourceUrl,
                targetRef: target,
                schema: flags.schema,
                formatOptions,
              });
              // Keep the per-unit plan files so a multi-unit plan can be written as one
              // migration file each (Go's `DatabaseDiff.Files`); `sql` stays the flattened
              // join for stdout review + machine payloads.
              return { sql: result.sql, files: result.files };
            }
            const sql = yield* legacyDiffMigra(ctx, {
              source: shadow.sourceUrl,
              target,
              schema: flags.schema,
              connectOptions: { isLocal: resolved.isLocal, dnsResolver },
            });
            // The migra engine has no execution-aware plan units, so it always writes a
            // single migration file (Go's `SaveDiff` single-file path).
            return { sql, files: undefined };
          }),
        (handle) => legacyRemoveShadowDatabase(spawner, handle.containerId),
      );
    }
    const out = diffResult.sql;

    // Go's `RunPgAdmin` returns straight to `SaveDiff` — no branch banner, no drop scan (both
    // live in `diff.Run`, `diff.go:38-47`, which the pgadmin path bypasses entirely).
    if (!usePgAdmin) {
      // Detect the branch from the resolved workdir, not the caller's CWD: Go
      // chdirs into --workdir in PersistentPreRunE before GetGitBranch
      // (`cmd/root.go`), so `supabase --workdir … db diff` must report the
      // project's branch, not the directory the command was invoked from.
      const branch = Option.getOrElse(yield* detectGitBranch(cliConfig.workdir), () => "main");
      yield* output.raw(
        `Finished ${legacyAqua("supabase db diff")} on branch ${legacyAqua(branch)}.\n\n`,
        "stderr",
      );
    }

    // Go's `SaveDiff` (`pgadmin.go:20`) + the drop-statement warning (`diff.go:44`, bypassed
    // by the pgadmin path).
    const engine = usePgAdmin ? "pgadmin" : useDelta ? "pg-delta" : "migra";
    const drops: ReadonlyArray<string> = usePgAdmin ? [] : legacyFindDropStatements(out);
    const writtenFiles: Array<string> = [];
    if (out.length < 2) {
      yield* output.raw("No schema changes found\n", "stderr");
      // Go's `SaveDiff` gates the file write on `len(file) > 0` (`pgadmin.go`), so
      // an empty `--file=""` (e.g. an unset shell var) falls through to stdout
      // rather than writing a `<timestamp>_.sql` migration with no name.
    } else if (Option.isSome(flags.file) && flags.file.value.length > 0) {
      const fileName = flags.file.value;
      // A pg-delta plan that crosses a transaction boundary yields more than one
      // ordered unit; writing them into a single migration file would later fail
      // when `db push`/`reset` applies it as one transaction. Write one migration
      // file per unit in that case via the shared writer (Go's
      // `WritePgDeltaMigrations`, `internal/db/diff/pgdelta_migrations.go`): each
      // file appends the unit name and gets a strictly increasing timestamp, the
      // full set is collision-checked against existing migrations, and every file is
      // written exclusively so a pre-existing migration is never overwritten. A
      // single-unit plan (and the migra engine) keeps the exact `<ts>_<name>.sql`
      // file (Go's `utils.WriteFile`), byte-identical to before.
      const planFiles = diffResult.files ?? [];
      if (planFiles.length > 1) {
        const writtenUnits = yield* legacyWritePgDeltaMigrations(fs, path, {
          workdir: cliConfig.workdir,
          baseMillis: yield* Clock.currentTimeMillis,
          name: fileName,
          files: planFiles.map((file) => ({ name: file.name, sql: file.sql })),
        }).pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
        for (const unit of writtenUnits) writtenFiles.push(unit.path);
      } else {
        const timestamp = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
        const migrationPath = legacyGetMigrationPath(path, cliConfig.workdir, timestamp, fileName);
        // Create parent dirs per written path (mirroring Go's `utils.WriteFile`), so a
        // nested `--file snapshots/remote` name creates `<ts>_snapshots/` first.
        yield* legacyMakeDir(fs, path.dirname(migrationPath)).pipe(
          Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })),
        );
        yield* fs
          .writeFileString(migrationPath, out)
          .pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
        writtenFiles.push(migrationPath);
      }
      yield* output.raw(`${warnDiff}\n`, "stderr");
    } else if (output.format === "text") {
      yield* output.raw(`${out}\n`);
    }
    if (drops.length > 0) {
      yield* output.raw(
        "Found drop statements in schema diff. Please double check if these are expected:\n",
        "stderr",
      );
      yield* output.raw(`${legacyYellow(drops.join("\n"))}\n`, "stderr");
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
    // command run: `legacyApplyProjectEnv` registers a finalizer that reverts it.
    Effect.scoped,
  );
});
