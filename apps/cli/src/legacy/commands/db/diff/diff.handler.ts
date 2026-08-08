import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import { detectGitBranch } from "../../../../shared/git/git-branch.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyAqua, legacyYellow } from "../../../shared/legacy-colors.ts";
import { legacyReadDbToml } from "../../../shared/legacy-db-config.toml-read.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyDbConnType } from "../../../shared/legacy-db-target-flags.ts";
import { legacyGetHostname } from "../../../shared/legacy-hostname.ts";
import { legacyMakeDir } from "../../../shared/legacy-make-dir.ts";
import { legacyToPostgresURL } from "../../../shared/legacy-postgres-url.ts";
import { legacySchemaToCsvField } from "../../../shared/legacy-schema-flags.ts";
import { legacyFindDropStatements } from "../../../shared/legacy-sql-split.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyParseBoolEnv,
  legacyResolveDiffEngine,
  legacySchemaPathsTransitionWarning,
  legacyShouldUsePgDelta,
} from "../../../shared/legacy-diff-engine.ts";
import {
  legacyFormatMigrationTimestamp,
  legacyGetMigrationPath,
} from "../../../shared/legacy-migration-file.ts";
import { legacyDiffMigra } from "../shared/legacy-migra.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDatabaseEndpoint,
  type LegacyPgDeltaEndpoint,
} from "../shared/legacy-pgdelta-engine.service.ts";
import { legacyWritePgDeltaMigrations } from "../shared/legacy-pgdelta-migrations.write.ts";
import {
  legacyIsPgDeltaDebugEnabled,
  type LegacyPgDeltaContext,
} from "../../../shared/legacy-pgdelta.ts";
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
  const pgDelta = yield* LegacyPgDeltaEngine;
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
      const resolveRef = (ref: string): Effect.Effect<LegacyPgDeltaEndpoint, unknown> =>
        Effect.gen(function* () {
          switch (legacyClassifyExplicitRef(ref)) {
            case "local": {
              const connection = {
                host: legacyGetHostname(),
                port: cfg.port,
                user: "postgres",
                password: cfg.password,
                database: "postgres",
              };
              return {
                kind: "database",
                ref: legacyToPostgresURL(connection),
                connection,
                connectOptions: { isLocal: true, dnsResolver },
              } satisfies LegacyPgDeltaDatabaseEndpoint;
            }
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
              return {
                kind: "database",
                ref: legacyToPostgresURL(resolved.conn),
                connection: resolved.conn,
                connectOptions: { isLocal: resolved.isLocal, dnsResolver },
              } satisfies LegacyPgDeltaDatabaseEndpoint;
            }
            case "migrations":
              return {
                kind: "migrations",
                // Preserve resolution order: only refs resolved before this endpoint
                // influence the migrations shadow/catalog.
                ...(mergedLinkedRef !== undefined ? { projectRef: mergedLinkedRef } : {}),
              } satisfies LegacyPgDeltaEndpoint;
            case "url":
              return {
                kind: "database",
                ref,
                // The next engine parses arbitrary explicit URLs itself. They are
                // remote by default, matching Go's TLS-safe connection path.
                connectOptions: { isLocal: false, dnsResolver },
              } satisfies LegacyPgDeltaDatabaseEndpoint;
            default:
              return yield* Effect.fail(
                new LegacyDbDiffUnknownTargetError({ message: legacyUnknownTargetMessage(ref) }),
              );
          }
        });
      const source = yield* resolveRef(from);
      const desired = yield* resolveRef(to);
      const explicitCtx: LegacyPgDeltaContext = {
        projectId: Option.getOrElse(cliConfig.projectId, () => ""),
        cwd: cliConfig.workdir,
        npmVersion: Option.getOrUndefined(cfg.pgDelta.npmVersion),
        denoVersion: cfg.denoVersion,
      };
      const result = yield* pgDelta.diffExplicit({
        context: explicitCtx,
        source,
        desired,
        schema: flags.schema,
        formatOptions: Option.getOrElse(cfg.pgDelta.formatOptions, () => ""),
        debug: legacyIsPgDeltaDebugEnabled(),
        strictCoverage: flags.strictCoverage,
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
      // CLI-1960: TS-only deprecation notice, printed before delegating (in both
      // text and machine output modes — diagnostics stay stderr-only per CLI-1546).
      // The delegated Go `db diff --use-pg-schema` still prints its own experimental
      // warning itself in its RunE (`cmd/db.go`); this is additive, not a
      // replacement, so don't drop it. Mirror the --use-pgadmin branch above.
      yield* output.raw(`${warnPgSchemaDeprecated}\n`, "stderr");
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
    const targetUrl = legacyToPostgresURL(resolved.conn);

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
    if (cfg.schemaPaths !== undefined && cfg.schemaPaths.length > 0) {
      yield* output.raw(legacySchemaPathsTransitionWarning, "stderr");
    }

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
    const diffingMessage =
      flags.schema.length > 0
        ? `Diffing schemas: ${flags.schema.join(",")}\n`
        : "Diffing schemas...\n";
    const diffResult = useDelta
      ? yield* Effect.gen(function* () {
          // The selected strategy owns pg-delta shadow/pool lifecycles. This message
          // precedes the call because the high-level boundary intentionally exposes
          // no partially-provisioned resource to the handler.
          yield* output.raw(diffingMessage, "stderr");
          const result = yield* pgDelta.diffDatabase({
            context: ctx,
            target: {
              kind: "database",
              ref: targetUrl,
              connection: resolved.conn,
              connectOptions: { isLocal: resolved.isLocal, dnsResolver },
            },
            schema: flags.schema,
            formatOptions,
            ...(connType === "linked" && linkedRef !== undefined ? { projectRef: linkedRef } : {}),
            debug: legacyIsPgDeltaDebugEnabled(),
            strictCoverage: flags.strictCoverage,
          });
          return { sql: result.sql, files: result.files };
        })
      : yield* Effect.gen(function* () {
          const shadow = yield* seam.provisionShadow({
            mode: "diff",
            schema: flags.schema,
            ...(connType === "linked" && linkedRef !== undefined ? { projectRef: linkedRef } : {}),
          });
          return yield* Effect.gen(function* () {
            yield* output.raw(diffingMessage, "stderr");
            const sql = yield* legacyDiffMigra(ctx, {
              source: shadow.sourceUrl,
              target: targetUrl,
              schema: flags.schema,
              connectOptions: { isLocal: resolved.isLocal, dnsResolver },
            });
            return { sql, files: undefined };
          }).pipe(Effect.ensuring(seam.removeShadowContainer(shadow.container)));
        });
    const out = diffResult.sql;

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
          files: planFiles.map((file) => ({
            name:
              file.suffix !== undefined && file.suffix !== null
                ? file.suffix.replace(/^_/u, "")
                : file.name,
            sql: file.sql,
            transactionMode: file.transactionMode,
          })),
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
  );
});
