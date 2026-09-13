function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Parses an RFC3339 timestamp and formats it as UTC "YYYY-MM-DD HH:MM:SS";
 * returns the input verbatim on parse failure.
 */
export function formatTimestamp(value: string): string {
  if (value.length === 0) return value;
  // `Date.parse` accepts a broader format surface than strict RFC3339, so this
  // requires the year-month-day-T prefix to reject already-formatted values
  // like "2026-02-08 16:44:07" that `Date.parse` would otherwise accept.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const date = new Date(parsed);
  return (
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
  );
}
