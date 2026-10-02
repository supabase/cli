import type { DownloadFunctionsResult } from "../../shared/functions/download.ts";
import type { MigrationFetchOutcome } from "../../command-internal/migration-fetch-run.ts";
import type { DbPullOutcome } from "../../command-internal/db-pull-run.ts";
import type {
  PullAggregate,
  PullStepFailure,
  PullStepId,
  PullStepResult,
  PullStepStatus,
} from "./pull.types.ts";

/**
 * Pure result-shaping helpers for `supabase pull`. Each `pull<Step>StepResult` maps one
 * sub-step's outcome into the shared `PullStepResult` shape that `pull.handler.ts` aggregates
 * across all four steps.
 */

// Duplicated from `workdir-project.ts`'s `relativeConfigPath` so this module stays
// Effect-import-free.
function pullRelativeToWorkdir(workdir: string, path: string): string {
  return path.startsWith(workdir) ? path.slice(workdir.length).replace(/^[/\\]/, "") : path;
}

export interface PullConfigStepOutcome {
  /** `--dry-run` was requested. */
  readonly dryRun: boolean;
  /** The config plan had at least one write or a new `[remotes.*]` block to create. */
  readonly hasWork: boolean;
  /** The single aggregated pull confirmation was accepted. */
  readonly confirmed: boolean;
  /** Workdir-relative config file path (e.g. `supabase/config.toml`). */
  readonly configFilePath: string;
}

/**
 * `config` step: `unchanged` with no work at all, `planned` when work exists but was skipped
 * (dry run or a declined confirmation), and `changed` once the plan applied. `detail` is always
 * the payload passed in, since `config pull` computes a diff report even when nothing applied.
 */
export function pullConfigStepResult(
  outcome: PullConfigStepOutcome,
  payload: Record<string, unknown>,
): PullStepResult {
  const applied = outcome.hasWork && !outcome.dryRun && outcome.confirmed;
  const status: PullStepStatus = !outcome.hasWork ? "unchanged" : applied ? "changed" : "planned";
  return {
    step: "config",
    status,
    written: applied ? [outcome.configFilePath] : [],
    detail: payload,
  };
}

export type PullMigrationHistoryStepOutcome =
  | {
      /**
       * Never attempted: `"not_needed"` when migrations already existed and
       * `--with-migration-history` wasn't passed, or `"declined"` when the aggregated
       * confirmation was declined before this step could run.
       */
      readonly kind: "skipped";
      readonly reason: "not_needed" | "declined";
    }
  | {
      /**
       * Would have run (bootstrap or `--with-migration-history`), but `--dry-run` suppressed
       * it — migration fetch has no real preview machinery.
       */
      readonly kind: "planned";
    }
  | {
      readonly kind: "fetched";
      readonly outcome: MigrationFetchOutcome;
      readonly workdir: string;
    };

/** Maps `PullMigrationHistoryStepOutcome` to a `PullStepResult`; `changed`/`unchanged` depends on
 *  whether the fetch wrote files. */
export function pullMigrationHistoryStepResult(
  outcome: PullMigrationHistoryStepOutcome,
): PullStepResult {
  if (outcome.kind === "skipped") {
    return {
      step: "migration_history",
      status: "skipped",
      written: [],
      detail: { files: [] },
      reason: outcome.reason,
    };
  }
  if (outcome.kind === "planned") {
    return { step: "migration_history", status: "planned", written: [], detail: { files: [] } };
  }
  const written = outcome.outcome.files.map((file) => pullRelativeToWorkdir(outcome.workdir, file));
  return {
    step: "migration_history",
    status: written.length > 0 ? "changed" : "unchanged",
    written,
    detail: { files: written },
  };
}

export type PullDbStepOutcome =
  | { readonly kind: "planned" }
  | { readonly kind: "in_sync" }
  | { readonly kind: "applied"; readonly outcome: DbPullOutcome; readonly workdir: string };

/**
 * `db` step: `planned` for a dry run; `unchanged` for `db pull`'s "already in sync" finding
 * (a finding, not a failure, at the `pull` level — see ADR 0024); `changed` once a schema was
 * written.
 */
export function pullDbStepResult(outcome: PullDbStepOutcome): PullStepResult {
  if (outcome.kind === "planned") {
    return { step: "db", status: "planned", written: [], detail: {} };
  }
  if (outcome.kind === "in_sync") {
    return { step: "db", status: "unchanged", written: [], detail: { in_sync: true } };
  }
  const { outcome: dbOutcome, workdir } = outcome;
  if (dbOutcome.kind === "declarative") {
    return {
      step: "db",
      status: "changed",
      written: [pullRelativeToWorkdir(workdir, dbOutcome.schemaWritten)],
      detail: { declarative: true, engine: dbOutcome.engine },
    };
  }
  return {
    step: "db",
    status: "changed",
    written: dbOutcome.schemaFiles.map((file) => pullRelativeToWorkdir(workdir, file)),
    detail: {
      declarative: false,
      engine: dbOutcome.engine,
      remote_history_updated: dbOutcome.remoteHistoryUpdated,
    },
  };
}

export type PullFunctionsStepOutcome =
  | { readonly kind: "planned" }
  | { readonly kind: "downloaded"; readonly result: DownloadFunctionsResult };

/**
 * `functions` step: `planned` for a dry run, `unchanged` with no functions, `changed` once at
 * least one slug downloaded. `written` lists each slug's directory since
 * `DownloadFunctionsResult` doesn't enumerate individual files.
 */
export function pullFunctionsStepResult(outcome: PullFunctionsStepOutcome): PullStepResult {
  if (outcome.kind === "planned") {
    return { step: "functions", status: "planned", written: [], detail: {} };
  }
  const { result } = outcome;
  const changed = result.slugs.length > 0;
  return {
    step: "functions",
    status: changed ? "changed" : "unchanged",
    written: changed ? result.slugs.map((slug) => `supabase/functions/${slug}`) : [],
    detail: { project_ref: result.projectRef, function_slugs: result.slugs },
  };
}

function hasStringMessage(value: unknown): value is { readonly message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function hasStringSuggestion(value: unknown): value is { readonly suggestion: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "suggestion" in value &&
    typeof value.suggestion === "string"
  );
}

function hasStringTag(value: unknown): value is { readonly _tag: string } {
  return (
    typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
  );
}

/**
 * True when a write-loop failure (e.g. `MigrationFetchWriteError`) already wrote some files
 * before a later item failed. Absent for every other failure, including one whose first item
 * failed with nothing written yet.
 */
function hasWrittenSoFar(
  value: unknown,
): value is { readonly writtenSoFar: ReadonlyArray<string> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "writtenSoFar" in value &&
    Array.isArray(value.writtenSoFar)
  );
}

/**
 * Extracts a message string from an arbitrary caught failure value, kept structural rather than
 * importing Effect's `Cause` type so this file stays Effect-import-free.
 */
function pullFailureMessage(cause: unknown): string {
  if (hasStringMessage(cause) && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  return String(cause);
}

function pullFailureSuggestion(cause: unknown): string | undefined {
  return hasStringSuggestion(cause) && cause.suggestion.length > 0 ? cause.suggestion : undefined;
}

/** The cause's own `_tag`, when present — lets a machine consumer classify a step failure
 *  without parsing `message`. */
function pullFailureCode(cause: unknown): string | undefined {
  return hasStringTag(cause) && cause._tag.length > 0 ? cause._tag : undefined;
}

/**
 * POSIX single-quote escaping for a value inserted into a suggested shell command.
 * `--remote-label` can contain whitespace, so leaving it unquoted could render an invalid or
 * dangerous copy-pasteable command.
 */
function pullShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Strips control characters (CR/LF/tab) from a value before it's inlined into a suggested shell
 * command, guarding the same CWE-117 concern as `pull.format.ts`'s `pullSanitizeRowText`. Kept
 * as its own copy since `pull.format.ts` imports from this module, so importing back would cycle.
 */
function pullSanitizeCommandToken(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ");
}

/**
 * The ` --remote-label <value>` suffix for a suggested command — sanitized, shell-quoted, and
 * empty when no label was passed. Shared so every suggested command renders it identically.
 */
function pullRemoteLabelFlag(remoteLabel: string | undefined): string {
  return remoteLabel === undefined
    ? ""
    : ` --remote-label ${pullShellQuote(pullSanitizeCommandToken(remoteLabel))}`;
}

/**
 * The standalone command to retry one failed step on its own, appended to that step's own
 * `failure.suggestion`. Always uses the already-resolved `ref`, never a branch name, since not
 * every sub-command resolves branch names the same way `pull` does.
 */
export function pullRetryHint(
  step: PullStepId,
  ref: string,
  remoteLabel: string | undefined,
): string {
  const remoteLabelFlag = pullRemoteLabelFlag(remoteLabel);
  const commandByStep: Record<PullStepId, string> = {
    config: `supabase config pull --project-ref ${ref}${remoteLabelFlag}`,
    migration_history: `supabase migration fetch --project-ref ${ref}`,
    // `pullDbStep` runs with `forceMigrationMode: true`, overriding any ambient `--experimental`
    // gate; `--experimental=false` reproduces that override so this suggested command performs
    // the same operation the failed step did.
    db: `supabase db pull --project-ref ${ref} --experimental=false`,
    functions: `supabase functions download --project-ref ${ref}`,
  };
  return `To retry just this step, run: ${commandByStep[step]}`;
}

/**
 * The `supabase pull --with-migration-history ...` command suggested by the db step's
 * migration-conflict remedy, using the same resolved `ref`/`remoteLabel` this run targeted so a
 * bare rerun can't silently retarget a different project.
 */
export function pullWithMigrationHistoryCommand(
  ref: string,
  remoteLabel: string | undefined,
): string {
  return `supabase pull --with-migration-history --project-ref ${ref}${pullRemoteLabelFlag(remoteLabel)}`;
}

/**
 * Builds a `status: "failed"` result for `step` from an arbitrary caught value. `written` comes
 * from the cause's own `writtenSoFar` when present (relativized against `workdir`), covering a
 * write-loop error whose earlier items already wrote before a later one failed.
 */
export function pullFailedStepResult(
  step: PullStepId,
  cause: unknown,
  workdir?: string,
): PullStepResult {
  const message = pullFailureMessage(cause);
  const suggestion = pullFailureSuggestion(cause);
  const code = pullFailureCode(cause);
  const writtenSoFar = hasWrittenSoFar(cause) ? cause.writtenSoFar : [];
  const written =
    workdir === undefined
      ? writtenSoFar
      : writtenSoFar.map((file) => pullRelativeToWorkdir(workdir, file));
  const failure: PullStepFailure = {
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(code === undefined ? {} : { code }),
  };
  return { step, status: "failed", written, detail: {}, failure };
}

export interface PullCounts {
  readonly changed: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly planned: number;
  readonly failed: number;
}

export function pullCounts(results: ReadonlyArray<PullStepResult>): PullCounts {
  const counts: { [status in PullStepStatus]: number } = {
    changed: 0,
    unchanged: 0,
    skipped: 0,
    planned: 0,
    failed: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }
  return counts;
}

/** Thin constructor so `pull.handler.ts` has one call site for building the aggregate. */
export function pullAggregate(input: {
  readonly ref: string;
  readonly branch: string | undefined;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly results: ReadonlyArray<PullStepResult>;
}): PullAggregate {
  return {
    ref: input.ref,
    branch: input.branch,
    dryRun: input.dryRun,
    confirmed: input.confirmed,
    dirtyPaths: input.dirtyPaths,
    results: input.results,
  };
}
