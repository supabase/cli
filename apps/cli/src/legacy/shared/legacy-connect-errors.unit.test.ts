import { describe, expect, it } from "vitest";

import {
  legacyIsIPv6ConnectivityError,
  legacyIsIPv6ConnectivityErrorCause,
} from "./legacy-connect-errors.ts";

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

  it("classifies Node ENETUNREACH stderr for IPv6 literals", () => {
    expect(
      legacyIsIPv6ConnectivityError("connect ENETUNREACH 2600:1f18::1:5432 - Local (:::0)"),
    ).toBe(true);
    expect(legacyIsIPv6ConnectivityError("connect ENETUNREACH 10.0.0.1:5432")).toBe(false);
  });

  it("does not classify unrelated errors", () => {
    expect(legacyIsIPv6ConnectivityError("permission denied for schema public")).toBe(false);
    expect(legacyIsIPv6ConnectivityError("")).toBe(false);
  });
});

describe("legacyIsIPv6ConnectivityErrorCause", () => {
  it("classifies Node getaddrinfo and network-unreachable errors", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENETUNREACH" })),
    ).toBe(true);
    expect(
      legacyIsIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENOTFOUND" })),
    ).toBe(true);
  });

  it("requires an IPv6 literal address for ambiguous Node dial errors", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EHOSTUNREACH", address: "2600:1f18::1" }),
      ),
    ).toBe(true);
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EADDRNOTAVAIL", address: "2a05:d014::1" }),
      ),
    ).toBe(true);
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EHOSTUNREACH", address: "10.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("recurses through AggregateError causes", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        new AggregateError([
          Object.assign(new Error(), { code: "ECONNREFUSED" }),
          Object.assign(new Error(), { code: "ENETUNREACH" }),
        ]),
      ),
    ).toBe(true);
  });

  it("recurses through wrapped cause fields", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        Object.assign(new Error("probe failed"), {
          cause: Object.assign(new Error(), { code: "ENETUNREACH" }),
        }),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated process and timeout failures", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ECONNREFUSED" })),
    ).toBe(false);
    expect(legacyIsIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENOENT" }))).toBe(
      false,
    );
    expect(
      legacyIsIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ETIMEDOUT" })),
    ).toBe(false);
  });

  it("falls back to the existing message classifier for wrapped libpq wording", () => {
    expect(
      legacyIsIPv6ConnectivityErrorCause(
        new Error("could not translate host name: no address associated with hostname"),
      ),
    ).toBe(true);
  });
});
