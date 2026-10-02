/**
 * Best-effort extraction of a human-readable message from an unknown thrown/failed value — an
 * Effect `PlatformError`, a driver error, a plain `Error`, or anything else.
 */
export const errorMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/**
 * Substitutes an absolute path a real syscall needed back to the display path used in error
 * messages. This shell never `process.chdir`s, so its own syscalls need a real absolute path,
 * but the wrapped message must still report the workdir-relative display path — otherwise it
 * leaks the local temp/workdir absolute path.
 */
export const relativizeErrorMessage = (
  rawMessage: string,
  absolutePath: string,
  displayPath: string,
): string =>
  absolutePath === displayPath ? rawMessage : rawMessage.split(absolutePath).join(displayPath);
