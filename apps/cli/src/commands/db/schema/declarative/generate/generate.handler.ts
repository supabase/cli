import { Effect, FileSystem, Option, Path } from "effect";

import {
  DnsResolverFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../../command-internal/prompt-yes-no.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { bold } from "../../../../../command-internal/colors.ts";
import { readProjectRefFile } from "../../../../../command-internal/temp-paths.ts";
import {
  loadProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
} from "../../../../../command-internal/db-config.toml-read.ts";
import { LinkedProjectCache } from "../../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { listLocalMigrations } from "../../../../../command-internal/migration-list.ts";
import {
  isPgDeltaDebugEnabled,
  resolvePgDeltaProjectId,
} from "../../../../../command-internal/pgdelta.ts";
import type { PgDeltaDatabaseEndpoint } from "../../../shared/pgdelta-engine.service.ts";
import { DeclarativeWriteError } from "../../../shared/pgdelta.errors.ts";
import {
  DeclarativeMutuallyExclusiveFlagsError,
  DeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { DeclarativeSeam } from "../../../shared/pgdelta.seam.service.ts";
import { warnFormerDeclarativeDefault } from "../declarative.former-default.ts";
import { requirePgDelta } from "../declarative.gate.ts";
import {
  type DeclarativeRunContext,
  generateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import {
  declarativeSchemaWrittenLine,
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "../../../shared/pgdelta.write.ts";
import type { DbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import {
  type LocalConn,
  localEndpoint,
  resolveRemoteEndpoint,
  resolveSmartTargetEndpoint,
} from "../declarative.smart-target.ts";

export const dbSchemaDeclarativeGenerate = Effect.fn("db.schema.declarative.generate")(function* (
  flags: DbSchemaDeclarativeGenerateFlags,
) {
  const output = yield* Output;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const dnsResolver = yield* DnsResolverFlag;
  // The project env is loaded and resolved before the gate below, so a `SUPABASE_EXPERIMENTAL`
  // set only in `supabase/.env` opens the gate too.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  // `--yes` or `SUPABASE_YES` (shell env or project `.env`) must auto-confirm the prompts below.
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // The resolved linked ref (explicit `--linked` only), hoisted so the post-run
  // linked-project cache finalizer can read it after the body resolves it.
  let linkedProjectRef: string | undefined;

  yield* Effect.gen(function* () {
    const baseToml = yield* readDbToml(fs, path, cliSettings.workdir);
    // Gate before the mutex check below (see `requirePgDelta`'s doc comment for why), and on the
    // base config: a remote `experimental.pgdelta.enabled = true` must not enable a
    // base-disabled command without `--experimental`.
    yield* requirePgDelta({
      experimental,
      pgDeltaEnabled: baseToml.pgDelta.enabled,
      configPath: path.join("supabase", "config.toml"),
    });

    // Mutually-exclusive db-url/linked/local group, checked after the gate above (see
    // `requirePgDelta`'s doc comment for the ordering). "Set" means explicitly set: Option
    // `Some`, or boolean `true`.
    const exclusive: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
    if (Option.isSome(flags.linked)) exclusive.push("linked");
    if (Option.isSome(flags.local)) exclusive.push("local");
    if (exclusive.length > 1) {
      return yield* Effect.fail(
        new DeclarativeMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
        }),
      );
    }

    // Explicit `--linked` re-loads config with the resolved ref, so a matching `[remotes.<ref>]`
    // block overrides `experimental.pgdelta.*` downstream only, not the gate above. Smart-mode's
    // "Linked project" choice does not re-load, so only `flags.linked` triggers this.
    let toml = baseToml;
    // The resolved linked ref (explicit `--linked` only) is threaded into the raw-shadow export
    // source, so its platform setup uses the remote-merged config, and into the post-run
    // linked-project cache finalizer below.
    if (Option.isSome(flags.linked)) {
      const linkedRef = Option.isSome(cliSettings.projectId)
        ? cliSettings.projectId
        : yield* readProjectRefFile(fs, path, cliSettings.workdir);
      if (Option.isSome(linkedRef)) {
        linkedProjectRef = linkedRef.value;
        toml = yield* readDbToml(fs, path, cliSettings.workdir, linkedRef.value);
      }
    }

    // Preserve the selected value for user-facing output: invocation-local `--output` wins,
    // otherwise the configured declarative path. File I/O resolves relative values from the
    // project workdir while keeping absolute values unchanged.
    const declarativeDirRel = Option.getOrElse(flags.outputDir, () =>
      resolveDeclarativeDir(path, toml.pgDelta),
    );
    const workdir = path.resolve(cliSettings.workdir);
    const declarativeDir = path.resolve(workdir, declarativeDirRel);
    const workdirFromOutput = path.relative(declarativeDir, workdir);
    const outputContainsWorkdir =
      workdirFromOutput.length === 0 ||
      (!path.isAbsolute(workdirFromOutput) &&
        workdirFromOutput !== ".." &&
        !workdirFromOutput.startsWith(`..${path.sep}`));
    if (declarativeDirRel.trim().length === 0 || outputContainsWorkdir) {
      return yield* Effect.fail(
        new DeclarativeWriteError({
          message:
            "declarative output directory must not be empty, resolve to the project directory, or contain the project directory",
        }),
      );
    }
    yield* warnFormerDeclarativeDefault(fs, path, cliSettings.workdir, toml.pgDelta);
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
    const local: LocalConn = { port: toml.port, password: toml.password };

    const run: DeclarativeRunContext = {
      pgDelta: {
        // `resolvePgDeltaProjectId` resolves `SUPABASE_PROJECT_ID` env → config.toml's
        // `project_id` → sanitized workdir basename — not `cliSettings.projectId` alone, which
        // is env-only and would mount the wrong `supabase_edge_runtime_` Deno-cache volume for a
        // project relying on config or the workdir-basename default.
        projectId: resolvePgDeltaProjectId(cliSettings.projectId, toml, cliSettings.workdir),
        cwd: cliSettings.workdir,
        // Merged config's deno_version (re-loaded with the linked ref above on
        // `--linked`), so pg-delta runs under the remote-configured Deno image.
        denoVersion: toml.denoVersion,
        projectEnv: toml.projectEnv,
      },
      formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
      declarativeDir,
      declarativeDirDisplay: declarativeDirRel,
      schema: flags.schema,
      noCache: flags.noCache,
      debug: isPgDeltaDebugEnabled(),
      strictCoverage: flags.strictCoverage,
      dnsResolver,
      ...(linkedProjectRef !== undefined ? { linkedProjectRef } : {}),
    };

    const hasExplicitTarget =
      Option.isSome(flags.local) || Option.isSome(flags.linked) || Option.isSome(flags.dbUrl);

    let target: PgDeltaDatabaseEndpoint;
    let overwrite: boolean;
    if (hasExplicitTarget) {
      const seam = yield* DeclarativeSeam;
      if (Option.isSome(flags.local)) {
        // Target selection keys off flag presence, but auto-start gates on the boolean value, so
        // `--local=false` selects the local target but must not start a stopped stack.
        yield* seam.ensureLocalPostgresImageCurrent();
        if (Option.getOrElse(flags.local, () => false)) {
          yield* seam.ensureLocalDatabaseStarted();
        }
        target = localEndpoint(local, dnsResolver);
      } else {
        target = yield* resolveRemoteEndpoint(flags);
      }
      overwrite = flags.overwrite;
    } else {
      if (!tty.stdinIsTty && !yes) {
        return yield* Effect.fail(
          new DeclarativeNonInteractiveError({
            message: "in non-interactive mode, specify a target: --local, --linked, or --db-url",
          }),
        );
      }
      if ((yield* hasDeclarativeFiles(fs, declarativeDir)) && !flags.overwrite) {
        // `--yes`/`SUPABASE_YES` auto-confirms, but still echoes the `<label> [y/N] y` stderr
        // line via `promptYesNo` rather than skipping it.
        const ok = yield* promptYesNo(
          output,
          yes,
          `Declarative schema already exists at ${bold(
            declarativeDirRel,
          )}. Regenerate from database? This will overwrite existing files.`,
          false,
        );
        if (!ok) {
          yield* output.raw("Skipped generating declarative schema.\n", "stderr");
          return;
        }
      }
      const hasMigrations = yield* hasMigrationFiles(fs, path, migrationsDir);
      // Only when migrations exist, resolve the ref (config `project_id` → `.temp/project-ref`)
      // and record it for the post-run cache finalizer, so smart generate in a linked workdir
      // caches the project regardless of which target the user picks.
      let linkedRef = Option.none<string>();
      if (hasMigrations) {
        // Only decides whether to offer the linked choice, so swallow a broken
        // `.temp/project-ref` here (omit the choice) rather than aborting; the explicit
        // `--linked` branch above still propagates a real failure.
        linkedRef = Option.isSome(cliSettings.projectId)
          ? cliSettings.projectId
          : yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            );
        if (Option.isSome(linkedRef)) {
          linkedProjectRef = linkedRef.value;
        }
      }
      target = yield* resolveSmartTargetEndpoint(
        flags,
        local,
        hasMigrations,
        fs,
        path,
        cliSettings.workdir,
        linkedRef,
        (yield* DeclarativeSeam).ensureLocalPostgresImageCurrent(),
      );
      overwrite = true;
    }

    const result = yield* generateDeclarativeOutput(run, target);

    if (!overwrite && (yield* confirmOverwriteHasFiles(fs, declarativeDir))) {
      // `--yes`/`SUPABASE_YES` auto-confirms, but still echoes the `<label> [y/N] y` stderr line
      // via `promptYesNo` rather than skipping it.
      const ok = yield* promptYesNo(
        output,
        yes,
        "Overwrite declarative schema? Existing files may be deleted.",
        false,
      );
      if (!ok) {
        yield* output.raw("Skipped writing declarative schema.\n", "stderr");
        return;
      }
    }

    const written = yield* writeDeclarativeSchemas(fs, path, declarativeDir, result);
    // The overwrite prompts above promise existing files may be deleted, but the
    // next writer only prunes what an export manifest claimed — say so when a
    // manifest-less directory kept files the export did not replace.
    yield* warnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
    yield* output.raw(declarativeSchemaWrittenLine(declarativeDirRel), "stderr");
  }).pipe(
    // Writes the linked-project cache for any resolved ref, on success and failure. Only
    // explicit `--linked` resolves a ref here; the cache layer no-ops when the file exists, the
    // token is missing, or the GET is non-200.
    Effect.ensuring(
      Effect.suspend(() =>
        linkedProjectRef !== undefined ? linkedProjectCache.cache(linkedProjectRef) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

const hasDeclarativeFiles = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  return entries.length > 0;
});

// The overwrite-confirmation guard. Unlike the smart-mode `hasDeclarativeFiles` above (which
// swallows read errors), an unreadable-but-existing declarative dir must abort here rather than
// read as "empty" and get silently overwritten by `writeDeclarativeSchemas`; only a not-exist
// directory means "no confirmation needed", so let any other `PlatformError` propagate unwrapped.
const confirmOverwriteHasFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<ReadonlyArray<string>>([])
          : Effect.fail(error),
      ),
    );
  return entries.length > 0;
});

const hasMigrationFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  // Smart-mode presence/prompt probe only: returns `false` on any error (unreadable dir,
  // path-is-a-file, not-exist, …), so generate continues into the no-migrations local flow. The
  // real diff path keeps `listLocalMigrations`'s hard error behavior instead.
  const migrations = yield* listLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );
  return migrations.length > 0;
});
