import { describe, expect, it } from "vitest";

import {
  isPrivateCidr,
  parseCidr,
  validateAndPartitionCidrs,
} from "./network-restrictions.cidr.ts";

describe("parseCidr", () => {
  it("parses a single IPv4 CIDR", () => {
    expect(parseCidr("1.2.3.0/24")).toEqual({ kind: "v4", address: "1.2.3.0", mask: 24 });
  });

  it("parses a /32 IPv4 CIDR", () => {
    expect(parseCidr("12.3.4.5/32")).toEqual({ kind: "v4", address: "12.3.4.5", mask: 32 });
  });

  it("parses a /0 IPv4 CIDR", () => {
    expect(parseCidr("0.0.0.0/0")).toEqual({ kind: "v4", address: "0.0.0.0", mask: 0 });
  });

  it("parses a single IPv6 CIDR", () => {
    expect(parseCidr("2001:db8:abcd:0012::0/64")).toEqual({
      kind: "v6",
      address: "2001:db8:abcd:0012::0",
      mask: 64,
    });
  });

  it("parses an IPv6 /128 CIDR", () => {
    expect(parseCidr("::1/128")).toEqual({ kind: "v6", address: "::1", mask: 128 });
  });

  it("rejects an input missing the `/mask` suffix", () => {
    expect(parseCidr("12.3.4.5")).toBeNull();
  });

  it("rejects an input with multiple `/` characters", () => {
    expect(parseCidr("1.2.3.0/24/foo")).toBeNull();
  });

  it("rejects an empty mask", () => {
    expect(parseCidr("1.2.3.0/")).toBeNull();
  });

  it("rejects a non-numeric mask", () => {
    expect(parseCidr("1.2.3.0/abc")).toBeNull();
  });

  it("rejects an IPv4 mask > 32", () => {
    expect(parseCidr("1.2.3.0/33")).toBeNull();
  });

  it("rejects an IPv6 mask > 128", () => {
    expect(parseCidr("::1/129")).toBeNull();
  });

  it("rejects an IPv4 octet > 255", () => {
    expect(parseCidr("256.1.2.3/24")).toBeNull();
  });

  it("rejects malformed IPv6 with too many groups", () => {
    expect(parseCidr("1:2:3:4:5:6:7:8:9/64")).toBeNull();
  });

  it("rejects malformed IPv6 with invalid hex", () => {
    expect(parseCidr("zzzz::1/64")).toBeNull();
  });

  it("rejects an empty string", () => {
    expect(parseCidr("")).toBeNull();
  });

  it("accepts leading zeros in the mask to match Go's parser", () => {
    expect(parseCidr("1.2.3.0/024")).toEqual({ kind: "v4", address: "1.2.3.0", mask: 24 });
  });

  it("reclassifies IPv4-mapped IPv6 inputs as v4 to match Go's To4() semantics", () => {
    expect(parseCidr("::ffff:10.0.0.1/128")).toEqual({
      kind: "v4",
      address: "::ffff:10.0.0.1",
      mask: 128,
      v4MappedAddress: "10.0.0.1",
    });
  });

  it("normalises an uppercase IPv4-mapped prefix to v4 (`::FFFF:`)", () => {
    expect(parseCidr("::FFFF:1.2.3.4/128")?.kind).toBe("v4");
  });

  it("preserves the IPv6 mask range (0-128) for IPv4-mapped inputs", () => {
    // /104 is out of range for v4 (0-32) but valid for IPv4-mapped IPv6.
    const parsed = parseCidr("::ffff:10.0.0.0/104");
    expect(parsed).not.toBeNull();
    expect(parsed?.mask).toBe(104);
    expect(parsed?.kind).toBe("v4");
  });

  it("treats the long-form IPv4-mapped IPv6 address as v4 (0:0:0:0:0:ffff:a.b.c.d)", () => {
    const parsed = parseCidr("0:0:0:0:0:ffff:10.0.0.1/128");
    expect(parsed?.kind).toBe("v4");
    expect(parsed?.v4MappedAddress).toBe("10.0.0.1");
  });

  it("does not treat ::feff:1.2.3.4 as IPv4-mapped (only ::ffff: qualifies per RFC 4291)", () => {
    // Go's `To4()` returns nil for `::feff:1.2.3.4`, so the address stays v6
    // and isPrivateCidr falls through to the first-byte check (which yields
    // 0 for `::`-leading addresses).
    expect(parseCidr("::feff:1.2.3.4/128")).toEqual({
      kind: "v6",
      address: "::feff:1.2.3.4",
      mask: 128,
    });
  });
});

describe("isPrivateCidr", () => {
  it("flags 10.0.0.0/8 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "10.0.0.0", mask: 8 })).toBe(true);
  });

  it("flags any address in 10.0.0.0/8 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "10.255.255.255", mask: 32 })).toBe(true);
  });

  it("flags 172.16.0.0 - 172.31.255.255 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "172.16.0.0", mask: 12 })).toBe(true);
    expect(isPrivateCidr({ kind: "v4", address: "172.31.255.255", mask: 32 })).toBe(true);
  });

  it("does NOT flag 172.15.0.0 or 172.32.0.0 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "172.15.0.0", mask: 12 })).toBe(false);
    expect(isPrivateCidr({ kind: "v4", address: "172.32.0.0", mask: 12 })).toBe(false);
  });

  it("flags 192.168.0.0/16 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "192.168.0.0", mask: 16 })).toBe(true);
    expect(isPrivateCidr({ kind: "v4", address: "192.168.255.255", mask: 32 })).toBe(true);
  });

  it("does NOT flag 192.169.0.0 as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "192.169.0.0", mask: 16 })).toBe(false);
  });

  it("does NOT flag a public IPv4 (1.2.3.4) as private", () => {
    expect(isPrivateCidr({ kind: "v4", address: "1.2.3.4", mask: 32 })).toBe(false);
  });

  it("flags fc00::/7 IPv6 addresses (0xFC) as private", () => {
    expect(isPrivateCidr({ kind: "v6", address: "fc00::1", mask: 7 })).toBe(true);
  });

  it("flags fd00:: IPv6 addresses (0xFD) as private", () => {
    expect(isPrivateCidr({ kind: "v6", address: "fd12::1", mask: 8 })).toBe(true);
  });

  it("does NOT flag a non-fc/fd IPv6 address as private", () => {
    expect(isPrivateCidr({ kind: "v6", address: "2001:db8::1", mask: 32 })).toBe(false);
  });

  it("does NOT flag :: (all-zero) as private", () => {
    expect(isPrivateCidr({ kind: "v6", address: "::1", mask: 128 })).toBe(false);
  });

  it("flags an IPv4-mapped private IPv6 address (::ffff:10.0.0.1) as private", () => {
    expect(
      isPrivateCidr({
        kind: "v4",
        address: "::ffff:10.0.0.1",
        mask: 128,
        v4MappedAddress: "10.0.0.1",
      }),
    ).toBe(true);
  });

  it("flags an IPv4-mapped 192.168.x private IPv6 address as private", () => {
    expect(
      isPrivateCidr({
        kind: "v4",
        address: "::ffff:192.168.0.1",
        mask: 128,
        v4MappedAddress: "192.168.0.1",
      }),
    ).toBe(true);
  });

  it("does NOT flag an IPv4-mapped public IPv6 address (::ffff:1.2.3.4) as private", () => {
    expect(
      isPrivateCidr({
        kind: "v4",
        address: "::ffff:1.2.3.4",
        mask: 128,
        v4MappedAddress: "1.2.3.4",
      }),
    ).toBe(false);
  });
});

describe("validateAndPartitionCidrs", () => {
  it("returns empty arrays for empty input", () => {
    expect(validateAndPartitionCidrs([], false)).toEqual({ ok: true, v4: [], v6: [] });
  });

  it("partitions mixed v4/v6 inputs while preserving input order", () => {
    const result = validateAndPartitionCidrs(
      ["12.3.4.5/32", "2001:db8:abcd:0012::0/64", "1.2.3.1/24"],
      false,
    );
    expect(result).toEqual({
      ok: true,
      v4: ["12.3.4.5/32", "1.2.3.1/24"],
      v6: ["2001:db8:abcd:0012::0/64"],
    });
  });

  it("rejects an invalid CIDR with the offending input", () => {
    expect(validateAndPartitionCidrs(["12.3.4.5"], false)).toEqual({
      ok: false,
      kind: "invalid",
      input: "12.3.4.5",
    });
  });

  it("reports the first failing input when multiple inputs are present", () => {
    expect(validateAndPartitionCidrs(["12.3.4.5", "10.0.0.0/8", "1.2.3.1/24"], false)).toEqual({
      ok: false,
      kind: "invalid",
      input: "12.3.4.5",
    });
  });

  it("rejects an RFC-1918 IPv4 private address by default", () => {
    expect(validateAndPartitionCidrs(["12.3.4.5/32", "10.0.0.0/8", "1.2.3.1/24"], false)).toEqual({
      ok: false,
      kind: "private",
      input: "10.0.0.0/8",
    });
  });

  it("rejects each RFC-1918 IPv4 prefix", () => {
    expect(validateAndPartitionCidrs(["172.16.0.0/12"], false).ok).toBe(false);
    expect(validateAndPartitionCidrs(["192.168.0.0/16"], false).ok).toBe(false);
  });

  it("rejects an RFC-4193 IPv6 private address by default", () => {
    expect(validateAndPartitionCidrs(["fc00::1/64"], false)).toEqual({
      ok: false,
      kind: "private",
      input: "fc00::1/64",
    });
  });

  it("bypasses private-IP rejection when bypassCidrChecks=true", () => {
    expect(validateAndPartitionCidrs(["10.0.0.0/8"], true)).toEqual({
      ok: true,
      v4: ["10.0.0.0/8"],
      v6: [],
    });
  });

  it("bypasses v6 private-IP rejection when bypassCidrChecks=true", () => {
    expect(validateAndPartitionCidrs(["fc00::1/64"], true)).toEqual({
      ok: true,
      v4: [],
      v6: ["fc00::1/64"],
    });
  });

  it("bypassCidrChecks does NOT suppress parse failures", () => {
    expect(validateAndPartitionCidrs(["12.3.4.5"], true)).toEqual({
      ok: false,
      kind: "invalid",
      input: "12.3.4.5",
    });
  });

  it("rejects an IPv4-mapped private IPv6 address by default (Go parity)", () => {
    expect(validateAndPartitionCidrs(["::ffff:10.0.0.0/104"], false)).toEqual({
      ok: false,
      kind: "private",
      input: "::ffff:10.0.0.0/104",
    });
  });

  it("routes an IPv4-mapped IPv6 input into the v4 bucket (preserves input string)", () => {
    expect(validateAndPartitionCidrs(["::ffff:1.2.3.4/128"], false)).toEqual({
      ok: true,
      v4: ["::ffff:1.2.3.4/128"],
      v6: [],
    });
  });
});
