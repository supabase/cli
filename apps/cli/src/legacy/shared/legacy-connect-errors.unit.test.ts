import { describe, expect, it } from "vitest";

import { legacyIsIPv6ConnectivityError } from "./legacy-connect-errors.ts";

describe("legacyIsIPv6ConnectivityError", () => {
  it("classifies the getaddrinfo IPv6-only failures (case-insensitive)", () => {
    expect(
      legacyIsIPv6ConnectivityError(
        'could not translate host name "db.x.supabase.co" to address: No address associated with hostname',
      ),
    ).toBe(true);
    expect(legacyIsIPv6ConnectivityError("Address family for hostname not supported")).toBe(true);
    expect(legacyIsIPv6ConnectivityError("dial tcp: network is unreachable")).toBe(true);
  });

  it("requires an IPv6 literal for the ambiguous dial errors", () => {
    // "no route to host" / "cannot assign requested address" only count with an IPv6 literal.
    expect(
      legacyIsIPv6ConnectivityError("dial tcp [2600:1f18::1]:5432: connect: no route to host"),
    ).toBe(true);
    expect(
      legacyIsIPv6ConnectivityError(
        "failed to connect to `host=db port=5432`: cannot assign requested address (2600:1f18::1)",
      ),
    ).toBe(true);
    // Same errors over IPv4 must NOT classify as IPv6.
    expect(legacyIsIPv6ConnectivityError("dial tcp 10.0.0.1:5432: no route to host")).toBe(false);
    expect(legacyIsIPv6ConnectivityError("cannot assign requested address")).toBe(false);
  });

  it("does not classify unrelated errors", () => {
    expect(legacyIsIPv6ConnectivityError("permission denied for schema public")).toBe(false);
    expect(legacyIsIPv6ConnectivityError("")).toBe(false);
  });
});
