import { DateTime, Option } from "effect";

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
  /* `Date.parse` reads a zone-less value as local time; `DateTime.make(value)` would read it as UTC. */
  const parsed = DateTime.make(Date.parse(value));
  if (Option.isNone(parsed)) return value;
  const { year, month, day, hour, minute, second } = DateTime.toPartsUtc(parsed.value);
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}
