import type { DownloadFunctionsResult } from "../../shared/functions/download.ts";
import type { LegacyDbPullOutcome } from "../db/pull/pull.handler.ts";
import type { LegacyMigrationFetchOutcome } from "../migration/fetch/fetch.handler.ts";
import type {
  LegacyPullAggregate,
  LegacyPullStepFailure,
  LegacyPullStepId,
  LegacyPullStepResult,
  LegacyPullStepStatus,
} from "./pull.types.ts";

/**
 * Pure result-shaping helpers for `supabase pull` — no Effect, no services.
 * Each `legacyPull<Step>StepResult` maps one sub-step's own already-frozen
 * outcome type into the shared `LegacyPullStepResult` shape `pull.handler.ts`
 * aggregates across all four steps (`pull.types.ts`). Status derivation rules
 * are documented per function below.
 */

/**
 * Strips a leading `workdir` prefix from an absolute path — the same
 * prefix-strip `legacy-workdir-project.ts`'s `legacyRelativeConfigPath`
 * implements, duplicated here (rather than imported) so this module stays
 * free of that file's own Effect-importing neighbors.
 */
function legacyPullRelativeToWorkdir(workdir: string, path: string): string {
  return path.startsWith(workdir) ? path.slice(workdir.length).replace(/^[/\\]/, "") : path;
}

export interface LegacyPullConfigStepOutcome {
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
export function legacyPullConfigStepResult(
  outcome: LegacyPullConfigStepOutcome,
  payload: Record<string, unknown>,
): LegacyPullStepResult {
  const applied = outcome.hasWork && !outcome.dryRun && outcome.confirmed;
  const status: LegacyPullStepStatus = !outcome.hasWork
    ? "unchanged"
    : applied
      ? "changed"
      : "planned";
  return {
    step: "config",
    status,
    written: applied ? [outcome.configFilePath] : [],
    detail: payload,
  };
}

export type LegacyPullMigrationHistoryStepOutcome =
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
      readonly outcome: LegacyMigrationFetchOutcome;
      readonly workdir: string;
    };

/**
 * `migration_history` step: `skipped` when never attempted (either it wasn't
 * needed, or the aggregated confirmation was declined before it could run);
 * `planned` for a dry run that would have fetched; otherwise `changed`/
 * `unchanged` based on whether the fetch actually wrote any files.
 */
export function legacyPullMigrationHistoryStepResult(
  outcome: LegacyPullMigrationHistoryStepOutcome,
): LegacyPullStepResult {
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
  const written = outcome.outcome.files.map((file) =>
    legacyPullRelativeToWorkdir(outcome.workdir, file),
  );
  return {
    step: "migration_history",
    status: written.length > 0 ? "changed" : "unchanged",
    written,
    detail: { files: written },
  };
}

export type LegacyPullDbStepOutcome =
  | { readonly kind: "planned" }
  | { readonly kind: "in_sync" }
  | { readonly kind: "applied"; readonly outcome: LegacyDbPullOutcome; readonly workdir: string };

/**
 * `db` step: `planned` for a dry run (`db pull` has no real preview
 * machinery, same rationale as migration history above); `unchanged` for `db
 * pull`'s own "already in sync" finding (`LegacyDbPullInSyncError`, caught by
 * the handler and reported here — a finding, not a failure, at the `pull`
 * level per ADR 0024); `changed` once a schema was actually written.
 */
export function legacyPullDbStepResult(outcome: LegacyPullDbStepOutcome): LegacyPullStepResult {
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
      written: [legacyPullRelativeToWorkdir(workdir, dbOutcome.schemaWritten)],
      detail: { declarative: true, engine: dbOutcome.engine },
    };
  }
  return {
    step: "db",
    status: "changed",
    written: dbOutcome.schemaFiles.map((file) => legacyPullRelativeToWorkdir(workdir, file)),
    detail: {
      declarative: false,
      engine: dbOutcome.engine,
      remote_history_updated: dbOutcome.remoteHistoryUpdated,
    },
  };
}

export type LegacyPullFunctionsStepOutcome =
  | { readonly kind: "planned" }
  | { readonly kind: "downloaded"; readonly result: DownloadFunctionsResult };

/**
 * `functions` step: `planned` for a dry run (no preview machinery);
 * `unchanged` when the project has no functions at all; `changed` once at
 * least one slug downloaded. `written` lists each downloaded slug's function
 * directory — `DownloadFunctionsResult` doesn't enumerate individual files,
 * so the directory is the most useful representative path per slug.
 */
export function legacyPullFunctionsStepResult(
  outcome: LegacyPullFunctionsStepOutcome,
): LegacyPullStepResult {
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
 * Duck-types a caught failure value (a plain `Error`, a tagged domain error,
 * or anything else `pull.handler.ts` extracts from a step's `Exit`) into a
 * message string — kept structural, rather than importing Effect's `Cause`
 * type, so this file stays free of Effect imports. The handler owns deciding
 * exactly what value reaches here.
 */
function legacyPullFailureMessage(cause: unknown): string {
  if (hasStringMessage(cause) && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  return String(cause);
}

function legacyPullFailureSuggestion(cause: unknown): string | undefined {
  return hasStringSuggestion(cause) && cause.suggestion.length > 0 ? cause.suggestion : undefined;
}

/** The squashed cause's own `_tag`, when it has one — a machine consumer's only way to classify
 *  a non-first (never re-failed) step failure without parsing `message`. */
function legacyPullFailureCode(cause: unknown): string | undefined {
  return hasStringTag(cause) && cause._tag.length > 0 ? cause._tag : undefined;
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
export function legacyPullRetryHint(
  step: LegacyPullStepId,
  ref: string,
  remoteLabel: string | undefined,
): string {
  const remoteLabelFlag = remoteLabel === undefined ? "" : ` --remote-label ${remoteLabel}`;
  const commandByStep: Record<LegacyPullStepId, string> = {
    config: `supabase config pull --project-ref ${ref}${remoteLabelFlag}`,
    migration_history: `supabase migration fetch --project-ref ${ref}`,
    db: `supabase db pull --project-ref ${ref}`,
    functions: `supabase functions download --project-ref ${ref}`,
  };
  return `To retry just this step, run: ${commandByStep[step]}`;
}

/** Builds a `status: "failed"` result for `step` from an arbitrary caught value. */
export function legacyPullFailedStepResult(
  step: LegacyPullStepId,
  cause: unknown,
): LegacyPullStepResult {
  const message = legacyPullFailureMessage(cause);
  const suggestion = legacyPullFailureSuggestion(cause);
  const code = legacyPullFailureCode(cause);
  const failure: LegacyPullStepFailure = {
    message,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(code === undefined ? {} : { code }),
  };
  return { step, status: "failed", written: [], detail: {}, failure };
}

export interface LegacyPullCounts {
  readonly changed: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly planned: number;
  readonly failed: number;
}

export function legacyPullCounts(results: ReadonlyArray<LegacyPullStepResult>): LegacyPullCounts {
  const counts: { [status in LegacyPullStepStatus]: number } = {
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
export function legacyPullAggregate(input: {
  readonly ref: string;
  readonly branch: string | undefined;
  readonly dryRun: boolean;
  readonly confirmed: boolean;
  readonly results: ReadonlyArray<LegacyPullStepResult>;
}): LegacyPullAggregate {
  return {
    ref: input.ref,
    branch: input.branch,
    dryRun: input.dryRun,
    confirmed: input.confirmed,
    results: input.results,
  };
}
