/**
 * Text rendering for the workers commands.
 *
 * Two conventions this shell holds and `supabase experimental workers` follows rather than
 * inventing its own: results are written with `output.raw` as plain text, with
 * no `intro`/`outro` framing, which no other handler here uses, and tabular
 * output goes through `renderGlamourTable`, so `workers list` sits beside
 * `functions list` and `projects list` looking like them.
 */

/**
 * `Label   value` detail lines for a single worker.
 *
 * Vertical rather than a one-row `renderGlamourTable` because a worker's values
 * include a URL and a source path: `branches get` gets away with laying its
 * seven narrow columns out horizontally, and these would not fit. Labels are
 * Title Case to match the other vertical key/value view this CLI renders,
 * `supabase status` (`legacy-status-pretty.ts`), rather than inventing a third
 * casing.
 *
 * Rows whose value is empty are dropped: several fields are optional strings in
 * the API contract (`state_reason`, for one), so an empty one would otherwise
 * render as a label, two spaces of padding and nothing else.
 */
export function legacyRenderWorkerDetails(rows: ReadonlyArray<readonly [string, string]>): string {
  const present = rows.filter(([, value]) => value !== "");
  if (present.length === 0) {
    return "";
  }
  const width = Math.max(...present.map(([label]) => label.length));
  return `${present.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n")}\n`;
}
