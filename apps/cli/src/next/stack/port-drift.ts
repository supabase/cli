import type { StackSummary } from "@supabase/stack/effect";

export const formatPortDriftWarning = (
  drift: NonNullable<StackSummary["drift"]>,
): string | undefined => {
  if (drift.length === 0) return undefined;
  const changes = drift.map(
    (entry) =>
      `${entry.key} changed from ${entry.actualPort ?? "not yet allocated"} to ${entry.configuredPort ?? "automatic"}`,
  );
  return `Port configuration changed while the stack is running: ${changes.join(", ")}. Restart to apply.`;
};
