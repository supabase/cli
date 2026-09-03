import { Cause, Clock, Effect, Exit, FileSystem, Option, Path, Result } from "effect";

import {
  LegacyDnsResolverFlag,
  legacyResolveExperimentalWithProjectEnv,
  legacyResolveYesWithProjectEnv,
} from "../../../../../../shared/legacy/global-flags.ts";
import { legacyPromptYesNo } from "../../../../../../shared/legacy/legacy-prompt-yes-no.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../../shared/runtime/tty.service.ts";
import { LegacyCliSettings } from "../../../../../config/legacy-cli-settings.service.ts";
import { legacyResetLocalDatabase } from "../../../../../shared/db-bootstrap/reset-local-database.ts";
import { legacyBold, legacyRed, legacyYellow } from "../../../../../shared/legacy-colors.ts";
import { LegacyDbConnection } from "../../../../../shared/legacy-db-connection.service.ts";
import { legacyGetHostname } from "../../../../../shared/legacy-hostname.ts";
import {
  legacyLoadProjectEnv,
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyMakeDir } from "../../../../../shared/legacy-make-dir.ts";
import { legacyApplyMigrationFile } from "../../../../../shared/legacy-migration-apply.ts";
import { LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION } from "../../../../../shared/legacy-pg-net-guidance.ts";
import { legacyReadProjectRefFile } from "../../../../../shared/legacy-temp-paths.ts";
import { LegacyLinkedProjectCache } from "../../../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import {
  legacyListLocalMigrations,
  legacyResolveSetupInputs,
} from "../../../../../shared/legacy-pgdelta.cache.ts";
import { legacyPgDeltaTempPath } from "../../../../../shared/legacy-pgdelta.paths.ts";
import { LegacyPgDeltaEngine } from "../../../shared/legacy-pgdelta-engine.service.ts";
import {
  legacyIsPgDeltaDebugEnabled,
  legacyResolvePgDeltaProjectId,
} from "../../../../../shared/legacy-pgdelta.ts";
import { legacyWritePgDeltaMigrations } from "../../../shared/legacy-pgdelta-migrations.write.ts";
import {
  legacyLocalEndpoint,
  legacyResolveSmartTargetEndpoint,
} from "../declarative.smart-target.ts";
import {
  type LegacyDebugBundle,
  legacyCollectMigrationsList,
  legacyDebugBundleMessage,
  legacyFormatDebugId,
  legacySaveDebugBundle,
} from "../../../shared/legacy-debug-bundle.ts";
import {
  LegacyDeclarativeApplyError,
  LegacyDeclarativeCompatibilityError,
  LegacyDeclarativeMutuallyExclusiveFlagsError,
  LegacyDeclarativeNoFilesGeneratedError,
  LegacyDeclarativeNonInteractiveError,
  legacyReadErrorSuggestion,
} from "../declarative.errors.ts";
import {
  legacyClassifyDeclarativeCompatibilityGap,
  legacyCurrentShellPlatform,
  legacyFormatDeclarativeGapEvidence,
  legacyFormatDeclarativeUpgradeGate,
  legacyFormatStagedExportAdoption,
  legacyResolveStagedDeclarativeDir,
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
} from "../declarative.flow.ts";
import { legacyWarnFormerDeclarativeDefault } from "../declarative.former-default.ts";
import { legacyAppendExtensionDeclarations } from "../declarative.extension-repair.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  type LegacyDeclarativeSyncResult,
  legacyDiffDeclarativeToMigrations,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { LegacyDeclarativeSeam } from "../../../shared/legacy-pgdelta.seam.service.ts";
import {
  legacyDeclarativeSchemaWrittenLine,
  legacyWarnPreservedUnmanagedDeclarativeFiles,
  legacyWriteDeclarativeSchemas,
} from "../../../shared/legacy-pgdelta.write.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";

const DEFAULT_SYNC_NAME = "declarative_sync";

/** Go's `GetCurrentTimestamp`: UTC `YYYYMMDDHHmmss`. */
const formatTimestamp = (millis: number): string =>
  new Date(millis).toISOString().replace(/\D/g, "").slice(0, 14);

// Go's debug-bundle id layout `20060102-150405` (UTC) — hoisted to
// `legacy-debug-bundle.ts` and reused by the `db pull` empty-diff bundle.
const formatDebugId = legacyFormatDebugId;

export const legacyDbSchemaDeclarativeSync = Effect.fn("legacy.db.schema.declarative.sync")(
  function* (flags: LegacyDbSchemaDeclarativeSyncFlags) {
    const output = yield* Output;
    const tty = yield* Tty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliSettings = yield* LegacyCliSettings;
    const telemetryState = yield* LegacyTelemetryState;
    // Go's `dbDeclarativeCmd.PersistentPreRunE` calls `flags.LoadConfig` — which runs
    // `loadNestedEnv` and `os.Setenv`s each project-.env key — BEFORE reading
    // `viper.GetBool("EXPERIMENTAL")` for the gate below (`apps/cli-go/cmd/
    // db_schema_declarative.go:73-78`, `pkg/config/config.go:789`). Load the project env
    // first and resolve against it, as `db reset` does for its own experimental gate, so a
    // `SUPABASE_EXPERIMENTAL` set only in `supabase/.env` opens the gate too.
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliSettings.workdir);
    const experimental = yield* legacyResolveExperimentalWithProjectEnv(projectEnv);
    // `--yes` OR `SUPABASE_YES` (shell env or project `.env`): Go's prompts here
    // read `viper.GetBool("YES")` after `loadNestedEnv`, so the env var must
    // auto-confirm too, not just the flag (CLI-1974).
    const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
    const dnsResolver = yield* LegacyDnsResolverFlag;
    const seam = yield* LegacyDeclarativeSeam;
    const engine = yield* LegacyPgDeltaEngine;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;

    // Go's sync bootstrap delegates to `runDeclarativeGenerate`, whose
    // `flags.LoadProjectRef` (called inside the `hasMigrationFiles` branch) sets the
    // global `flags.ProjectRef`; root `ensureProjectGroupsCached` then writes the
    // linked-project cache/groups on success or failure (`cmd/root.go:176,214-218`).
    // Captured in the bootstrap branch below; the finalizer on the whole handler body
    // reads it. Declared at handler scope so it is visible to both the body and the
    // `.pipe` finalizer.
    let linkedProjectRef: string | undefined;

    yield* Effect.gen(function* () {
      const toml = yield* legacyReadDbToml(fs, path, cliSettings.workdir);
      // Gate before the mutex check below — order matters; see
      // legacyRequirePgDelta's doc comment for why.
      yield* legacyRequirePgDelta({
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        configPath: path.join("supabase", "config.toml"),
      });

      // cobra `MarkFlagsMutuallyExclusive("apply", "no-apply")`
      // (`apps/cli-go/cmd/db_schema_declarative.go:561`, deleted in CLI-1970;
      // last present at commit 7b469f5b3) runs via
      // `ValidateFlagGroups()`, which cobra invokes AFTER `PersistentPreRunE` (the
      // gate above) — see legacyRequirePgDelta's doc comment for the full ordering.
      // Reject the conflict here rather than letting `--no-apply` silently win in
      // the apply-decision helper.
      const exclusive: Array<string> = [];
      if (Option.isSome(flags.apply)) exclusive.push("apply");
      if (Option.isSome(flags.noApply)) exclusive.push("no-apply");
      if (exclusive.length > 1) {
        return yield* Effect.fail(
          new LegacyDeclarativeMutuallyExclusiveFlagsError({
            message: `if any flags in the group [apply no-apply] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
          }),
        );
      }

      // Go's `utils.GetDeclarativeDir()` — the config value verbatim (already
      // `supabase/`-prefixed when relative) or the relative `supabase/schemas`
      // default. Printed verbatim in the bootstrap's written-to line below, exactly
      // as Go prints it (Go chdirs into the workdir, so its paths stay relative).
      const declarativeDirRel = legacyResolveDeclarativeDir(path, toml.pgDelta);
      // `path.resolve` (not `path.join`) so an absolute `declarative_schema_path` is
      // used as-is, matching Go's `config.resolve` (which only prefixes the workdir onto
      // a relative path). `path.join(workdir, abs)` would mangle the absolute path.
      const declarativeDir = path.resolve(cliSettings.workdir, declarativeDirRel);
      const stagedDirRel = legacyResolveStagedDeclarativeDir(declarativeDirRel);
      // Repair prompts name the file they would edit by its full configured path —
      // a bare `extension.sql` is ambiguous in a tree with nested schema folders.
      const extensionSqlRel = path.join(declarativeDirRel, "extension.sql");
      const migrationsDir = path.join(cliSettings.workdir, "supabase", "migrations");
      const tempDir = legacyPgDeltaTempPath(path, cliSettings.workdir);
      const run: LegacyDeclarativeRunContext = {
        pgDelta: {
          // `legacyResolvePgDeltaProjectId` mirrors Go's `Config.ProjectId` singleton
          // (`SUPABASE_PROJECT_ID` env → config.toml's `project_id` → sanitized workdir
          // basename) — NOT `cliSettings.projectId` alone, which is env-only and resolves to
          // `""` for a project relying on config.toml's `project_id` or the workdir-basename
          // default, mounting the WRONG `supabase_edge_runtime_` Deno-cache volume.
          projectId: legacyResolvePgDeltaProjectId(
            cliSettings.projectId,
            toml,
            cliSettings.workdir,
          ),
          cwd: cliSettings.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
          denoVersion: toml.denoVersion,
          projectEnv: toml.projectEnv,
        },
        formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
        declarativeDir,
        declarativeDirDisplay: declarativeDirRel,
        schema: flags.schema,
        noCache: flags.noCache,
        debug: legacyIsPgDeltaDebugEnabled(),
        strictCoverage: flags.strictCoverage,
        dnsResolver,
      };
      const ensureLocalPostgresImageCurrent = seam.ensureLocalPostgresImageCurrent();
      yield* legacyWarnFormerDeclarativeDefault(fs, path, cliSettings.workdir, toml.pgDelta);
      const declarativeFilesExist = yield* declarativeDirHasFiles(fs, declarativeDir);

      // Go's `saveApplyDebugBundle`: warn (rather than masking the apply error) and
      // treat the bundle path as empty when the debug directory cannot be created, so
      // an apply failure still surfaces without claiming a bundle was saved
      // (`apps/cli-go/cmd/db_schema_declarative.go:447-461`, deleted in
      // CLI-1970; last present at commit 7b469f5b3).
      const saveApplyDebugBundle = (bundle: LegacyDebugBundle) =>
        legacySaveDebugBundle(fs, path, cliSettings.workdir, tempDir, migrationsDir, bundle).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              output
                .raw(`Warning: failed to save debug artifacts: ${error.message}\n`, "stderr")
                .pipe(Effect.as("")),
            onSuccess: Effect.succeed,
          }),
        );

      // Step 1: declarative files must exist; in a TTY, offer to generate them.
      if (!declarativeFilesExist) {
        const noFiles = new LegacyDeclarativeNonInteractiveError({
          message: "no declarative schema found. Run supabase db schema declarative generate first",
        });
        if (!tty.stdinIsTty && !yes) return yield* Effect.fail(noFiles);
        // Go asks via Console.PromptYesNo (db_schema_declarative.go:381, default
        // true): --yes/SUPABASE_YES auto-confirms WITH the `<label> [Y/n] y`
        // stderr echo (console.go:70-72) — routed through `legacyPromptYesNo`
        // so the echo is not skipped (CLI-1974).
        const ok = yield* legacyPromptYesNo(
          output,
          yes,
          "No declarative schema found. Generate a new one ?",
          true,
        );
        if (!ok) return yield* Effect.fail(noFiles);
        // Go delegates to the full smart-generate flow (`runDeclarativeGenerate`,
        // db_schema_declarative.go:321): with migrations present it offers the
        // local / linked / custom target choice + local-reset prompt, so a linked
        // workdir can bootstrap from the remote rather than silently using local.
        // Smart-mode presence probe only: Go's delegated `runDeclarativeGenerate` uses
        // `hasMigrationFiles`, which returns `false` on ANY `ListLocalMigrations` error
        // (`db_schema_declarative.go:164-169`), flowing into the no-migrations local
        // generate. Swallow read errors here so an unreadable/file migrations path
        // doesn't abort the bootstrap; the diff path below keeps the hard list behavior.
        const hasMigrations =
          (yield* legacyListLocalMigrations(fs, path, migrationsDir).pipe(
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          )).length > 0;
        // Go calls `flags.LoadProjectRef` only inside `runDeclarativeGenerate`'s
        // `hasMigrationFiles` branch (`db_schema_declarative.go:219-224`), which sets
        // the global `flags.ProjectRef` so the post-run cache fires regardless of the
        // chosen target. Resolve the ref the same way (config `project_id` →
        // `.temp/project-ref`), only when migrations exist, and record it for the
        // finalizer so a linked-workdir bootstrap caches like Go.
        let linkedRef = Option.none<string>();
        if (hasMigrations) {
          // Smart prompt only decides whether to OFFER the linked choice — Go guards
          // `LoadProjectRef` with `if err == nil` (`db_schema_declarative.go:222-224`),
          // ignoring read errors and continuing with local/custom. Swallow a broken
          // `.temp/project-ref` here; `linkedProjectRef` then stays unset so the post-run
          // cache correctly does not fire (Go leaves `flags.ProjectRef` empty on error).
          linkedRef = Option.isSome(cliSettings.projectId)
            ? cliSettings.projectId
            : yield* legacyReadProjectRefFile(fs, path, cliSettings.workdir).pipe(
                Effect.orElseSucceed(() => Option.none<string>()),
              );
          if (Option.isSome(linkedRef)) {
            linkedProjectRef = linkedRef.value;
          }
        }
        // sync has no target flags (Go passes its target-less `cmd` into generate),
        // so reset stays interactive (the prompt fires under the local choice).
        const target = yield* legacyResolveSmartTargetEndpoint(
          { dbUrl: Option.none(), linked: Option.none(), password: Option.none(), reset: false },
          { port: toml.port, password: toml.password },
          hasMigrations,
          fs,
          path,
          cliSettings.workdir,
          linkedRef,
          ensureLocalPostgresImageCurrent,
        );
        const generated = yield* legacyGenerateDeclarativeOutput(run, toml, target);
        const written = yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, generated);
        // A manifest-less directory keeps files the export did not replace, and those
        // files go straight into the plan below — warn before diffing against them.
        yield* legacyWarnPreservedUnmanagedDeclarativeFiles(declarativeDirRel, written);
        if (!(yield* declarativeDirHasFiles(fs, declarativeDir))) {
          return yield* Effect.fail(
            new LegacyDeclarativeNoFilesGeneratedError({
              message: "declarative schema generation did not produce any files",
            }),
          );
        }
        // Go's bootstrap delegates to the full `declarative.Generate`, which warms the
        // declarative catalog cache when --no-cache is unset (`declarative.go:133-157`,
        // `cmd/db_schema_declarative.go:321`) — applying the just-generated schema to a
        // shadow DB so an unappliable schema fails HERE, before building the migrations
        // catalog / emitting a diff debug bundle, and warming the catalog the following
        // diff reuses. (sync is target-less and writes to the single toml-resolved dir,
        // so the generate handler's remote-override dir guard isn't needed here.)
        if (!run.noCache && engine.implementation === "legacy") {
          yield* seam.exportCatalog({ mode: "declarative", noCache: run.noCache });
        }
        // Go's delegated `declarative.Generate` prints the written-to line to stderr
        // after the write and the catalog warm (`declarative.go:133→138-155→156`), on
        // both the interactive-accept and --yes/SUPABASE_YES bootstrap paths, and
        // regardless of --no-cache (the warm is skipped, the line is not). It prints
        // `utils.GetDeclarativeDir()` — the relative dir above, never a resolved
        // absolute path, because Go chdirs into the workdir (CLI-1980).
        yield* output.raw(legacyDeclarativeSchemaWrittenLine(declarativeDirRel), "stderr");
      }

      // Step 2: diff migrations state vs declarative; on error, save a debug bundle.
      // `setupInputs` is the cache-key/baseline-setup subset of `toml` that the now-
      // native migrations-catalog resolution needs (CLI-1959) — see
      // `legacyResolveSetupInputs`'s doc comment.
      const setupInputs = yield* legacyResolveSetupInputs(
        fs,
        path,
        cliSettings.workdir,
        toml.majorVersion,
        Option.getOrUndefined(toml.orioledbVersion),
        toml.baseline,
      );
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
            new LegacyDeclarativeCompatibilityError({
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
              new LegacyDeclarativeCompatibilityError({
                message: `${stagedDirRel} already contains files without a pg-delta export manifest. Move or remove that directory, then run sync again so the staged export cannot preserve unrelated SQL.`,
              }),
            );
          }
        }
        yield* ensureLocalPostgresImageCurrent;
        yield* seam.ensureLocalDatabaseStarted();
        // The staged export snapshots the RUNNING local database verbatim — not a
        // shadow built from migrations, which is what the failed plan compared. Say
        // so, and offer the same reset the smart-target local path offers, so stale
        // Studio-made drift does not silently become the staged declarative tree.
        // This path is only reachable interactively (both prompts above gate on a
        // TTY without --yes), so the prompt always really asks.
        yield* output.raw(
          `Exporting from the running local database (not the migrations state). Review ${stagedDirRel} before adopting it.\n`,
          "stderr",
        );
        const shouldReset = yield* legacyPromptYesNo(
          output,
          yes,
          "Reset local database to match migrations first? (local data will be lost)",
          false,
        );
        if (shouldReset) {
          yield* legacyResetLocalDatabase().pipe(
            Effect.mapError(
              (error) =>
                new LegacyDeclarativeApplyError({
                  message: `database reset failed: ${error.message}`,
                  suggestion: legacyReadErrorSuggestion(error),
                }),
            ),
          );
        }
        const generated = yield* legacyGenerateDeclarativeOutput(
          { ...run, declarativeDir: stagedDir },
          toml,
          legacyLocalEndpoint({ port: toml.port, password: toml.password }, dnsResolver),
        );
        const written = yield* legacyWriteDeclarativeSchemas(fs, path, stagedDir, generated);
        yield* legacyWarnPreservedUnmanagedDeclarativeFiles(stagedDirRel, written);
        yield* output.raw(legacyDeclarativeSchemaWrittenLine(stagedDirRel), "stderr");
        yield* output.raw(
          [
            ...legacyFormatStagedExportAdoption({
              declarativeDir: declarativeDirRel,
              schema: flags.schema,
              platform: legacyCurrentShellPlatform(),
            }),
            "",
          ].join("\n"),
          "stderr",
        );
      });

      const planDeclarativeSync = () =>
        legacyDiffDeclarativeToMigrations(run, toml, setupInputs).pipe(
          Effect.tapError((error) =>
            error instanceof LegacyDeclarativeCompatibilityError
              ? Effect.void
              : Effect.gen(function* () {
                  const migrations = yield* legacyCollectMigrationsList(fs, path, migrationsDir);
                  yield* legacySaveDebugBundle(
                    fs,
                    path,
                    cliSettings.workdir,
                    tempDir,
                    migrationsDir,
                    {
                      id: formatDebugId(yield* Clock.currentTimeMillis),
                      error: error.message,
                      migrations,
                    },
                  ).pipe(
                    Effect.matchEffect({
                      // Go prints nothing when SaveDebugBundle errors on the diff path
                      // (`db_schema_declarative.go:337-340`: `if saveErr == nil`).
                      onFailure: () => Effect.void,
                      onSuccess: (debugDir) =>
                        output.raw(legacyDebugBundleMessage(debugDir), "stderr"),
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
          if (
            !(error instanceof LegacyDeclarativeCompatibilityError) ||
            error.loadFindings === undefined
          ) {
            return yield* Effect.fail(error);
          }

          const missingExtensions = [
            ...new Set(error.loadFindings.map((finding) => finding.extension)),
          ].sort();
          if (missingExtensions.includes("pg_net") && !toml.webhooksEnabled) {
            return yield* Effect.fail(
              new LegacyDeclarativeCompatibilityError({
                message: [
                  "The declarative schema uses pg_net, but Database Webhooks are not enabled in the local project config.",
                  "",
                  LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
                ].join("\n"),
              }),
            );
          }
          if (!tty.stdinIsTty || yes) return yield* Effect.fail(error);

          yield* output.raw(`${legacyYellow(error.message)}\n`, "stderr");
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
          if (choice === "cancel") return Option.none<LegacyDeclarativeSyncResult>();
          if (choice === "stage") {
            yield* stageNextExport();
            return Option.none<LegacyDeclarativeSyncResult>();
          }
          const repaired = yield* legacyAppendExtensionDeclarations(
            declarativeDir,
            missingExtensions,
          );
          yield* output.raw(
            `Updated ${legacyBold(repaired.path)} with:\n${repaired.addedDeclarations.join("\n")}\n`,
            "stderr",
          );
        }
      });

      const initialResult = yield* planWithLoadRecovery();
      if (Option.isNone(initialResult)) return;
      let result: LegacyDeclarativeSyncResult = initialResult.value;

      // Resolve successful manifest-less plans too. Repairs re-enter planning so a
      // second, broader legacy gap (for example cron intents) cannot fall through to
      // migration writing after the first missing extension is declared.
      while (true) {
        if (
          engine.implementation === "next" &&
          !result.manifestPresent &&
          !toml.webhooksEnabled &&
          result.removals.extensions.includes("pg_net")
        ) {
          return yield* Effect.fail(
            new LegacyDeclarativeCompatibilityError({
              message: [
                "The migrations state includes pg_net, but Database Webhooks are not enabled in the local project config.",
                "",
                LEGACY_ENABLE_LOCAL_WEBHOOKS_SUGGESTION,
              ].join("\n"),
            }),
          );
        }
        const compatibility = legacyClassifyDeclarativeCompatibilityGap({
          implementation: engine.implementation,
          manifestPresent: result.manifestPresent,
          removals: result.removals,
          declaredExtensions: result.declaredExtensions,
        });
        if (compatibility.recommendedAction === "none") break;
        // `--allow-removals` is the scripted form of "Continue with removals": the
        // planned removals are reviewed as destructive changes below instead of
        // being refused as legacy-export evidence.
        if (flags.allowRemovals) break;

        // Both recommended actions mean the same thing to the user — the tree is a
        // legacy export — so they render one shared template and differ only in the
        // choices offered. Non-interactively the recoveries are the staged
        // regenerate and `--allow-removals`, carried on `suggestion` so `Output.fail`
        // prints them instead of the "rerun with --debug" footer.
        const gate = legacyFormatDeclarativeUpgradeGate({
          evidence: legacyFormatDeclarativeGapEvidence(compatibility),
          context: {
            declarativeDir: declarativeDirRel,
            schema: flags.schema,
            platform: legacyCurrentShellPlatform(),
          },
          offerAllowRemovals: true,
        });
        if (!tty.stdinIsTty || yes) {
          return yield* Effect.fail(
            new LegacyDeclarativeCompatibilityError({
              message: gate.message,
              suggestion: gate.suggestion,
            }),
          );
        }
        yield* output.raw(`${legacyYellow(gate.message)}\n`, "stderr");

        if (compatibility.recommendedAction === "stage-next-export") {
          const choice = yield* output.promptSelect("How would you like to continue?", [
            {
              value: "stage",
              label: `Generate next export to ${stagedDirRel}`,
              hint: "recommended",
            },
            { value: "continue", label: "Continue with removals" },
            { value: "cancel", label: "Cancel" },
          ]);
          if (choice === "continue") break;
          if (choice === "stage") yield* stageNextExport();
          return;
        }

        // Repairing the tree in place is offered only interactively, and only as an
        // advanced choice: on a real legacy tree each added declaration tends to
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
        const repaired = yield* legacyAppendExtensionDeclarations(
          declarativeDir,
          compatibility.repairableExtensions,
        );
        yield* output.raw(
          `Updated ${legacyBold(repaired.path)} with:\n${repaired.addedDeclarations.join("\n")}\n`,
          "stderr",
        );
        const replanned = yield* planWithLoadRecovery();
        if (Option.isNone(replanned)) return;
        result = replanned.value;
      }

      // Step 3: empty diff.
      if (result.diffSQL.trim().length < 2) {
        yield* output.raw("No schema changes found\n", "stderr");
        return;
      }
      yield* output.raw("Generated migration SQL:\n", "stderr");
      yield* output.raw(`${result.diffSQL}\n`, "stderr");

      // Step 4: resolve migration name (prompt in TTY when --name unset).
      const file = Option.getOrElse(flags.file, () => DEFAULT_SYNC_NAME);
      const explicitName = Option.getOrElse(flags.name, () => "");
      let migrationName = legacyResolveDeclarativeMigrationName(explicitName, file);
      if (explicitName.length === 0 && tty.stdinIsTty && !yes) {
        const input = yield* output.promptText(
          `Enter a name for this migration (press Enter to keep '${migrationName}'): `,
        );
        if (input.trim().length > 0) migrationName = input.trim();
      }

      // Step 5: write the timestamped migration file.
      const nowMillis = yield* Clock.currentTimeMillis;
      let migrationPaths: ReadonlyArray<string>;
      if (engine.implementation === "next" && result.files.length > 1) {
        const written = yield* legacyWritePgDeltaMigrations(fs, path, {
          workdir: cliSettings.workdir,
          baseMillis: nowMillis,
          name: migrationName,
          files: result.files,
        }).pipe(
          Effect.mapError((error) => new LegacyDeclarativeApplyError({ message: error.message })),
        );
        migrationPaths = written.map((migration) => migration.path);
      } else {
        const timestamp = formatTimestamp(nowMillis);
        const migrationPath = path.join(migrationsDir, `${timestamp}_${migrationName}.sql`);
        yield* legacyMakeDir(fs, migrationsDir);
        yield* fs.writeFileString(migrationPath, result.diffSQL);
        migrationPaths = [migrationPath];
      }
      for (const migrationPath of migrationPaths) {
        yield* output.raw(`Created new migration at ${legacyBold(migrationPath)}\n`, "stderr");
      }

      // Step 6: drop warnings.
      if (result.dropWarnings.length > 0) {
        yield* output.raw(
          `${legacyYellow(
            engine.implementation === "next"
              ? "Found destructive changes in schema diff. Please double check if these are expected:"
              : "Found drop statements in schema diff. Please double check if these are expected:",
          )}\n`,
          "stderr",
        );
        yield* output.raw(`${legacyYellow(result.dropWarnings.join("\n"))}\n`, "stderr");
      }

      // Step 7: apply decision.
      const decision = legacyResolveDeclarativeSyncApplyDecision({
        // The mutex check above gates on presence (Go `flag.Changed`); the decision
        // itself reads the resolved boolean value (Go's `BoolVar` default is false).
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
      yield* ensureLocalPostgresImageCurrent;
      const applyExit = yield* applyMigrationToLocal(
        { port: toml.port, password: toml.password, dnsResolver },
        migrationPaths,
      ).pipe(Effect.exit);

      if (Exit.isSuccess(applyExit)) {
        yield* output.raw("Migration applied successfully.\n", "stderr");
        return;
      }

      // A Ctrl-C or defect during the apply is not a migration-apply failure —
      // propagate it unchanged instead of synthesizing a fake
      // `LegacyDeclarativeApplyError` (review CLI-1958).
      const applyFailure = Cause.findFail(applyExit.cause);
      if (Result.isFailure(applyFailure)) {
        return yield* Effect.failCause(applyFailure.failure);
      }

      // Apply failed: print, save a debug bundle, and (in a TTY) offer reset+reapply.
      const applyError = applyFailure.success.error;
      yield* output.raw(
        `${legacyRed(`Migration failed to apply: ${applyError.message}`)}\n`,
        "stderr",
      );
      const ts = formatDebugId(yield* Clock.currentTimeMillis);
      const migrations = yield* legacyCollectMigrationsList(fs, path, migrationsDir);
      const debugDir = yield* saveApplyDebugBundle({
        id: `${ts}-apply-error`,
        sourceRef: result.sourceRef,
        targetRef: result.targetRef,
        migrationSql: result.diffSQL,
        error: applyError.message,
        migrations,
      });

      if (tty.stdinIsTty && !yes) {
        const shouldReset = yield* output.promptConfirm(
          "Would you like to reset the local database and reapply all migrations? (local data will be lost)",
          { defaultValue: false },
        );
        if (shouldReset) {
          // Go runs reset in-process (`cmd/db_schema_declarative.go:414-423`).
          // `legacyResetLocalDatabase` now runs the same way — in-process, sharing this
          // command's own context — rather than shelling out to a second `supabase-go`
          // child (CLI-2062): it resolves `LegacyNetworkIdFlag` itself, so no
          // argv-forwarding is needed to stay on a custom network.
          const resetExit = yield* legacyResetLocalDatabase().pipe(Effect.exit);
          if (Exit.isFailure(resetExit)) {
            // A Ctrl-C or defect during the recovery reset must cancel the command,
            // not get rewritten into a synthetic "unknown error" apply failure —
            // propagate it unchanged (review CLI-1958).
            const resetFailure = Cause.findFail(resetExit.cause);
            if (Result.isFailure(resetFailure)) {
              return yield* Effect.failCause(resetFailure.failure);
            }
            // Go returns `resetErr` here, surfacing the failure that actually blocked
            // recovery — not the original apply error — and prints it exactly once (no
            // extra "database reset failed:" wrapper). Build the reset error from the
            // real typed failure and use that one value for the message, suggestion,
            // debug bundle, and return.
            const rawResetFailure = resetFailure.success.error;
            const resetError = new LegacyDeclarativeApplyError({
              message: rawResetFailure.message,
              suggestion: legacyReadErrorSuggestion(rawResetFailure),
            });
            yield* output.raw(
              `${legacyRed(`Database reset also failed: ${resetError.message}`)}\n`,
              "stderr",
            );
            const resetDebugDir = yield* saveApplyDebugBundle({
              id: `${ts}-after-reset`,
              sourceRef: result.sourceRef,
              targetRef: result.targetRef,
              migrationSql: result.diffSQL,
              error: resetError.message,
              migrations,
            });
            // Go guards each saved-path line with `len(debugDir) > 0`
            // (`db_schema_declarative.go:413-419`), so a bundle that failed to save
            // does not print a path that does not exist.
            if (debugDir.length > 0) {
              yield* output.raw(`\nDebug information saved to ${legacyBold(debugDir)}\n`, "stderr");
            }
            if (resetDebugDir.length > 0) {
              yield* output.raw(
                `Debug information saved to ${legacyBold(resetDebugDir)}\n`,
                "stderr",
              );
            }
            yield* output.raw(legacyDebugBundleMessage(""), "stderr");
            return yield* Effect.fail(resetError);
          }
          yield* output.raw("Database reset and all migrations applied successfully.\n", "stderr");
          return;
        }
      }
      // Go: `if len(debugDir) > 0 { PrintDebugBundleMessage(debugDir) }`
      // (`db_schema_declarative.go:428-431`).
      if (debugDir.length > 0) {
        yield* output.raw(legacyDebugBundleMessage(debugDir), "stderr");
      }
      return yield* Effect.fail(applyError);
    }).pipe(
      // Mirror Go's `ensureProjectGroupsCached` PersistentPostRun (`cmd/root.go:176,
      // 214-218`): when the bootstrap path resolved a linked ref, write the
      // linked-project cache (`GET /v1/projects/{ref}` → `supabase/.temp/
      // linked-project.json`) whether sync succeeds or fails. The cache layer no-ops
      // when the file exists / no token / non-200. Only the linked bootstrap sets
      // `linkedProjectRef`, so non-linked syncs never trigger this.
      Effect.ensuring(
        Effect.suspend(() =>
          linkedProjectRef !== undefined ? linkedProjectCache.cache(linkedProjectRef) : Effect.void,
        ),
      ),
      Effect.ensuring(telemetryState.flush),
    );
  },
);

const declarativeDirHasFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  return entries.length > 0;
});

/** Connects once and applies the ordered migration files (Go's `applyMigrationToLocal`). */
const applyMigrationToLocal = (
  local: { port: number; password: string; dnsResolver: "native" | "https" },
  migrationPaths: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const dbConnection = yield* LegacyDbConnection;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const session = yield* dbConnection
      .connect(
        {
          // Go's applyMigrationToLocal connects with utils.Config.Hostname
          // (`apps/cli-go/cmd/db_schema_declarative.go:463`, deleted in
          // CLI-1970; last present at commit 7b469f5b3), honoring
          // SUPABASE_SERVICES_HOSTNAME / tcp DOCKER_HOST — not a hardcoded loopback.
          host: legacyGetHostname(),
          port: local.port,
          user: "postgres",
          password: local.password,
          database: "postgres",
        },
        { isLocal: true, dnsResolver: local.dnsResolver },
      )
      .pipe(
        Effect.mapError(
          (error) => new LegacyDeclarativeApplyError({ message: error.message, connect: true }),
        ),
      );
    for (const migrationPath of migrationPaths) {
      yield* legacyApplyMigrationFile(
        session,
        fs,
        path,
        migrationPath,
        (message) => new LegacyDeclarativeApplyError({ message }),
      );
    }
  }).pipe(Effect.scoped);
