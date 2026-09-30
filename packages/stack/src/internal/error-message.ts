/** Walks an error's `.cause` chain, joining each distinct message so nested detail is not lost. */
export const errorChainMessage = (error: unknown): string => {
  const parts: Array<string> = [];
  const visited = new Set<Error>();
  let current: unknown = error;
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    const text = current.message || current.name;
    // Wrappers often copy their cause's message; keep the chain but not the repeat.
    if (parts.at(-1) !== text) parts.push(text);
    current = current.cause;
  }
  return parts.join(": ");
};
