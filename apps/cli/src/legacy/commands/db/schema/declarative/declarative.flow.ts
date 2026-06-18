/**
 * Pure control-flow helpers ported 1:1 from
 * `apps/cli-go/cmd/db_schema_declarative.go`. Kept free of Effect/services so
 * the precedence rules are unit-testable in isolation; the handlers run the
 * actual TTY prompt for the `"prompt"` decision.
 */

/**
 * Resolves the migration name. The explicit `--name` wins over `--file`
 * (default `declarative_sync`). Mirrors Go's `resolveDeclarativeMigrationName`
 * (`:99-104`).
 */
export function legacyResolveDeclarativeMigrationName(name: string, file: string): string {
  return name.length > 0 ? name : file;
}

/** Whether sync applies the generated migration, prompts, or skips. */
export type LegacyDeclarativeApplyDecision = "apply" | "skip" | "prompt";

/**
 * Decides whether to apply the generated migration to the local database.
 * Precedence (Go's `resolveDeclarativeSyncShouldApply`, `:106-124`):
 * `--no-apply` > `--apply` > global `--yes` > TTY prompt > non-TTY default (skip).
 */
export function legacyResolveDeclarativeSyncApplyDecision(opts: {
  readonly apply: boolean;
  readonly noApply: boolean;
  readonly yes: boolean;
  readonly tty: boolean;
}): LegacyDeclarativeApplyDecision {
  if (opts.noApply) return "skip";
  if (opts.apply) return "apply";
  if (opts.yes) return "apply";
  if (opts.tty) return "prompt";
  return "skip";
}
