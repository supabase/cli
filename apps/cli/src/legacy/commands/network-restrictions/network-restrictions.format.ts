// Go's `fmt.Printf("%+v", x)` produces different bytes depending on whether `x`
// is a nil `*[]string` (the API field is absent) or a non-nil pointer to a
// possibly-empty slice. Specifically:
//
//   *[]string(nil) -> "<nil>"
//   &[]string{}    -> "&[]"
//   &[]string{"a"} -> "&[a]"
//   &[]string{"a", "b"} -> "&[a b]"  (single-space separated, no quoting)
//
// The GET and POST handlers print `resp.JSON*.Config.DbAllowedCidrs` directly,
// which is `*[]string` and therefore tri-state. The PATCH handler prints
// `&localSlice`, which is always non-nil and so renders as `&[]` or `&[...]`.
// `value === undefined` represents the GET/POST "field absent" case.

interface PrintableStatus {
  readonly v4: readonly string[] | undefined;
  readonly v6: readonly string[] | undefined;
  readonly applied: boolean;
}

function formatGoSlice(value: readonly string[] | undefined): string {
  if (value === undefined) return "<nil>";
  return `&[${value.join(" ")}]`;
}

/**
 * Reproduces the three-line `fmt.Printf` block emitted by Go's
 * `apps/cli-go/internal/restrictions/{get,update}/*.go` byte-for-byte.
 */
export function printNetworkRestrictionsStatus(input: PrintableStatus): string {
  return (
    `DB Allowed IPv4 CIDRs: ${formatGoSlice(input.v4)}\n` +
    `DB Allowed IPv6 CIDRs: ${formatGoSlice(input.v6)}\n` +
    `Restrictions applied successfully: ${input.applied ? "true" : "false"}\n`
  );
}
