import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyPgConnInput } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { legacySchemaToCsvField } from "../../../shared/legacy-schema-flags.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyParseBoolEnv,
  legacyResolveDiffEngine,
  legacyShouldUsePgDelta,
} from "../shared/legacy-diff-engine.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../shared/legacy-migration-file.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import { type LegacyPgDeltaContext, legacyDiffPgDelta } from "../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeSeam } from "../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbDiffFlags } from "./diff.command.ts";
import { legacyClassifyExplicitRef, legacyUnknownTargetMessage } from "./diff.explicit.ts";
import {
  LegacyDbDiffEngineConflictError,
  LegacyDbDiffExplicitFlagsError,
  LegacyDbDiffTargetFlagsError,
  LegacyDbDiffUnknownTargetError,
  LegacyDbDiffWriteError,
} from "./diff.errors.ts";

// Go's `warnDiff` (`apps/cli-go/internal/db/diff/pgadmin.go:17`), shown after a
// `--file` migration is written.
const warnDiff = `WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ${legacyAqua("supabase db reset")} to verify that the new migration does not generate errors.`;

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

/**
 * Rebuilds the `db diff` argv for the pgAdmin / pg-schema delegate path. Flags
 * stay flags (the Go-proxy channel-parity rule). The explicit `--from`/`--to` and
 * engine mutex are already handled before this runs, so it just forwards the
 * engine flag that won plus the target / schema / file flags the user passed.
 */
const rebuildDelegateArgs = (flags: LegacyDbDiffFlags): Array<string> => {
  const args = ["db", "diff"];
  const pushBool = (name: string, value: Option.Option<boolean>) => {
    // Engine flags act on their value, so only an explicitly-true one is
    // meaningful; `Some(false)` equals the cobra default.
    if (Option.isSome(value) && value.value) args.push(`--${name}`);
  };
  const pushTarget = (name: string, value: Option.Option<boolean>) => {
    // Target flags (linked/local) are *selectors*: Go's ParseDatabaseConfig keys
    // off `flag.Changed` before the value (`internal/utils/flags/db_url.go`), so a
    // Changed-but-false flag still selects that target. Forward whenever `Some`
    // (emitting `--flag=false` for `Some(false)`) so the child's `flag.Changed`
    // matches the parent's `Option.isSome`; otherwise the child falls through to a
    // different default target than the one the native path resolved.
    if (Option.isSome(value)) args.push(value.value ? `--${name}` : `--${name}=false`);
  };
  pushBool("use-migra", flags.useMigra);
  pushBool("use-pgadmin", flags.usePgAdmin);
  pushBool("use-pg-schema", flags.usePgSchema);
  pushBool("use-pg-delta", flags.usePgDelta);
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
  const seam = yield* LegacyDeclarativeSeam;
  const proxy = yield* LegacyGoProxy;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dnsResolver = yield* LegacyDnsResolverFlag;

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
              });
              const ref2 = Option.getOrUndefined(resolved.ref ?? Option.none());
              if (ref2 !== undefined) {
                linkedRefForCache = ref2;
                mergedLinkedRef = ref2;
                cfg = yield* legacyReadDbToml(fs, path, cliConfig.workdir, ref2);
              }
              return connToUrl(resolved.conn);
            }
            case "migrations":
              return yield* seam.exportCatalog({
                mode: "migrations",
                noCache: false,
                // Pass the linked ref only if one resolved earlier in the cascade,
                // so the `__catalog` child merges the same remote override Go's
                // in-process migrations catalog sees (`explicit.go:88-126`). Absent
                // otherwise → base config, matching Go's resolution order.
                ...(mergedLinkedRef !== undefined ? { projectRef: mergedLinkedRef } : {}),
              });
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
        projectId: Option.getOrElse(cliConfig.projectId, () => ""),
        cwd: cliConfig.workdir,
        npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
        denoVersion: cfg.denoVersion,
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
        yield* fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
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

    // pgAdmin / pg-schema delegate to the bundled Go binary (Go's `RunPgAdmin` /
    // `DiffPgSchema` are not ported). They are explicit engine selections that do
    // not depend on config, so they short-circuit before the target resolve.
    // Disable the child's telemetry so the single `cli_command_executed` event
    // comes from this TS command's instrumentation.
    const usePgAdmin = Option.getOrElse(flags.usePgAdmin, () => false);
    const usePgSchema = Option.getOrElse(flags.usePgSchema, () => false);
    // Runs the delegated engine via the Go binary. In machine-output mode the
    // child's stdout is captured and re-emitted as a structured envelope, so
    // scripted callers get valid JSON instead of the Go child's raw SQL on stdout
    // (CLI-1546: stdout is payload-only in machine mode). The delegated child owns
    // any `--file` write, so the written migration path isn't introspectable here
    // (reported as `file: null`).
    const delegateDiff = (engine: "pgadmin" | "pg-schema") =>
      Effect.gen(function* () {
        const env = { SUPABASE_TELEMETRY_DISABLED: "1" };
        if (output.format !== "text") {
          const captured = yield* proxy.execCapture(rebuildDelegateArgs(flags), { env });
          yield* output.success("Diff complete.", {
            diff: captured,
            file: null,
            schemas: flags.schema,
            engine,
          });
          return;
        }
        yield* proxy.exec(rebuildDelegateArgs(flags), { env });
      });
    if (usePgAdmin) {
      yield* delegateDiff("pgadmin");
      return;
    }
    if (usePgSchema) {
      // The delegated Go `db diff --use-pg-schema` prints the experimental
      // warning itself in its RunE (`cmd/db.go`), so don't pre-print it here —
      // doing so would double the warning. Mirror the --use-pgadmin branch above.
      yield* delegateDiff("pg-schema");
      return;
    }

    // Native path: resolve the target, provision a live shadow source, then diff.
    const connType: LegacyDbConnType = Option.isSome(flags.dbUrl)
      ? "db-url"
      : Option.isSome(flags.linked)
        ? "linked"
        : "local";
    const resolved = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType,
      dnsResolver,
      password: Option.none(),
    });
    const linkedRef = Option.getOrUndefined(resolved.ref ?? Option.none());
    if (linkedRef !== undefined) linkedRefForCache = linkedRef;
    const targetUrl = connToUrl(resolved.conn);

    // Read config with the resolved linked ref so a matching `[remotes.<ref>]`
    // block merges before the engine/format/runtime are read — Go loads config
    // after `LoadProjectRef` on the linked path (`flags/db_url.go:87-97`). The
    // default `db diff` target is local/db-url, which never merges a remote block,
    // so it reads the base config here (Go's local/direct `LoadConfig`, no ref).
    const cfg =
      connType === "linked" && linkedRef !== undefined
        ? yield* legacyReadDbToml(fs, path, cliConfig.workdir, linkedRef)
        : yield* legacyReadDbToml(fs, path, cliConfig.workdir);
    const ctx: LegacyPgDeltaContext = {
      projectId: Option.getOrElse(cliConfig.projectId, () => ""),
      cwd: cliConfig.workdir,
      npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
      denoVersion: cfg.denoVersion,
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

    yield* output.raw("Creating shadow database...\n", "stderr");
    const shadow = yield* seam.provisionShadow({
      mode: "diff",
      targetLocal: resolved.isLocal,
      usePgDelta: useDelta,
      schema: flags.schema,
      // Linked path only: the shadow merges the same `[remotes.<ref>]` override
      // the engine/format read above (Go builds the shadow from the remote-merged
      // config). Default `db diff` is local, which never merges a remote block.
      projectRef: connType === "linked" ? linkedRef : undefined,
    });

    const out = yield* Effect.gen(function* () {
      const target = shadow.targetUrlOverride ?? targetUrl;
      yield* output.raw(
        flags.schema.length > 0
          ? `Diffing schemas: ${flags.schema.join(",")}\n`
          : "Diffing schemas...\n",
        "stderr",
      );
      if (useDelta) {
        const result = yield* legacyDiffPgDelta(ctx, {
          sourceRef: shadow.sourceUrl,
          targetRef: target,
          schema: flags.schema,
          formatOptions,
        });
        return result.sql;
      }
      return yield* legacyDiffMigra(ctx, {
        source: shadow.sourceUrl,
        target,
        schema: flags.schema,
        connectOptions: { isLocal: resolved.isLocal, dnsResolver },
      });
    }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));

    // Detect the branch from the resolved workdir, not the caller's CWD: Go
    // chdirs into --workdir in PersistentPreRunE before GetGitBranch
    // (`cmd/root.go`), so `supabase --workdir … db diff` must report the
    // project's branch, not the directory the command was invoked from.
    const branch = Option.getOrElse(yield* detectGitBranch(cliConfig.workdir), () => "main");
    yield* output.raw(
      `Finished ${legacyAqua("supabase db diff")} on branch ${legacyAqua(branch)}.\n\n`,
      "stderr",
    );

    // Go's `SaveDiff` (`pgadmin.go:20`) + the drop-statement warning (`diff.go:44`).
    const engine = useDelta ? "pg-delta" : "migra";
    const drops = legacyFindDropStatements(out);
    let writtenFile: string | null = null;
    if (out.length < 2) {
      yield* output.raw("No schema changes found\n", "stderr");
      // Go's `SaveDiff` gates the file write on `len(file) > 0` (`pgadmin.go`), so
      // an empty `--file=""` (e.g. an unset shell var) falls through to stdout
      // rather than writing a `<timestamp>_.sql` migration with no name.
    } else if (Option.isSome(flags.file) && flags.file.value.length > 0) {
      const timestamp = legacyFormatMigrationTimestamp(yield* Clock.currentTimeMillis);
      const migrationPath = legacyGetMigrationPath(
        path,
        cliConfig.workdir,
        timestamp,
        flags.file.value,
      );
      yield* fs
        .makeDirectory(path.dirname(migrationPath), { recursive: true })
        .pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
      yield* fs
        .writeFileString(migrationPath, out)
        .pipe(Effect.mapError((cause) => new LegacyDbDiffWriteError({ message: cause.message })));
      writtenFile = migrationPath;
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
        file: writtenFile,
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
  );
});
