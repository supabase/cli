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
  // Go's `dbDeclarativeCmd.PersistentPreRunE` calls `flags.LoadConfig` — which runs
  // `loadNestedEnv` and `os.Setenv`s each project-.env key — BEFORE reading
  // `viper.GetBool("EXPERIMENTAL")` for the gate below (`apps/cli-go/cmd/
  // db_schema_declarative.go:73-78`, `pkg/config/config.go:789`). Load the project env
  // first and resolve against it, as `db reset` does for its own experimental gate, so a
  // `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` opens the gate too.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  // `--yes` OR `SUPABASE_YES` (shell env or project `.env`): Go's prompts here
  // read `viper.GetBool("YES")` after `loadNestedEnv`, so the env var must
  // auto-confirm too, not just the flag (CLI-1974).
  const yes = yield* resolveYesWithProjectEnv(projectEnv);

  // The resolved linked ref (explicit `--linked` only), hoisted so the post-run
  // linked-project cache finalizer can read it after the body resolves it.
  let linkedProjectRef: string | undefined;

  yield* Effect.gen(function* () {
    const baseToml = yield* readDbToml(fs, path, cliSettings.workdir);
    // Gate before the mutex check below — order matters; see
    // requirePgDelta's doc comment for why. The pg-delta gate also runs on
    // the BASE config: Go's declarative `PersistentPreRunE` gates before the root
    // `ParseDatabaseConfig` reloads any `[remotes.<ref>]` block, so a remote
    // `experimental.pgdelta.enabled = true` must NOT enable a base-disabled
    // command without `--experimental`.
    yield* requirePgDelta({
      experimental,
      pgDeltaEnabled: baseToml.pgDelta.enabled,
      configPath: path.join("supabase", "config.toml"),
    });

    // cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
    // (`apps/cli-go/cmd/db_schema_declarative.go:570`, deleted in CLI-1970;
    // last present at commit 7b469f5b3) runs via
    // `ValidateFlagGroups()`, which cobra invokes AFTER `PersistentPreRunE` (the
    // gate above) — see requirePgDelta's doc comment for the full ordering.
    // "Set" follows cobra's `Changed`: Option set when `Some`, boolean when `true`.
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

    // Explicit `--linked`: Go re-loads config with the resolved ref (root
    // `ParseDatabaseConfig` linked branch), so a matching `[remotes.<ref>]` block
    // overrides `experimental.pgdelta.*` (declarative_schema_path / format_options)
    // for the downstream path/format settings only — NOT the gate above. (Smart-mode
    // "Linked project" does NOT re-load in Go, so it is excluded — only `flags.linked`.)
    let toml = baseToml;
    // The resolved linked ref (explicit `--linked` only) is threaded into the
    // native raw-shadow export source (so its platform setup uses the
    // remote-merged config, matching Go's `Generate`) and into the post-run
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

    // Preserve the selected value for user-facing output: invocation-local
    // `--output` wins, otherwise use the configured declarative path. File I/O
    // resolves relative values from the project workdir while keeping absolute
    // values unchanged.
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
        // `resolvePgDeltaProjectId` mirrors Go's `Config.ProjectId` singleton
        // (`SUPABASE_PROJECT_ID` env → config.toml's `project_id` → sanitized workdir
        // basename) — NOT `cliSettings.projectId` alone, which is env-only and resolves to
        // `""` for a project relying on config.toml's `project_id` or the workdir-basename
        // default, mounting the WRONG `supabase_edge_runtime_` Deno-cache volume. `toml`
        // reflects any `--linked` remote merge above, so its own `appliedRemote`/`projectId`
        // suppress a conflicting ambient env var the same way `db diff`/`db pull` do.
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
        // Target selection keys off flag presence (Go's `Changed`), but the
        // auto-start gates on the boolean VALUE: Go passes `declarativeLocal` to
        // `ensureLocalDatabaseStarted` (`db_schema_declarative.go:190`), which
        // short-circuits `if !local { return nil }` (`:127-128`). So `--local=false`
        // selects the local target but must NOT start a stopped stack.
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
        // Go asks via Console.PromptYesNo (db_schema_declarative.go:268-270,
        // default false): --yes/SUPABASE_YES auto-confirms WITH the
        // `<label> [y/N] y` stderr echo (console.go:70-72) — routed through
        // `promptYesNo` so the echo is not skipped (CLI-1974).
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
      // Go's `runDeclarativeGenerate` calls `flags.LoadProjectRef` ONLY inside the
      // `hasMigrationFiles` branch (`db_schema_declarative.go:219-224`): it offers a
      // "Linked project" choice when the workdir is linked, and that `LoadProjectRef`
      // sets the global `flags.ProjectRef`, so root `ensureProjectGroupsCached` writes
      // the linked-project cache/groups regardless of which target the user then picks
      // (`cmd/root.go:176,214-218`). Resolve the ref the same way the resolver's
      // `--linked` branch does (config `project_id` → `.temp/project-ref`) — only when
      // migrations exist (matching Go's placement; no read in the no-migrations path) —
      // and record it for the post-run cache finalizer so smart generate in a linked
      // workdir caches like Go even when the user chooses local/custom.
      let linkedRef = Option.none<string>();
      if (hasMigrations) {
        // Smart prompt only decides whether to OFFER the linked choice — Go guards
        // this `LoadProjectRef` with `if err == nil` (`db_schema_declarative.go:222-224`),
        // ignoring read/validation errors and proceeding with local/custom. So swallow
        // a broken `.temp/project-ref` here (omit the linked choice) rather than
        // aborting; the explicit `--linked` branch above keeps propagating (hard path).
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
      // Go's confirmOverwrite goes through Console.PromptYesNo (`internal/db/
      // declarative/declarative.go:234`, default false): --yes/SUPABASE_YES
      // auto-confirms WITH the `<label> [y/N] y` stderr echo (console.go:70-72)
      // — routed through `promptYesNo` so the echo is not skipped
      // (CLI-1974).
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
    // Go's `ensureProjectGroupsCached` PersistentPostRun (`cmd/root.go:176,214-234`)
    // writes the linked-project cache (`GET /v1/projects/{ref}` →
    // `supabase/.temp/linked-project.json`) for any resolved ref, on success and
    // failure. Only explicit `--linked` resolves a ref here (Go gates on
    // `flags.ProjectRef != ""`); the cache layer no-ops when the file exists, the
    // token is missing, or the GET is non-200. Read the ref lazily — it is assigned
    // inside the body above.
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

// The overwrite-confirmation guard, mirroring Go's `confirmOverwrite`
// (`apps/cli-go/internal/db/declarative/declarative.go:220-235`). Unlike the
// smart-mode `hasDeclarativeFiles` above (which matches `cmd.hasDeclarativeFiles`
// and swallows read errors), `confirmOverwrite` returns the `ReadDir` error and
// `Generate` aborts on it (`declarative.go:123-127`). So an unreadable-but-existing
// declarative dir must abort here rather than read as "empty" and get silently
// overwritten by `writeDeclarativeSchemas`. Only a not-exist directory means
// "no confirmation needed"; Go returns the raw error, so let the `PlatformError`
// propagate unwrapped.
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
  // Smart-mode presence/prompt probe only: mirror Go's `cmd.hasMigrationFiles`
  // (`db_schema_declarative.go:164-169`), which wraps `migration.ListLocalMigrations`
  // and returns `false` on EVERY error (unreadable dir, path-is-a-file, …), not just
  // not-exist — so generate continues into the no-migrations local flow. The real diff
  // path keeps `listLocalMigrations`' hard error behavior (Go `declarative.go:369`).
  const migrations = yield* listLocalMigrations(fs, path, migrationsDir).pipe(
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );
  return migrations.length > 0;
});
