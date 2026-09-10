import { Cause, Clock, Effect, Exit, FileSystem, Option, Path, Ref, Result } from "effect";

import {
  DnsResolverFlag,
  resolveExperimentalWithProjectEnv,
  resolveYesWithProjectEnv,
} from "../../../../../command-internal/global-flags.ts";
import { promptYesNo } from "../../../../../command-internal/prompt-yes-no.ts";
import { MachineErrorContext } from "../../../../../shared/output/machine-error-context.service.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { resetLocalDatabase } from "../../../../../command-internal/db-bootstrap/reset-local-database.ts";
import { aqua, bold, red, yellow } from "../../../../../command-internal/colors.ts";
import { DbConnectError } from "../../../../../command-internal/db-connection.errors.ts";
import { DbConnection } from "../../../../../command-internal/db-connection.service.ts";
import { getHostname } from "../../../../../command-internal/hostname.ts";
import {
  loadProjectEnv,
  readDbToml,
  resolveDeclarativeDir,
} from "../../../../../command-internal/db-config.toml-read.ts";
import {
  applyMigrationFile,
  applyRenderedSqlUnits,
} from "../../../../../command-internal/migration-apply.ts";
import { ENABLE_LOCAL_WEBHOOKS_SUGGESTION } from "../../../../../command-internal/pg-net-guidance.ts";
import { readProjectRefFile } from "../../../../../command-internal/temp-paths.ts";
import { LinkedProjectCache } from "../../../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../../../telemetry/telemetry-state.service.ts";
import { listLocalMigrations } from "../../../../../command-internal/migration-list.ts";
import { pgDeltaTempPath } from "../../../../../command-internal/pgdelta.paths.ts";
import {
  isPgDeltaDebugEnabled,
  resolvePgDeltaProjectId,
} from "../../../../../command-internal/pgdelta.ts";
import { writePgDeltaMigrations } from "../../../shared/pgdelta-migrations.write.ts";
import { localEndpoint, resolveSmartTargetEndpoint } from "../declarative.smart-target.ts";
import {
  type DebugBundle,
  type DebugBundleResult,
  collectMigrationsList,
  debugBundleMessage,
  formatDebugId,
  saveDebugBundle,
} from "../../../shared/debug-bundle.ts";
import { ListPgDeltaSqlFiles } from "../../../shared/pgdelta-files.ts";
import {
  DeclarativeApplyError,
  DeclarativeCompatibilityError,
  DeclarativeDiffError,
  DeclarativeInvalidMigrationStemError,
  DeclarativeLocalDbNotRunningError,
  DeclarativeMutuallyExclusiveFlagsError,
  DeclarativeNoFilesGeneratedError,
  DeclarativeNonInteractiveError,
  DeclarativeTransientConfirmationRequiredError,
  readErrorSuggestion,
} from "../declarative.errors.ts";
import {
  classifyDeclarativeCompatibilityGap,
  currentShellPlatform,
  formatDeclarativeGapEvidence,
  formatDeclarativeUpgradeGate,
  formatStagedExportAdoption,
  resolveStagedDeclarativeDir,
  resolveDeclarativeMigrationName,
  resolveDeclarativeSyncApplyDecision,
  validateDeclarativeMigrationStem,
} from "../declarative.flow.ts";
import { warnFormerDeclarativeDefault } from "../declarative.former-default.ts";
import { appendExtensionDeclarations } from "../declarative.extension-repair.ts";
import { requirePgDelta } from "../declarative.gate.ts";
import {
  type DeclarativeRunContext,
  type DeclarativeSyncResult,
  diffDeclarativeToMigrations,
  generateDeclarativeOutput,
  planDeclarativeToDatabase,
} from "../declarative.orchestrate.ts";
import { DeclarativeSeam } from "../../../shared/pgdelta.seam.service.ts";
import {
  declarativeSchemaWrittenLine,
  warnPreservedUnmanagedDeclarativeFiles,
  writeDeclarativeSchemas,
} from "../../../shared/pgdelta.write.ts";
import type { DbSchemaDeclarativeSyncFlags } from "./sync.command.ts";

const DEFAULT_SYNC_NAME = "declarative_sync";

export const dbSchemaDeclarativeSync = Effect.fn("db.schema.declarative.sync")(function* (
  flags: DbSchemaDeclarativeSyncFlags,
) {
  const output = yield* Output;
  const machineErrorContext = yield* Effect.serviceOption(MachineErrorContext);
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  // The project env is loaded and resolved before the gate below, so a `SUPABASE_EXPERIMENTAL`
  // set only in `supabase/.env` opens the gate too.
  const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
  const experimental = yield* resolveExperimentalWithProjectEnv(projectEnv);
  // `--yes` or `SUPABASE_YES` (shell env or project `.env`) must auto-confirm the prompts below.
  const yes = yield* resolveYesWithProjectEnv(projectEnv);
  const dnsResolver = yield* DnsResolverFlag;
  const seam = yield* DeclarativeSeam;
  const linkedProjectCache = yield* LinkedProjectCache;

  // Set when the bootstrap branch below resolves a linked ref, so the `Effect.ensuring`
  // finalizer at the end of this handler can refresh the linked-project cache.
  let linkedProjectRef: string | undefined;

  yield* Effect.gen(function* () {
    const toml = yield* readDbToml(fs, path, cliSettings.workdir);
    // Gate before the mutex check below — order matters; see
    // requirePgDelta's doc comment for why.
    yield* requirePgDelta({
      experimental,
      pgDeltaEnabled: toml.pgDelta.enabled,
      configPath: path.join("supabase", "config.toml"),
    });

    // Mutually-exclusive apply/no-apply group, checked after the gate above. Reject the conflict
    // here rather than letting `--no-apply` silently win in the apply-decision helper.
    const exclusive: Array<string> = [];
    if (Option.isSome(flags.apply)) exclusive.push("apply");
    if (Option.isSome(flags.noApply)) exclusive.push("no-apply");
    if (exclusive.length > 1) {
      return yield* Effect.fail(
        new DeclarativeMutuallyExclusiveFlagsError({
          message: `if any flags in the group [apply no-apply] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
        }),
      );
    }
    const transient = Option.getOrElse(flags.transient, () => false);
    if (transient) {
      if (Option.isSome(flags.apply) && !flags.apply.value) {
        return yield* Effect.fail(
          new DeclarativeMutuallyExclusiveFlagsError({
            message: "--transient cannot be combined with --apply=false",
          }),
        );
      }
      const conflicts: Array<string> = [];
      if (Option.isSome(flags.noApply)) conflicts.push("no-apply");
      if (Option.isSome(flags.file)) conflicts.push("file");
      if (Option.isSome(flags.name)) conflicts.push("name");
      if (conflicts.length > 0) {
        return yield* Effect.fail(
          new DeclarativeMutuallyExclusiveFlagsError({
            message: `--transient cannot be combined with ${conflicts
              .map((flag) => `--${flag}`)
              .join(", ")}`,
          }),
        );
      }
    }
    if (Option.isSome(flags.file)) {
      const validation = validateDeclarativeMigrationStem(flags.file.value);
      if (validation !== undefined) {
        return yield* Effect.fail(
          new DeclarativeInvalidMigrationStemError({
            message: `invalid --file value: ${validation}`,
          }),
        );
      }
    }
    if (Option.isSome(flags.name)) {
      const validation = validateDeclarativeMigrationStem(flags.name.value);
      if (validation !== undefined) {
        return yield* Effect.fail(
          new DeclarativeInvalidMigrationStemError({
            message: `invalid --name value: ${validation}`,
          }),
        );
      }
    }

    // The config value verbatim (already `supabase/`-prefixed when relative) or the relative
    // `supabase/schemas` default; printed verbatim in the bootstrap's written-to line below.
    const declarativeDirRel = resolveDeclarativeDir(path, toml.pgDelta);
    // `path.resolve` (not `path.join`) so an absolute `declarative_schema_path` is used as-is;
    // `path.join(workdir, abs)` would mangle an absolute path.
    const declarativeDir = path.resolve(cliSettings.workdir, declarativeDirRel);
    const stagedDirRel = resolveStagedDeclarativeDir(declarativeDirRel);
    // Repair prompts name the file they would edit by its full configured path —
    // a bare `extension.sql` is ambiguous in a tree with nested schema folders.
    const extensionSqlRel = path.join(declarativeDirRel, "extension.sql");
    const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
    const tempDir = pgDeltaTempPath(path, cliSettings.workdir);
    const run: DeclarativeRunContext = {
      pgDelta: {
        // `resolvePgDeltaProjectId` resolves `SUPABASE_PROJECT_ID` env → config.toml's
        // `project_id` → sanitized workdir basename — not `cliSettings.projectId` alone, which
        // is env-only and would mount the wrong `supabase_edge_runtime_` Deno-cache volume for a
        // project relying on config or the workdir-basename default.
        projectId: resolvePgDeltaProjectId(cliSettings.projectId, toml, cliSettings.workdir),
        cwd: cliSettings.workdir,
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
    };
    const ensureLocalPostgresImageCurrent = seam.ensureLocalPostgresImageCurrent();
    yield* warnFormerDeclarativeDefault(fs, path, cliSettings.workdir, toml.pgDelta);
    const declarativeFilesExist = yield* declarativeDirHasSqlFiles(fs, declarativeDir);

    // Warns (rather than masking the apply error) and treats the bundle path as empty when the
    // debug directory cannot be created, so an apply failure still surfaces without claiming a
    // bundle was saved.
    const saveApplyDebugBundle = (bundle: DebugBundle) =>
      saveDebugBundle(fs, path, cliSettings.workdir, tempDir, migrationsDir, bundle).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            output
              .raw(`Warning: failed to save debug artifacts: ${error.message}\n`, "stderr")
              .pipe(
                Effect.as({
                  directory: "",
                  migrationSqlSaved: false,
                } satisfies DebugBundleResult),
              ),
          onSuccess: (result) =>
            result.migrationSqlSaved
              ? Effect.succeed(result)
              : output
                  .raw("Warning: failed to save generated SQL debug artifact.\n", "stderr")
                  .pipe(Effect.as(result)),
        }),
      );

    // Step 1: declarative files must exist; in a TTY, offer to generate them.
    if (!declarativeFilesExist) {
      const noFiles = new DeclarativeNonInteractiveError({
        message: "no declarative schema found. Run supabase db schema declarative generate first",
      });
      if (transient) return yield* Effect.fail(noFiles);
      if (!tty.stdinIsTty && !yes) return yield* Effect.fail(noFiles);
      // `--yes`/`SUPABASE_YES` auto-confirms, but still echoes the `<label> [Y/n] y` stderr line
      // via `promptYesNo` rather than skipping it.
      const ok = yield* promptYesNo(
        output,
        yes,
        "No declarative schema found. Generate a new one ?",
        true,
      );
      if (!ok) return yield* Effect.fail(noFiles);
      // Delegates to the full smart-generate flow: with migrations present it offers the
      // local/linked/custom target choice plus a local-reset prompt. The presence probe below
      // swallows read errors rather than aborting the bootstrap; the diff path further down
      // keeps the hard list behavior.
      const hasMigrations =
        (yield* listLocalMigrations(fs, path, migrationsDir).pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
        )).length > 0;
      // Only when migrations exist, resolve the ref (config `project_id` → `.temp/project-ref`)
      // and record it for the finalizer, so a linked-workdir bootstrap caches regardless of the
      // chosen target.
      let linkedRef = Option.none<string>();
      if (hasMigrations) {
        // Only decides whether to offer the linked choice, so swallow a broken
        // `.temp/project-ref` here; `linkedProjectRef` then stays unset so the post-run cache
        // correctly does not fire.
        linkedRef = Option.isSome(cliSettings.projectId)
          ? cliSettings.projectId
          : yield* readProjectRefFile(fs, path, cliSettings.workdir).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            );
        if (Option.isSome(linkedRef)) {
          linkedProjectRef = linkedRef.value;
        }
      }
      // sync has no target flags, so reset stays interactive (the prompt fires under the local
      // choice).
      const target = yield* resolveSmartTargetEndpoint(
        { dbUrl: Option.none(), linked: Option.none(), password: Option.none(), reset: false },
        { port: toml.port, password: toml.password },
        hasMigrations,
        fs,
        path,
        cliSettings.workdir,
        linkedRef,
        ensureLocalPostgresImageCurrent,
      );
      const generated = yield* generateDeclarativeOutput(run, target);
      const written = yield* writeDeclarativeSchemas(fs, path, declarativeDir, generated);
      // A manifest-less directory keeps files the export did not replace, and those
      // files go straight into the plan below — warn before diffing against them.
      yield* warnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
      if (!(yield* declarativeDirHasSqlFiles(fs, declarativeDir))) {
        return yield* Effect.fail(
          new DeclarativeNoFilesGeneratedError({
            message: "declarative schema generation did not produce any files",
          }),
        );
      }
      // Printed on both the interactive-accept and --yes/SUPABASE_YES bootstrap paths, and
      // regardless of `--no-cache` (only the catalog warm is skipped). Uses the relative dir
      // above, never a resolved absolute path.
      yield* output.raw(declarativeSchemaWrittenLine(declarativeDirRel), "stderr");
    }

    const transientSource = transient
      ? yield* Effect.gen(function* () {
          if (!(yield* seam.isLocalDatabaseRunning())) {
            return yield* Effect.fail(
              new DeclarativeLocalDbNotRunningError({
                message: `${aqua("supabase start")} is not running.`,
                suggestion: "Start the local database, then rerun sync --transient.",
              }),
            );
          }
          yield* ensureLocalPostgresImageCurrent;
          return localEndpoint({ port: toml.port, password: toml.password }, dnsResolver);
        })
      : undefined;

    // Step 2: diff migrations state vs declarative; on error, save a debug bundle.
    const stageNextExport = Effect.fnUntraced(function* () {
      const stagedDir = path.resolve(cliSettings.workdir, stagedDirRel);
      // Reject the active directory itself AND anything nested under it: a
      // staged export inside the declarative tree would be loaded recursively
      // by the next sync, and the printed `rm -rf && mv` adoption command
      // would delete the staged copy along with the tree.
      const stagedRelative = path.relative(declarativeDir, stagedDir);
      if (
        stagedRelative === "" ||
        (!stagedRelative.startsWith("..") && !path.isAbsolute(stagedRelative))
      ) {
        return yield* Effect.fail(
          new DeclarativeCompatibilityError({
            message: `${stagedDirRel} is inside the active declarative schema directory; choose a different staging directory.`,
          }),
        );
      }
      const stagedExists = yield* fs.exists(stagedDir).pipe(Effect.orElseSucceed(() => false));
      if (stagedExists) {
        const [entries, hasManifest] = yield* Effect.all([
          fs.readDirectory(stagedDir),
          fs.exists(path.join(stagedDir, ".pgdelta-export.json")),
        ]);
        if (entries.length > 0 && !hasManifest) {
          return yield* Effect.fail(
            new DeclarativeCompatibilityError({
              message: `${stagedDirRel} already contains files without a pg-delta export manifest. Move or remove that directory, then run sync again so the staged export cannot preserve unrelated SQL.`,
            }),
          );
        }
      }
      yield* ensureLocalPostgresImageCurrent;
      yield* seam.ensureLocalDatabaseStarted();
      // The staged export snapshots the running local database verbatim, not a shadow built
      // from migrations (what the failed plan compared) — offer the same reset the smart-target
      // local path offers, so stale Studio-made drift doesn't silently become the staged tree.
      yield* output.raw(
        `Exporting from the running local database (not the migrations state). Review ${stagedDirRel} before adopting it.\n`,
        "stderr",
      );
      const shouldReset = yield* promptYesNo(
        output,
        yes,
        "Reset local database to match migrations first? (local data will be lost)",
        false,
      );
      if (shouldReset) {
        yield* resetLocalDatabase().pipe(
          Effect.mapError(
            (error) =>
              new DeclarativeApplyError({
                message: `database reset failed: ${error.message}`,
                suggestion: readErrorSuggestion(error),
              }),
          ),
        );
      }
      const generated = yield* generateDeclarativeOutput(
        { ...run, declarativeDir: stagedDir },
        localEndpoint({ port: toml.port, password: toml.password }, dnsResolver),
      );
      const written = yield* writeDeclarativeSchemas(fs, path, stagedDir, generated);
      yield* warnPreservedUnmanagedDeclarativeFiles(stagedDirRel, written);
      yield* output.raw(declarativeSchemaWrittenLine(stagedDirRel), "stderr");
      yield* output.raw(
        [
          ...formatStagedExportAdoption({
            declarativeDir: declarativeDirRel,
            schema: flags.schema,
            platform: currentShellPlatform(),
          }),
          "",
        ].join("\n"),
        "stderr",
      );
    });

    const planDeclarativeSync = () =>
      (transientSource === undefined
        ? diffDeclarativeToMigrations(run, toml)
        : planDeclarativeToDatabase(run, toml, transientSource)
      ).pipe(
        Effect.tapError((error) =>
          error instanceof DeclarativeCompatibilityError
            ? Effect.void
            : Effect.gen(function* () {
                const migrations = yield* collectMigrationsList(fs, path, migrationsDir);
                yield* saveDebugBundle(fs, path, cliSettings.workdir, tempDir, migrationsDir, {
                  id: formatDebugId(yield* Clock.currentTimeMillis),
                  error: error.message,
                  migrations,
                }).pipe(
                  Effect.matchEffect({
                    // Prints nothing when the debug bundle itself fails to save.
                    onFailure: () => Effect.void,
                    onSuccess: ({ directory }) =>
                      output.raw(debugBundleMessage(directory), "stderr"),
                  }),
                );
              }),
        ),
      );

    const planWithLoadRecovery = Effect.fnUntraced(function* () {
      while (true) {
        const attempt = yield* planDeclarativeSync().pipe(
          Effect.match({
            onFailure: (error) => ({ error }),
            onSuccess: (result) => ({ result }),
          }),
        );
        if ("result" in attempt) return Option.some(attempt.result);
        const error = attempt.error;
        if (!(error instanceof DeclarativeCompatibilityError) || error.loadFindings === undefined) {
          return yield* Effect.fail(error);
        }

        const missingExtensions = [
          ...new Set(error.loadFindings.map((finding) => finding.extension)),
        ].sort();
        if (missingExtensions.includes("pg_net") && !toml.webhooksEnabled) {
          return yield* Effect.fail(
            new DeclarativeCompatibilityError({
              message: [
                "The declarative schema uses pg_net, but Database Webhooks are not enabled in the local project config.",
                "",
                ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
              ].join("\n"),
            }),
          );
        }
        if (!tty.stdinIsTty || yes) return yield* Effect.fail(error);

        yield* output.raw(`${yellow(error.message)}\n`, "stderr");
        const choice = yield* output.promptSelect("How would you like to continue?", [
          {
            value: "stage",
            label: `Generate next export to ${stagedDirRel}`,
            hint: "recommended",
          },
          {
            value: "repair",
            label: `Add missing extension declarations to ${extensionSqlRel} and re-plan`,
            hint: "may surface another gap",
          },
          { value: "cancel", label: "Cancel" },
        ]);
        if (choice === "cancel") return Option.none<DeclarativeSyncResult>();
        if (choice === "stage") {
          yield* stageNextExport();
          return Option.none<DeclarativeSyncResult>();
        }
        const repaired = yield* appendExtensionDeclarations(declarativeDir, missingExtensions);
        yield* output.raw(
          `Updated ${bold(repaired.path)} with:\n${repaired.addedDeclarations.join("\n")}\n`,
          "stderr",
        );
      }
    });

    const initialResult = yield* planWithLoadRecovery();
    if (Option.isNone(initialResult)) return;
    let result: DeclarativeSyncResult = initialResult.value;
    if (transient && output.format !== "text" && Option.isSome(machineErrorContext)) {
      yield* machineErrorContext.value.set(transientResult(result, false));
    }

    // Resolve successful manifest-less plans too. Repairs re-enter planning so a
    // second, broader legacy gap (for example cron intents) cannot fall through to
    // migration writing after the first missing extension is declared.
    while (true) {
      if (
        !result.manifestPresent &&
        !toml.webhooksEnabled &&
        result.removals.extensions.includes("pg_net")
      ) {
        return yield* Effect.fail(
          new DeclarativeCompatibilityError({
            message: [
              "The migrations state includes pg_net, but Database Webhooks are not enabled in the local project config.",
              "",
              ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
            ].join("\n"),
          }),
        );
      }
      const compatibility = classifyDeclarativeCompatibilityGap({
        manifestPresent: result.manifestPresent,
        removals: result.removals,
      });
      if (compatibility.recommendedAction === "none") break;

      // Both recommended actions mean the same thing to the user — the tree is a
      // legacy export — so they render one shared template and differ only in the
      // choices offered. Non-interactively there is exactly one recovery: the
      // staged regenerate, carried on `suggestion` so `Output.fail` prints it
      // instead of the "rerun with --debug" footer.
      const gate = formatDeclarativeUpgradeGate({
        evidence: formatDeclarativeGapEvidence(compatibility),
        context: {
          declarativeDir: declarativeDirRel,
          schema: flags.schema,
          platform: currentShellPlatform(),
        },
      });
      if (!tty.stdinIsTty || yes) {
        return yield* Effect.fail(
          new DeclarativeCompatibilityError({
            message: gate.message,
            suggestion: gate.suggestion,
          }),
        );
      }
      yield* output.raw(`${yellow(gate.message)}\n`, "stderr");

      if (compatibility.recommendedAction === "stage-next-export") {
        const choice = yield* output.promptSelect("How would you like to continue?", [
          {
            value: "stage",
            label: `Generate next export to ${stagedDirRel}`,
            hint: "recommended",
          },
          { value: "cancel", label: "Cancel" },
        ]);
        if (choice === "stage") yield* stageNextExport();
        return;
      }

      // Repairing the tree in place is offered only interactively, and only as an
      // advanced choice: on a real CLI tree each added declaration tends to
      // unlock the next refusal, so it is a false trail for a scripted run.
      const choice = yield* output.promptSelect("How would you like to continue?", [
        { value: "stage", label: `Generate next export to ${stagedDirRel}`, hint: "recommended" },
        {
          value: "repair",
          label: `Add declarations to ${extensionSqlRel} and re-plan`,
          hint: "may surface another gap",
        },
        { value: "continue", label: "Continue with removals" },
        { value: "cancel", label: "Cancel" },
      ]);
      if (choice === "cancel") return;
      if (choice === "stage") {
        yield* stageNextExport();
        return;
      }
      if (choice === "continue") break;
      const repaired = yield* appendExtensionDeclarations(
        declarativeDir,
        compatibility.repairableExtensions,
      );
      yield* output.raw(
        `Updated ${bold(repaired.path)} with:\n${repaired.addedDeclarations.join("\n")}\n`,
        "stderr",
      );
      const replanned = yield* planWithLoadRecovery();
      if (Option.isNone(replanned)) return;
      result = replanned.value;
      if (transient && output.format !== "text" && Option.isSome(machineErrorContext)) {
        yield* machineErrorContext.value.set(transientResult(result, false));
      }
    }

    // Step 3: empty diff.
    if (result.diffSQL.trim().length < 2) {
      if (transient && output.format !== "text") {
        yield* output.success("No schema changes found.", transientResult(result, false));
      } else {
        yield* output.raw("No schema changes found\n", "stderr");
      }
      return;
    }
    if (transient) {
      if (output.format === "text") {
        yield* output.raw("Planned declarative SQL:\n", "stderr");
        yield* output.raw(`${result.diffSQL}\n`, "stdout");
      }
    } else {
      yield* output.raw("Generated migration SQL:\n", "stderr");
      yield* output.raw(`${result.diffSQL}\n`, "stderr");
    }

    const printDropWarnings = () =>
      result.dropWarnings.length === 0
        ? Effect.void
        : Effect.gen(function* () {
            yield* output.raw(
              `${yellow(
                "Found destructive changes in schema diff. Please double check if these are expected:",
              )}\n`,
              "stderr",
            );
            yield* output.raw(`${yellow(result.dropWarnings.join("\n"))}\n`, "stderr");
          });

    if (transient) {
      yield* printDropWarnings();
      if (!yes) {
        if (!tty.stdinIsTty || output.format !== "text") {
          return yield* Effect.fail(
            new DeclarativeTransientConfirmationRequiredError({
              message: "transient apply requires confirmation in non-interactive mode",
              suggestion: "Rerun with --transient --yes to apply the planned SQL.",
            }),
          );
        }
        const confirmed = yield* output.promptConfirm(
          "Apply these schema changes directly to the local database?",
          { defaultValue: true },
        );
        if (!confirmed) return;
      }

      const applyExit = yield* applyRenderedSqlToLocal(
        { port: toml.port, password: toml.password, dnsResolver },
        result.files,
      ).pipe(Effect.exit);
      if (Exit.isFailure(applyExit)) {
        const failure = Cause.findFail(applyExit.cause);
        if (Result.isFailure(failure)) return yield* Effect.failCause(failure.failure);
        const rawError = failure.success.error;
        const partialApplySuggestion =
          "Some nontransactional or earlier units may already have applied. Rerun sync --transient to re-plan before retrying.";
        const applyError =
          rawError instanceof DeclarativeApplyError && rawError.connect === true
            ? rawError
            : rawError instanceof DbConnectError
              ? new DeclarativeApplyError({
                  message: rawError.message,
                  connect: true,
                  suggestion: partialApplySuggestion,
                })
              : new DeclarativeApplyError({
                  message: rawError.message,
                  suggestion: partialApplySuggestion,
                });
        yield* output.raw(`${red(`Transient apply failed: ${applyError.message}`)}\n`, "stderr");
        const migrations = yield* collectMigrationsList(fs, path, migrationsDir);
        const debugBundle = yield* saveApplyDebugBundle({
          id: `${formatDebugId(yield* Clock.currentTimeMillis)}-transient-apply-error`,
          sourceRef: result.sourceRef,
          targetRef: result.targetRef,
          migrationSql: result.diffSQL,
          error: applyError.message,
          migrations,
        });
        if (debugBundle.directory.length > 0) {
          yield* output.raw(debugBundleMessage(debugBundle.directory), "stderr");
        }
        return yield* Effect.fail(applyError);
      }
      if (output.format === "text") {
        yield* output.raw("Schema changes applied successfully.\n", "stderr");
        yield* output.raw(`${result.diffSQL}\n`, "stdout");
      } else {
        yield* output.success(
          "Schema changes applied successfully.",
          transientResult(result, true),
        );
      }
      return;
    }

    // Step 4: resolve migration name (prompt in TTY when --name unset).
    const file = Option.getOrElse(flags.file, () => DEFAULT_SYNC_NAME);
    const explicitName = Option.getOrElse(flags.name, () => "");
    let migrationName = resolveDeclarativeMigrationName(explicitName, file);
    if (explicitName.length === 0 && tty.stdinIsTty && !yes) {
      const input = yield* output.promptText(
        `Enter a name for this migration (press Enter to keep '${migrationName}'): `,
        { validate: validateDeclarativeMigrationStem },
      );
      if (input.trim().length > 0) migrationName = input.trim();
    }
    const migrationNameValidation = validateDeclarativeMigrationStem(migrationName);
    if (migrationNameValidation !== undefined) {
      return yield* Effect.fail(
        new DeclarativeInvalidMigrationStemError({
          message: `invalid migration name: ${migrationNameValidation}`,
        }),
      );
    }

    // Step 5: write the timestamped migration file.
    const nowMillis = yield* Clock.currentTimeMillis;
    const written = yield* writePgDeltaMigrations(fs, path, {
      workdir: cliSettings.workdir,
      baseMillis: nowMillis,
      name: migrationName,
      files: result.files,
    }).pipe(Effect.mapError((error) => new DeclarativeApplyError({ message: error.message })));
    const migrationPaths = written.map((migration) => migration.path);
    for (const migrationPath of migrationPaths) {
      yield* output.raw(`Created new migration at ${bold(migrationPath)}\n`, "stderr");
    }

    // Step 6: drop warnings.
    yield* printDropWarnings();

    // Step 7: apply decision.
    const decision = resolveDeclarativeSyncApplyDecision({
      // The mutex check above gates on presence; the decision itself reads the resolved boolean
      // value (default false).
      apply: Option.getOrElse(flags.apply, () => false),
      noApply: Option.getOrElse(flags.noApply, () => false),
      yes,
      tty: tty.stdinIsTty,
    });
    const shouldApply =
      decision === "apply"
        ? true
        : decision === "skip"
          ? false
          : yield* output.promptConfirm("Apply this migration to local database?", {
              defaultValue: true,
            });
    if (!shouldApply) return;

    // Step 8: apply the migration to the local database (native).
    let applyAttempted = false;
    const appliedSegments = yield* Ref.make(0);
    const sqlMayHaveCommitted = yield* Ref.make(false);
    const applyExit = yield* ensureLocalPostgresImageCurrent.pipe(
      Effect.andThen(
        Effect.sync(() => {
          applyAttempted = true;
        }),
      ),
      Effect.andThen(
        applyMigrationToLocal(
          { port: toml.port, password: toml.password, dnsResolver },
          migrationPaths,
          Ref.update(appliedSegments, (count) => count + 1),
          Ref.set(sqlMayHaveCommitted, true),
        ),
      ),
      Effect.exit,
    );

    if (Exit.isSuccess(applyExit)) {
      yield* output.raw("Migration applied successfully.\n", "stderr");
      return;
    }

    // A Ctrl-C or defect during the apply is not a migration-apply failure — propagate it
    // unchanged instead of synthesizing a fake `DeclarativeApplyError`.
    const applyFailure = Cause.findFail(applyExit.cause);
    if (Result.isFailure(applyFailure)) {
      return yield* Effect.failCause(applyFailure.failure);
    }

    // Apply failed: print, save a debug bundle, and (in a TTY) offer reset+reapply.
    const applyError = applyFailure.success.error;
    yield* output.raw(
      `${red(
        `${applyAttempted ? "Migration failed to apply" : "Migration apply preflight failed"}: ${applyError.message}`,
      )}\n`,
      "stderr",
    );
    const ts = formatDebugId(yield* Clock.currentTimeMillis);
    const migrations = yield* collectMigrationsList(fs, path, migrationsDir);
    const debugBundle = yield* saveApplyDebugBundle({
      id: `${ts}-apply-error`,
      sourceRef: result.sourceRef,
      targetRef: result.targetRef,
      migrationSql: result.diffSQL,
      error: applyError.message,
      migrations,
    });

    if (tty.stdinIsTty && !yes && applyAttempted) {
      const shouldReset = yield* output.promptConfirm(
        "Would you like to reset the local database and reapply all migrations? (local data will be lost)",
        { defaultValue: false },
      );
      if (shouldReset) {
        // `resetLocalDatabase` runs in-process, sharing this command's own context: it resolves
        // `NetworkIdFlag` itself, so no argv-forwarding is needed to stay on a custom network.
        const resetExit = yield* resetLocalDatabase().pipe(Effect.exit);
        if (Exit.isFailure(resetExit)) {
          // A Ctrl-C or defect during the recovery reset must cancel the command, not get
          // rewritten into a synthetic "unknown error" apply failure.
          const resetFailure = Cause.findFail(resetExit.cause);
          if (Result.isFailure(resetFailure)) {
            return yield* Effect.failCause(resetFailure.failure);
          }
          // Surfaces the failure that actually blocked recovery, not the original apply error,
          // printed exactly once (no extra "database reset failed:" wrapper) — build it from the
          // real typed failure and reuse that one value for message, suggestion, and bundle.
          const rawResetFailure = resetFailure.success.error;
          const resetError = new DeclarativeApplyError({
            message: rawResetFailure.message,
            suggestion: readErrorSuggestion(rawResetFailure),
          });
          yield* output.raw(
            `${red(`Database reset also failed: ${resetError.message}`)}\n`,
            "stderr",
          );
          const resetDebugBundle = yield* saveApplyDebugBundle({
            id: `${ts}-after-reset`,
            sourceRef: result.sourceRef,
            targetRef: result.targetRef,
            migrationSql: result.diffSQL,
            error: resetError.message,
            migrations,
          });
          // Guards each saved-path line so a bundle that failed to save doesn't print a path
          // that doesn't exist.
          if (debugBundle.directory.length > 0) {
            yield* output.raw(
              `\nDebug information saved to ${bold(debugBundle.directory)}\n`,
              "stderr",
            );
          }
          if (resetDebugBundle.directory.length > 0) {
            yield* output.raw(
              `Debug information saved to ${bold(resetDebugBundle.directory)}\n`,
              "stderr",
            );
          }
          yield* output.raw(debugBundleMessage(""), "stderr");
          return yield* Effect.fail(resetError);
        }
        yield* output.raw("Database reset and all migrations applied successfully.\n", "stderr");
        return;
      }
    }
    const appliedSegmentCount = yield* Ref.get(appliedSegments);
    const sqlCommitted = yield* Ref.get(sqlMayHaveCommitted);
    let keepGeneratedFiles = appliedSegmentCount > 0 || sqlCommitted;
    if (appliedSegmentCount > 0) {
      yield* output.raw(
        "Generated migration files were kept because one or more segments were already recorded in migration history.\n",
        "stderr",
      );
    } else if (sqlCommitted) {
      yield* output.raw(
        "Generated migration files were kept because SQL from this apply may already have been committed.\n",
        "stderr",
      );
    } else if (tty.stdinIsTty && !yes) {
      keepGeneratedFiles = yield* output.promptConfirm("Keep the generated migration file(s)?", {
        defaultValue: false,
      });
    }
    if (!keepGeneratedFiles) {
      if (!debugBundle.migrationSqlSaved) {
        yield* output.raw(
          "Generated migration files were kept because debug artifacts could not be saved.\n",
          "stderr",
        );
      } else {
        for (const migrationPath of migrationPaths) {
          yield* fs
            .remove(migrationPath)
            .pipe(
              Effect.catch((error) =>
                output.raw(
                  `Warning: failed to remove generated migration ${migrationPath}: ${error.message}\n`,
                  "stderr",
                ),
              ),
            );
        }
      }
    }
    if (debugBundle.directory.length > 0) {
      yield* output.raw(debugBundleMessage(debugBundle.directory), "stderr");
    }
    return yield* Effect.fail(applyError);
  }).pipe(
    // Writes the linked-project cache whenever the bootstrap path resolved a linked ref, whether
    // sync succeeds or fails; only the linked bootstrap sets `linkedProjectRef`, so non-linked
    // syncs never trigger this.
    Effect.ensuring(
      Effect.suspend(() =>
        linkedProjectRef !== undefined ? linkedProjectCache.cache(linkedProjectRef) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

const declarativeDirHasSqlFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  return (
    (yield* ListPgDeltaSqlFiles(fs, dir).pipe(
      Effect.mapError((error) => new DeclarativeDiffError({ message: error.message })),
    )).length > 0
  );
});

const transientResult = (
  result: DeclarativeSyncResult,
  applied: boolean,
): Record<string, unknown> => ({
  changed: result.diffSQL.trim().length >= 2,
  applied,
  migration_written: false,
  history_recorded: false,
  sql: result.diffSQL,
  units: result.files.map((file) => ({
    name: file.name,
    transaction_mode: file.transactionMode,
    sql: file.sql,
  })),
});

const connectToLocal = (local: {
  port: number;
  password: string;
  dnsResolver: "native" | "https";
}) =>
  Effect.gen(function* () {
    const dbConnection = yield* DbConnection;
    return yield* dbConnection
      .connect(
        {
          // Host resolution order: SUPABASE_SERVICES_HOSTNAME → tcp DOCKER_HOST → 127.0.0.1, not
          // a hardcoded loopback.
          host: getHostname(),
          port: local.port,
          user: "postgres",
          password: local.password,
          database: "postgres",
        },
        { isLocal: true, dnsResolver: local.dnsResolver },
      )
      .pipe(
        Effect.mapError(
          (error) => new DeclarativeApplyError({ message: error.message, connect: true }),
        ),
      );
  });

const applyRenderedSqlToLocal = (
  local: { port: number; password: string; dnsResolver: "native" | "https" },
  files: DeclarativeSyncResult["files"],
) =>
  Effect.gen(function* () {
    const session = yield* connectToLocal(local);
    yield* applyRenderedSqlUnits(session, files, (message) => {
      return new DeclarativeApplyError({ message });
    });
  }).pipe(Effect.scoped);

/** Connects once and applies the ordered migration files (Go's `applyMigrationToLocal`). */
const applyMigrationToLocal = (
  local: { port: number; password: string; dnsResolver: "native" | "https" },
  migrationPaths: ReadonlyArray<string>,
  onMigrationRecorded: Effect.Effect<void>,
  onStatementsCommitted: Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const session = yield* connectToLocal(local);
    for (const migrationPath of migrationPaths) {
      yield* applyMigrationFile(
        session,
        fs,
        path,
        migrationPath,
        (message) => new DeclarativeApplyError({ message }),
        onStatementsCommitted,
      );
      yield* onMigrationRecorded;
    }
  }).pipe(Effect.scoped);
