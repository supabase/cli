import {
  CliConfigFileConflictError,
  CliConfigParseError,
  CliConfigSchemaVersionError,
} from "@supabase/config/effect";
import {
  type CliConfigLocation,
  locateCliConfigKey,
  parseCliConfigDocumentFile,
  type ParsedCliConfigDocument,
} from "@supabase/config/internal";
import { Effect, FileSystem, Option, Path, Result } from "effect";

import {
  aqua,
  bold,
  type ColorStream,
  dim,
  green,
  red,
  yellow,
} from "../../../command-internal/colors.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { unsupportedOutputFlagMessage } from "../../../command-internal/output-formats.ts";
import {
  type ConfigValidationIssue,
  missingIssue,
} from "../../../command-internal/config-validate.ts";
import { collectLocalConfigIssues } from "../../../command-internal/local-config-values.ts";
import { validateWorkdirIsDirectory } from "../../../command-internal/workdir-validation.ts";
import {
  missingProjectConfigMessageEffect,
  relativeConfigPath,
} from "../../../command-internal/workdir-project.ts";
import { cliRemoteProjectIdEnvName } from "../../../config/cli-config-keys.ts";
import { CLI_CONFIG_OPTIONAL_ENV_PATHS } from "../../../config/cli-config-key-annotations.ts";
import {
  describeCliConfigOrigin,
  type CliConfigKeyOrigin,
} from "../../../config/cli-config-key.ts";
import { getDocumentValue, isDocumentRecord } from "../../../config/cli-config-document.ts";
import { flattenSchemaIssues } from "../../../config/cli-config-schema-issues.ts";
import {
  reportableUnknownCliConfigKeys,
  suggestCliConfigKey,
} from "../../../config/cli-config-unknown-keys.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import {
  CliConfigValues,
  type ResolvedCliConfig,
} from "../../../config/cli-config-values.service.ts";
import { type CliConfigValueError } from "../../../config/cli-config.errors.ts";
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
import {
  type ConfigProblem,
  dedupeProblems,
  displayPath,
  envReferences,
  type EnvReference,
  isPublicValuePath,
  nearestEnabledGate,
  splitRemotePath,
  withoutFollowOns,
  withoutUnresolvedEnvErrors,
} from "./validate.model.ts";

type ReportFormat = ValidateReport["format"];
type FileFormat = "toml" | "json";

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
  fields: Omit<ConfigProblem, "code" | "severity" | "showValue"> & {
    readonly severity?: ConfigProblem["severity"];
    readonly showValue?: boolean;
  },
): ConfigProblem => ({ severity: "error", showValue: false, code, ...fields });

const withRemote = (
  problems: ReadonlyArray<ConfigProblem>,
  remote: string | undefined,
): ReadonlyArray<ConfigProblem> =>
  remote === undefined
    ? problems
    : problems.map((item) => (item.remote === undefined ? { ...item, remote } : item));

const reportFormat = (file: string, format: FileFormat): ReportFormat =>
  format === "toml" ? "toml" : file.endsWith(".jsonc") ? "jsonc" : "json";

const stripBrackets = (key: string): string => key.replace(/^\[|\]$/g, "");

function removedKeyProblems(
  parsed: ParsedCliConfigDocument,
  format: ReportFormat,
): ReadonlyArray<ConfigProblem> {
  return parsed.removedKeys.map(({ key, replacement }) => {
    const split = splitRemotePath(stripBrackets(key).split("."));
    const local = displayPath(split.path);
    const replacementLocal = splitRemotePath(stripBrackets(replacement).split(".")).path.join(".");
    const isTable = key.startsWith("[");
    return problem("removed_key", {
      path: split.path,
      reason: "removed",
      help:
        isTable && format === "toml"
          ? `rename [${local}] to [${replacementLocal}]`
          : `use ${replacementLocal} instead`,
      ...(split.remote === undefined ? {} : { remote: split.remote }),
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
  if (format !== "toml") return locateCliConfigKey(source, "json", ["$schema"], "value");
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
  source: string,
  format: FileFormat,
): CliConfigLocation | undefined {
  if (item.location !== undefined || item.path === undefined || item.external !== undefined) {
    return item.location;
  }
  const segments = item.path;
  const target = KEY_TARGET_CODES.has(item.code) ? "key" : "value";
  const remotePath = item.remote === undefined ? undefined : ["remotes", item.remote, ...segments];
  const candidates =
    remotePath === undefined
      ? [segments]
      : item.code === "remote_project_id"
        ? [remotePath]
        : [remotePath, segments];
  const attempts = candidates.map((path) => locateCliConfigKey(source, format, path, target));
  return (
    attempts.find((found) => found?.exact === true) ?? attempts.find((found) => found !== undefined)
  );
}

function deprecatedKeyProblems(parsed: ParsedCliConfigDocument): ReadonlyArray<ConfigProblem> {
  return parsed.deprecatedPaths.map((dotted) => {
    const split = splitRemotePath(dotted.split("."));
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

const schemaProblems = (
  failures: ReadonlyArray<CliConfigParseError>,
): ReadonlyArray<ConfigProblem> =>
  failures.flatMap((failure) => {
    const flat = flattenSchemaIssues(failure.cause);
    if (flat.length === 0) {
      return [problem("invalid_value", { reason: "does not match the config schema" })];
    }
    return flat.map((issue) => {
      const { path } = issue;
      const detail =
        issue.code === "missing_required" && path.length > 0
          ? missingIssue(displayPath(path), "")
          : { reason: issue.reason, help: issue.help };
      return problem(issue.code, {
        ...(path.length === 0 ? {} : { path }),
        reason: detail.reason,
        ...(detail.help === undefined ? {} : { help: detail.help }),
        showValue: issue.code !== "missing_required" && path.length > 0 && isPublicValuePath(path),
      });
    });
  });

function invalidValueProblem(error: CliConfigValueError, file: string): ConfigProblem {
  const fromEnv = error.tier === "shell" || error.tier === "projectEnv";
  const reason =
    error.expected !== undefined
      ? `expected ${error.expected}`
      : error.issues !== undefined && error.issues.length > 0
        ? error.issues.join("; ")
        : "invalid value";
  const path = error.path.split(".");
  return problem("invalid_value", {
    path,
    reason,
    ...(error.expected?.startsWith("one of") ? { help: `use ${error.expected}` } : {}),
    ...(fromEnv && error.source !== undefined
      ? {
          external: true as const,
          help: `${error.source} sets this value, not ${file}; fix or unset it there`,
        }
      : { showValue: isPublicValuePath(path) }),
  });
}

function semanticProblem(
  issue: ConfigValidationIssue,
  origin: CliConfigKeyOrigin,
  file: string,
  describeOrigin: (origin: CliConfigKeyOrigin) => string,
): ConfigProblem {
  const { code } = issue;
  const path = issue.segments ?? issue.path.split(".");
  const fromEnv = origin.tier === "shell" || origin.tier === "projectEnv";
  return problem(code, {
    ...(issue.path === "" ? {} : { path }),
    reason: issue.reason,
    ...(fromEnv
      ? {
          external: true as const,
          help: `${describeOrigin(origin)} sets this value, not ${file}; fix or unset it there`,
        }
      : {
          ...(issue.help === undefined ? {} : { help: issue.help }),
          showValue: code !== "missing_required" && issue.path !== "" && isPublicValuePath(path),
        }),
  });
}

function envLoadProblem(error: CliConfigLoadError): ConfigProblem {
  const { file } = error;
  if (file === undefined) {
    return problem("env_file", {
      subject: "environment variables",
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

function remoteFailureProblem(failure: { remote: string; message: string }): ConfigProblem {
  const duplicate = /^duplicate project_id for \[remotes\.[^\]]+\] and \[remotes\.([^\]]+)\]$/.exec(
    failure.message,
  );
  return problem("remote_project_id", {
    path: ["project_id"],
    remote: failure.remote,
    reason:
      duplicate?.[1] === undefined
        ? "not a project ref"
        : `same project_id as remotes.${duplicate[1]}`,
    help:
      duplicate?.[1] === undefined
        ? "use the 20-character ref from your project's dashboard URL"
        : "give each remote its own project_id",
    showValue: true,
  });
}

export const configValidate = Effect.fn("config.validate")(function* () {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliSettings = yield* CommandSettings;
  const outputFlag = yield* OutputFlag;
  const processControl = yield* ProcessControl;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const configValues = yield* CliConfigValues;
  const { workdir } = cliSettings;

  const emit = Effect.fnUntraced(function* (report: ValidateReport) {
    const errors = report.problems.filter((item) => item.severity === "error");
    yield* Effect.annotateCurrentSpan({
      "config.error_count": errors.length,
      "config.warning_count": report.problems.length - errors.length,
      "config.remote_count": report.remotes.length,
      "config.format": report.format,
      "config.complete": report.stoppedAt === undefined,
    });
    if (output.format !== "text") {
      yield* output.success(validateSummaryMessage(report), validateJsonPayload(report));
    } else {
      yield* output.raw(validateReport(report, reportStyle(process.stdout)));
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
    return {
      file: display,
      format: reportFormat(display, format),
      source,
      remotes: [],
      skippedRemotes: [],
      stoppedAt,
      problems: problems.map((item) => ({
        ...item,
        location: locateProblem(item, source, format),
      })),
    } satisfies ValidateReport;
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
                showValue: true,
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
          reason: `${declaration.ref} is not a Supabase config schema, so the file is read as schema v1`,
          help: "set it to https://supabase.com/schemas/config/v1.json",
          location: locateSchemaDeclaration(parsed.rawText, format),
          showValue: true,
        }),
      );
    }

    interface PassResult {
      readonly problems: ReadonlyArray<ConfigProblem>;
      readonly resolved: ResolvedCliConfig | undefined;
      readonly stop?: StopStage;
    }

    const pass = Effect.fnUntraced(function* (remote: string | undefined) {
      const result = yield* configValues
        .load({
          workdir,
          projectRef: Option.none(),
          validation: true,
          ...(remote === undefined ? {} : { remoteName: remote }),
        })
        .pipe(Effect.result);
      if (Result.isFailure(result)) {
        const error = result.failure;
        const failed = (problems: ReadonlyArray<ConfigProblem>, stop?: StopStage): PassResult => ({
          problems: withRemote(problems, remote),
          resolved: undefined,
          ...(stop === undefined ? {} : { stop }),
        });
        switch (error._tag) {
          case "CliConfigParseError":
            return failed(schemaProblems([error]));
          case "CliConfigValueError":
            return failed([invalidValueProblem(error, file)]);
          case "CliConfigRemovedEnvError":
            return failed([problem("removed_env", { reason: error.message })], "removed_env");
          case "CliConfigLoadError":
            return failed([envLoadProblem(error)], "env_file");
          default:
            return yield* new ConfigValidateLoadError({ message: error.message });
        }
      }
      const resolved = result.success;
      const semantic = yield* collectLocalConfigIssues(
        resolved.materialized.config,
        workdir,
        resolved.loaded.document,
        resolved.loaded.path,
      );
      const removedPaths = [
        ...resolved.pruned,
        ...resolved.invalid.map((error) => error.path.split(".")),
      ];
      const describeOrigin = (origin: CliConfigKeyOrigin) =>
        describeCliConfigOrigin(origin, { workdir, path: pathService });
      const passed: PassResult = {
        problems: withRemote(
          [
            ...schemaProblems(resolved.schemaFailures),
            ...resolved.invalid.map((error) => invalidValueProblem(error, file)),
            ...withoutFollowOns(
              semantic.map((issue) =>
                semanticProblem(
                  issue,
                  resolved.materialized.originAt(issue.path),
                  file,
                  describeOrigin,
                ),
              ),
              removedPaths,
            ),
          ],
          remote,
        ),
        resolved,
      };
      return passed;
    });

    const base = yield* pass(undefined).pipe(Effect.withSpan("config.validate.base"));
    if (base.stop !== undefined) {
      const report = {
        file,
        format,
        source: parsed.rawText,
        remotes: [],
        skippedRemotes: [],
        stoppedAt: base.stop,
        problems: [...notices, ...base.problems].map((item) => ({
          ...item,
          location: locateProblem(item, parsed.rawText, parsed.format),
        })),
      } satisfies ValidateReport;
      return yield* emit(report);
    }

    const references = envReferences(parsed.rawDocument);
    const { unresolved, unresolvedProjectIdRemotes } = yield* Effect.gen(function* () {
      const none = {
        unresolved: [] as ReadonlyArray<EnvReference>,
        unresolvedProjectIdRemotes: new Set<string>(),
      };
      if (references.length === 0) return none;
      const resolved: ResolvedCliConfig | undefined =
        base.resolved ??
        (yield* configValues
          .load({
            workdir,
            projectRef: Option.none(),
            ignoreConfigFile: true,
            validation: true,
          })
          .pipe(Effect.option, Effect.map(Option.getOrUndefined)));
      if (resolved === undefined) return none;
      const projectIdRemotes = references.flatMap((reference) =>
        reference.remote !== undefined && reference.path.join(".") === "project_id"
          ? [reference.remote]
          : [],
      );
      const values = yield* resolved
        .envValues([
          ...references.map((reference) => reference.name),
          ...projectIdRemotes.map(cliRemoteProjectIdEnvName),
        ])
        .pipe(Effect.orElseSucceed((): Record<string, string> => ({})));
      const unresolvedRefs = references.filter((reference) => values[reference.name] === undefined);
      return {
        unresolved: unresolvedRefs,
        unresolvedProjectIdRemotes: new Set(
          unresolvedRefs.flatMap((reference) =>
            reference.remote !== undefined &&
            reference.path.join(".") === "project_id" &&
            values[cliRemoteProjectIdEnvName(reference.remote)] === undefined
              ? [reference.remote]
              : [],
          ),
        ),
      };
    }).pipe(Effect.withSpan("config.validate.env"));

    const failedRemotes = new Map(
      (base.resolved?.remoteFailures ?? []).map((failure) => [failure.remote, failure]),
    );
    const skippedRemotes = remoteNames
      .filter((name) => failedRemotes.has(name))
      .map((name) => ({
        name,
        reason: unresolvedProjectIdRemotes.has(name)
          ? "project_id is an unset env() reference"
          : "invalid project_id",
      }));
    const checkedRemotes = remoteNames.filter((name) => !failedRemotes.has(name));
    const remotePasses = yield* Effect.forEach(checkedRemotes, (name) => pass(name), {
      concurrency: 1,
    }).pipe(Effect.withSpan("config.validate.remotes"));
    const passes = new Map<string | undefined, PassResult>([
      [undefined, base],
      ...checkedRemotes.map((name, index): [string, PassResult] => [name, remotePasses[index]!]),
    ]);

    const remoteWrites = (remote: string, path: ReadonlyArray<string>): boolean =>
      isDocumentRecord(rawRemotes) && getDocumentValue(rawRemotes[remote], path) !== undefined;
    const remoteOverrides = (remote: string, path: ReadonlyArray<string>): boolean =>
      isDocumentRecord(rawRemotes) &&
      path.some((_, index) => {
        const value = getDocumentValue(rawRemotes[remote], path.slice(0, index + 1));
        return value !== undefined && !isDocumentRecord(value);
      });
    const inheritedBy = (reference: EnvReference, remote: string): boolean =>
      reference.remote === undefined && !remoteOverrides(remote, reference.path);
    const unresolvedSet = new Set(unresolved);
    const unresolvedFor = (remote: string | undefined): ReadonlyArray<EnvReference> =>
      references.filter(
        (reference) =>
          unresolvedSet.has(reference) &&
          (reference.remote === remote || (remote !== undefined && inheritedBy(reference, remote))),
      );
    const { kept, blamed } = withoutUnresolvedEnvErrors(
      dedupeProblems(
        [
          ...notices,
          ...base.problems,
          ...(base.resolved?.remoteFailures ?? [])
            .filter(
              (failure) =>
                remoteNames.includes(failure.remote) &&
                !unresolvedProjectIdRemotes.has(failure.remote),
            )
            .map(remoteFailureProblem),
          ...remotePasses.flatMap((item) => item.problems),
        ],
        remoteWrites,
      ),
      unresolvedFor,
    );

    const isRelevantIn = (reference: EnvReference, context: string | undefined): boolean => {
      if (CLI_CONFIG_OPTIONAL_ENV_PATHS[displayPath(reference.path)] !== undefined) return false;
      const owner = passes.get(context)?.resolved;
      const gate =
        nearestEnabledGate(owner?.materialized.config, reference.path) ??
        nearestEnabledGate(owner?.loaded.document, reference.path);
      return gate !== false;
    };
    const envWarning = (reference: EnvReference, remote: string | undefined) =>
      problem("env_unresolved", {
        severity: "warning",
        path: reference.path,
        reason: `${reference.name} is not set, so this key gets the literal text "env(${reference.name})"`,
        help: `set ${reference.name} in your shell or supabase/.env (SUPABASE_ENV=<name> also reads supabase/.env.<name>)`,
        showValue: true,
        ...(remote === undefined ? {} : { remote }),
      });
    const isOverridden = (reference: EnvReference, context: string | undefined): boolean => {
      const origin = passes
        .get(context)
        ?.resolved?.materialized.originAt(displayPath(reference.path));
      return origin?.tier === "shell" || origin?.tier === "projectEnv" || origin?.tier === "flag";
    };
    const envWarnings = unresolved.flatMap((reference) => {
      const warns = (context: string | undefined) =>
        !isOverridden(reference, context) &&
        (blamed.some((item) => item.reference === reference && item.remote === context) ||
          isRelevantIn(reference, context));
      if (reference.remote !== undefined) {
        return warns(reference.remote) ? [envWarning(reference, reference.remote)] : [];
      }
      if (warns(undefined)) return [envWarning(reference, undefined)];
      return checkedRemotes
        .filter((name) => inheritedBy(reference, name) && warns(name))
        .map((name) => envWarning(reference, name));
    });
    const located = [...kept, ...envWarnings].map((item) => ({
      ...item,
      location: locateProblem(item, parsed.rawText, parsed.format),
    }));

    return yield* emit({
      file,
      format,
      source: parsed.rawText,
      remotes: checkedRemotes,
      skippedRemotes,
      problems: located,
    });
  }).pipe(Effect.ensuring(telemetryState.flush));
});
