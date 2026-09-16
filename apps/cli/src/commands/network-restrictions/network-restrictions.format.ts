// `undefined` (field absent) renders as `<nil>`; an array, empty or not, renders as
// `&[]` / `&[a b]` (space-separated, unquoted). GET/POST responses can omit the field;
// PATCH always supplies a concrete array.

interface PrintableStatus {
  readonly v4: readonly string[] | undefined;
  readonly v6: readonly string[] | undefined;
  readonly applied: boolean;
}

function formatGoSlice(value: readonly string[] | undefined): string {
  if (value === undefined) return "<nil>";
  return `&[${value.join(" ")}]`;
}

/** Renders the established three-line status block byte-for-byte. */
export function printNetworkRestrictionsStatus(input: PrintableStatus): string {
  return (
    `DB Allowed IPv4 CIDRs: ${formatGoSlice(input.v4)}\n` +
    `DB Allowed IPv6 CIDRs: ${formatGoSlice(input.v6)}\n` +
    `Restrictions applied successfully: ${input.applied ? "true" : "false"}\n`
  );
}
