/**
 * Reads a nested transport error code without recursing through a malformed
 * cyclic cause chain.
 */
export const errorCode = (cause: unknown): string | undefined => {
  const maxCauseDepth = 8;
  const seen = new Set<object>();
  let current: unknown = cause;
  for (let depth = 0; depth < maxCauseDepth; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return undefined;
    seen.add(current);
    if ("code" in current && typeof current.code === "string") return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
};
