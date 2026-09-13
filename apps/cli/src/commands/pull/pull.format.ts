import { pullCounts } from "./pull.aggregate.ts";
import { PULL_STEP_ORDER, type PullAggregate, type PullStepResult } from "./pull.types.ts";

/**
 * Pure text/JSON formatters for `supabase pull`; rendering and status-summary decisions live
 * here and in `pull.aggregate.ts`.
 */

/** Version of the machine payload's own shape — bump when it changes incompatibly. */
export const PULL_PAYLOAD_VERSION = 1;

/**
 * The structured result for `--output-format json|stream-json`, per step
 * keyed by `PullStepId` — see `pull.aggregate.ts`'s per-step mappers for
 * how each `steps.<id>` entry's `detail` is built.
 */
export function pullPayload(aggregate: PullAggregate): Record<string, unknown> {
  const resultByStep = new Map(aggregate.results.map((result) => [result.step, result] as const));
  const steps: Record<string, unknown> = {};
  for (const step of PULL_STEP_ORDER) {
    const result = resultByStep.get(step);
    if (result === undefined) {
      continue;
    }
    steps[step] = {
      status: result.status,
      written: result.written,
      detail: result.detail,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.failure === undefined ? {} : { failure: result.failure }),
    };
  }

  return {
    schema_version: PULL_PAYLOAD_VERSION,
    target: {
      project_ref: aggregate.ref,
      ...(aggregate.branch === undefined ? {} : { branch: aggregate.branch }),
    },
    dry_run: aggregate.dryRun,
    confirmed: aggregate.confirmed,
    // Present (possibly empty) on every disposition: a `--dry-run --output-format json` script
    // has no other way to know a real run would hit this dirty-tree guard.
    dirty_paths: aggregate.dirtyPaths,
    // A failed step can still carry a non-empty `written` array (a partial write before it
    // failed), so `wrote` is derived from every step's recorded writes, not just `changed` ones.
    wrote: aggregate.results.some(
      (result) => result.status === "changed" || result.written.length > 0,
    ),
    step_order: PULL_STEP_ORDER,
    steps,
    counts: pullCounts(aggregate.results),
  };
}

/**
 * One-line `message` for `output.success`. Every branch names its own disposition up front
 * (dry-run, declined, partial-failure, or complete) so an agent reading just `.message` can't
 * mistake one for a completed pull.
 */
export function pullSummaryMessage(aggregate: PullAggregate): string {
  const counts = pullCounts(aggregate.results);
  const countsText = `${counts.changed} changed, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.planned} planned, ${counts.failed} failed`;
  if (!aggregate.confirmed && !aggregate.dryRun) {
    return `Pull declined: nothing was changed (${countsText}).`;
  }
  if (aggregate.dryRun) {
    return `Pull preview (dry run): nothing was changed (${countsText}).`;
  }
  if (counts.failed > 0) {
    return `Pull finished with failures: ${countsText}.`;
  }
  return `Pull complete: ${countsText}.`;
}

/** Longest `PullStepStatus` word (`"unchanged"`) — the status column's fixed width. */
const PULL_STATUS_COLUMN_WIDTH = "unchanged".length;

/**
 * Strips control characters (CR/LF/tab) from a failure message before it's inlined into an
 * aligned summary row (CWE-117): a message can carry remote-controlled content (a function
 * slug, an API response body) that would otherwise forge fake summary rows in text-mode output.
 */
function pullSanitizeRowText(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ");
}

/** The representative detail shown on a step's summary row — its failure message, its skip
 *  reason, or the first written path (with a "+N more" suffix when there is more than one). */
function pullStepDetailText(result: PullStepResult): string {
  if (result.status === "failed") {
    return pullSanitizeRowText(result.failure?.message ?? "");
  }
  if (result.status === "skipped" && result.reason !== undefined) {
    return `(${result.reason})`;
  }
  const [firstWritten] = result.written;
  if (firstWritten === undefined) {
    return "";
  }
  return result.written.length > 1
    ? `${firstWritten} (+${result.written.length - 1} more)`
    : firstWritten;
}

/**
 * Splits a failed step's `failure.suggestion` into individual, sanitized, non-empty lines (it
 * can carry embedded `\n`-separated commands). Sanitized the same way as row text (CWE-117),
 * since a suggestion can also carry remote-controlled content.
 */
function pullSuggestionLines(suggestion: string): ReadonlyArray<string> {
  return suggestion
    .split("\n")
    .map((line) => pullSanitizeRowText(line).trim())
    .filter((line) => line.length > 0);
}

/**
 * The full text-mode summary block: a header line naming the target project, then one aligned
 * row per step in `PULL_STEP_ORDER` order. A `failed` step's row inlines its own failure message
 * even when it isn't the step whose failure exits the process.
 */
export function renderPullSummary(aggregate: PullAggregate): string {
  const resultByStep = new Map(aggregate.results.map((result) => [result.step, result] as const));
  const stepColumnWidth = Math.max(...PULL_STEP_ORDER.map((step) => step.length));

  // Continuation lines (a failed step's suggestion) indent to line up under
  // the detail column, rather than repeating the step/status columns.
  const continuationPrefix = `  ${"".padEnd(stepColumnWidth)}  ${"".padEnd(PULL_STATUS_COLUMN_WIDTH)}  `;

  const lines: Array<string> = [`Pull summary — project ${aggregate.ref}`];
  for (const step of PULL_STEP_ORDER) {
    const result = resultByStep.get(step);
    if (result === undefined) {
      continue;
    }
    const detail = pullStepDetailText(result);
    lines.push(
      `  ${step.padEnd(stepColumnWidth)}  ${result.status.padEnd(PULL_STATUS_COLUMN_WIDTH)}  ${detail}`.trimEnd(),
    );
    if (result.failure?.suggestion !== undefined) {
      for (const line of pullSuggestionLines(result.failure.suggestion)) {
        lines.push(`${continuationPrefix}${line}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface PullConfirmMessageInput {
  /** The resolved target project ref — named in the header line so the confirmation body says
   *  which project/branch is about to be written to. */
  readonly ref: string;
  /** The branch name `--project-ref` resolved, when it named one; `undefined` for a ref-shaped
   *  or linked-fallback target. */
  readonly branch: string | undefined;
  /** `config pull`'s own rendered diff body (`renderConfigPullText`), when there was
   *  anything to show; `undefined`/empty reads as "no config differences found". */
  readonly configDiffText: string | undefined;
  /** Whether the migration-history step will actually run this invocation. */
  readonly willFetchMigrationHistory: boolean;
  /** Why it will run — `"flag"` for `--with-migration-history`, `"bootstrap"` for an empty/missing
   *  `supabase/migrations`. Only read when `willFetchMigrationHistory` is `true`. */
  readonly migrationHistoryReason: "flag" | "bootstrap" | undefined;
  /** Workdir-relative paths (out of the config file, `supabase/migrations`, `supabase/functions`)
   *  that currently have uncommitted or untracked changes in git — the orchestrator's own,
   *  per-path git guard. Empty when nothing is dirty (or `--force` skipped the check entirely). */
  readonly dirtyPaths: ReadonlyArray<string>;
}

/** Joins `paths` into an English list — `"a"`, `"a and b"`, or `"a, b, and c"` — for the shared
 *  dirty-tree warning below. */
function joinPathList(paths: ReadonlyArray<string>): string {
  if (paths.length <= 1) {
    return paths[0] ?? "";
  }
  if (paths.length === 2) {
    return `${paths[0]} and ${paths[1]}`;
  }
  return `${paths.slice(0, -1).join(", ")}, and ${paths[paths.length - 1]}`;
}

/**
 * The dirty-tree warning sentence naming every path in `dirtyPaths` — shared with
 * `PullUncommittedChangesError`'s own message so the two surfaces can never drift on wording.
 */
export function pullDirtyWarningMessage(dirtyPaths: ReadonlyArray<string>): string {
  const verb = dirtyPaths.length === 1 ? "has" : "have";
  return `${joinPathList(dirtyPaths)} ${verb} uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.`;
}

/**
 * The single aggregated confirmation prompt's disclosure body, printed before the yes/no
 * question. `db pull` and `functions download` get one qualitative line each (no preview
 * machinery); migration history only gets a line when it will actually run (see ADR 0024).
 */
export function pullConfirmMessage(input: PullConfirmMessageInput): string {
  // Sanitized before interpolation (CWE-117): a branch name containing CR/LF could otherwise
  // forge fake lines in this header.
  const ref = pullSanitizeRowText(input.ref);
  const branch = input.branch === undefined ? undefined : pullSanitizeRowText(input.branch);
  const lines: Array<string> = [
    branch === undefined
      ? `Pulling from project ${ref}`
      : `Pulling from project ${ref} (branch "${branch}")`,
    "",
  ];
  if (input.configDiffText !== undefined && input.configDiffText.length > 0) {
    lines.push(input.configDiffText.trimEnd(), "");
  } else {
    lines.push("No config differences found.", "");
  }
  if (input.willFetchMigrationHistory) {
    const reason =
      input.migrationHistoryReason === "flag"
        ? "--with-migration-history was passed"
        : "supabase/migrations has no migration files";
    lines.push(`Fetch the remote migration history table into supabase/migrations (${reason}).`);
    if (input.migrationHistoryReason === "flag") {
      lines.push(
        "This overwrites existing files in supabase/migrations that share a name with a remote history entry.",
      );
    }
  }
  lines.push(
    "Pull the remote database schema into supabase/migrations (also updates the remote migration history table; requires Docker).",
  );
  lines.push("Download every Edge Function's source into supabase/functions.");
  if (input.dirtyPaths.length > 0) {
    lines.push("", pullDirtyWarningMessage(input.dirtyPaths));
  }
  return `${lines.join("\n")}\n`;
}
