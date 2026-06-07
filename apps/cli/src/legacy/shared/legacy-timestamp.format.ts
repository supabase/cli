function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/**
 * Reproduces `utils.FormatTimestamp` from `apps/cli-go/internal/utils/render.go:17`:
 * parse RFC3339; on success format as UTC "YYYY-MM-DD HH:MM:SS"; on failure
 * return the input verbatim.
 */
export function formatLegacyTimestamp(value: string): string {
  if (value.length === 0) return value;
  // Go uses time.Parse(time.RFC3339, value). Date.parse accepts a broader format
  // surface, so we additionally require the year-month-day prefix to weed out
  // values like "2026-02-08 16:44:07" (already-formatted) that Date.parse would
  // happily accept but Go's strict RFC3339 parser would reject.
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
