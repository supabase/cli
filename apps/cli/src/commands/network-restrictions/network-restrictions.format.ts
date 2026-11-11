import { detailRows } from "../../shared/output/gutter.ts";

// `undefined` (field absent) renders as `<nil>`; an array, empty or not, renders as
// `&[]` / `&[a b]` (space-separated, unquoted). GET/POST responses can omit the field;
// PATCH always supplies a concrete array.

interface PrintableStatus {
  readonly v4: readonly string[] | undefined;
  readonly v6: readonly string[] | undefined;
  readonly applied: boolean;
}

function formatStringSlice(value: readonly string[] | undefined): string {
  if (value === undefined) return "<nil>";
  return `&[${value.join(" ")}]`;
}

const cidrs = (value: readonly string[] | undefined): string =>
  value === undefined || value.length === 0 ? "All addresses" : value.join(", ");

/**
 * Renders the restriction status: detail rows on a terminal, otherwise the established three-line
 * block byte-for-byte.
 */
export function printNetworkRestrictionsStatus(
  input: PrintableStatus,
  stream: { readonly isTTY?: boolean | undefined } = process.stdout,
): string {
  if (stream.isTTY === true) {
    return detailRows([
      ["IPv4 allowed", cidrs(input.v4)],
      ["IPv6 allowed", cidrs(input.v6)],
      ["Applied", input.applied ? "Yes" : "No"],
    ]);
  }
  return (
    `DB Allowed IPv4 CIDRs: ${formatStringSlice(input.v4)}\n` +
    `DB Allowed IPv6 CIDRs: ${formatStringSlice(input.v6)}\n` +
    `Restrictions applied successfully: ${input.applied ? "true" : "false"}\n`
  );
}
