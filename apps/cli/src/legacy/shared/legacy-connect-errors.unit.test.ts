import { describe, expect, it } from "vitest";

import {
  LEGACY_SUGGEST_ENV_VAR,
  legacyConnectSuggestion,
  legacyIpv6Suggestion,
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

describe("legacyConnectSuggestion", () => {
  const ctx = {
    dashboardUrl: "https://supabase.com/dashboard",
    profileName: "supabase",
    debug: false,
  } as const;

  // The @effect/sql SqlError wraps the node driver error on `.cause`; a multi-address
  // dial wraps an AggregateError whose `.errors[]` carry the per-IP system errors.
  const sqlError = (cause: unknown) =>
    Object.assign(new Error("PgClient: Failed to connect"), { cause });
  const systemError = (message: string, code: string) =>
    Object.assign(new Error(message), { code });

  it("maps a refused connection (node ECONNREFUSED) to the network-restrictions hint", () => {
    const err = sqlError(systemError("connect ECONNREFUSED 127.0.0.1:54322", "ECONNREFUSED"));
    expect(legacyConnectSuggestion(err, ctx)).toBe(
      "Make sure your local IP is allowed in Network Restrictions and Network Bans.\nhttps://supabase.com/dashboard/project/_/database/settings",
    );
  });

  it("maps an AggregateError of refused dials to the network-restrictions hint", () => {
    const err = sqlError(
      Object.assign(new AggregateError([], "all attempts failed"), {
        errors: [systemError("connect ECONNREFUSED [::1]:54322", "ECONNREFUSED")],
      }),
    );
    expect(legacyConnectSuggestion(err, ctx)).toContain(
      "Make sure your local IP is allowed in Network Restrictions and Network Bans.",
    );
  });

  it("maps the pooler allow_list rejection to the network-restrictions hint", () => {
    const err = sqlError(new Error("Address not in tenant allow_list"));
    expect(legacyConnectSuggestion(err, ctx)).toContain("Network Restrictions and Network Bans");
  });

  it("maps a password-auth failure to the env-var suggestion", () => {
    const err = sqlError(
      Object.assign(new Error('password authentication failed for user "postgres"'), {
        code: "28P01",
      }),
    );
    expect(legacyConnectSuggestion(err, ctx)).toBe(LEGACY_SUGGEST_ENV_VAR);
  });

  it("suggests the --debug SSL note only under --debug", () => {
    const err = sqlError(new Error("SSL connection is required"));
    expect(legacyConnectSuggestion(err, ctx)).toBeUndefined();
    expect(legacyConnectSuggestion(err, { ...ctx, debug: true })).toBe(
      "SSL connection is not supported with --debug flag",
    );
  });

  it("maps an IPv6-only connectivity failure to the IPv6 pooler suggestion", () => {
    const err = sqlError(new Error("dial tcp: network is unreachable"));
    expect(legacyConnectSuggestion(err, ctx)).toBe(legacyIpv6Suggestion());
  });

  it("maps a tenant-not-found error to the wrong-profile hint", () => {
    const err = sqlError(new Error("Tenant or user not found"));
    expect(legacyConnectSuggestion(err, ctx)).toBe(
      "Make sure your project exists on profile: supabase",
    );
  });

  it("returns undefined for an unrecognized connect error", () => {
    expect(legacyConnectSuggestion(sqlError(new Error("some other failure")), ctx)).toBeUndefined();
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
