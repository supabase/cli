import { Cause, Clock, Effect, Exit, FileSystem, Option, Path } from "effect";

import {
  LegacyDnsResolverFlag,
  LegacyExperimentalFlag,
  LegacyNetworkIdFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyBold, legacyRed, legacyYellow } from "../../../../../shared/legacy-colors.ts";
import { LegacyDbConnection } from "../../../../../shared/legacy-db-connection.service.ts";
import { legacyGetHostname } from "../../../../../shared/legacy-hostname.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyApplyMigrationFile } from "../../../../../shared/legacy-migration-apply.ts";
import { legacyReadProjectRefFile } from "../../../../../shared/legacy-temp-paths.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations, legacyPgDeltaTempPath } from "../declarative.cache.ts";
import { legacyResolveSmartTargetUrl } from "../declarative.smart-target.ts";
import {
  legacyCollectMigrationsList,
  legacyDebugBundleMessage,
  legacySaveDebugBundle,
} from "../declarative.debug-bundle.ts";
import {
  LegacyDeclarativeApplyError,
  LegacyDeclarativeMutuallyExclusiveFlagsError,
  LegacyDeclarativeNoFilesGeneratedError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import {
  legacyResolveDeclarativeMigrationName,
  legacyResolveDeclarativeSyncApplyDecision,
} from "../declarative.flow.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  type LegacyDeclarativeSyncResult,
  legacyDiffDeclarativeToMigrations,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { LegacyDeclarativeSeam } from "../declarative.seam.service.ts";
import { legacyWriteDeclarativeSchemas } from "../declarative.write.ts";
import type { LegacyDbSchemaDeclarativeSyncFlags } from "./sync.command.ts";

const DEFAULT_SYNC_NAME = "declarative_sync";

/** Go's `GetCurrentTimestamp`: UTC `YYYYMMDDHHmmss`. */
const formatTimestamp = (millis: number): string =>
  new Date(millis).toISOString().replace(/\D/g, "").slice(0, 14);

/** Go's debug-bundle id layout `20060102-150405` (UTC). */
const formatDebugId = (millis: number): string => {
  const digits = new Date(millis).toISOString().replace(/\D/g, "").slice(0, 14);
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
};

export const legacyDbSchemaDeclarativeSync = Effect.fn("legacy.db.schema.declarative.sync")(
  function* (flags: LegacyDbSchemaDeclarativeSyncFlags) {
    const output = yield* Output;
    const tty = yield* Tty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const telemetryState = yield* LegacyTelemetryState;
    const experimental = yield* LegacyExperimentalFlag;
    const yes = yield* LegacyYesFlag;
    const networkId = yield* LegacyNetworkIdFlag;
    const dnsResolver = yield* LegacyDnsResolverFlag;
    const seam = yield* LegacyDeclarativeSeam;

    yield* Effect.gen(function* () {
      // cobra `MarkFlagsMutuallyExclusive("apply", "no-apply")`
      // (`apps/cli-go/cmd/db_schema_declarative.go:490`) runs before PreRunE/RunE,
      // so reject the conflict before reading config or the pg-delta gate, rather
      // than letting `--no-apply` silently win in the apply-decision helper.
      const exclusive: Array<string> = [];
      if (flags.apply) exclusive.push("apply");
      if (flags.noApply) exclusive.push("no-apply");
      if (exclusive.length > 1) {
        return yield* Effect.fail(
          new LegacyDeclarativeMutuallyExclusiveFlagsError({
            message: `if any flags in the group [apply no-apply] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
          }),
        );
      }

      const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
      yield* legacyRequirePgDelta({
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        configPath: path.join("supabase", "config.toml"),
      });

      const declarativeDir = path.join(
        cliConfig.workdir,
        legacyResolveDeclarativeDir(path, toml.pgDelta),
      );
      const migrationsDir = path.join(cliConfig.workdir, "supabase", "migrations");
      const tempDir = legacyPgDeltaTempPath(path, cliConfig.workdir);
      const run: LegacyDeclarativeRunContext = {
        pgDelta: {
          projectId: Option.getOrElse(cliConfig.projectId, () => ""),
          cwd: cliConfig.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
        },
        formatOptions: Option.getOrElse(toml.pgDelta.formatOptions, () => ""),
        declarativeDir,
        schema: flags.schema,
        noCache: flags.noCache,
      };

      // Step 1: declarative files must exist; in a TTY, offer to generate them.
      if (!(yield* declarativeDirHasFiles(fs, declarativeDir))) {
        const noFiles = new LegacyDeclarativeNonInteractiveError({
          message: "no declarative schema found. Run supabase db schema declarative generate first",
        });
        if (!tty.stdinIsTty && !yes) return yield* Effect.fail(noFiles);
        // Go's Console.PromptYesNo auto-returns true when the global YES flag is set
        // (`apps/cli-go/internal/utils/console.go:70-73`), so --yes must skip this
        // prompt rather than block/fail.
        const ok = yes
          ? true
          : yield* output.promptConfirm("No declarative schema found. Generate a new one ?", {
              defaultValue: true,
            });
        if (!ok) return yield* Effect.fail(noFiles);
        // Go delegates to the full smart-generate flow (`runDeclarativeGenerate`,
        // db_schema_declarative.go:321): with migrations present it offers the
        // local / linked / custom target choice + local-reset prompt, so a linked
        // workdir can bootstrap from the remote rather than silently using local.
        const hasMigrations =
          (yield* legacyListLocalMigrations(fs, path, migrationsDir)).length > 0;
        const linkedRef = Option.isSome(cliConfig.projectId)
          ? cliConfig.projectId
          : yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir);
        // sync has no target flags (Go passes its target-less `cmd` into generate),
        // so reset stays interactive (the prompt fires under the local choice).
        const targetUrl = yield* legacyResolveSmartTargetUrl(
          { dbUrl: Option.none(), linked: false, password: Option.none(), reset: false },
          { port: toml.port, password: toml.password },
          hasMigrations,
          fs,
          path,
          cliConfig.workdir,
          linkedRef,
        );
        const generated = yield* legacyGenerateDeclarativeOutput(run, targetUrl);
        yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, generated);
        if (!(yield* declarativeDirHasFiles(fs, declarativeDir))) {
          return yield* Effect.fail(
            new LegacyDeclarativeNoFilesGeneratedError({
              message: "declarative schema generation did not produce any files",
            }),
          );
        }
      }

      // Step 2: diff migrations state vs declarative; on error, save a debug bundle.
      const result: LegacyDeclarativeSyncResult = yield* legacyDiffDeclarativeToMigrations(
        run,
      ).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const migrations = yield* legacyCollectMigrationsList(fs, path, migrationsDir);
            const debugDir = yield* legacySaveDebugBundle(fs, path, tempDir, migrationsDir, {
              id: formatDebugId(yield* Clock.currentTimeMillis),
              error: error.message,
              migrations,
            });
            yield* output.raw(legacyDebugBundleMessage(debugDir), "stderr");
          }),
        ),
      );

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
      const timestamp = formatTimestamp(yield* Clock.currentTimeMillis);
      const migrationPath = path.join(migrationsDir, `${timestamp}_${migrationName}.sql`);
      yield* fs.makeDirectory(migrationsDir, { recursive: true });
      yield* fs.writeFileString(migrationPath, result.diffSQL);
      yield* output.raw(`Created new migration at ${legacyBold(migrationPath)}\n`, "stderr");

      // Step 6: drop warnings.
      if (result.dropWarnings.length > 0) {
        yield* output.raw(
          `${legacyYellow("Found drop statements in schema diff. Please double check if these are expected:")}\n`,
          "stderr",
        );
        yield* output.raw(`${legacyYellow(result.dropWarnings.join("\n"))}\n`, "stderr");
      }

      // Step 7: apply decision.
      const decision = legacyResolveDeclarativeSyncApplyDecision({
        apply: flags.apply,
        noApply: flags.noApply,
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
      const applyExit = yield* applyMigrationToLocal(
        { port: toml.port, password: toml.password, dnsResolver },
        migrationPath,
      ).pipe(Effect.exit);

      if (Exit.isSuccess(applyExit)) {
        yield* output.raw("Migration applied successfully.\n", "stderr");
        return;
      }

      // Apply failed: print, save a debug bundle, and (in a TTY) offer reset+reapply.
      const applyError =
        applyExit.cause.reasons.find(Cause.isFailReason)?.error ??
        new LegacyDeclarativeApplyError({ message: "failed to apply migration" });
      yield* output.raw(
        `${legacyRed(`Migration failed to apply: ${applyError.message}`)}\n`,
        "stderr",
      );
      const ts = formatDebugId(yield* Clock.currentTimeMillis);
      const migrations = yield* legacyCollectMigrationsList(fs, path, migrationsDir);
      const debugDir = yield* legacySaveDebugBundle(fs, path, tempDir, migrationsDir, {
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
          // Forward --network-id: Go's in-process reset.Run honors the root viper
          // network-id (`apps/cli-go/internal/utils/docker.go:267-271`), so the
          // seam-spawned reset must carry it to stay on a custom network.
          const code = yield* seam.execInherit([
            "db",
            "reset",
            "--local",
            ...(Option.isSome(networkId) ? ["--network-id", networkId.value] : []),
          ]);
          if (code !== 0) {
            // Go returns `resetErr` here (`apps/cli-go/cmd/db_schema_declarative.go:414-423`),
            // surfacing the failure that actually blocked recovery — not the original
            // apply error. The seam yields only an exit code, so build the reset error
            // from it and use that one value for the message, debug bundle, and return.
            const resetError = new LegacyDeclarativeApplyError({
              message: `database reset failed (exit ${code})`,
            });
            yield* output.raw(
              `${legacyRed(`Database reset also failed: ${resetError.message}`)}\n`,
              "stderr",
            );
            const resetDebugDir = yield* legacySaveDebugBundle(fs, path, tempDir, migrationsDir, {
              id: `${ts}-after-reset`,
              sourceRef: result.sourceRef,
              targetRef: result.targetRef,
              migrationSql: result.diffSQL,
              error: resetError.message,
              migrations,
            });
            yield* output.raw(`Debug information saved to ${legacyBold(debugDir)}\n`, "stderr");
            yield* output.raw(
              `Debug information saved to ${legacyBold(resetDebugDir)}\n`,
              "stderr",
            );
            yield* output.raw(legacyDebugBundleMessage(""), "stderr");
            return yield* Effect.fail(resetError);
          }
          yield* output.raw("Database reset and all migrations applied successfully.\n", "stderr");
          return;
        }
      }
      yield* output.raw(legacyDebugBundleMessage(debugDir), "stderr");
      return yield* Effect.fail(applyError);
    }).pipe(Effect.ensuring(telemetryState.flush));
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

/** Connects to the local database and applies the single migration file (Go's `applyMigrationToLocal`). */
const applyMigrationToLocal = (
  local: { port: number; password: string; dnsResolver: "native" | "https" },
  migrationPath: string,
) =>
  Effect.gen(function* () {
    const dbConnection = yield* LegacyDbConnection;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const session = yield* dbConnection
      .connect(
        {
          // Go's applyMigrationToLocal connects with utils.Config.Hostname
          // (`apps/cli-go/cmd/db_schema_declarative.go:463`), honoring
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
        Effect.mapError((error) => new LegacyDeclarativeApplyError({ message: error.message })),
      );
    yield* legacyApplyMigrationFile(
      session,
      fs,
      path,
      migrationPath,
      (message) => new LegacyDeclarativeApplyError({ message }),
    );
  }).pipe(Effect.scoped);
