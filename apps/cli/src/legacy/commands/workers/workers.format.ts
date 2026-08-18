import { renderGlamourTable } from "../../output/legacy-glamour-table.ts";

/**
 * Text rendering for the workers commands.
 *
 * Two conventions this shell holds and `supabase workers` follows rather than
 * inventing its own: results are written with `output.raw` as plain text — no
 * `intro`/`outro` framing, which no other handler here uses — and tabular
 * output goes through `renderGlamourTable`, so `workers list` sits beside
 * `functions list` and `projects list` looking like them.
 */

/** `label   value` detail lines, aligned the way this shell's key/value output is. */
export function renderWorkerDetails(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return `${rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n")}\n`;
}

export function renderWorkersTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  return renderGlamourTable(headers, rows);
}
