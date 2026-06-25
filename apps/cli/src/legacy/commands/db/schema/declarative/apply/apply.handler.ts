import { Effect, FileSystem, Option, Path } from "effect";

import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../../../shared/output/output.service.ts";
import { LegacyCliConfig } from "../../../../../config/legacy-cli-config.service.ts";
import { legacyGetHostname } from "../../../../../shared/legacy-hostname.ts";
import {
  legacyReadDbToml,
  legacyResolveDeclarativeDir,
} from "../../../../../shared/legacy-db-config.toml-read.ts";
import { legacyToPostgresURL } from "../../../../../shared/legacy-postgres-url.ts";
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
    const experimental = yield* LegacyExperimentalFlag;
    const debug = yield* LegacyDebugFlag;
    const seam = yield* LegacyDeclarativeSeam;

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
          message: "no declarative schema found. Run supabase db schema declarative generate first",
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
    lines.push(
      verbose
        ? `Diagnostics:\n${result.diagnostics.map((issue) => `- ${formatUnknownIssue(issue)}`).join("\n")}`
        : `${result.diagnostics.length} pg-topo diagnostic(s) omitted (re-run with --debug to view).`,
    );
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
    lines.push(`- ${formatUnknownIssue(issue)}`);
  }
}

function formatUnknownIssue(issue: unknown): string {
  if (typeof issue === "string") return issue;
  return JSON.stringify(issue) ?? String(issue);
}
