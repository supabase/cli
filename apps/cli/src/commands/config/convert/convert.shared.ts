import { CliConfigParseError } from "@supabase/config/effect";
import { createCliConfigDocumentText, parseCliConfigDocumentFile } from "@supabase/config/internal";
import { Effect, FileSystem, Path, Predicate } from "effect";

import {
  aqua,
  blue,
  bold,
  type ColorStream,
  dim,
  green,
  yellow,
} from "../../../command-internal/colors.ts";
import {
  failedConfigFilePath,
  recordConfigFormat,
} from "../../../config/cli-config-format-telemetry.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import {
  describeConfigParseError,
  missingProjectConfigMessageEffect,
} from "../../../command-internal/workdir-project.ts";
import {
  ConfigConvertFileChangedError,
  ConfigConvertLoadConfigError,
  ConfigConvertUnsupportedError,
  ConfigConvertWriteError,
} from "./convert.errors.ts";
import type { ReportStyle } from "./convert.format.ts";

export const isSymlink = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));

/** The first of `<source>.bak`, `<source>.2.bak`, ... that does not exist yet. */
export const freeBackupPath = Effect.fnUntraced(function* (
  configDir: string,
  source: string,
  checkFailureMessage: (cause: string) => string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (let attempt = 1; ; attempt++) {
    const candidate = path.join(
      configDir,
      attempt === 1 ? `${source}.bak` : `${source}.${attempt}.bak`,
    );
    const taken = yield* fs
      .exists(candidate)
      .pipe(
        Effect.mapError(
          (cause) => new ConfigConvertWriteError({ message: checkFailureMessage(cause.message) }),
        ),
      );
    if (!taken) {
      return candidate;
    }
  }
});

/** Removes the file the conversion created if it still holds `text`, returning a note for the error. */
const rollbackCreated = Effect.fnUntraced(function* (
  createdPath: string,
  text: string,
  notes: {
    readonly removed: string;
    readonly changed: string;
    readonly removalFailure: (cause: string) => string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(createdPath).pipe(
    Effect.flatMap((written) =>
      written === text
        ? fs.remove(createdPath).pipe(Effect.as(notes.removed))
        : Effect.succeed(notes.changed),
    ),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.succeed(
        Predicate.isTagged(cause.reason, "NotFound")
          ? notes.removed
          : notes.removalFailure(cause.message),
      ),
    ),
  );
});

/** Loads the project's config document, failing when the project has none. */
export const readConfigDocument = Effect.fnUntraced(function* () {
  const cliSettings = yield* CommandSettings;
  const parsed = yield* parseCliConfigDocumentFile(cliSettings.workdir, { search: false }).pipe(
    Effect.tapError((error) => recordConfigFormat(failedConfigFilePath(error))),
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
  yield* recordConfigFormat(parsed?.path);
  if (parsed === null) {
    return yield* new ConfigConvertLoadConfigError({
      message: yield* missingProjectConfigMessageEffect(cliSettings),
    });
  }
  return parsed;
});

/** Fails unless the file at `sourcePath` is valid UTF-8. */
export const requireUtf8 = Effect.fnUntraced(function* (
  sourcePath: string,
  notUtf8Message: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.readFile(sourcePath).pipe(
    Effect.mapError((cause) => new ConfigConvertLoadConfigError({ message: cause.message })),
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () => new ConfigConvertUnsupportedError({ message: notUtf8Message }),
      }),
    ),
  );
});

export interface ConversionWriteMessages {
  readonly permissions: (cause: string) => string;
  readonly write: (cause: string) => string;
  readonly targetAppeared: string;
  readonly rollback: {
    readonly removed: string;
    readonly changed: string;
    readonly removalFailure: (cause: string) => string;
  };
  readonly backupFailure: (cause: string, rollbackNote: string) => string;
  readonly backupUnverified: (cause: string) => string;
  readonly sourceChanged: string;
}

/** Creates the converted file, moves the source to its backup, and checks the backup still holds `sourceText`. */
export const writeConversion = Effect.fnUntraced(function* (input: {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly backupPath: string;
  readonly text: string;
  readonly sourceText: string;
  readonly messages: ConversionWriteMessages;
}) {
  const fs = yield* FileSystem.FileSystem;
  const { messages } = input;
  const sourceMode = yield* fs.stat(input.sourcePath).pipe(
    Effect.map((info) => info.mode & 0o7777),
    Effect.mapError(
      (cause) => new ConfigConvertWriteError({ message: messages.permissions(cause.message) }),
    ),
  );
  yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const created = yield* createCliConfigDocumentText(
        input.targetPath,
        input.text,
        sourceMode,
      ).pipe(
        Effect.catchTag(
          "CliConfigWriteError",
          (cause) => new ConfigConvertWriteError({ message: messages.write(cause.message) }),
        ),
      );
      if (!created) {
        return yield* new ConfigConvertFileChangedError({ message: messages.targetAppeared });
      }
      yield* fs.rename(input.sourcePath, input.backupPath).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.flatMap(rollbackCreated(input.targetPath, input.text, messages.rollback), (note) =>
            Effect.fail(
              new ConfigConvertWriteError({
                message: messages.backupFailure(cause.message, note),
              }),
            ),
          ),
        ),
      );
    }),
  );
  const moved = yield* fs
    .readFileString(input.backupPath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ConfigConvertWriteError({ message: messages.backupUnverified(cause.message) }),
      ),
    );
  if (moved !== input.sourceText) {
    return yield* new ConfigConvertFileChangedError({ message: messages.sourceChanged });
  }
}, Effect.withSpan("config.convert.write"));

export const reportStyle = (stream: ColorStream): ReportStyle => ({
  bold: (text) => bold(text, stream),
  dim: (text) => dim(text, stream),
  green: (text) => green(text, stream),
  yellow: (text) => yellow(text, stream),
  blue: (text) => blue(text, stream),
  code: (text) => aqua(text, stream),
});
