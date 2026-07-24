import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import * as Pg from "pg";
import { describe, expect, it } from "vitest";

import {
  LEGACY_SUGGEST_ENV_VAR,
  legacyConnectFailureMessage,
  legacyConnectSuggestion,
  legacyIpv6Suggestion,
  legacyIsIPv6ConnectivityError,
  legacyIsIPv6ConnectivityErrorCause,
} from "./legacy-connect-errors.ts";

// The real `@effect/sql` wrapper produced by the connect probe
// (`legacyAcquireProbedPool`): a `SqlError` whose `ConnectionError` reason carries
// the node-postgres driver error as its `cause`.
const realSqlConnectError = (cause: unknown) =>
  new SqlError({
    reason: new ConnectionError({
      cause,
      message: "PgClient: Failed to connect",
      operation: "connect",
    }),
  });

// A node/Bun system error exactly as the `net` stack raises it while dialing:
// `connect ECONNREFUSED 127.0.0.1:5432` with errno-style fields attached.
const dialError = (code: string, address: string, port: number) =>
  Object.assign(new Error(`connect ${code} ${address}:${port}`), {
    code,
    errno: -61,
    syscall: "connect",
    address,
    port,
  });

// A real node-postgres server ErrorResponse (`DatabaseError` from pg-protocol),
// with the fields a live Postgres attaches for a failed password authentication.
const authFailedError = () =>
  Object.assign(
    new Pg.DatabaseError('password authentication failed for user "postgres"', 104, "error"),
    { severity: "FATAL", code: "28P01", file: "auth.c", line: "326", routine: "auth_failed" },
  );

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

  it("classifies Node ENETUNREACH inside the parenthesized connect-failure rendering", () => {
    expect(
      legacyIsIPv6ConnectivityError(
        "failed to connect to `host=db.x.supabase.co user=postgres database=postgres`: dial error (connect ENETUNREACH 2600:1f18::1:5432)",
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors", () => {
    expect(legacyIsIPv6ConnectivityError("permission denied for schema public")).toBe(false);
    expect(legacyIsIPv6ConnectivityError("")).toBe(false);
  });
});

describe("legacyConnectFailureMessage", () => {
  const target = { host: "db.abcdefghij.supabase.co", user: "postgres", database: "postgres" };
  const prefix =
    "failed to connect to `host=db.abcdefghij.supabase.co user=postgres database=postgres`:";

  it("renders host/user/database and the staged dial cause through the real SqlError chain", () => {
    const error = realSqlConnectError(dialError("ECONNREFUSED", "127.0.0.1", 5432));
    expect(legacyConnectFailureMessage(target, error)).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:5432)`,
    );
  });

  it("surfaces the last dial attempt of a dual-stack AggregateError (pgconn last-fallback parity)", () => {
    // node dials ::1 then 127.0.0.1 for `localhost` and aggregates both failures
    // into an AggregateError with an EMPTY message; pgconn's fallback loop
    // likewise surfaces the last attempt's error.
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "::1", 5432),
        dialError("ECONNREFUSED", "127.0.0.1", 5432),
      ],
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(aggregate))).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:5432)`,
    );
  });

  it("reproduces pgconn's server-error rendering byte-for-byte for a server ErrorResponse", () => {
    expect(legacyConnectFailureMessage(target, realSqlConnectError(authFailedError()))).toBe(
      `${prefix} server error (FATAL: password authentication failed for user "postgres" (SQLSTATE 28P01))`,
    );
  });

  it("stages a DNS failure as hostname resolving error (Bun getaddrinfo shape)", () => {
    // Bun's getaddrinfo failure omits the hostname from the message; the host is
    // already carried by the `host=…` identity.
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(dns))).toBe(
      `${prefix} hostname resolving error (getaddrinfo ENOTFOUND)`,
    );
    // A transient resolver failure classifies by code alone (no syscall field).
    const eaiAgain = Object.assign(new Error("getaddrinfo EAI_AGAIN db.x.supabase.co"), {
      code: "EAI_AGAIN",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(eaiAgain))).toBe(
      `${prefix} hostname resolving error (getaddrinfo EAI_AGAIN db.x.supabase.co)`,
    );
  });

  it("stages a dial errno by code alone when the syscall field is absent", () => {
    const timedOut = Object.assign(new Error("connect ETIMEDOUT 10.0.0.9:5432"), {
      code: "ETIMEDOUT",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(timedOut))).toBe(
      `${prefix} dial error (connect ETIMEDOUT 10.0.0.9:5432)`,
    );
  });

  it("stages TLS failures as tls error", () => {
    // node-postgres' own refusal message carries no code.
    expect(
      legacyConnectFailureMessage(
        target,
        realSqlConnectError(new Error("The server does not support SSL connections")),
      ),
    ).toBe(`${prefix} tls error (The server does not support SSL connections)`);
    const selfSigned = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(selfSigned))).toBe(
      `${prefix} tls error (self-signed certificate in certificate chain)`,
    );
    // node's ERR_TLS_* family (e.g. a hostname mismatch under verify-full).
    const altname = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(altname))).toBe(
      `${prefix} tls error (Hostname/IP does not match certificate's altnames)`,
    );
  });

  it("renders an unrecognized cause verbatim (CLI-1942 session-pooler EOF shape)", () => {
    // node-postgres raises `Connection terminated unexpectedly` where pgconn
    // says `failed to receive message (unexpected EOF)` — no stage is guessed.
    const eof = new Error("Connection terminated unexpectedly");
    expect(legacyConnectFailureMessage(target, realSqlConnectError(eof))).toBe(
      `${prefix} Connection terminated unexpectedly`,
    );
  });

  it("handles a bare driver error (raw-client path) and non-object failures", () => {
    // `acquireRawClient` maps the node-postgres rejection without a SqlError wrapper.
    expect(legacyConnectFailureMessage(target, dialError("ECONNREFUSED", "127.0.0.1", 6543))).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:6543)`,
    );
    expect(legacyConnectFailureMessage(target, "boom")).toBe(`${prefix} boom`);
  });

  it("falls back to the code when the cause carries an empty message", () => {
    const bare = Object.assign(new Error(), { code: "ECONNREFUSED" });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(bare))).toBe(
      `${prefix} dial error (ECONNREFUSED)`,
    );
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

  it("maps node's no-route-to-host (EHOSTUNREACH over IPv4) to the wrong-profile hint", () => {
    // Go matches pgconn's `connect: no route to host`; node renders the same
    // failure as `connect EHOSTUNREACH <ip>:<port>` with errno fields.
    const err = realSqlConnectError(dialError("EHOSTUNREACH", "10.1.2.3", 5432));
    expect(legacyConnectSuggestion(err, ctx)).toBe(
      "Make sure your project exists on profile: supabase",
    );
  });

  it("maps an IPv6 no-route-to-host (EHOSTUNREACH) to the IPv6 pooler suggestion", () => {
    // Go's `no route to host` counts as IPv6 when the message carries an IPv6
    // literal; node carries the dialed address as a structured field instead.
    const err = realSqlConnectError(dialError("EHOSTUNREACH", "2600:1f18::1", 5432));
    expect(legacyConnectSuggestion(err, ctx)).toBe(legacyIpv6Suggestion());
  });

  it("maps an IPv6 cannot-assign-address (EADDRNOTAVAIL) to the IPv6 pooler suggestion", () => {
    const err = realSqlConnectError(dialError("EADDRNOTAVAIL", "2a05:d014::1", 5432));
    expect(legacyConnectSuggestion(err, ctx)).toBe(legacyIpv6Suggestion());
  });

  it("maps an aggregate of IPv6 dial failures to the IPv6 pooler suggestion", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      errors: [dialError("EHOSTUNREACH", "2600:1f18::1", 5432)],
    });
    expect(legacyConnectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(
      legacyIpv6Suggestion(),
    );
  });

  it("keeps an IPv4 EADDRNOTAVAIL unclassified, like Go without an IPv6 literal", () => {
    const err = realSqlConnectError(dialError("EADDRNOTAVAIL", "10.1.2.3", 5432));
    expect(legacyConnectSuggestion(err, ctx)).toBeUndefined();
  });

  it("fires the refused hint through the real SqlError chain, not just the test double", () => {
    const err = realSqlConnectError(dialError("ECONNREFUSED", "127.0.0.1", 54322));
    expect(legacyConnectSuggestion(err, ctx)).toContain("Network Restrictions and Network Bans");
  });

  it("fires the env-var hint for a real node-postgres 28P01 DatabaseError", () => {
    expect(legacyConnectSuggestion(realSqlConnectError(authFailedError()), ctx)).toBe(
      LEGACY_SUGGEST_ENV_VAR,
    );
  });

  it("keeps the CLI-1942 session-pooler EOF unclassified so the generic --debug suggestion applies", () => {
    // Go's SetConnectSuggestion has no branch for pgconn's `unexpected EOF`
    // (the session-pooler drop in CLI-1942); node-postgres' equivalent
    // `Connection terminated unexpectedly` must stay unclassified too.
    const err = realSqlConnectError(new Error("Connection terminated unexpectedly"));
    expect(legacyConnectSuggestion(err, ctx)).toBeUndefined();
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
