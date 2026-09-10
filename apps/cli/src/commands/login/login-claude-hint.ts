/**
 * Returns the Claude Code plugin-install hint only when the CLI is running inside Claude Code
 * (`CLAUDECODE`/`CLAUDE_CODE` env) and stdout is an interactive terminal; otherwise returns `""`.
 */
const CLAUDE_CODE_HINT = `<claude-code-hint v="1" type="plugin" value="supabase@claude-plugins-official" />`;

export function isClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["CLAUDECODE"] ?? "") !== "" || (env["CLAUDE_CODE"] ?? "") !== "";
}

export function suggestClaudePlugin(opts: {
  readonly stdoutIsTty: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): string {
  if (!isClaudeCode(opts.env)) return "";
  if (!opts.stdoutIsTty) return "";
  return CLAUDE_CODE_HINT;
}
