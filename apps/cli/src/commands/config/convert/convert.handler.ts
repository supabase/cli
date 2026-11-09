import {
  convertCliConfigTomlToJsonc,
  parseCliConfigDocumentFile,
  createCliConfigDocumentText,
} from "@supabase/config/internal";
import { CliConfigParseError } from "@supabase/config/effect";
import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
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
  convertWarnings,
  dryRunMessage,
  dryRunPayload,
  jsonPrecedenceMessage,
  refusalMessage,
  REMOVED_MESSAGE,
  JSONC_APPEARED_MESSAGE,
  JSONC_REMOVED_NOTE,
  jsoncRemovalFailureNote,
  tomlRemovalFailureMessage,
  trustedDomainMessage,
  vscodeFailureWarning,
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

    const emitWarnings = (warnings: ReadonlyArray<string>) =>
      output.format === "text"
        ? Effect.forEach(warnings, (line) => output.raw(`${line}\n`, "stderr"), { discard: true })
        : Effect.void;

    if (flags.dryRun) {
      const vscode = yield* trustSchemaDomainInVscode(cliSettings.workdir, true);
      const warnings = convertWarnings({
        moved: outcome.movedComments,
        vscodeFailure: vscode.failure,
      });
      const message = dryRunMessage(vscode.updated);
      if (output.format === "text") {
        yield* output.raw(`${message}\n`, "stderr");
        yield* output.raw(outcome.text);
        yield* emitWarnings(warnings);
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

    yield* emitWarnings(
      convertWarnings({ moved: outcome.movedComments, vscodeFailure: undefined }),
    );

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
      const rollback = fs.remove(jsoncPath, { force: true }).pipe(
        Effect.as(JSONC_REMOVED_NOTE),
        Effect.catchTag("PlatformError", (cause) =>
          Effect.succeed(jsoncRemovalFailureNote(cause.message)),
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
      yield* output.raw(`${CONVERTED_MESSAGE}\n`);
      yield* output.raw(`${REMOVED_MESSAGE}\n`);
      if (vscode.updated) {
        yield* output.raw(`${trustedDomainMessage}\n`);
      }
      if (vscode.failure !== undefined) {
        yield* emitWarnings([vscodeFailureWarning(vscode.failure)]);
      }
    } else {
      yield* output.success(
        CONVERTED_MESSAGE,
        convertPayload({
          schema: outcome.schemaRef,
          moved: outcome.movedComments,
          vscodeUpdated: vscode.updated,
          warnings: convertWarnings({
            moved: outcome.movedComments,
            vscodeFailure: vscode.failure,
          }),
        }),
      );
    }
  }).pipe(Effect.ensuring(telemetryState.flush));
});
