/**
 * Port of Go's `utils.SuggestClaudePlugin` (`apps/cli-go/internal/utils/misc.go:43-57`).
 *
 * Returns the Claude Code plugin-install hint **only** when both:
 *   1. the CLI is running inside Claude Code (`CLAUDECODE` / `CLAUDE_CODE` env —
 *      Go's `agent.IsClaudeCode`), and
 *   2. stdout is an interactive terminal (Go's `term.IsTerminal(stdout)`).
 *
 * Otherwise returns `""`. Pure: env + TTY state are passed in so the helper is
 * trivially unit-testable and free of service dependencies.
 */
const CLAUDE_CODE_HINT = `<claude-code-hint v="1" type="plugin" value="supabase@claude-plugins-official" />`;

export function legacyIsClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["CLAUDECODE"] ?? "") !== "" || (env["CLAUDE_CODE"] ?? "") !== "";
}

export function legacySuggestClaudePlugin(opts: {
  readonly stdoutIsTty: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  if (!legacyIsClaudeCode(opts.env)) return "";
  if (!opts.stdoutIsTty) return "";
  return CLAUDE_CODE_HINT;
}
