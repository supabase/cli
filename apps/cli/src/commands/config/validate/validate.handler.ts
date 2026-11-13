import {
  CliConfigFileConflictError,
  CliConfigParseError,
  CliConfigSchemaVersionError,
} from "@supabase/config/effect";
import {
  collectCliConfigEnvReferences,
  type CliConfigLocation,
  scanCliConfigDocument,
  type CliConfigDocumentScan,
  parseCliConfigDocumentFile,
  type ParsedCliConfigDocument,
} from "@supabase/config/internal";
import { Effect, FileSystem, Option, Result } from "effect";

import {
  aqua,
  bold,
  type ColorStream,
  dim,
  green,
  red,
  yellow,
} from "../../../command-internal/colors.ts";
import { tomlSegment } from "./validate.units.ts";
import {
  runConfigValidation,
  type EngineProblem,
  type EnvReferenceUse,
  type ValidateRun,
} from "./validate.engine.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../../command-internal/workdir-project.ts";
import { getDocumentValue, isDocumentRecord } from "../../../config/cli-config-document.ts";
import { loadCliConfigEnvLookup } from "../../../config/cli-config-env-lookup.ts";
import {
  reportableUnknownCliConfigKeys,
  suggestCliConfigKey,
} from "../../../config/cli-config-unknown-keys.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { type CliConfigLoadError } from "../../../shared/config/cli-config-load.errors.ts";
import { configParseCauseMessage } from "../../../shared/output/normalize-error.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  ConfigValidateLoadError,
  ConfigValidateOutputFlagUnsupportedError,
  ConfigValidateWorkdirError,
} from "./validate.errors.ts";
import {
  type ReportStyle,
  type StopStage,
  validateJsonPayload,
  validateReport,
  type ValidateReport,
  validateSummaryMessage,
} from "./validate.format.ts";
import { type ConfigProblem, displayPath, splitRemotePath } from "./validate.model.ts";

type ReportFormat = ValidateReport["format"];
type FileFormat = "toml" | "json";
type ReportBody = Omit<ValidateReport, "mode" | "deferred" | "unknownValues" | "complete">;

const reportStyle = (stream: ColorStream): ReportStyle => ({
  bold: (text) => bold(text, stream),
  dim: (text) => dim(text, stream),
  green: (text) => green(text, stream),
  red: (text) => red(text, stream),
  yellow: (text) => yellow(text, stream),
  code: (text) => aqua(text, stream),
});

const problem = (
  code: ConfigProblem["code"],
  fields: Omit<ConfigProblem, "code" | "severity"> & {
    readonly severity?: ConfigProblem["severity"];
  },
): ConfigProblem => ({ severity: "error", code, ...fields });

const reportFormat = (file: string, format: FileFormat): ReportFormat =>
  format === "toml" ? "toml" : file.endsWith(".jsonc") ? "jsonc" : "json";

function removedKeyProblems(
  parsed: ParsedCliConfigDocument,
  format: ReportFormat,
): ReadonlyArray<ConfigProblem> {
  return parsed.removedKeys.map(({ path, replacementPath, table, remote }) => {
    const scope = remote === undefined ? [] : ["remotes", remote];
    const tomlTable = (segments: ReadonlyArray<string>): string =>
      `[${[...scope, ...segments].map(tomlSegment).join(".")}]`;
    return problem("removed_key", {
      path,
      reason: "removed",
      help:
        table && format === "toml"
          ? `rename ${tomlTable(path)} to ${tomlTable(replacementPath)}`
          : `use ${displayPath(replacementPath)} instead`,
      ...(remote === undefined ? {} : { remote }),
    });
  });
}

const numberField = (cause: unknown, field: string): number | undefined => {
  const value = typeof cause === "object" && cause !== null ? Reflect.get(cause, field) : undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
};

function syntaxProblem(error: CliConfigParseError): ConfigProblem {
  const line = numberField(error.cause, "line");
  const column = numberField(error.cause, "column");
  return problem("syntax", {
    reason: configParseCauseMessage(error.cause).replace(/ \(line \d+, column \d+\)$/, ""),
    ...(line === undefined ? {} : { location: { line, column: column ?? 1, exact: true } }),
  });
}

const SCHEMA_DIRECTIVE = /^[ \t]*#:schema[ \t]+(\S+)/m;

function locateSchemaDeclaration(
  source: string,
  format: ReportFormat,
): CliConfigLocation | undefined {
  if (format !== "toml") {
    return scanCliConfigDocument(source, "json").locate(["$schema"], "value");
  }
  const match = SCHEMA_DIRECTIVE.exec(source);
  if (match === null || match[1] === undefined) return undefined;
  const before = source.slice(0, match.index + match[0].length - match[1].length);
  const lines = before.split("\n");
  const column = (lines.at(-1)?.length ?? 0) + 1;
  return {
    line: lines.length,
    column,
    endLine: lines.length,
    endColumn: column + match[1].length,
    exact: true,
  };
}

const KEY_TARGET_CODES: ReadonlySet<ConfigProblem["code"]> = new Set([
  "unknown_key",
  "removed_key",
  "deprecated_key",
]);

function locateProblem(
  item: ConfigProblem,
  document: CliConfigDocumentScan,
): CliConfigLocation | undefined {
  if (item.location !== undefined || item.path === undefined) {
    return item.location;
  }
  const segments = item.path;
  const target = KEY_TARGET_CODES.has(item.code) ? "key" : "value";
  const remotePath =
    item.remote === undefined || item.inBase === true
      ? undefined
      : ["remotes", item.remote, ...segments];
  return document.locate(remotePath ?? segments, target);
}

function locatedProblem(item: ConfigProblem, document: CliConfigDocumentScan): ConfigProblem {
  return { ...item, location: locateProblem(item, document) };
}

function deprecatedKeyProblems(parsed: ParsedCliConfigDocument): ReadonlyArray<ConfigProblem> {
  const rawRemotes = parsed.rawDocument?.["remotes"];
  const remoteNames = isDocumentRecord(rawRemotes) ? Object.keys(rawRemotes) : [];
  return parsed.deprecatedPaths.map((dotted) => {
    const owner = remoteNames
      .filter((name) => dotted.startsWith(`remotes.${name}.auth.`))
      .toSorted((left, right) => right.length - left.length)[0];
    const segments =
      owner === undefined
        ? dotted.split(".")
        : ["remotes", owner, ...dotted.slice(`remotes.${owner}.`.length).split(".")];
    const split = splitRemotePath(segments);
    const local = displayPath(split.path);
    return problem("deprecated_key", {
      severity: "warning",
      path: split.path,
      reason: "deprecated, will be removed in v4",
      help: `use ${local.replace(/enable_signup$/, "enabled")} instead`,
      ...(split.remote === undefined ? {} : { remote: split.remote }),
    });
  });
}

function unknownKeyProblems(parsed: ParsedCliConfigDocument): ReadonlyArray<ConfigProblem> {
  return reportableUnknownCliConfigKeys(parsed.rawDocument).map(({ path, knownKeys }) => {
    const isTable = isDocumentRecord(getDocumentValue(parsed.rawDocument, path));
    const suggestion = suggestCliConfigKey(path.at(-1) ?? "", knownKeys);
    const split = splitRemotePath(path);
    return problem("unknown_key", {
      path: split.path,
      reason: isTable ? "unknown table" : "unknown key",
      ...(suggestion === undefined ? {} : { help: `did you mean \`${suggestion}\`?` }),
      ...(split.remote === undefined ? {} : { remote: split.remote }),
    });
  });
}

function envLoadProblem(error: CliConfigLoadError): ConfigProblem {
  const { file } = error;
  if (file === undefined) {
    return problem("env_file", {
      label: "environment variables",
      reason: "could not be resolved",
      help: "check the variables set in your shell",
    });
  }
  return problem("env_file", {
    subject: file,
    reason: error.fileFailure === "parse" ? "could not be parsed" : "could not be read",
    help:
      error.fileFailure === "parse"
        ? `fix the syntax of ${file}`
        : `check that ${file} is a readable file`,
  });
}

function remotesShapeProblems(rawRemotes: unknown): ReadonlyArray<ConfigProblem> {
  if (rawRemotes === undefined) return [];
  if (!isDocumentRecord(rawRemotes)) {
    return [problem("invalid_type", { path: ["remotes"], reason: "expected a table" })];
  }
  return Object.entries(rawRemotes)
    .filter(([, value]) => !isDocumentRecord(value))
    .map(([name]) =>
      problem("invalid_type", { path: ["remotes", name], reason: "expected a table" }),
    );
}

const useLabel = (use: EnvReferenceUse): string =>
  use.location === undefined
    ? displayPath(use.path)
    : `${use.location.line}:${use.location.column}`;

function engineProblem(item: EngineProblem): ConfigProblem {
  const { env, ...rest } = item;
  if (env !== undefined) {
    return {
      ...rest,
      reason: `${env.name} is ${item.code === "env_unset" ? "not set" : "set but empty"}. It is used at ${env.uses.map(useLabel).join(", ")}`,
    };
  }
  return rest;
}

const runReport = (
  file: string,
  format: ReportFormat,
  remotes: ReadonlyArray<string>,
  notices: ReadonlyArray<ConfigProblem>,
  run: ValidateRun,
) => ({
  file,
  format,
  remotes,
  problems: [...notices, ...run.problems.map(engineProblem)],
  deferred: run.deferred,
  unknownValues: run.unknownValues,
  complete: run.complete,
});

export const configValidate = Effect.fn("config.validate")(function* (flags: {
  readonly resolveEnv: boolean;
}) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  const outputFlag = yield* OutputFlag;
  const processControl = yield* ProcessControl;
  const fs = yield* FileSystem.FileSystem;
  const { workdir } = cliSettings;
  const mode = flags.resolveEnv ? "resolve-env" : "default";

  const emit = Effect.fnUntraced(function* (
    report: ReportBody & Partial<Pick<ValidateReport, "deferred" | "unknownValues" | "complete">>,
  ) {
    const full: ValidateReport = {
      deferred: [],
      unknownValues: 0,
      complete: true,
      ...report,
      mode,
    };
    const errors = full.problems.filter((item) => item.severity === "error");
    yield* Effect.annotateCurrentSpan({
      "config.error_count": errors.length,
      "config.warning_count": full.problems.length - errors.length,
      "config.remote_count": full.remotes.length,
      "config.format": full.format,
      "config.complete": full.stoppedAt === undefined && full.complete,
      "config.deferred_count": full.deferred.length,
      "config.unknown_value_count": full.unknownValues,
      "config.resolve_env": flags.resolveEnv,
    });
    if (output.format !== "text") {
      yield* output.success(validateSummaryMessage(full), validateJsonPayload(full));
    } else {
      yield* output.raw(validateReport(full, reportStyle(process.stdout)));
    }
    if (errors.length > 0) yield* processControl.setExitCode(1);
  });

  const readSource = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));

  const stopReport = Effect.fnUntraced(function* (
    file: string,
    format: FileFormat,
    stoppedAt: StopStage,
    problems: ReadonlyArray<ConfigProblem>,
    options: { readonly readSource: boolean; readonly source?: string } = { readSource: true },
  ) {
    const source = options.source ?? (options.readSource ? yield* readSource(file) : "");
    const display = relativeConfigPath(workdir, file);
    const document = scanCliConfigDocument(source, format);
    return {
      file: display,
      format: reportFormat(display, format),
      remotes: [],
      stoppedAt,
      problems: problems.map((item) => locatedProblem(item, document)),
    } satisfies ReportBody;
  });

  yield* Effect.gen(function* () {
    if (Option.isSome(outputFlag)) {
      return yield* new ConfigValidateOutputFlagUnsupportedError({
        message: unsupportedOutputFlagMessage("config validate"),
      });
    }
    yield* validateWorkdirIsDirectory(workdir, fs).pipe(
      Effect.mapError((error) => new ConfigValidateWorkdirError({ message: error.message })),
    );

    const parsedResult = yield* parseCliConfigDocumentFile(workdir, {
      search: false,
      tolerateRemovedKeys: true,
    }).pipe(Effect.result, Effect.withSpan("config.validate.read"));
    if (Result.isFailure(parsedResult)) {
      const error = parsedResult.failure;
      if (error instanceof CliConfigFileConflictError) {
        const [first] = error.paths;
        const shown = error.paths.map((path) => relativeConfigPath(workdir, path));
        return yield* emit(
          yield* stopReport(
            first ?? "supabase/config.toml",
            "json",
            "file_conflict",
            [
              problem("file_conflict", {
                reason: `${shown.join(" and ")} both exist`,
                help: "delete the file you don't use",
              }),
            ],
            { readSource: false },
          ),
        );
      }
      if (error instanceof CliConfigSchemaVersionError) {
        const source = yield* readSource(error.path);
        return yield* emit(
          yield* stopReport(
            error.path,
            error.format,
            "schema_version",
            [
              problem("schema_version", {
                reason: error.message,
                location: locateSchemaDeclaration(source, reportFormat(error.path, error.format)),
              }),
            ],
            { readSource: true, source },
          ),
        );
      }
      if (error instanceof CliConfigParseError) {
        return yield* emit(
          yield* stopReport(error.path, error.format, "syntax", [syntaxProblem(error)]),
        );
      }
      return yield* new ConfigValidateLoadError({ message: error.message });
    }

    const parsed = parsedResult.success;
    if (parsed === null) {
      return yield* new ConfigValidateLoadError({
        message: yield* missingProjectConfigMessageEffect(cliSettings),
      });
    }

    if (parsed.rawDocument === undefined) {
      return yield* emit(
        yield* stopReport(
          parsed.path,
          parsed.format,
          "syntax",
          [problem("syntax", { reason: "the top level must be an object" })],
          { readSource: false, source: parsed.rawText },
        ),
      );
    }

    const file = relativeConfigPath(workdir, parsed.path);
    const format = reportFormat(file, parsed.format);
    const rawRemotes = parsed.rawDocument?.["remotes"];
    const remoteNames = isDocumentRecord(rawRemotes)
      ? Object.entries(rawRemotes)
          .filter(([, value]) => isDocumentRecord(value))
          .map(([name]) => name)
      : [];

    const notices: Array<ConfigProblem> = [
      ...removedKeyProblems(parsed, format),
      ...deprecatedKeyProblems(parsed),
      ...parsed.ignoredPaths.map((ignored) =>
        problem("shadowed_file", {
          subject: relativeConfigPath(workdir, ignored),
          reason: `is not validated or used: ${file} takes precedence`,
          help: "delete the file you don't use",
        }),
      ),
      ...unknownKeyProblems(parsed),
      ...remotesShapeProblems(rawRemotes),
    ];
    const declaration = parsed.schemaDeclaration;
    if (declaration !== undefined && declaration.version === undefined) {
      notices.push(
        problem("unrecognized_schema", {
          severity: "warning",
          subject: file,
          reason:
            "the schema reference is not a Supabase config schema, so the file is read as schema v1",
          help: "set it to https://supabase.com/schemas/config/v1.json",
          location: locateSchemaDeclaration(parsed.rawText, format),
        }),
      );
    }
    const document = scanCliConfigDocument(parsed.rawText, parsed.format);
    const locatedNotices = notices.map((item) => locatedProblem(item, document));

    const lookup = yield* Effect.gen(function* () {
      if (!flags.resolveEnv) return undefined;
      const names = [
        ...new Set(collectCliConfigEnvReferences(parsed.rawDocument).map((use) => use.name)),
      ];
      return yield* loadCliConfigEnvLookup(workdir, names).pipe(Effect.result);
    }).pipe(Effect.withSpan("config.validate.env"));
    if (lookup !== undefined && Result.isFailure(lookup)) {
      return yield* emit({
        file,
        format,
        remotes: [],
        stoppedAt: "env_file",
        problems: [...locatedNotices, envLoadProblem(lookup.failure)],
      });
    }

    const run = yield* runConfigValidation(
      parsed,
      workdir,
      lookup === undefined ? undefined : lookup.success,
    );
    return yield* emit(runReport(file, format, remoteNames, locatedNotices, run));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
