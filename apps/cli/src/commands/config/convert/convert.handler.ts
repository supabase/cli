import {
  convertCliConfigTomlToJsonc,
  parseCliConfigDocumentFile,
  createCliConfigDocumentText,
} from "@supabase/config/internal";
import { CliConfigParseError } from "@supabase/config/effect";
import { Effect, FileSystem, Option, Path, Predicate } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import {
  aqua,
  blue,
  bold,
  type ColorStream,
  dim,
  green,
  red,
  yellow,
} from "../../../command-internal/colors.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import {
  describeConfigParseError,
  missingProjectConfigMessageEffect,
} from "../../../command-internal/workdir-project.ts";
import { trustSupabaseSchemaDomain } from "../../../shared/init/project-init.ts";
import { InitParseSettingsError } from "../../../shared/init/project-init.errors.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { ConfigConvertFlags } from "./convert.command.ts";
import {
  ConfigConvertAlreadyJsonError,
  ConfigConvertFileChangedError,
  ConfigConvertLoadConfigError,
  ConfigConvertOutputFlagUnsupportedError,
  ConfigConvertUnsupportedError,
  ConfigConvertWorkdirError,
  ConfigConvertWriteError,
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
  type ReportStyle,
  JSONC_APPEARED_MESSAGE,
  JSONC_CHANGED_NOTE,
  JSONC_REMOVED_NOTE,
  JSONC_VANISHED_MESSAGE,
  jsoncRemovalFailureNote,
  tomlRemovalFailureMessage,
} from "./convert.format.ts";

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

const reportStyle = (stream: ColorStream): ReportStyle => ({
  bold: (text) => bold(text, stream),
  dim: (text) => dim(text, stream),
  green: (text) => green(text, stream),
  red: (text) => red(text, stream),
  yellow: (text) => yellow(text, stream),
  blue: (text) => blue(text, stream),
  code: (text) => aqua(text, stream),
});

export const configConvert = Effect.fn("config.convert")(function* (flags: ConfigConvertFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  const outputFlag = yield* OutputFlag;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    if (Option.isSome(outputFlag)) {
      return yield* new ConfigConvertOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("config convert"),
      });
    }

    yield* validateWorkdirIsDirectory(cliSettings.workdir, fs).pipe(
      Effect.mapError((error) => new ConfigConvertWorkdirError({ message: error.message })),
    );

    const parsed = yield* parseCliConfigDocumentFile(cliSettings.workdir, { search: false }).pipe(
      Effect.mapError(
        (cause) =>
          new ConfigConvertLoadConfigError({
            message:
              cause instanceof CliConfigParseError
                ? describeConfigParseError(cliSettings.workdir, cause)
                : cause.message,
          }),
      ),
      Effect.withSpan("config.convert.read"),
    );
    if (parsed === null) {
      return yield* new ConfigConvertLoadConfigError({
        message: yield* missingProjectConfigMessageEffect(cliSettings),
      });
    }
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

    const outcome = yield* convertCliConfigTomlToJsonc(parsed.rawText).pipe(
      Effect.catchTag(
        "CliConfigConvertError",
        (error) => new ConfigConvertUnsupportedError({ message: refusalMessage(error) }),
      ),
      Effect.withSpan("config.convert.render"),
    );
    yield* Effect.annotateCurrentSpan({
      "config.dry_run": flags.dryRun,
      "config.schema_source": outcome.schemaSource,
      "config.comment_count": outcome.commentCount,
      "config.moved_comment_count": outcome.movedComments.length,
    });

    if (flags.dryRun) {
      const vscode = yield* trustSchemaDomainInVscode(cliSettings.workdir, true);
      const warnings = convertWarnings({
        dryRun: true,
        moved: outcome.movedComments,
        vscodeFailure: vscode.failure,
      });
      const message = dryRunMessage(vscode.updated);
      if (output.format === "text") {
        yield* output.raw(outcome.text);
        yield* output.raw(
          `\n${convertReport(
            {
              dryRun: true,
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
            moved: outcome.movedComments,
            vscodeWouldUpdate: vscode.updated,
            warnings,
            content: outcome.text,
          }),
        );
      }
      return;
    }

    const jsoncPath = path.join(configDir, "config.jsonc");
    yield* Effect.gen(function* () {
      const tomlMode = yield* fs.stat(parsed.path).pipe(
        Effect.map((info) => info.mode & 0o7777),
        Effect.mapError(
          (cause) =>
            new ConfigConvertWriteError({
              message: `Could not read the permissions of supabase/config.toml: ${cause.message}. Nothing was converted.`,
            }),
        ),
      );
      const created = yield* createCliConfigDocumentText(jsoncPath, outcome.text, tomlMode).pipe(
        Effect.catchTag(
          "CliConfigWriteError",
          (cause) => new ConfigConvertWriteError({ message: cause.message }),
        ),
      );
      if (!created) {
        return yield* new ConfigConvertFileChangedError({ message: JSONC_APPEARED_MESSAGE });
      }
      const rollback = fs.readFileString(jsoncPath).pipe(
        Effect.flatMap((written) =>
          written === outcome.text
            ? fs.remove(jsoncPath).pipe(Effect.as(JSONC_REMOVED_NOTE))
            : Effect.succeed(JSONC_CHANGED_NOTE),
        ),
        Effect.catchTag("PlatformError", (cause) =>
          Effect.succeed(
            Predicate.isTagged(cause.reason, "NotFound")
              ? JSONC_REMOVED_NOTE
              : jsoncRemovalFailureNote(cause.message),
          ),
        ),
      );
      const current = yield* fs.readFileString(parsed.path).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.flatMap(rollback, (note) =>
            Effect.fail(
              new ConfigConvertWriteError({
                message: `Could not re-read supabase/config.toml to confirm it is unchanged: ${cause.message}. ${note}`,
              }),
            ),
          ),
        ),
      );
      if (current !== parsed.rawText) {
        const note = yield* rollback;
        return yield* new ConfigConvertFileChangedError({
          message: `supabase/config.toml changed on disk while config convert was running. ${note}`,
        });
      }
      const published = yield* fs.readFileString(jsoncPath).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Predicate.isTagged(cause.reason, "NotFound")
            ? Effect.void
            : Effect.fail(
                new ConfigConvertWriteError({
                  message: `Could not re-read supabase/config.jsonc to confirm it is intact: ${cause.message}. supabase/config.toml was kept.`,
                }),
              ),
        ),
      );
      if (published !== outcome.text) {
        return yield* new ConfigConvertFileChangedError({
          message: published === undefined ? JSONC_VANISHED_MESSAGE : JSONC_CHANGED_NOTE,
        });
      }
      yield* fs
        .remove(parsed.path)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConfigConvertWriteError({ message: tomlRemovalFailureMessage(cause.message) }),
          ),
        );
    }).pipe(Effect.withSpan("config.convert.write"));

    const vscode = yield* trustSchemaDomainInVscode(cliSettings.workdir, false);

    if (output.format === "text") {
      yield* output.raw(
        convertReport(
          {
            dryRun: false,
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
          moved: outcome.movedComments,
          vscodeUpdated: vscode.updated,
          warnings: convertWarnings({
            dryRun: false,
            moved: outcome.movedComments,
            vscodeFailure: vscode.failure,
          }),
        }),
      );
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
