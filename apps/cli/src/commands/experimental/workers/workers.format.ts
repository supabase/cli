/**
 * Text rendering for the workers commands.
 *
 * Results are written with `output.raw` as plain text with no `intro`/`outro`
 * framing, and tabular output goes through `renderGlamourTable`, matching
 * `functions list` and `projects list`.
 */

/**
 * `Label   value` detail lines for a single worker.
 *
 * Vertical rather than a `renderGlamourTable` row because a worker's values
 * include a URL and a source path that would not fit in narrow columns. Rows
 * with an empty value (e.g. `state_reason`, an optional API field) are
 * dropped rather than rendered as a bare label.
 */
export function renderWorkerDetails(rows: ReadonlyArray<readonly [string, string]>): string {
  const present = rows.filter(([, value]) => value !== "");
  if (present.length === 0) {
    return "";
  }
  const width = Math.max(...present.map(([label]) => label.length));
  return `${present.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n")}\n`;
}
