import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyExperimentalFlag,
  LegacyYesFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { Tty } from "../../../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../../../shared/legacy-colors.ts";
import { legacyReadProjectRefFile } from "../../../../../shared/legacy-temp-paths.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyListLocalMigrations } from "../declarative.cache.ts";
import {
  LegacyDeclarativeMutuallyExclusiveFlagsError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { LegacyDeclarativeSeam } from "../declarative.seam.service.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyGenerateDeclarativeOutput,
} from "../declarative.orchestrate.ts";
import { legacyWriteDeclarativeSchemas } from "../declarative.write.ts";
import type { LegacyDbSchemaDeclarativeGenerateFlags } from "./generate.command.ts";
import {
  type LegacyLocalConn,
  legacyLocalUrl,
  legacyResolveRemoteUrl,
  legacyResolveSmartTargetUrl,
} from "../declarative.smart-target.ts";

export const legacyDbSchemaDeclarativeGenerate = Effect.fn("legacy.db.schema.declarative.generate")(
  function* (flags: LegacyDbSchemaDeclarativeGenerateFlags) {
    const output = yield* Output;
    const tty = yield* Tty;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const telemetryState = yield* LegacyTelemetryState;
    const experimental = yield* LegacyExperimentalFlag;
    const yes = yield* LegacyYesFlag;

    yield* Effect.gen(function* () {
      // cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
      // (`apps/cli-go/cmd/db_schema_declarative.go:499`) runs before PreRunE/RunE,
      // so reject conflicting targets before reading config or the pg-delta gate.
      // "Set" follows cobra's `Changed`: Option set when `Some`, boolean when `true`.
      const exclusive: Array<string> = [];
      if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
      if (flags.linked) exclusive.push("linked");
      if (flags.local) exclusive.push("local");
      if (exclusive.length > 1) {
        return yield* Effect.fail(
          new LegacyDeclarativeMutuallyExclusiveFlagsError({
            message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
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
      const local: LegacyLocalConn = { port: toml.port, password: toml.password };

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

      const hasExplicitTarget = flags.local || flags.linked || Option.isSome(flags.dbUrl);

      let targetUrl: string;
      let overwrite: boolean;
      if (hasExplicitTarget) {
        if (flags.local) {
          // Go runs ensureLocalDatabaseStarted before generating from local
          // (db_schema_declarative.go:190) — start a stopped stack instead of
          // failing to connect.
          yield* (yield* LegacyDeclarativeSeam).ensureLocalDatabaseStarted();
          targetUrl = legacyLocalUrl(local);
        } else {
          targetUrl = yield* legacyResolveRemoteUrl(flags);
        }
        overwrite = flags.overwrite;
      } else {
        if (!tty.stdinIsTty && !yes) {
          return yield* Effect.fail(
            new LegacyDeclarativeNonInteractiveError({
              message: "in non-interactive mode, specify a target: --local, --linked, or --db-url",
            }),
          );
        }
        if ((yield* hasDeclarativeFiles(fs, declarativeDir)) && !flags.overwrite) {
          // Go asks via Console.PromptYesNo (db_schema_declarative.go:208, default
          // false), which auto-returns true under the global --yes flag, so --yes
          // regenerates without prompting instead of blocking in non-interactive mode.
          const ok = yes
            ? true
            : yield* output.promptConfirm(
                `Declarative schema already exists at ${legacyBold(
                  declarativeDir,
                )}. Regenerate from database? This will overwrite existing files.`,
                { defaultValue: false },
              );
          if (!ok) {
            yield* output.raw("Skipped generating declarative schema.\n", "stderr");
            return;
          }
        }
        const hasMigrations = yield* hasMigrationFiles(fs, path, migrationsDir);
        // Go's `runDeclarativeGenerate` offers a "Linked project" choice when the
        // workdir is linked (`flags.LoadProjectRef` succeeds). Resolve the ref the
        // same way the resolver's `--linked` branch does (config `project_id` →
        // `.temp/project-ref`) so the smart prompt offers linked iff `--linked`
        // would work for this workdir.
        const linkedRef = Option.isSome(cliConfig.projectId)
          ? cliConfig.projectId
          : yield* legacyReadProjectRefFile(fs, path, cliConfig.workdir);
        targetUrl = yield* legacyResolveSmartTargetUrl(
          flags,
          local,
          hasMigrations,
          fs,
          path,
          cliConfig.workdir,
          linkedRef,
        );
        overwrite = true;
      }

      const result = yield* legacyGenerateDeclarativeOutput(run, targetUrl);

      if (!overwrite && (yield* hasDeclarativeFiles(fs, declarativeDir))) {
        // Go's confirmOverwrite goes through Console.PromptYesNo, which returns true
        // immediately when the global YES flag is set (`apps/cli-go/internal/utils/
        // console.go:70-73`). Honor --yes here too, or non-interactive/JSON runs
        // would error on the prompt and a TTY would block despite --yes.
        const ok = yes
          ? true
          : yield* output.promptConfirm(
              "Overwrite declarative schema? Existing files may be deleted.",
              { defaultValue: false },
            );
        if (!ok) {
          yield* output.raw("Skipped writing declarative schema.\n", "stderr");
          return;
        }
      }

      yield* legacyWriteDeclarativeSchemas(fs, path, declarativeDir, result);
      yield* output.raw(`Declarative schema written to ${legacyBold(declarativeDir)}\n`, "stderr");
    }).pipe(Effect.ensuring(telemetryState.flush));
  },
);

const hasDeclarativeFiles = Effect.fnUntraced(function* (fs: FileSystem.FileSystem, dir: string) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as string[]));
  return entries.length > 0;
});

const hasMigrationFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  migrationsDir: string,
) {
  const migrations = yield* legacyListLocalMigrations(fs, path, migrationsDir);
  return migrations.length > 0;
});
