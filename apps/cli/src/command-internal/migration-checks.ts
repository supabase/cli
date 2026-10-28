import {
  buildAfterCommitRead,
  buildCheckStatements,
  type CheckError,
  type Finding,
  type Fix,
  parseFindings,
  rulesAt,
} from "@supabase/pg-checks";
import { Context, Data, Effect, Option, type Ref } from "effect";

import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { bold, red, yellow } from "./colors.ts";
import type { DbSession } from "./db-connection.service.ts";
import type { DbTomlValues } from "./db-config.toml-read.ts";
import { errorMessage } from "./error-message.ts";
import { withTargetFlags } from "./migration-history.ts";
import type { MigrationChecksPolicy } from "./migration-checks-policy.ts";
import { wrapStatusLabel } from "./status-pretty.ts";

/** The security check settings for one migration apply run. */
export interface MigrationChecksRun {
  readonly policy: MigrationChecksPolicy;
  /** `[api].schemas`, the schemas the Data API exposes. */
  readonly exposedSchemas: ReadonlyArray<string>;
  /** `--skip-checks`. */
  readonly skip: boolean;
  /** The target flags (`--remote`, `--remote=<url>`) a suggested `db advisors` command repeats; empty for local. */
  readonly targetFlags: string;
}

/** Builds the run settings from the loaded `config.toml`. */
export const migrationChecksRun = (
  toml: Pick<DbTomlValues, "migrationChecks" | "apiSchemas">,
  skip: boolean,
  targetFlags = "",
): MigrationChecksRun => ({
  policy: toml.migrationChecks,
  exposedSchemas: toml.apiSchemas,
  skip,
  targetFlags,
});

/**
 * `--skip-checks` for local replays (`db reset`, `start`), which reach the replay through several
 * bootstrap layers that each reload `config.toml` themselves.
 */
export const MigrationChecksSkipped = Context.Reference<boolean>(
  "supabase/migration-checks/MigrationChecksSkipped",
  { defaultValue: () => false },
);

/**
 * Lets a caller that keeps going after the local replay's end-state check (`start` brings the
 * remaining services up) collect the failure instead of aborting; it reports the failure last.
 */
export const MigrationChecksDeferral = Context.Reference<
  Ref.Ref<Option.Option<MigrationChecksBlockedError>> | undefined
>("supabase/migration-checks/MigrationChecksDeferral", { defaultValue: () => undefined });

/** Timeout, in milliseconds, of the in-transaction check statement. */
export const MigrationChecksTimeoutMs = Context.Reference<number>(
  "supabase/migration-checks/MigrationChecksTimeoutMs",
  { defaultValue: () => 2000 },
);

/** What the after-commit report concluded for one run. */
type MigrationChecksOutcome =
  | "skipped"
  | "off"
  | "passed"
  | "applied_with_findings"
  | "read_failed";

/** The after-commit report, also emitted in machine-readable output. */
export interface MigrationChecksReport {
  readonly outcome: MigrationChecksOutcome;
  readonly findings: ReadonlyArray<Finding>;
  /** Files whose error-level rules ran after commit instead of inside their transaction. */
  readonly checkedAfterCommit: ReadonlyArray<string>;
}

/**
 * Security checks stopped a migration run: an error-level finding, the check timing out, an
 * error-level rule that could not be verified, or an `[api].schemas` entry the checks cannot use.
 */
export class MigrationChecksBlockedError extends Data.TaggedError("MigrationChecksBlockedError")<{
  readonly message: string;
  readonly suggestion?: string;
  readonly reason: "blocked" | "timed_out" | "unchecked" | "invalid_config";
  /** `SB001` (blocked) or `SB002` (timed out); the error code in machine output. */
  readonly errorCode?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return this.reason === "timed_out" || this.reason === "unchecked"
      ? actionability.provideFlags
      : actionability.invalidConfig;
  }
}

const SKIP_CHECKS_SUGGESTION = "Rerun with --skip-checks to apply without security checks.";

const BLOCKED_CODE = "SB001";
const TIMED_OUT_CODE = "SB002";

const OUTPUT_WIDTH = 80;

/** Wraps `text` at word boundaries to the output width; a word longer than the width, such as a URL, stays whole. */
const wrap = (text: string): string => wrapStatusLabel(text, OUTPUT_WIDTH).join("\n");

/**
 * `headline` leads the message with the error code; `body` (already wrapped) follows. Both the
 * headline and the suggestion are wrapped here so every blocked run reads the same.
 */
const blockedError = (
  headline: string,
  body: string,
  suggestion: string,
): MigrationChecksBlockedError =>
  new MigrationChecksBlockedError({
    message: `${wrap(`${BLOCKED_CODE}: ${headline}`)}${body === "" ? "" : `\n${body}`}`,
    suggestion: wrap(suggestion),
    reason: "blocked",
    errorCode: BLOCKED_CODE,
  });

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

const objectName = (finding: Finding): string =>
  finding.schema === null
    ? (finding.name ?? "")
    : finding.name === null
      ? finding.schema
      : `${finding.schema}.${finding.name}`;

/** Finding text carries its markdown backticks escaped; shows them as plain backticks. */
const unescapeBackticks = (text: string): string => text.replaceAll("\\`", "`");

const cleanFinding = (finding: Finding): Finding => ({
  ...finding,
  detail: unescapeBackticks(finding.detail),
  fixes: finding.fixes.map((fix) => ({
    ...fix,
    label: unescapeBackticks(fix.label),
    why: unescapeBackticks(fix.why),
  })),
});

/** Errors first, then by rule and object, so every command lists the same findings in the same order. */
const compareFindings = (a: Finding, b: Finding): number =>
  Number(b.severity === "error") - Number(a.severity === "error") ||
  a.rule.localeCompare(b.rule) ||
  objectName(a).localeCompare(objectName(b));

const cleanFindings = (findings: ReadonlyArray<Finding>): ReadonlyArray<Finding> =>
  findings.map(cleanFinding).toSorted(compareFindings);

/** Wraps `text` to the output width after `prefix`, indenting continuation lines under the text. */
const hang = (prefix: string, text: string): string =>
  wrapStatusLabel(text, Math.max(OUTPUT_WIDTH - prefix.length, 20))
    .map((line, index) => (index === 0 ? prefix : " ".repeat(prefix.length)) + line)
    .join("\n");

/**
 * Colours only the tag. The reset keeps a surrounding styled message (`Output.fail` tints the whole
 * error red) from re-opening its colour after the tag's own close code.
 */
const severityTag = (severity: Finding["severity"]): string => {
  const plain = severity === "error" ? "[error]" : "[warn]";
  const coloured = severity === "error" ? red(plain) : yellow(plain);
  return coloured === plain ? plain : `${coloured}\u001b[0m`;
};

/** SQL keeps its own line breaks; wrapping it would change what a reader copies. */
const renderFix = (fix: Fix, index: number): ReadonlyArray<string> => [
  hang(
    index === 0 ? "    Fix: " : "    Or:  ",
    fix.kind === "template" ? `${fix.label} (fill in the <placeholders>)` : fix.label,
  ),
  ...(fix.sql === null ? [] : fix.sql.split("\n").map((line) => `      ${line}`)),
  hang("      ", fix.why),
];

/**
 * Renders the findings of one message. The fixes and docs of a rule print once, on its first
 * finding; later findings of that rule point back to it.
 */
const findingRenderer = () => {
  const firstByRule = new Map<string, string>();
  return (finding: Finding): string => {
    const type = finding.type === null ? "" : ` (${finding.type})`;
    const first = firstByRule.get(finding.rule);
    if (first === undefined) firstByRule.set(finding.rule, objectName(finding));
    const docs =
      first !== undefined || finding.docs === null
        ? []
        : [
            `    Docs: ${finding.docs}`.length <= OUTPUT_WIDTH
              ? `    Docs: ${finding.docs}`
              : `    Docs:\n      ${finding.docs}`,
          ];
    const fixes =
      first === undefined
        ? finding.fixes.flatMap(renderFix)
        : finding.fixes.length === 0
          ? []
          : [hang("    Fix: ", `same as ${first} above, applied to ${objectName(finding)}.`)];
    const lines = [
      `  ${severityTag(finding.severity)} ${finding.rule}: ${objectName(finding)}${type}`,
      ...(finding.detail === "" ? [] : [hang("    ", finding.detail)]),
      ...fixes,
      ...docs,
    ];
    return `${lines.join("\n")}\n`;
  };
};

/** Identifies a rule's finding on one object, the unit `[db.migrations.checks.exclude]` matches. */
const objectKey = (finding: Finding): string => JSON.stringify([finding.rule, objectName(finding)]);

const findingKey = (finding: Finding): string =>
  JSON.stringify([finding.rule, finding.schema, finding.name, finding.type, finding.detail]);

/** How to let the blocked objects through without touching the database. */
const allowSuggestion = (errors: ReadonlyArray<Finding>): string => {
  const rules = [...new Set(errors.map((finding) => finding.rule))];
  const objects = [...new Set(errors.map(objectName))];
  return (
    `To allow ${objects.length === 1 ? objects[0] : "these objects"}, set ${rules.join(", ")} to "warn" or "off" in [db.migrations.checks], ` +
    `add the object to [db.migrations.checks.exclude], or rerun with --skip-checks.`
  );
};

const baselineCommand = (targetFlags: string): string =>
  bold(withTargetFlags("supabase db advisors --baseline", targetFlags));

/** Fails when an `[api].schemas` entry cannot be passed to the checks' Data API setting. */
const validateExposedSchemas = Effect.fnUntraced(function* (schemas: ReadonlyArray<string>) {
  const invalid = schemas.filter((schema) => schema.includes(","));
  if (invalid.length === 0) return;
  return yield* new MigrationChecksBlockedError({
    message: `[api].schemas entry ${invalid.map((schema) => JSON.stringify(schema)).join(", ")} contains a comma, which security checks cannot represent: the Data API reads its schema list comma-separated.`,
    suggestion: `Remove the comma from the schema name in [api].schemas, or rerun with --skip-checks.`,
    reason: "invalid_config",
  });
});

const readFindings = Effect.fn("MigrationChecks.read")(function* (
  session: DbSession,
  run: Pick<MigrationChecksRun, "policy" | "exposedSchemas">,
) {
  const read = buildAfterCommitRead(run.policy, { exposedSchemas: run.exposedSchemas });
  let rows: ReadonlyArray<unknown> = [];
  for (const [index, sql] of read.statements.entries()) {
    if (index === read.resultIndex) {
      rows = yield* session
        .query(sql)
        .pipe(Effect.tapError(() => session.exec("rollback").pipe(Effect.ignore)));
    } else {
      yield* session
        .exec(sql)
        .pipe(Effect.tapError(() => session.exec("rollback").pipe(Effect.ignore)));
    }
  }
  const findings = cleanFindings(parseFindings(rows, run.policy));
  yield* Effect.annotateCurrentSpan("migration_checks.finding_count", findings.length);
  return findings;
});

/** Reads every current finding for the rules at `warn` and `error`, as `db advisors --baseline` records them. */
export const readMigrationCheckFindings = Effect.fn("MigrationChecks.readAll")(function* (
  session: DbSession,
  run: Pick<MigrationChecksRun, "policy" | "exposedSchemas">,
) {
  yield* validateExposedSchemas(run.exposedSchemas);
  return yield* readFindings(session, run);
});

/** Tracks one apply run: the in-transaction check SQL and the findings present before the run. */
interface MigrationChecksTracker {
  /** Statements to append inside each eligible file's transaction; empty when nothing blocks. */
  readonly inBatch: ReadonlyArray<string>;
  /** The error for a file whose in-transaction check failed; the file and its history row rolled back. */
  readonly inBatchFailure: (file: string, check: CheckError) => MigrationChecksBlockedError;
  /**
   * Reads findings after the run commits and reports new warnings and every error. Fails when
   * an error-level finding remains or files in `checkedAfterCommit` could not be verified; the
   * migrations stay committed either way.
   */
  readonly afterCommit: (
    checkedAfterCommit: ReadonlyArray<string>,
  ) => Effect.Effect<MigrationChecksReport, MigrationChecksBlockedError, Output>;
  /** Reads findings once after a local replay; an error-level finding fails the command. */
  readonly endState: Effect.Effect<MigrationChecksReport, MigrationChecksBlockedError, Output>;
}

const skippedTracker = (outcome: "skipped" | "off"): MigrationChecksTracker => {
  const report: MigrationChecksReport = { outcome, findings: [], checkedAfterCommit: [] };
  return {
    inBatch: [],
    inBatchFailure: (file, check) => inBatchCheckError(file, check, new Set(), ""),
    afterCommit: () => Effect.succeed(report),
    endState: Effect.succeed(report),
  };
};

const inBatchCheckError = (
  file: string,
  check: CheckError,
  preexisting: ReadonlySet<string>,
  targetFlags: string,
): MigrationChecksBlockedError => {
  if (check.kind === "timed_out") {
    return new MigrationChecksBlockedError({
      message: `${TIMED_OUT_CODE}: Security checks on ${file} timed out, so the migration was rolled back.`,
      suggestion: SKIP_CHECKS_SUGGESTION,
      reason: "timed_out",
      errorCode: TIMED_OUT_CODE,
    });
  }
  const errors = cleanFindings(check.errors);
  const touched = errors.filter((finding) => !preexisting.has(objectKey(finding)));
  const existing = errors.filter((finding) => preexisting.has(objectKey(finding)));
  const baseline = `Run ${baselineCommand(targetFlags)} to exclude every existing finding.`;
  const renderFinding = findingRenderer();
  const [headline, ...sections] =
    touched.length === 0
      ? [
          `Migration ${file} was rolled back: ${plural(existing.length, "existing security finding")} at error must be resolved or baselined.`,
          baseline,
          ...existing.map(renderFinding),
        ]
      : [
          `Migration ${file} was rolled back: ${plural(touched.length, "security check")} failed.`,
          ...touched.map(renderFinding),
          ...(existing.length === 0
            ? []
            : [
                `Also ${plural(existing.length, "existing security finding")} at error that predate${existing.length === 1 ? "s" : ""} this run. ${baseline}`,
                ...existing.map(renderFinding),
              ]),
        ];
  const warnings =
    check.warnings.length === 0
      ? []
      : [
          `Also found ${plural(check.warnings.length, "warning")}:`,
          ...cleanFindings(check.warnings).map(renderFinding),
        ];
  return blockedError(
    headline ?? "",
    joinSections([...sections, ...warnings]),
    allowSuggestion(errors),
  );
};

/** Wraps each heading and joins it with the findings, which already end with their own newline. */
const joinSections = (lines: ReadonlyArray<string>): string =>
  lines
    .map((line) => (line.endsWith("\n") ? line : `${wrap(line)}\n`))
    .join("")
    .trimEnd();

const reportFindings = Effect.fnUntraced(function* (
  findings: ReadonlyArray<Finding>,
  preexisting: ReadonlySet<string>,
  targetFlags: string,
) {
  const output = yield* Output;
  // Machine output carries the findings in its payload.
  if (output.format !== "text") return;
  const isExisting = (finding: Finding) =>
    finding.severity === "error" && preexisting.has(objectKey(finding));
  const existing = findings.filter(isExisting);
  const touched = findings.filter((finding) => !isExisting(finding));
  const errors = touched.filter((finding) => finding.severity === "error").length;
  const warnings = touched.length - errors;
  const counts = [
    ...(errors > 0 ? [plural(errors, "error")] : []),
    ...(warnings > 0 ? [plural(warnings, "warning")] : []),
  ].join(" and ");
  const renderFinding = findingRenderer();
  const existingHeading = `${plural(existing.length, "existing security finding")} at error that predate${existing.length === 1 ? "s" : ""} this run.`;
  const sections = [
    ...(touched.length === 0
      ? []
      : [
          `${existing.length > 0 || errors > 0 ? "" : `${yellow("WARNING:")} `}Security checks found ${counts} after this run:`,
          ...touched.map(renderFinding),
        ]),
    ...(existing.length === 0
      ? []
      : [
          `${touched.length === 0 ? "Security checks found" : "Also"} ${existingHeading} Run ${baselineCommand(targetFlags)} to exclude every existing finding.`,
          ...existing.map(renderFinding),
        ]),
  ];
  yield* output.raw(`${joinSections(sections)}\n`, "stderr");
});

/**
 * Starts security checks for a migration apply run: prints the skip notice, or reads the findings
 * already present so the report lists only warnings on objects the run created or changed.
 * Error-level rules block on every finding, wherever it came from.
 */
export const startMigrationChecks = Effect.fn("MigrationChecks.start")(function* (
  session: DbSession,
  run: MigrationChecksRun,
) {
  const output = yield* Output;
  const errorRules = rulesAt(run.policy, "error").length;
  const warnRules = rulesAt(run.policy, "warn").length;
  yield* Effect.annotateCurrentSpan({
    "migration_checks.skip": run.skip,
    "migration_checks.error_rule_count": errorRules,
    "migration_checks.warn_rule_count": warnRules,
  });
  if (run.skip) {
    yield* output.raw(
      `${yellow("WARNING:")} Skipping security checks (--skip-checks).\n`,
      "stderr",
    );
    return skippedTracker("skipped");
  }
  if (errorRules + warnRules === 0) return skippedTracker("off");
  yield* validateExposedSchemas(run.exposedSchemas);
  const timeoutMs = yield* MigrationChecksTimeoutMs;

  const before = yield* readFindings(session, run).pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      output
        .raw(
          `${yellow("WARNING:")} Security checks could not read the findings present before this run, so warnings on objects the run did not change may be reported: ${errorMessage(error)}\n`,
          "stderr",
        )
        .pipe(Effect.as(Option.none<ReadonlyArray<Finding>>())),
    ),
  );
  const beforeFindings = Option.getOrElse(before, () => []);
  const { targetFlags } = run;
  const preexisting = new Set(beforeFindings.map(objectKey));
  const beforeKeys = new Set(beforeFindings.map(findingKey));

  /** New warnings plus every error; `None` when the read failed (a warning is printed). */
  const readAfter = Effect.fnUntraced(function* () {
    return yield* readFindings(session, run).pipe(
      Effect.map((findings) =>
        Option.some(
          findings.filter(
            (finding) => finding.severity === "error" || !beforeKeys.has(findingKey(finding)),
          ),
        ),
      ),
      Effect.catch((error) =>
        output
          .raw(
            `${yellow("WARNING:")} Security checks could not read the database after this run, so no findings are reported: ${errorMessage(error)}\n`,
            "stderr",
          )
          .pipe(Effect.as(Option.none<ReadonlyArray<Finding>>())),
      ),
    );
  });

  const unchecked = (message: string) =>
    new MigrationChecksBlockedError({
      message,
      suggestion: "Run supabase db advisors against this database to review its security findings.",
      reason: "unchecked",
    });

  const conclude = Effect.fnUntraced(function* (
    findings: ReadonlyArray<Finding>,
    checkedAfterCommit: ReadonlyArray<string>,
  ) {
    if (findings.length > 0) {
      yield* reportFindings(findings, preexisting, targetFlags);
    }
    return {
      outcome: findings.length > 0 ? "applied_with_findings" : "passed",
      findings,
      checkedAfterCommit,
    } as const;
  });

  const annotateReport = (report: MigrationChecksReport) =>
    Effect.annotateCurrentSpan({
      "migration_checks.outcome": report.outcome,
      "migration_checks.finding_count": report.findings.length,
      "migration_checks.checked_after_commit_count": report.checkedAfterCommit.length,
    }).pipe(Effect.as(report));

  const tracker: MigrationChecksTracker = {
    inBatch: buildCheckStatements(run.policy, { exposedSchemas: run.exposedSchemas, timeoutMs }),
    inBatchFailure: (file, check) => inBatchCheckError(file, check, preexisting, targetFlags),
    afterCommit: Effect.fn("MigrationChecks.afterCommit")(function* (
      checkedAfterCommit: ReadonlyArray<string>,
    ) {
      if (warnRules === 0 && checkedAfterCommit.length === 0) {
        return yield* annotateReport({ outcome: "passed", findings: [], checkedAfterCommit });
      }
      const findings = yield* readAfter();
      if (Option.isNone(findings)) {
        yield* annotateReport({ outcome: "read_failed", findings: [], checkedAfterCommit });
        if (errorRules > 0 && checkedAfterCommit.length > 0) {
          return yield* unchecked(
            `Security checks could not verify ${checkedAfterCommit.join(", ")}: ${checkedAfterCommit.length === 1 ? "it runs" : "they run"} outside a single transaction, so error-level rules run after commit, and that read failed. The migrations stayed applied.`,
          );
        }
        return { outcome: "read_failed", findings: [], checkedAfterCommit } as const;
      }
      const report = yield* conclude(findings.value, checkedAfterCommit).pipe(
        Effect.flatMap(annotateReport),
      );
      const errors = findings.value.filter((finding) => finding.severity === "error");
      if (errors.length > 0) {
        const committed =
          checkedAfterCommit.length === 0
            ? "The migrations were already committed"
            : `${checkedAfterCommit.join(", ")} ${checkedAfterCommit.length === 1 ? "was" : "were"} already committed (${checkedAfterCommit.length === 1 ? "it cannot" : "they cannot"} run inside a single transaction)`;
        return yield* blockedError(
          `${committed}, and security checks found ${plural(errors.length, "error")} after commit. They were not rolled back.`,
          "",
          `Fix the findings in a new migration, run ${baselineCommand(targetFlags)} to exclude the current ones, or set the rule to "warn" or "off" in [db.migrations.checks].`,
        );
      }
      return report;
    }),
    endState: Effect.gen(function* () {
      const findings = yield* readAfter();
      if (Option.isNone(findings)) {
        yield* annotateReport({ outcome: "read_failed", findings: [], checkedAfterCommit: [] });
        if (errorRules > 0) {
          return yield* unchecked(
            "Security checks could not read the database after applying local migrations, so error-level rules were not verified.",
          );
        }
        return { outcome: "read_failed", findings: [], checkedAfterCommit: [] } as const;
      }
      const errors = findings.value.filter((finding) => finding.severity === "error");
      if (errors.length > 0) {
        yield* Effect.annotateCurrentSpan("migration_checks.outcome", "blocked");
        const warnings = findings.value.filter((finding) => finding.severity === "warn");
        return yield* blockedError(
          `Security checks found ${plural(errors.length, "error")} after applying local migrations. The database is left with every migration applied.`,
          joinSections([...errors, ...warnings].map(findingRenderer())),
          `To proceed, fix the findings in a new migration, run ${baselineCommand(targetFlags)} to exclude the current ones, or rerun with --skip-checks. ${allowSuggestion(errors)}`,
        );
      }
      return yield* conclude(findings.value, []).pipe(Effect.flatMap(annotateReport));
    }).pipe(Effect.withSpan("MigrationChecks.endState")),
  };
  return tracker;
});
