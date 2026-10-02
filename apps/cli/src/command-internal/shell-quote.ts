/** Shell family a printed command is rendered for. */
export type ShellPlatform = "posix" | "windows";

export const currentShellPlatform = (): ShellPlatform =>
  process.platform === "win32" ? "windows" : "posix";

const BARE_SAFE_ARGUMENT = /^[a-zA-Z0-9_./:@%+=,-]+$/;

/** Quotes one argument so a printed command can be pasted into the given shell as-is. */
export function shellQuoteArgument(value: string, platform: ShellPlatform): string {
  if (BARE_SAFE_ARGUMENT.test(value)) return value;
  // PowerShell single-quoted strings escape a quote by doubling it; POSIX
  // shells need the classic '"'"' dance.
  return platform === "windows"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}
