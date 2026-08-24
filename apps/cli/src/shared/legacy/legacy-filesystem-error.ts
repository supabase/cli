import { PlatformError, Predicate } from "effect";

function platformCauseCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }
  const code = cause.code;
  return typeof code === "string" ? code : undefined;
}

export function findPlatformError(cause: unknown): PlatformError.PlatformError | undefined {
  if (cause instanceof PlatformError.PlatformError) {
    return cause;
  }
  if (typeof cause === "object" && cause !== null && "cause" in cause) {
    return findPlatformError(cause.cause);
  }
  return undefined;
}

/**
 * Preserve the host filesystem wording at the Effect platform boundary.
 * PlatformError keeps the original runtime error under reason.cause; callers
 * otherwise only see normalized tags such as NotFound or BadResource.
 */
export function legacyFilesystemErrorMessage(cause: unknown): string {
  const platformError = findPlatformError(cause);
  if (platformError === undefined) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  const reason = platformError.reason;
  const original = reason.cause;
  const originalMessage = original instanceof Error ? original.message : undefined;
  if (originalMessage !== undefined && originalMessage.length > 0) {
    return originalMessage;
  }

  if (Predicate.isTagged(reason, "NotFound")) {
    return "ENOENT: no such file or directory";
  }
  if (Predicate.isTagged(reason, "PermissionDenied")) {
    return "EACCES: permission denied";
  }
  if (Predicate.isTagged(reason, "BadResource")) {
    const code = platformCauseCode(original);
    if (code === "EISDIR") {
      return "EISDIR: illegal operation on a directory";
    }
    if (code === "ENOTDIR") {
      return "ENOTDIR: not a directory";
    }
    if (reason.method === "readDirectory" || reason.syscall === "scandir") {
      return `ENOTDIR: not a directory${
        reason.pathOrDescriptor === undefined ? "" : ` (${String(reason.pathOrDescriptor)})`
      }`;
    }
    if (reason.method === "readFile" || reason.method === "readFileString") {
      return `EISDIR: illegal operation on a directory${
        reason.pathOrDescriptor === undefined ? "" : ` (${String(reason.pathOrDescriptor)})`
      }`;
    }
  }
  return platformError.message;
}
