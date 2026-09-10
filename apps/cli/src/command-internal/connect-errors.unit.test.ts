import { ConnectionError, SqlError } from "effect/unstable/sql/SqlError";
import * as Pg from "pg";
import { describe, expect, it } from "vitest";

import {
  SUGGEST_ENV_VAR,
  SUGGEST_LOCAL_STACK,
  connectFailureMessage,
  connectSuggestion,
  ipv6Suggestion,
  isDialFailure,
  isIPv6ConnectivityError,
  isIPv6ConnectivityErrorCause,
} from "./connect-errors.ts";

// The real `@effect/sql` wrapper produced by the connect probe
// (`acquireProbedPool`): a `SqlError` whose `ConnectionError` reason carries
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

describe("isIPv6ConnectivityError", () => {
  it("classifies the getaddrinfo IPv6-only failures (case-insensitive)", () => {
    expect(
      isIPv6ConnectivityError(
        'could not translate host name "db.x.supabase.co" to address: No address associated with hostname',
      ),
    ).toBe(true);
    expect(isIPv6ConnectivityError("Address family for hostname not supported")).toBe(true);
    expect(isIPv6ConnectivityError("dial tcp: network is unreachable")).toBe(true);
  });

  it("requires an IPv6 literal for the ambiguous dial errors", () => {
    expect(isIPv6ConnectivityError("dial tcp [2600:1f18::1]:5432: connect: no route to host")).toBe(
      true,
    );
    expect(
      isIPv6ConnectivityError(
        "failed to connect to `host=db port=5432`: cannot assign requested address (2600:1f18::1)",
      ),
    ).toBe(true);
    expect(isIPv6ConnectivityError("dial tcp 10.0.0.1:5432: no route to host")).toBe(false);
    expect(isIPv6ConnectivityError("cannot assign requested address")).toBe(false);
  });

  it("classifies Node ENETUNREACH stderr for IPv6 literals", () => {
    expect(isIPv6ConnectivityError("connect ENETUNREACH 2600:1f18::1:5432 - Local (:::0)")).toBe(
      true,
    );
    expect(isIPv6ConnectivityError("connect ENETUNREACH 10.0.0.1:5432")).toBe(false);
  });

  it("classifies Node ENETUNREACH inside the parenthesized connect-failure rendering", () => {
    expect(
      isIPv6ConnectivityError(
        "failed to connect to `host=db.x.supabase.co user=postgres database=postgres`: dial error (connect ENETUNREACH 2600:1f18::1:5432)",
      ),
    ).toBe(true);
  });

  it("does not classify unrelated errors", () => {
    expect(isIPv6ConnectivityError("permission denied for schema public")).toBe(false);
    expect(isIPv6ConnectivityError("")).toBe(false);
  });
});

describe("connectFailureMessage", () => {
  const target = { host: "db.abcdefghij.supabase.co", user: "postgres", database: "postgres" };
  const prefix =
    "failed to connect to `host=db.abcdefghij.supabase.co user=postgres database=postgres`:";

  it("renders host/user/database and the staged dial cause through the real SqlError chain", () => {
    const error = realSqlConnectError(dialError("ECONNREFUSED", "127.0.0.1", 5432));
    expect(connectFailureMessage(target, error)).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:5432)`,
    );
  });

  it("surfaces the last dial attempt of a dual-stack AggregateError (pgconn last-fallback parity)", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "::1", 5432),
        dialError("ECONNREFUSED", "127.0.0.1", 5432),
      ],
    });
    expect(connectFailureMessage(target, realSqlConnectError(aggregate))).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:5432)`,
    );
  });

  it("reproduces pgconn's server-error rendering byte-for-byte for a server ErrorResponse", () => {
    expect(connectFailureMessage(target, realSqlConnectError(authFailedError()))).toBe(
      `${prefix} server error (FATAL: password authentication failed for user "postgres" (SQLSTATE 28P01))`,
    );
  });

  it("stages a DNS failure as hostname resolving error (Bun getaddrinfo shape)", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    });
    expect(connectFailureMessage(target, realSqlConnectError(dns))).toBe(
      `${prefix} hostname resolving error (getaddrinfo ENOTFOUND)`,
    );
    const eaiAgain = Object.assign(new Error("getaddrinfo EAI_AGAIN db.x.supabase.co"), {
      code: "EAI_AGAIN",
    });
    expect(connectFailureMessage(target, realSqlConnectError(eaiAgain))).toBe(
      `${prefix} hostname resolving error (getaddrinfo EAI_AGAIN db.x.supabase.co)`,
    );
  });

  it("stages a dial errno by code alone when the syscall field is absent", () => {
    const timedOut = Object.assign(new Error("connect ETIMEDOUT 10.0.0.9:5432"), {
      code: "ETIMEDOUT",
    });
    expect(connectFailureMessage(target, realSqlConnectError(timedOut))).toBe(
      `${prefix} dial error (connect ETIMEDOUT 10.0.0.9:5432)`,
    );
  });

  it("stages TLS failures as tls error", () => {
    expect(
      connectFailureMessage(
        target,
        realSqlConnectError(new Error("The server does not support SSL connections")),
      ),
    ).toBe(`${prefix} tls error (The server does not support SSL connections)`);
    const selfSigned = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    expect(connectFailureMessage(target, realSqlConnectError(selfSigned))).toBe(
      `${prefix} tls error (self-signed certificate in certificate chain)`,
    );
    const altname = Object.assign(new Error("Hostname/IP does not match certificate's altnames"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    expect(connectFailureMessage(target, realSqlConnectError(altname))).toBe(
      `${prefix} tls error (Hostname/IP does not match certificate's altnames)`,
    );
  });

  it("stages every documented X509 certificate-verification code as tls error", () => {
    // Pinned code-by-code so a future trim of the allowlist regresses loudly.
    const x509Codes = [
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_CRL",
      "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
      "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
      "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
      "CERT_SIGNATURE_FAILURE",
      "CRL_SIGNATURE_FAILURE",
      "CERT_NOT_YET_VALID",
      "CERT_HAS_EXPIRED",
      "CRL_NOT_YET_VALID",
      "CRL_HAS_EXPIRED",
      "ERROR_IN_CERT_NOT_BEFORE_FIELD",
      "ERROR_IN_CERT_NOT_AFTER_FIELD",
      "ERROR_IN_CRL_LAST_UPDATE_FIELD",
      "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
      "OUT_OF_MEM",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_CHAIN_TOO_LONG",
      "CERT_REVOKED",
      "INVALID_CA",
      "PATH_LENGTH_EXCEEDED",
      "INVALID_PURPOSE",
      "CERT_UNTRUSTED",
      "CERT_REJECTED",
      "HOSTNAME_MISMATCH",
    ] as const;
    for (const code of x509Codes) {
      const failure = Object.assign(new Error(`certificate verification failed: ${code}`), {
        code,
      });
      expect(connectFailureMessage(target, realSqlConnectError(failure))).toBe(
        `${prefix} tls error (certificate verification failed: ${code})`,
      );
    }
  });

  it("stages a mid-handshake TLS disconnect as tls error despite its ECONNRESET code", () => {
    const midHandshake = Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { code: "ECONNRESET" },
    );
    expect(connectFailureMessage(target, realSqlConnectError(midHandshake))).toBe(
      `${prefix} tls error (Client network socket disconnected before secure TLS connection was established)`,
    );
  });

  it("renders a raw socket reset verbatim — not phase-specific, so no stage is guessed", () => {
    const rawReset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(connectFailureMessage(target, realSqlConnectError(rawReset))).toBe(
      `${prefix} read ECONNRESET`,
    );
  });

  it("renders an unrecognized cause verbatim (CLI-1942 session-pooler EOF shape)", () => {
    const eof = new Error("Connection terminated unexpectedly");
    expect(connectFailureMessage(target, realSqlConnectError(eof))).toBe(
      `${prefix} Connection terminated unexpectedly`,
    );
  });

  it("handles a bare driver error (raw-client path) and non-object failures", () => {
    expect(connectFailureMessage(target, dialError("ECONNREFUSED", "127.0.0.1", 6543))).toBe(
      `${prefix} dial error (connect ECONNREFUSED 127.0.0.1:6543)`,
    );
    expect(connectFailureMessage(target, "boom")).toBe(`${prefix} boom`);
  });

  it("falls back to the code when the cause carries an empty message", () => {
    const bare = Object.assign(new Error(), { code: "ECONNREFUSED" });
    expect(connectFailureMessage(target, realSqlConnectError(bare))).toBe(
      `${prefix} dial error (ECONNREFUSED)`,
    );
  });
});

describe("connectSuggestion", () => {
  const ctx = {
    dashboardUrl: "https://supabase.com/dashboard",
    profileName: "supabase",
    isLocal: false,
  } as const;

  const sqlError = (cause: unknown) =>
    Object.assign(new Error("PgClient: Failed to connect"), { cause });
  const systemError = (message: string, code: string) =>
    Object.assign(new Error(message), { code });

  it("maps a refused connection (node ECONNREFUSED) to the network-restrictions hint", () => {
    const err = sqlError(systemError("connect ECONNREFUSED 127.0.0.1:54322", "ECONNREFUSED"));
    expect(connectSuggestion(err, ctx)).toBe(
      "Make sure your local IP is allowed in Network Restrictions and Network Bans.\nhttps://supabase.com/dashboard/project/_/database/settings",
    );
  });

  it("maps a refused local connection to the local stack hint", () => {
    const err = sqlError(systemError("connect ECONNREFUSED 127.0.0.1:54322", "ECONNREFUSED"));
    expect(connectSuggestion(err, { ...ctx, isLocal: true })).toBe(SUGGEST_LOCAL_STACK);
  });

  it("maps an AggregateError of refused dials to the network-restrictions hint", () => {
    const err = sqlError(
      Object.assign(new AggregateError([], "all attempts failed"), {
        errors: [systemError("connect ECONNREFUSED [::1]:54322", "ECONNREFUSED")],
      }),
    );
    expect(connectSuggestion(err, ctx)).toContain(
      "Make sure your local IP is allowed in Network Restrictions and Network Bans.",
    );
  });

  it("maps the pooler allow_list rejection to the network-restrictions hint", () => {
    const err = sqlError(new Error("Address not in tenant allow_list"));
    expect(connectSuggestion(err, ctx)).toContain("Network Restrictions and Network Bans");
  });

  it("maps a password-auth failure to the env-var suggestion", () => {
    const err = sqlError(
      Object.assign(new Error('password authentication failed for user "postgres"'), {
        code: "28P01",
      }),
    );
    expect(connectSuggestion(err, ctx)).toBe(SUGGEST_ENV_VAR);
  });

  it("does not blame --debug when the server demands SSL", () => {
    const err = sqlError(new Error("SSL connection is required"));
    expect(connectSuggestion(err, ctx)).toBeUndefined();
  });

  it("maps an IPv6-only connectivity failure to the IPv6 pooler suggestion", () => {
    const err = sqlError(new Error("dial tcp: network is unreachable"));
    expect(connectSuggestion(err, ctx)).toBe(ipv6Suggestion());
  });

  it("maps a tenant-not-found error to the wrong-profile hint", () => {
    const err = sqlError(new Error("Tenant or user not found"));
    expect(connectSuggestion(err, ctx)).toBe("Make sure your project exists on profile: supabase");
  });

  it("maps node's no-route-to-host (EHOSTUNREACH over IPv4) to the wrong-profile hint", () => {
    const err = realSqlConnectError(dialError("EHOSTUNREACH", "10.1.2.3", 5432));
    expect(connectSuggestion(err, ctx)).toBe("Make sure your project exists on profile: supabase");
  });

  it("maps an IPv6 no-route-to-host (EHOSTUNREACH) to the IPv6 pooler suggestion", () => {
    const err = realSqlConnectError(dialError("EHOSTUNREACH", "2600:1f18::1", 5432));
    expect(connectSuggestion(err, ctx)).toBe(ipv6Suggestion());
  });

  it("maps an IPv6 cannot-assign-address (EADDRNOTAVAIL) to the IPv6 pooler suggestion", () => {
    const err = realSqlConnectError(dialError("EADDRNOTAVAIL", "2a05:d014::1", 5432));
    expect(connectSuggestion(err, ctx)).toBe(ipv6Suggestion());
  });

  it("maps an aggregate of IPv6 dial failures to the IPv6 pooler suggestion", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      errors: [dialError("EHOSTUNREACH", "2600:1f18::1", 5432)],
    });
    expect(connectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(ipv6Suggestion());
  });

  it("classifies only the LAST attempt of a mixed-family aggregate (pgconn last-fallback parity)", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "EHOSTUNREACH",
      errors: [
        dialError("EHOSTUNREACH", "2600:1f18::1", 5432),
        dialError("ETIMEDOUT", "10.0.0.9", 5432),
      ],
    });
    expect(connectSuggestion(realSqlConnectError(aggregate), ctx)).toBeUndefined();
  });

  it("fires the IPv6 pooler suggestion when the LAST aggregate attempt is the IPv6 dial failure", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
        dialError("EHOSTUNREACH", "2600:1f18::1", 5432),
      ],
    });
    expect(connectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(ipv6Suggestion());
  });

  it("ignores the parent aggregate's copied first-attempt code (node aggregateErrors shape)", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
        dialError("ENETUNREACH", "2600:1f18::1", 5432),
      ],
    });
    expect(connectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(ipv6Suggestion());
  });

  it("classifies a refused LAST attempt as network restrictions despite an IPv6 first attempt", () => {
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ENETUNREACH",
      errors: [
        dialError("ENETUNREACH", "2600:1f18::1", 5432),
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
      ],
    });
    expect(connectSuggestion(realSqlConnectError(aggregate), ctx)).toContain(
      "Network Restrictions and Network Bans",
    );
  });

  it("sets no suggestion for a mid-handshake TLS disconnect, like Go", () => {
    const midHandshake = Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { code: "ECONNRESET" },
    );
    expect(connectSuggestion(realSqlConnectError(midHandshake), ctx)).toBeUndefined();
  });

  it("keeps an IPv4 EADDRNOTAVAIL unclassified, like Go without an IPv6 literal", () => {
    const err = realSqlConnectError(dialError("EADDRNOTAVAIL", "10.1.2.3", 5432));
    expect(connectSuggestion(err, ctx)).toBeUndefined();
  });

  it("fires the refused hint through the real SqlError chain, not just the test double", () => {
    const err = realSqlConnectError(dialError("ECONNREFUSED", "127.0.0.1", 54322));
    expect(connectSuggestion(err, ctx)).toContain("Network Restrictions and Network Bans");
  });

  it("fires the env-var hint for a real node-postgres 28P01 DatabaseError", () => {
    expect(connectSuggestion(realSqlConnectError(authFailedError()), ctx)).toBe(SUGGEST_ENV_VAR);
  });

  it("keeps the CLI-1942 session-pooler EOF unclassified so the generic --debug suggestion applies", () => {
    const err = realSqlConnectError(new Error("Connection terminated unexpectedly"));
    expect(connectSuggestion(err, ctx)).toBeUndefined();
  });

  it("returns undefined for an unrecognized connect error", () => {
    expect(connectSuggestion(sqlError(new Error("some other failure")), ctx)).toBeUndefined();
  });
});

describe("isDialFailure", () => {
  it("classifies dial errno failures", () => {
    expect(isDialFailure(realSqlConnectError(dialError("ECONNREFUSED", "127.0.0.1", 54322)))).toBe(
      true,
    );
    expect(isDialFailure(realSqlConnectError(dialError("ETIMEDOUT", "127.0.0.1", 54322)))).toBe(
      true,
    );
  });

  it("classifies the last attempt of a multi-address dial", () => {
    expect(
      isDialFailure(
        realSqlConnectError(
          new AggregateError([
            dialError("ENETUNREACH", "::1", 54322),
            dialError("ECONNREFUSED", "127.0.0.1", 54322),
          ]),
        ),
      ),
    ).toBe(true);
  });

  it("classifies the code-less connect timeouts", () => {
    expect(isDialFailure(realSqlConnectError(new Error("Connection timed out")))).toBe(true);
    expect(isDialFailure(realSqlConnectError(new Error("timeout expired")))).toBe(true);
    expect(
      isDialFailure(realSqlConnectError(new Error("timeout exceeded when trying to connect"))),
    ).toBe(true);
  });

  it("does not classify server, auth, or unknown errors", () => {
    expect(isDialFailure(realSqlConnectError(authFailedError()))).toBe(false);
    expect(
      isDialFailure(realSqlConnectError(new Error("Connection terminated unexpectedly"))),
    ).toBe(false);
    expect(isDialFailure(undefined)).toBe(false);
  });
});

describe("isIPv6ConnectivityErrorCause", () => {
  it("classifies Node getaddrinfo and network-unreachable errors", () => {
    expect(isIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENETUNREACH" }))).toBe(
      true,
    );
    expect(isIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENOTFOUND" }))).toBe(
      true,
    );
  });

  it("requires an IPv6 literal address for ambiguous Node dial errors", () => {
    expect(
      isIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EHOSTUNREACH", address: "2600:1f18::1" }),
      ),
    ).toBe(true);
    expect(
      isIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EADDRNOTAVAIL", address: "2a05:d014::1" }),
      ),
    ).toBe(true);
    expect(
      isIPv6ConnectivityErrorCause(
        Object.assign(new Error(), { code: "EHOSTUNREACH", address: "10.0.0.1" }),
      ),
    ).toBe(false);
  });

  it("recurses through AggregateError causes", () => {
    expect(
      isIPv6ConnectivityErrorCause(
        new AggregateError([
          Object.assign(new Error(), { code: "ECONNREFUSED" }),
          Object.assign(new Error(), { code: "ENETUNREACH" }),
        ]),
      ),
    ).toBe(true);
  });

  it("recurses through wrapped cause fields", () => {
    expect(
      isIPv6ConnectivityErrorCause(
        Object.assign(new Error("probe failed"), {
          cause: Object.assign(new Error(), { code: "ENETUNREACH" }),
        }),
      ),
    ).toBe(true);
  });

  it("does not classify unrelated process and timeout failures", () => {
    expect(isIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toBe(
      false,
    );
    expect(isIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ENOENT" }))).toBe(
      false,
    );
    expect(isIPv6ConnectivityErrorCause(Object.assign(new Error(), { code: "ETIMEDOUT" }))).toBe(
      false,
    );
  });

  it("falls back to the existing message classifier for wrapped libpq wording", () => {
    expect(
      isIPv6ConnectivityErrorCause(
        new Error("could not translate host name: no address associated with hostname"),
      ),
    ).toBe(true);
  });
});
