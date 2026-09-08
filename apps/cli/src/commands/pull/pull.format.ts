import { legacyPullCounts } from "./pull.aggregate.ts";
import {
  LEGACY_PULL_STEP_ORDER,
  type LegacyPullAggregate,
  type LegacyPullStepResult,
} from "./pull.types.ts";

/**
 * Pure text/JSON formatters for `supabase pull` — no Effect, no services.
 * `pull.handler.ts` owns sequencing only; every rendering/status-summary
 * decision lives here and in `pull.aggregate.ts`.
 */

/** Version of the machine payload's own shape — bump when it changes incompatibly. */
export const LEGACY_PULL_PAYLOAD_VERSION = 1;

/**
 * The structured result for `--output-format json|stream-json`, per step
 * keyed by `LegacyPullStepId` — see `pull.aggregate.ts`'s per-step mappers for
 * how each `steps.<id>` entry's `detail` is built.
 */
export function legacyPullPayload(aggregate: LegacyPullAggregate): Record<string, unknown> {
  const resultByStep = new Map(aggregate.results.map((result) => [result.step, result] as const));
  const steps: Record<string, unknown> = {};
  for (const step of LEGACY_PULL_STEP_ORDER) {
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
    schema_version: LEGACY_PULL_PAYLOAD_VERSION,
    target: {
      project_ref: aggregate.ref,
      ...(aggregate.branch === undefined ? {} : { branch: aggregate.branch }),
    },
    dry_run: aggregate.dryRun,
    confirmed: aggregate.confirmed,
    wrote: aggregate.results.some((result) => result.status === "changed"),
    step_order: LEGACY_PULL_STEP_ORDER,
    steps,
    counts: legacyPullCounts(aggregate.results),
  };
}

/**
 * One-line `message` passed alongside the payload to `output.success` — an
 * agent echoing just `.message` should never mistake a dry-run/declined/
 * partial-failure result for a completed pull, so every branch names its own
 * disposition up front, then always reports the full per-status breakdown.
 */
export function legacyPullSummaryMessage(aggregate: LegacyPullAggregate): string {
  const counts = legacyPullCounts(aggregate.results);
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

/** Longest `LegacyPullStepStatus` word (`"unchanged"`) — the status column's fixed width. */
const LEGACY_PULL_STATUS_COLUMN_WIDTH = "unchanged".length;

/**
 * Strips control characters (CR/LF/tab) from a failure message before it is inlined into an
 * aligned summary row (CWE-117) — a failure message can carry remote-controlled content (a
 * function slug, an API response body) that would otherwise forge fake additional summary rows
 * in text-mode output.
 */
function legacyPullSanitizeRowText(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ");
}

/** The representative detail shown on a step's summary row — its failure message, its skip
 *  reason, or the first written path (with a "+N more" suffix when there is more than one). */
function legacyPullStepDetailText(result: LegacyPullStepResult): string {
  if (result.status === "failed") {
    return legacyPullSanitizeRowText(result.failure?.message ?? "");
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
 * The full text-mode summary block: a header line naming the target project,
 * then one aligned row per step in `LEGACY_PULL_STEP_ORDER` order. A `failed`
 * step's row inlines its failure message even though only the first original
 * failure re-fails the process (`pull.handler.ts`'s job).
 */
export function legacyRenderPullSummary(aggregate: LegacyPullAggregate): string {
  const resultByStep = new Map(aggregate.results.map((result) => [result.step, result] as const));
  const stepColumnWidth = Math.max(...LEGACY_PULL_STEP_ORDER.map((step) => step.length));

  const lines: Array<string> = [`Pull summary — project ${aggregate.ref}`];
  for (const step of LEGACY_PULL_STEP_ORDER) {
    const result = resultByStep.get(step);
    if (result === undefined) {
      continue;
    }
    const detail = legacyPullStepDetailText(result);
    lines.push(
      `  ${step.padEnd(stepColumnWidth)}  ${result.status.padEnd(LEGACY_PULL_STATUS_COLUMN_WIDTH)}  ${detail}`.trimEnd(),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface LegacyPullConfirmMessageInput {
  /** The resolved target project ref — named in the header line so the confirmation body says
   *  which project/branch is about to be written to. */
  readonly ref: string;
  /** The branch name `--project-ref` resolved, when it named one; `undefined` for a ref-shaped
   *  or linked-fallback target. */
  readonly branch: string | undefined;
  /** Workdir-relative config file path (e.g. `supabase/config.toml`), used both by the dirty
   *  warning and anywhere else this body needs to name the actual file being written. */
  readonly configPath: string;
  /** `config pull`'s own rendered diff body (`legacyRenderConfigPullText`), when there was
   *  anything to show; `undefined`/empty reads as "no config differences found". */
  readonly configDiffText: string | undefined;
  /** Whether the migration-history step will actually run this invocation. */
  readonly willFetchMigrationHistory: boolean;
  /** Why it will run — `"flag"` for `--with-migration-history`, `"bootstrap"` for an empty/missing
   *  `supabase/migrations`. Only read when `willFetchMigrationHistory` is `true`. */
  readonly migrationHistoryReason: "flag" | "bootstrap" | undefined;
  /** Whether the config file has uncommitted/untracked changes (the orchestrator's own git guard). */
  readonly dirty: boolean;
}

/**
 * The single aggregated confirmation prompt's disclosure body — printed
 * before the actual yes/no question, mirroring `legacyRenderConfigPullText`'s
 * role in `config pull`. `db pull` and `functions download` have no preview
 * machinery of their own, so they get one qualitative line each instead of a
 * real diff; migration history only gets a line when it will actually run
 * this invocation (see the confirmed bootstrap-auto-run decision, ADR 0024).
 * The body's lines are ordered to match `LEGACY_PULL_STEP_ORDER` (config →
 * migration_history → db → functions).
 */
export function legacyPullConfirmMessage(input: LegacyPullConfirmMessageInput): string {
  const lines: Array<string> = [
    input.branch === undefined
      ? `Pulling from project ${input.ref}`
      : `Pulling from project ${input.ref} (branch "${input.branch}")`,
    "",
  ];
  // config
  if (input.configDiffText !== undefined && input.configDiffText.length > 0) {
    lines.push(input.configDiffText.trimEnd(), "");
  } else {
    lines.push("No config differences found.", "");
  }
  // migration_history
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
  // db
  lines.push(
    "Pull the remote database schema into supabase/migrations (also updates the remote migration history table; requires Docker).",
  );
  // functions
  lines.push("Download every Edge Function's source into supabase/functions.");
  if (input.dirty) {
    lines.push(
      "",
      `${input.configPath} has uncommitted or untracked changes. Commit or stash them (-u for untracked), or rerun with --force.`,
    );
  }
  return `${lines.join("\n")}\n`;
}
