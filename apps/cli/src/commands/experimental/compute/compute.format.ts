/**
 * Text rendering for the compute commands.
 *
 * Results are written with `output.raw` as plain text with no `intro`/`outro`
 * framing, and tabular output goes through `renderGlamourTable`, matching
 * `functions list` and `projects list`.
 */

/**
 * `Label   value` detail lines for a single compute.
 *
 * Vertical rather than a `renderGlamourTable` row because a compute's values
 * include a URL and a source path that would not fit in narrow columns. Rows
 * with an empty value (e.g. `state_reason`, an optional API field) are
 * dropped rather than rendered as a bare label.
 */
export function renderComputeDetails(rows: ReadonlyArray<readonly [string, string]>): string {
  const present = rows.filter(([, value]) => value !== "");
  if (present.length === 0) {
    return "";
  }
  const width = Math.max(...present.map(([label]) => label.length));
  return `${present.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n")}\n`;
}

/**
 * A wait, for the deploy summary: `48s`, `3m21s`, `1h04m`.
 *
 * Whole seconds throughout — these measure a server-side build and rollout, where sub-second
 * precision would imply the CLI polled far more tightly than it does.
 */
export function formatWaited(millis: number): string {
  const total = Math.max(0, Math.round(millis / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
