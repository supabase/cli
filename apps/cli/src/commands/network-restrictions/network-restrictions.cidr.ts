import { isIP } from "node:net";

export interface ParsedCidr {
  readonly kind: "v4" | "v6";
  readonly address: string;
  readonly mask: number;
  /**
   * Set when the input was an IPv4-mapped IPv6 form (RFC 4291 §2.5.5.2, e.g.
   * `::ffff:10.0.0.1`). Holds the unwrapped IPv4 dotted-decimal used for classification;
   * `kind` is `"v4"` in this case, but `mask` keeps the original IPv6 range (0-128).
   */
  readonly v4MappedAddress?: string;
}

/**
 * Parses a CIDR string (e.g. `10.0.0.0/8`) for `supabase network-restrictions update`.
 *
 * Returns `null` if the input is not a well-formed CIDR; callers translate `null` into
 * `NetworkRestrictionsInvalidCidrError`.
 */
export function parseCidr(input: string): ParsedCidr | null {
  const slashIdx = input.indexOf("/");
  if (slashIdx === -1) return null;
  if (input.indexOf("/", slashIdx + 1) !== -1) return null;

  const address = input.slice(0, slashIdx);
  const maskStr = input.slice(slashIdx + 1);
  if (maskStr.length === 0 || !/^\d+$/.test(maskStr)) return null;
  // Leading zeros in the mask are accepted (`/024` → 24).
  const mask = Number.parseInt(maskStr, 10);

  const family = isIP(address);
  if (family === 4) {
    if (mask < 0 || mask > 32) return null;
    return { kind: "v4", address, mask };
  }
  if (family === 6) {
    if (mask < 0 || mask > 128) return null;
    // Unwraps IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) to their v4 form before private-range
    // and bucket classification, so `::ffff:10.0.0.1/128` is treated as v4, not v6.
    const v4Mapped = extractIpv4MappedAddress(address);
    if (v4Mapped !== null) {
      return { kind: "v4", address, mask, v4MappedAddress: v4Mapped };
    }
    return { kind: "v6", address, mask };
  }
  return null;
}

/**
 * Checks whether a parsed CIDR falls in a private range.
 *
 * - IPv4 (RFC 1918): `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
 * - IPv6 (RFC 4193): `fc00::/7` — top 7 bits equal `1111110` (first byte `0xFC` or `0xFD`).
 */
export function isPrivateCidr(cidr: ParsedCidr): boolean {
  if (cidr.kind === "v4") {
    // IPv4-mapped IPv6 inputs surface here with `v4MappedAddress` set; check that unwrapped form.
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
 * Detects the RFC 4291 IPv4-mapped IPv6 form (`::ffff:a.b.c.d`, or its fully-expanded
 * `0:0:0:0:0:ffff:a.b.c.d`) and returns the unwrapped IPv4 dotted-decimal — the only forms
 * Node's `isIP` reports as v6 for this shape.
 */
function extractIpv4MappedAddress(address: string): string | null {
  const lowered = address.toLowerCase();
  const shortPrefix = "::ffff:";
  if (lowered.startsWith(shortPrefix)) {
    const candidate = lowered.slice(shortPrefix.length);
    return isIP(candidate) === 4 ? candidate : null;
  }
  const longMatch = /^(?:0:){5}ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lowered);
  if (longMatch !== null && longMatch[1] !== undefined && isIP(longMatch[1]) === 4) {
    return longMatch[1];
  }
  return null;
}

function parseFirstIpv6Byte(address: string): number | null {
  // A leading "::" hextet is all zero, so the high byte is 0, outside fc00::/7.
  if (address.startsWith(":")) return 0;
  const firstColon = address.indexOf(":");
  if (firstColon === -1) return null;
  const firstHextet = address.slice(0, firstColon);
  if (firstHextet.length === 0 || firstHextet.length > 4) return null;
  if (!/^[0-9a-fA-F]+$/.test(firstHextet)) return null;
  // The first hextet is big-endian; left-padding to 4 hex digits and taking the first two
  // gives the high byte. E.g. "fc" is 0x00fc, so the high byte is 0x00 — not in fc00::/7.
  const padded = firstHextet.padStart(4, "0");
  return Number.parseInt(padded.slice(0, 2), 16);
}

/**
 * Validates every input string and partitions them into IPv4/IPv6 lists.
 *
 * Returns a discriminated error instead of throwing so callers can map it to the
 * appropriate `Data.TaggedError` and render the established verbatim message.
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
 * Splits the V2 PATCH response shape (`config.dbAllowedCidrs: Array<{address, type}>`) into
 * the two flat string arrays the output template expects.
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
