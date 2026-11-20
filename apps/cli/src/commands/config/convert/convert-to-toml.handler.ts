import { convertCliConfigJsoncToToml } from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path } from "effect";

import { canPrompt } from "../../../command-internal/hosted-consent/hosted-consent.prompt.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import {
  PropConvertMovedCommentCount,
  PropConvertReason,
} from "../../../shared/telemetry/event-catalog.ts";
import {
  type ConvertReason,
  recordCommandTelemetry,
} from "../../../telemetry/command-telemetry-attributes.ts";
import type { ConfigConvertFlags } from "./convert.command.ts";
import {
  ConfigConvertLoadConfigError,
  ConfigConvertTomlExistsError,
  ConfigConvertUnsupportedError,
} from "./convert.errors.ts";
import { refusalMessage } from "./convert.format.ts";
import {
  ALREADY_TOML_MESSAGE,
  alreadyTomlPayload,
  convertedToTomlMessage,
  convertToTomlPayload,
  dryRunToTomlMessage,
  dryRunToTomlPayload,
  jsonChangedMessage,
  jsonNotUtf8Message,
  jsonSymlinkMessage,
  parseReason,
  REASON_OPTIONS,
  REASON_PROMPT,
  tomlAppearedMessage,
  tomlChangedNote,
  tomlExistsMessage,
  tomlRemovalFailureNote,
  tomlRemovedNote,
  tomlSymlinkMessage,
  tomlWriteFailureMessage,
  toTomlBackupCheckFailureMessage,
  toTomlBackupFailureMessage,
  toTomlBackupUnverifiedMessage,
  toTomlReport,
  toTomlWarnings,
  undoToTomlCommand,
} from "./convert-to-toml.format.ts";
import {
  freeBackupPath,
  isSymlink,
  readConfigDocument,
  reportStyle,
  requireUtf8,
  writeConversion,
} from "./convert.shared.ts";

const promptForReason = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const telemetryRuntime = yield* TelemetryRuntime;
  if (telemetryRuntime.consent !== "granted" || !(yield* canPrompt)) {
    return undefined;
  }
  const answer = yield* output
    .promptSelect(REASON_PROMPT, REASON_OPTIONS, { silentCancel: true })
    .pipe(Effect.catchCause(() => Effect.void));
  return answer === undefined ? undefined : parseReason(answer);
});

export const configConvertToToml = Effect.fnUntraced(function* (flags: ConfigConvertFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeInfo = yield* RuntimeInfo;

  yield* Effect.annotateCurrentSpan({
    "config.dry_run": flags.dryRun,
    "config.convert.target": "toml",
  });
  const parsed = yield* readConfigDocument();

  if (parsed.format !== "json") {
    if (output.format === "text") {
      yield* output.raw(`${ALREADY_TOML_MESSAGE}\n`);
    } else {
      yield* output.success(ALREADY_TOML_MESSAGE, alreadyTomlPayload());
    }
    return;
  }

  const configDir = path.dirname(parsed.path);
  const jsonFile = path.basename(parsed.path);
  const tomlPath = path.join(configDir, "config.toml");
  const tomlExists = yield* fs
    .exists(tomlPath)
    .pipe(Effect.mapError((cause) => new ConfigConvertLoadConfigError({ message: cause.message })));
  if (tomlExists) {
    return yield* new ConfigConvertTomlExistsError({ message: tomlExistsMessage(jsonFile) });
  }

  yield* requireUtf8(parsed.path, jsonNotUtf8Message(jsonFile));
  const outcome = yield* convertCliConfigJsoncToToml(parsed.rawText).pipe(
    Effect.catchTag(
      "CliConfigConvertError",
      (error) => new ConfigConvertUnsupportedError({ message: refusalMessage(error, jsonFile) }),
    ),
    Effect.withSpan("config.convert.render"),
  );
  yield* Effect.annotateCurrentSpan({
    "config.schema_source": outcome.schemaSource,
    "config.comment_count": outcome.commentCount,
    "config.moved_comment_count": outcome.movedComments.length,
  });
  yield* recordCommandTelemetry({ [PropConvertMovedCommentCount]: outcome.movedComments.length });

  if (yield* isSymlink(fs, parsed.path)) {
    return yield* new ConfigConvertUnsupportedError({ message: jsonSymlinkMessage(jsonFile) });
  }
  if (yield* isSymlink(fs, tomlPath)) {
    return yield* new ConfigConvertUnsupportedError({ message: tomlSymlinkMessage(jsonFile) });
  }
  const backupPath = yield* freeBackupPath(configDir, jsonFile, (cause) =>
    toTomlBackupCheckFailureMessage(jsonFile, cause),
  );
  const backup = `supabase/${path.basename(backupPath)}`;
  const windows = runtimeInfo.platform === "win32";
  const root = path.relative(runtimeInfo.cwd, cliSettings.workdir);
  const undo = undoToTomlCommand(
    windows ? root.replaceAll("\\", "/") : root,
    backup,
    jsonFile,
    windows ? "windows" : "posix",
  );

  if (flags.dryRun) {
    if (output.format === "text") {
      yield* output.raw(outcome.text);
      yield* output.raw(
        `\n${toTomlReport(
          { dryRun: true, jsonFile, backup, undo, moved: outcome.movedComments },
          reportStyle(process.stderr),
        )}`,
        "stderr",
      );
    } else {
      yield* output.success(
        dryRunToTomlMessage(jsonFile, backup),
        dryRunToTomlPayload({
          schema: outcome.schemaRef,
          backup,
          moved: outcome.movedComments,
          warnings: toTomlWarnings({ dryRun: true, undo, moved: outcome.movedComments }),
          content: outcome.text,
        }),
      );
    }
    return;
  }

  yield* writeConversion({
    sourcePath: parsed.path,
    targetPath: tomlPath,
    backupPath,
    text: outcome.text,
    sourceText: parsed.rawText,
    messages: {
      permissions: (cause) =>
        `Could not read the permissions of supabase/${jsonFile}: ${cause}. Nothing was converted.`,
      write: (cause) => tomlWriteFailureMessage(jsonFile, cause),
      targetAppeared: tomlAppearedMessage(jsonFile),
      rollback: {
        removed: tomlRemovedNote(jsonFile),
        changed: tomlChangedNote(jsonFile),
        removalFailure: (detail) => tomlRemovalFailureNote(jsonFile, detail),
      },
      backupFailure: (cause, note) => toTomlBackupFailureMessage(jsonFile, backup, cause, note),
      backupUnverified: (cause) => toTomlBackupUnverifiedMessage(jsonFile, backup, cause, undo),
      sourceChanged: jsonChangedMessage(jsonFile, backup, undo),
    },
  });

  if (output.format === "text") {
    yield* output.raw(
      toTomlReport(
        { dryRun: false, jsonFile, backup, undo, moved: outcome.movedComments },
        reportStyle(process.stdout),
      ),
    );
  } else {
    yield* output.success(
      convertedToTomlMessage(jsonFile),
      convertToTomlPayload({
        schema: outcome.schemaRef,
        backup,
        moved: outcome.movedComments,
        warnings: toTomlWarnings({ dryRun: false, undo, moved: outcome.movedComments }),
      }),
    );
  }

  const reason: ConvertReason | undefined = Option.isSome(flags.reason)
    ? flags.reason.value
    : yield* promptForReason();
  if (reason !== undefined) {
    yield* recordCommandTelemetry({ [PropConvertReason]: reason });
  }
});
