/**
 * Best-effort extraction of a human-readable message from an unknown thrown/failed
 * value — an Effect `PlatformError`, a driver error, a plain `Error`, or anything else.
 * Shared by every legacy module that wraps a raw Effect/driver failure into Go-style
 * error text (Go's own `err.Error()` equivalent), so wording stays consistent across
 * call sites instead of each one re-deriving its own fallback.
 */
export const legacyErrorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Substitutes an absolute path a real syscall needed back to its Go-equivalent
 * display path inside an already-rendered error message. Go's own `fsys` is always a
 * real `afero.OsFs` with the process cwd already `chdir`'ed into the workdir
 * (`ChangeWorkDir`, `cmd/root.go`), so every Go error message embeds the
 * workdir-relative (or verbatim-absolute) path it was actually called with. This shell
 * deliberately never `process.chdir`s, so its own syscalls need a real absolute path to
 * work — but the wrapped message must still report the Go-equivalent path, not the
 * local temp/workdir absolute path the syscall needed, or it leaks a path Go would
 * never show. Shared by every legacy module that wraps a raw filesystem failure this
 * way (`legacy-sql-files-glob.ts`'s matched-file/matched-directory warnings,
 * `legacy-migration-apply.ts`'s migration-file read errors).
 */
export const legacyRelativizeErrorMessage = (
  rawMessage: string,
  absolutePath: string,
  displayPath: string,
): string =>
  absolutePath === displayPath ? rawMessage : rawMessage.split(absolutePath).join(displayPath);
