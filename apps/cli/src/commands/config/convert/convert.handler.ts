import { convertCliConfigTomlToJsonc } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import { trustSupabaseSchemaDomain } from "../../../shared/init/project-init.ts";
import { InitParseSettingsError } from "../../../shared/init/project-init.errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  PropConvertMovedCommentCount,
  PropConvertTarget,
} from "../../../shared/telemetry/event-catalog.ts";
import { recordCommandTelemetry } from "../../../telemetry/command-telemetry-attributes.ts";
import type { ConfigConvertFlags } from "./convert.command.ts";
import {
  ConfigConvertAlreadyJsonError,
  ConfigConvertLoadConfigError,
  ConfigConvertOutputFlagUnsupportedError,
  ConfigConvertReasonWithoutTomlTargetError,
  ConfigConvertUnsupportedError,
  ConfigConvertWorkdirError,
} from "./convert.errors.ts";
import {
  alreadyConvertedMessage,
  alreadyConvertedPayload,
  CONVERTED_MESSAGE,
  convertPayload,
  convertReport,
  convertWarnings,
  dryRunMessage,
  dryRunPayload,
  jsonPrecedenceMessage,
  refusalMessage,
  JSONC_APPEARED_MESSAGE,
  JSONC_CHANGED_NOTE,
  JSONC_REMOVED_NOTE,
  JSONC_SYMLINK_MESSAGE,
  NOT_UTF8_MESSAGE,
  TOML_SYMLINK_MESSAGE,
  backupCheckFailureMessage,
  backupFailureMessage,
  backupUnverifiedMessage,
  jsoncRemovalFailureNote,
  tomlChangedMessage,
  undoCommand,
  writeFailureMessage,
} from "./convert.format.ts";
import {
  freeBackupPath,
  isSymlink,
  readConfigDocument,
  reportStyle,
  requireUtf8,
  writeConversion,
} from "./convert.shared.ts";
import { configConvertToToml } from "./convert-to-toml.handler.ts";
import { REASON_WITHOUT_TOML_TARGET_MESSAGE } from "./convert-to-toml.format.ts";

const trustSchemaDomainInVscode = Effect.fn("config.convert.vscode")(function* (
  workdir: string,
  dryRun: boolean,
) {
  const result = yield* trustSupabaseSchemaDomain(workdir, { dryRun }).pipe(
    Effect.match({
      onSuccess: (updated): { readonly updated: boolean; readonly failure?: string } => ({
        updated,
      }),
      onFailure: (error) => ({
        updated: false,
        failure: error instanceof InitParseSettingsError ? error.detail : error.message,
      }),
    }),
  );
  yield* Effect.annotateCurrentSpan("config.vscode_updated", result.updated);
  return result;
});

const refuseSymlinks = Effect.fnUntraced(function* (tomlPath: string, jsoncPath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* isSymlink(fs, tomlPath)) {
    return yield* new ConfigConvertUnsupportedError({ message: TOML_SYMLINK_MESSAGE });
  }
  if (yield* isSymlink(fs, jsoncPath)) {
    return yield* new ConfigConvertUnsupportedError({ message: JSONC_SYMLINK_MESSAGE });
  }
});

export const configConvert = Effect.fn("config.convert")(function* (flags: ConfigConvertFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  const outputFlag = yield* OutputFlag;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;

  yield* Effect.gen(function* () {
    yield* recordCommandTelemetry({ [PropConvertTarget]: flags.to === "toml" ? "toml" : "jsonc" });
    if (Option.isSome(outputFlag)) {
      return yield* new ConfigConvertOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("config convert"),
      });
    }

    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigConvertWorkdirError({ message: error.message })),
    );

    if (Option.isSome(flags.reason) && flags.to !== "toml") {
      return yield* new ConfigConvertReasonWithoutTomlTargetError({
        message: REASON_WITHOUT_TOML_TARGET_MESSAGE,
      });
    }
    if (flags.to === "toml") {
      return yield* configConvertToToml(flags);
    }

    yield* Effect.annotateCurrentSpan("config.dry_run", flags.dryRun);
    yield* Effect.annotateCurrentSpan("config.convert.target", "jsonc");
    const parsed = yield* readConfigDocument();
    const configDir = path.dirname(parsed.path);
    if (parsed.format === "json") {
      const jsonFile = path.basename(parsed.path);
      const tomlExists = yield* fs
        .exists(path.join(configDir, "config.toml"))
        .pipe(
          Effect.mapError((cause) => new ConfigConvertLoadConfigError({ message: cause.message })),
        );
      if (tomlExists) {
        return yield* new ConfigConvertAlreadyJsonError({
          message: jsonPrecedenceMessage(jsonFile),
        });
      }
      if (output.format === "text") {
        yield* output.raw(`${alreadyConvertedMessage(jsonFile)}\n`);
      } else {
        yield* output.success(alreadyConvertedMessage(jsonFile), alreadyConvertedPayload(jsonFile));
      }
      return;
    }

    yield* requireUtf8(parsed.path, NOT_UTF8_MESSAGE);
    const outcome = yield* convertCliConfigTomlToJsonc(parsed.rawText).pipe(
      Effect.catchTag(
        "CliConfigConvertError",
        (error) => new ConfigConvertUnsupportedError({ message: refusalMessage(error) }),
      ),
      Effect.withSpan("config.convert.render"),
    );
    yield* Effect.annotateCurrentSpan({
      "config.schema_source": outcome.schemaSource,
      "config.comment_count": outcome.commentCount,
      "config.moved_comment_count": outcome.movedComments.length,
    });
    yield* recordCommandTelemetry({ [PropConvertMovedCommentCount]: outcome.movedComments.length });

    const jsoncPath = path.join(configDir, "config.jsonc");
    yield* refuseSymlinks(parsed.path, jsoncPath);
    const backupPath = yield* freeBackupPath(configDir, "config.toml", backupCheckFailureMessage);
    const backup = `supabase/${path.basename(backupPath)}`;
    const windows = runtimeInfo.platform === "win32";
    const root = path.relative(runtimeInfo.cwd, cliSettings.workdir);
    const undo = undoCommand(
      windows ? root.replaceAll("\\", "/") : root,
      backup,
      windows ? "windows" : "posix",
    );

    if (flags.dryRun) {
      const vscode = yield* trustSchemaDomainInVscode(cliSettings.workdir, true);
      const warnings = convertWarnings({
        dryRun: true,
        undo,
        moved: outcome.movedComments,
        vscodeFailure: vscode.failure,
      });
      const message = dryRunMessage(vscode.updated, backup);
      if (output.format === "text") {
        yield* output.raw(outcome.text);
        yield* output.raw(
          `\n${convertReport(
            {
              dryRun: true,
              backup,
              undo,
              moved: outcome.movedComments,
              vscodeUpdated: vscode.updated,
              vscodeFailure: vscode.failure,
            },
            reportStyle(process.stderr),
          )}`,
          "stderr",
        );
      } else {
        yield* output.success(
          message,
          dryRunPayload({
            schema: outcome.schemaRef,
            backup,
            moved: outcome.movedComments,
            vscodeWouldUpdate: vscode.updated,
            warnings,
            content: outcome.text,
          }),
        );
      }
      return;
    }

    yield* writeConversion({
      sourcePath: parsed.path,
      targetPath: jsoncPath,
      backupPath,
      text: outcome.text,
      sourceText: parsed.rawText,
      messages: {
        permissions: (cause) =>
          `Could not read the permissions of supabase/config.toml: ${cause}. Nothing was converted.`,
        write: writeFailureMessage,
        targetAppeared: JSONC_APPEARED_MESSAGE,
        rollback: {
          removed: JSONC_REMOVED_NOTE,
          changed: JSONC_CHANGED_NOTE,
          removalFailure: jsoncRemovalFailureNote,
        },
        backupFailure: (cause, note) => backupFailureMessage(backup, cause, note),
        backupUnverified: (cause) => backupUnverifiedMessage(backup, cause, undo),
        sourceChanged: tomlChangedMessage(backup, undo),
      },
    });

    const vscode = yield* trustSchemaDomainInVscode(cliSettings.workdir, false);

    if (output.format === "text") {
      yield* output.raw(
        convertReport(
          {
            dryRun: false,
            backup,
            undo,
            moved: outcome.movedComments,
            vscodeUpdated: vscode.updated,
            vscodeFailure: vscode.failure,
          },
          reportStyle(process.stdout),
        ),
      );
    } else {
      yield* output.success(
        CONVERTED_MESSAGE,
        convertPayload({
          schema: outcome.schemaRef,
          backup,
          moved: outcome.movedComments,
          vscodeUpdated: vscode.updated,
          warnings: convertWarnings({
            dryRun: false,
            undo,
            moved: outcome.movedComments,
            vscodeFailure: vscode.failure,
          }),
        }),
      );
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
