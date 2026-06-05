import { isIP } from "node:net";

export interface ParsedCidr {
  readonly kind: "v4" | "v6";
  readonly address: string;
  readonly mask: number;
  /**
   * Set when the input was an IPv4-mapped IPv6 form (RFC 4291 §2.5.5.2,
   * e.g. `::ffff:10.0.0.1`). Holds the unwrapped IPv4 dotted-decimal so
   * `isPrivateCidr` and partitioning use Go's `To4()`-driven semantics.
   * `kind` is `"v4"` in this case; the original IPv6 mask range (0-128)
   * still applies, so we keep `mask` as the caller supplied it.
   */
  readonly v4MappedAddress?: string;
}

/**
 * Parses a CIDR string the same way Go's `net.ParseCIDR` does for the inputs
 * accepted by `supabase network-restrictions update` (see
 * `apps/cli-go/internal/restrictions/update/update.go:21`).
 *
 * Returns `null` if the input is not a well-formed CIDR; callers translate
 * `null` into `LegacyNetworkRestrictionsInvalidCidrError`.
 */
export function parseCidr(input: string): ParsedCidr | null {
  const slashIdx = input.indexOf("/");
  if (slashIdx === -1) return null;
  if (input.indexOf("/", slashIdx + 1) !== -1) return null;

  const address = input.slice(0, slashIdx);
  const maskStr = input.slice(slashIdx + 1);
  if (maskStr.length === 0 || !/^\d+$/.test(maskStr)) return null;
  // `Number.parseInt(..., 10)` accepts leading zeros (`/024` → 24). Go's
  // `net.ParseCIDR` does the same, so we keep parity intentionally.
  const mask = Number.parseInt(maskStr, 10);

  const family = isIP(address);
  if (family === 4) {
    if (mask < 0 || mask > 32) return null;
    return { kind: "v4", address, mask };
  }
  if (family === 6) {
    if (mask < 0 || mask > 128) return null;
    // Go's `net.IP.To4()` unwraps IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`)
    // to their v4 form before `IsPrivate()` and bucket classification. Mirror
    // that here so `::ffff:10.0.0.1/128` is rejected as private and routed to
    // `dbAllowedCidrs` (v4 list), not `dbAllowedCidrsV6`.
    const v4Mapped = extractIpv4MappedAddress(address);
    if (v4Mapped !== null) {
      return { kind: "v4", address, mask, v4MappedAddress: v4Mapped };
    }
    return { kind: "v6", address, mask };
  }
  return null;
}

/**
 * Mirrors Go's `net.IP.IsPrivate()` (`apps/cli-go/internal/restrictions/update/update.go:25`)
 * for the address families accepted by `parseCidr`.
 *
 * - IPv4 (RFC 1918): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
 * - IPv6 (RFC 4193): `fc00::/7` — top 7 bits equal `1111110` (first byte `0xFC` or `0xFD`).
 */
export function isPrivateCidr(cidr: ParsedCidr): boolean {
  if (cidr.kind === "v4") {
    // IPv4-mapped IPv6 inputs surface here with `v4MappedAddress` set; check
    // that unwrapped form so Go's `To4()` semantics apply.
    const octets = cidr.v4MappedAddress ?? cidr.address;
    const parts = octets.split(".");
    if (parts.length !== 4) return false;
    const a = Number.parseInt(parts[0]!, 10);
    const b = Number.parseInt(parts[1]!, 10);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  const firstByte = parseFirstIpv6Byte(cidr.address);
  if (firstByte === null) return false;
  return (firstByte & 0xfe) === 0xfc;
}

/**
 * Detects the RFC 4291 IPv4-mapped IPv6 form and returns the unwrapped IPv4
 * dotted-decimal. Per the spec the high 80 bits must be zero and the next 16
 * bits must be exactly `0xFFFF` (case-insensitive `ffff`); anything else is a
 * regular IPv6 address.
 *
 * Supports the canonical short form (`::ffff:a.b.c.d`) and the fully-expanded
 * long form (`0:0:0:0:0:ffff:a.b.c.d`), which are the only forms Node's
 * `isIP` produces a "6" verdict for and that Go's `To4()` unwraps.
 */
function extractIpv4MappedAddress(address: string): string | null {
  const lowered = address.toLowerCase();
  // Short form: ::ffff:a.b.c.d (overwhelmingly the common case).
  const shortPrefix = "::ffff:";
  if (lowered.startsWith(shortPrefix)) {
    const candidate = lowered.slice(shortPrefix.length);
    return isIP(candidate) === 4 ? candidate : null;
  }
  // Long form: 0:0:0:0:0:ffff:a.b.c.d
  const longMatch = /^(?:0:){5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lowered);
  if (longMatch !== null && longMatch[1] !== undefined && isIP(longMatch[1]) === 4) {
    return longMatch[1];
  }
  return null;
}

function parseFirstIpv6Byte(address: string): number | null {
  // Addresses starting with `::` have a leading all-zero hextet, so the high
  // byte is unambiguously 0 (which is not in `fc00::/7`).
  if (address.startsWith(":")) return 0;
  const firstColon = address.indexOf(":");
  if (firstColon === -1) return null;
  const firstHextet = address.slice(0, firstColon);
  if (firstHextet.length === 0 || firstHextet.length > 4) return null;
  if (!/^[0-9a-fA-F]+$/.test(firstHextet)) return null;
  // The first hextet is a big-endian 16-bit value. Left-padding to 4 hex
  // digits and slicing the first two gives the *high* byte (which is what
  // Go's `ip[0]` corresponds to). For example `"fc"` represents `0x00fc`, so
  // the high byte is `0x00` — correctly NOT in `fc00::/7`.
  const padded = firstHextet.padStart(4, "0");
  return Number.parseInt(padded.slice(0, 2), 16);
}

/**
 * Validate every input string and partition into IPv4 / IPv6 lists in the same
 * order Go does (`apps/cli-go/internal/restrictions/update/update.go:20-33`).
 *
 * Returns either the partitioned lists or a discriminated error describing
 * which input failed and why. Callers translate the discriminated error into
 * the appropriate `Data.TaggedError` so telemetry and stderr render Go's
 * verbatim message.
 */
export function validateAndPartitionCidrs(
  inputs: readonly string[],
  bypassCidrChecks: boolean,
):
  | { readonly ok: true; readonly v4: readonly string[]; readonly v6: readonly string[] }
  | { readonly ok: false; readonly kind: "invalid" | "private"; readonly input: string } {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const cidr of inputs) {
    const parsed = parseCidr(cidr);
    if (parsed === null) {
      return { ok: false, kind: "invalid", input: cidr };
    }
    if (!bypassCidrChecks && isPrivateCidr(parsed)) {
      return { ok: false, kind: "private", input: cidr };
    }
    if (parsed.kind === "v4") {
      v4.push(cidr);
    } else {
      v6.push(cidr);
    }
  }
  return { ok: true, v4, v6 };
}

/**
 * Splits the V2 PATCH response shape (`config.dbAllowedCidrs: Array<{address, type}>`)
 * into the two flat string arrays the Go output template expects. Order matches
 * `apps/cli-go/internal/restrictions/update/update.go:75-83`.
 *
 * Lives next to `parseCidr` / `validateAndPartitionCidrs` because it performs
 * the same v4/v6 partitioning, just sourced from the response shape instead of
 * raw CLI input.
 */
export function partitionPatchedCidrs(
  items: ReadonlyArray<{ readonly address: string; readonly type: "v4" | "v6" }> | undefined,
): { readonly v4: string[]; readonly v6: string[] } {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const item of items ?? []) {
    if (item.type === "v4") v4.push(item.address);
    else v6.push(item.address);
  }
  return { v4, v6 };
}
