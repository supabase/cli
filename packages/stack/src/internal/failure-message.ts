/** Describes a failure as a string; Effect errors such as `Cause.UnknownError` can lack a message. */
export const failureMessage = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const visited = new Set<Error>();
  let current: unknown = cause;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const message: unknown = current.message;
    if (typeof message === "string" && message.length > 0) return message;
    current = current.cause;
  }
  return current === undefined || current instanceof Error ? cause.name : failureMessage(current);
};
