import { Effect, FileSystem, Option, Path } from "effect";

import {
  legacyResolveDebug,
  legacyResolveExperimental,
} from "../../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyGetHostname } from "../../../../../shared/legacy-hostname.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyToPostgresURL } from "../../../../../shared/legacy-postgres-url.ts";
import { LegacyTelemetryState } from "../../../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyApplyDeclarativePgDelta } from "../../../shared/legacy-pgdelta.ts";
import { LegacyDeclarativeSeam } from "../../../shared/legacy-pgdelta.seam.service.ts";
import {
  LegacyDeclarativeApplyError,
  LegacyDeclarativeNonInteractiveError,
} from "../declarative.errors.ts";
import { legacyRequirePgDelta } from "../declarative.gate.ts";
import type { LegacyDbSchemaDeclarativeApplyFlags } from "./apply.command.ts";

export const legacyDbSchemaDeclarativeApply = Effect.fn("legacy.db.schema.declarative.apply")(
  function* (_flags: LegacyDbSchemaDeclarativeApplyFlags) {
    const output = yield* Output;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const telemetryState = yield* LegacyTelemetryState;
    const experimental = yield* legacyResolveExperimental;
    const debug = yield* legacyResolveDebug;
    const seam = yield* LegacyDeclarativeSeam;

    yield* Effect.gen(function* () {
      const toml = yield* legacyReadDbToml(fs, path, cliConfig.workdir);
      yield* legacyRequirePgDelta({
        experimental,
        pgDeltaEnabled: toml.pgDelta.enabled,
        configPath: path.join("supabase", "config.toml"),
      });

      const declarativeDir = path.resolve(
        cliConfig.workdir,
        legacyResolveDeclarativeDir(path, toml.pgDelta),
      );
      if (!(yield* declarativeDirHasFiles(fs, declarativeDir))) {
        return yield* Effect.fail(
          new LegacyDeclarativeNonInteractiveError({
            message:
              "no declarative schema found. Run supabase db schema declarative generate first",
          }),
        );
      }

      yield* seam.ensureLocalDatabaseStarted();

      yield* output.raw("Applying declarative schemas via pg-delta...\n", "stderr");
      const result = yield* legacyApplyDeclarativePgDelta(
        {
          projectId: Option.getOrElse(cliConfig.projectId, () => ""),
          cwd: cliConfig.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
          denoVersion: toml.denoVersion,
        },
        {
          declarativeDir,
          targetRef: legacyToPostgresURL({
            host: legacyGetHostname(),
            port: toml.port,
            user: "postgres",
            password: toml.password,
            database: "postgres",
          }),
        },
      );

      if (result.status !== "success") {
        yield* output.raw(`${formatApplyFailure(result, debug)}\n`, "stderr");
        if (debug) {
          const debugJson = formatDebugJSON(result.raw);
          if (debugJson.length > 0) {
            yield* output.raw("pg-delta apply result:\n", "stderr");
            yield* output.raw(`${debugJson}\n`, "stderr");
          }
        }
        return yield* Effect.fail(
          new LegacyDeclarativeApplyError({
            message: `pg-delta declarative apply failed with status: ${result.status}`,
          }),
        );
      }

      yield* output.raw(
        `Applied ${result.totalApplied} statements in ${result.totalRounds} round(s).\n`,
        "stderr",
      );
      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("Declarative schema applied.", {
          status: result.status,
          totalStatements: result.totalStatements,
          totalRounds: result.totalRounds,
          totalApplied: result.totalApplied,
          totalSkipped: result.totalSkipped,
        });
      }
    }).pipe(Effect.ensuring(telemetryState.flush));
  },
);

const declarativeDirHasFiles = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  dir: string,
) {
  const exists = yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return false;
  const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): string[] => []));
  return entries.length > 0;
});

function formatApplyFailure(
  result: {
    readonly status: string;
    readonly totalStatements: number;
    readonly totalRounds: number;
    readonly totalApplied: number;
    readonly totalSkipped: number;
    readonly errors: ReadonlyArray<unknown>;
    readonly stuckStatements: ReadonlyArray<unknown>;
    readonly validationErrors: ReadonlyArray<unknown>;
    readonly diagnostics: ReadonlyArray<unknown>;
    readonly raw: string;
  },
  verbose: boolean,
): string {
  const totalStatements =
    result.totalStatements === 0
      ? result.totalApplied + result.totalSkipped + result.stuckStatements.length
      : result.totalStatements;
  const lines = [
    `pg-delta apply returned status ${JSON.stringify(result.status)}.`,
    `${result.totalApplied}/${totalStatements} statements applied in ${result.totalRounds} round(s); ${result.totalSkipped} skipped.`,
  ];
  appendIssues(lines, "Errors:", result.errors);
  appendIssues(lines, "Stuck statements:", result.stuckStatements);
  appendIssues(
    lines,
    "Validation errors (from check_function_bodies=on pass):",
    result.validationErrors,
  );
  if (result.diagnostics.length > 0) {
    if (verbose) {
      lines.push("Diagnostics:");
      for (const diagnostic of result.diagnostics) {
        lines.push(formatApplyDiagnosis(diagnostic));
      }
    } else {
      lines.push(
        `${result.diagnostics.length} pg-topo diagnostic(s) omitted (re-run with --debug to view).`,
      );
    }
  }
  if (
    result.errors.length === 0 &&
    result.stuckStatements.length === 0 &&
    result.validationErrors.length === 0
  ) {
    lines.push(
      "No per-statement diagnostics were reported by pg-delta.",
      "Re-run with --debug to print the raw pg-delta payload, or open an issue at",
      "https://github.com/supabase/pg-toolbelt/issues with the debug bundle attached.",
    );
  }
  return lines.join("\n");
}

function appendIssues(lines: string[], title: string, issues: ReadonlyArray<unknown>): void {
  if (issues.length === 0) return;
  lines.push(title);
  for (const issue of issues) {
    lines.push(formatApplyIssue(issue));
  }
}

function formatApplyIssue(issue: unknown): string {
  if (typeof issue === "string") return `- ${issue}`;
  const statement = objectProperty(issue, "statement");
  if (statement === undefined || statement === null) {
    return `- ${formatApplyIssueMessage(issue)}`;
  }
  const id = stringProperty(statement, "id");
  let title = `- ${id.length > 0 ? id : "unknown statement"}`;
  const statementClass = stringProperty(statement, "statementClass");
  if (statementClass.length > 0) {
    title += ` [${statementClass}]`;
  }
  const lines = [title, `  ${formatApplyIssueMessage(issue)}`];
  const detail = stringProperty(issue, "detail").trim();
  if (detail.length > 0) {
    lines.push(`  Detail: ${detail}`);
  }
  const hint = stringProperty(issue, "hint").trim();
  if (hint.length > 0) {
    lines.push(`  Hint: ${hint}`);
  }
  const sql = formatStatementSQL(stringProperty(statement, "sql"));
  if (sql.length > 0) {
    lines.push(`  SQL: ${sql}`);
  }
  return lines.join("\n");
}

function formatApplyIssueMessage(issue: unknown): string {
  let message = stringProperty(issue, "message").trim();
  if (message.length === 0) {
    message = typeof issue === "string" ? issue : "unknown pg-delta issue";
  }
  const metadata = [];
  const code = stringProperty(issue, "code");
  if (code.length > 0) {
    metadata.push(`SQLSTATE ${code}`);
  }
  const position = numberProperty(issue, "position");
  if (position > 0) {
    metadata.push(`position ${position}`);
  }
  if (booleanProperty(issue, "isDependencyError")) {
    metadata.push("dependency error");
  }
  if (metadata.length === 0) return message;
  return `${message} (${metadata.join(", ")})`;
}

function formatApplyDiagnosis(diagnostic: unknown): string {
  let message = stringProperty(diagnostic, "message").trim();
  if (message.length === 0) {
    message = "unknown pg-delta diagnostic";
  }
  let line = "- ";
  const code = stringProperty(diagnostic, "code").trim();
  if (code.length > 0) {
    line += `[${code}] `;
  }
  line += message;
  const loc = formatStatementLocation(objectProperty(diagnostic, "statementId"));
  if (loc.length > 0) {
    line += ` (${loc})`;
  }
  const suggestedFix = stringProperty(diagnostic, "suggestedFix").trim();
  if (suggestedFix.length > 0) {
    line += `\n  Suggested fix: ${suggestedFix}`;
  }
  return line;
}

function formatStatementLocation(location: unknown): string {
  if (typeof location === "string") return location.trim();
  const filePath = stringProperty(location, "filePath").trim();
  if (filePath.length === 0) return "";
  const statementIndex = numberProperty(location, "statementIndex");
  if (statementIndex > 0) {
    return `${filePath}#${statementIndex}`;
  }
  return filePath;
}

function formatStatementSQL(sql: string): string {
  const normalized = sql.split(/\s+/).filter(Boolean).join(" ");
  const maxLen = 120;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

function formatDebugJSON(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), undefined, 2);
  } catch {
    return trimmed;
  }
}

function objectProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
}

function stringProperty(value: unknown, key: string): string {
  const property = objectProperty(value, key);
  return typeof property === "string" ? property : "";
}

function numberProperty(value: unknown, key: string): number {
  const property = objectProperty(value, key);
  return typeof property === "number" ? property : 0;
}

function booleanProperty(value: unknown, key: string): boolean {
  const property = objectProperty(value, key);
  return property === true;
}
