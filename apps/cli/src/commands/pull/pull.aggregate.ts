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
 * Pure result-shaping helpers for `supabase pull` — no Effect, no services.
 * Each `pull<Step>StepResult` maps one sub-step's own already-frozen
 * outcome type into the shared `PullStepResult` shape `pull.handler.ts`
 * aggregates across all four steps (`pull.types.ts`). Status derivation rules
 * are documented per function below.
 */

/**
 * Strips a leading `workdir` prefix from an absolute path — the same
 * prefix-strip `workdir-project.ts`'s `relativeConfigPath`
 * implements, duplicated here (rather than imported) so this module stays
 * free of that file's own Effect-importing neighbors.
 */
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
 * `config` step: `unchanged` when the plan had no work at all; `planned` when
 * there was work but it was never applied (`--dry-run`, OR the aggregated
 * confirmation was declined — the two read identically from this step's own
 * perspective, since neither one ever reaches the write); `changed` once the
 * plan actually ran (confirmed, not a dry run). `detail` is always the config
 * step's own JSON payload verbatim, since `config pull` computes a real diff
 * report even for a dry-run or declined outcome.
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
       * Never attempted this run — `supabase/migrations` already had files and
       * `--with-migration-history` was not passed (`"not_needed"`), or the
       * aggregated confirmation was declined while this step would otherwise
       * have run (`"declined"`).
       */
      readonly kind: "skipped";
      readonly reason: "not_needed" | "declined";
    }
  | {
      /**
       * Would have run (bootstrap or `--with-migration-history`), but
       * `--dry-run` suppressed it — migration fetch has no real preview
       * machinery.
       */
      readonly kind: "planned";
    }
  | {
      readonly kind: "fetched";
      readonly outcome: MigrationFetchOutcome;
      readonly workdir: string;
    };

/**
 * `migration_history` step: `skipped` when never attempted (either it wasn't
 * needed, or the aggregated confirmation was declined before it could run);
 * `planned` for a dry run that would have fetched; otherwise `changed`/
 * `unchanged` based on whether the fetch actually wrote any files.
 */
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
 * `db` step: `planned` for a dry run (`db pull` has no real preview
 * machinery, same rationale as migration history above); `unchanged` for `db
 * pull`'s own "already in sync" finding (`DbPullInSyncError`, caught by
 * the handler and reported here — a finding, not a failure, at the `pull`
 * level per ADR 0024); `changed` once a schema was actually written.
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
 * `functions` step: `planned` for a dry run (no preview machinery);
 * `unchanged` when the project has no functions at all; `changed` once at
 * least one slug downloaded. `written` lists each downloaded slug's function
 * directory — `DownloadFunctionsResult` doesn't enumerate individual files,
 * so the directory is the most useful representative path per slug.
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
 * Duck-types a caught failure value carrying `writtenSoFar` — a write-loop error (e.g.
 * `MigrationFetchWriteError`) that had already written some files before a LATER item in
 * the same loop failed (a tampered/malformed remote row, a mid-loop write failure, ...).
 * Absent for every other failure, including a write-loop error whose very first item
 * failed (nothing written yet).
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
 * Duck-types a caught failure value (a plain `Error`, a tagged domain error,
 * or anything else `pull.handler.ts` extracts from a step's `Exit`) into a
 * message string — kept structural, rather than importing Effect's `Cause`
 * type, so this file stays free of Effect imports. The handler owns deciding
 * exactly what value reaches here.
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

/** The squashed cause's own `_tag`, when it has one — a machine consumer's only way to classify
 *  a non-first (never re-failed) step failure without parsing `message`. */
function pullFailureCode(cause: unknown): string | undefined {
  return hasStringTag(cause) && cause._tag.length > 0 ? cause._tag : undefined;
}

/**
 * POSIX single-quote escaping for a value inserted into a suggested shell command —
 * mirrors `commands/db/shared/pgdelta-next-diagnostics.ts`'s `shellQuote`. Kept as its
 * own tiny copy rather than a shared import: this file is deliberately Effect-import-free
 * (see `pull.handler.ts`'s own note on why `--remote-label` needs quoting — `config
 * pull`'s own `--remote-label` accepts labels requiring TOML quoting, including
 * whitespace, so an unquoted value here could render an invalid or dangerous
 * copy-pasteable command).
 */
function pullShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Strips control characters (CR/LF/tab) from a value before it is inlined into a
 * suggested shell command — the same CWE-117 concern `pull.format.ts`'s
 * `pullSanitizeRowText` guards against for rendered summary text. Kept as its own copy
 * here (rather than importing that sibling helper) since `pull.format.ts` already
 * imports FROM this module (`pullCounts`) and this file is deliberately
 * Effect-import-free.
 */
function pullSanitizeCommandToken(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ");
}

/**
 * The ` --remote-label <value>` suffix for a suggested command — sanitized and
 * shell-quoted, empty when no label was passed. Shared by `pullRetryHint`'s config-step
 * command and `pullWithMigrationHistoryCommand` below, so every suggested command that
 * carries a user-supplied `--remote-label` renders it identically.
 */
function pullRemoteLabelFlag(remoteLabel: string | undefined): string {
  return remoteLabel === undefined
    ? ""
    : ` --remote-label ${pullShellQuote(pullSanitizeCommandToken(remoteLabel))}`;
}

/**
 * The exact standalone command to retry ONE failed step on its own —
 * `pull.handler.ts` appends this line to a failed step's own
 * `failure.suggestion` (Phase 3), on top of whatever the step's own
 * error/suggestion already says, so a user watching `pull` fail doesn't have
 * to guess which of its four sub-commands to rerun, or redo every step that
 * already succeeded by rerunning the whole orchestrator. Takes the
 * already-RESOLVED `ref` — never a branch name someone typed for
 * `--project-ref`, since not every sub-command necessarily resolves branch
 * names the same way `pull` does, while a resolved ref is always a valid
 * `--project-ref` value everywhere.
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
    db: `supabase db pull --project-ref ${ref}`,
    functions: `supabase functions download --project-ref ${ref}`,
  };
  return `To retry just this step, run: ${commandByStep[step]}`;
}

/**
 * The exact `supabase pull --with-migration-history ...` command the db step's own
 * migration-conflict remedy (`pull.handler.ts`'s `pullDbStepFailureResult`) suggests
 * rerunning — named with the SAME resolved `ref`/`remoteLabel` `pull` itself targeted,
 * so blindly rerunning the bare `--with-migration-history` command (with no target) can
 * never silently retarget a different project than the one this run actually resolved
 * (a branch, an explicit different ref, ...). Shares `pullRemoteLabelFlag` with
 * `pullRetryHint` above so the two suggested commands render `--remote-label`
 * identically.
 */
export function pullWithMigrationHistoryCommand(
  ref: string,
  remoteLabel: string | undefined,
): string {
  return `supabase pull --with-migration-history --project-ref ${ref}${pullRemoteLabelFlag(remoteLabel)}`;
}

/**
 * Builds a `status: "failed"` result for `step` from an arbitrary caught value.
 * `written` is populated from the cause's own `writtenSoFar` when it carries one (a
 * write-loop error whose earlier items had already written before a later one failed) —
 * relativized against `workdir` exactly like every other step's own `written` array,
 * when the caller has one; `workdir` is only ever passed for the `migration_history`
 * step today, the only one whose failure cause (`MigrationFetchWriteError`) can carry
 * `writtenSoFar`. Falls back to `[]` when the cause carries no such information.
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
