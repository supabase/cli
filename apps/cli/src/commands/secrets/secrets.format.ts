import { renderGlamourTable } from "../../output/glamour-table.ts";

const SECRETS_HEADERS = ["NAME", "DIGEST"] as const;

/**
 * Reproduces `secrets list`'s established pretty-mode byte output. `renderGlamourTable` lays
 * out columns directly, so a literal `|` in a secret name passes through unescaped.
 */
export function renderSecretsListTable(
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  const rows = secrets.map((s) => [s.name, s.value]);
  return renderGlamourTable(SECRETS_HEADERS, rows);
}
