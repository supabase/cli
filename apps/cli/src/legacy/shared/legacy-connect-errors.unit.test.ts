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

  it("stages every documented X509 certificate-verification code as tls error", () => {
    // pgconn stages by connection phase — ANY startTLS failure is `tls error (…)`
    // (`pgconn.go:283-289`) — so the complete Node/OpenSSL verification family
    // (Node tls docs "X509 certificate error codes") must keep the staged
    // rendering under sslmode=verify-ca / verify-full. Pinned code-by-code so a
    // future trim of the allowlist regresses loudly.
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
      expect(legacyConnectFailureMessage(target, realSqlConnectError(failure))).toBe(
        `${prefix} tls error (certificate verification failed: ${code})`,
      );
    }
  });

  it("stages a mid-handshake TLS disconnect as tls error despite its ECONNRESET code", () => {
    // Node/Bun's `_tls_wrap.js` onConnectEnd shape: the server accepted
    // SSLRequest but closed the socket before the handshake completed. The
    // message is phase-specific (only ever raised pre-secure-connection), so it
    // stages like pgconn's startTLS wrap (`tls error (…)`, pgconn.go:283-289).
    const midHandshake = Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { code: "ECONNRESET" },
    );
    expect(legacyConnectFailureMessage(target, realSqlConnectError(midHandshake))).toBe(
      `${prefix} tls error (Client network socket disconnected before secure TLS connection was established)`,
    );
  });

  it("renders a raw socket reset verbatim — not phase-specific, so no stage is guessed", () => {
    // Node's hard-RST shape (`read ECONNRESET`, syscall "read") is identical
    // before and after the handshake, so unlike the message above it must NOT
    // be staged as tls error.
    const rawReset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(legacyConnectFailureMessage(target, realSqlConnectError(rawReset))).toBe(
      `${prefix} read ECONNRESET`,
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

  // `ssl` comes from the DSN alone, so a server demanding it blames the DSN, not the flag.
  it("does not blame --debug when the server demands SSL", () => {
    const err = sqlError(new Error("SSL connection is required"));
    expect(legacyConnectSuggestion(err, ctx)).toBeUndefined();
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

  it("classifies only the LAST attempt of a mixed-family aggregate (pgconn last-fallback parity)", () => {
    // Go can never blame an abandoned attempt: pgconn's fallback loop keeps only
    // the last error (`pgconn.go:171-203`) and `SetConnectSuggestion` classifies
    // that same rendered string (`connect.go:317`). An earlier IPv6 EHOSTUNREACH
    // followed by a final unclassified IPv4 timeout must NOT fire the IPv6 hint.
    // The parent carries `code` copied from errors[0] (node's `aggregateErrors`),
    // which must not leak into the wrong-profile branch either.
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "EHOSTUNREACH",
      errors: [
        dialError("EHOSTUNREACH", "2600:1f18::1", 5432),
        dialError("ETIMEDOUT", "10.0.0.9", 5432),
      ],
    });
    expect(legacyConnectSuggestion(realSqlConnectError(aggregate), ctx)).toBeUndefined();
  });

  it("fires the IPv6 pooler suggestion when the LAST aggregate attempt is the IPv6 dial failure", () => {
    // The surfaced (last) attempt drives both the rendered cause and the
    // suggestion — an earlier refused IPv4 attempt is ignored, like Go, even
    // though node copies its `code` onto the aggregate parent.
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
        dialError("EHOSTUNREACH", "2600:1f18::1", 5432),
      ],
    });
    expect(legacyConnectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(
      legacyIpv6Suggestion(),
    );
  });

  it("ignores the parent aggregate's copied first-attempt code (node aggregateErrors shape)", () => {
    // Node's `aggregateErrors` (`lib/internal/errors.js`, Bun matches) copies
    // `errors[0].code` onto the AggregateError itself. A refused first attempt
    // followed by a final unreachable-IPv6 attempt must classify the LAST
    // attempt (IPv6 pooler hint), not the parent's copied ECONNREFUSED —
    // otherwise the suggestion disagrees with the rendered cause, which Go
    // makes impossible (`pgconn.go:171-203`, `connect.go:317`).
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
      errors: [
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
        dialError("ENETUNREACH", "2600:1f18::1", 5432),
      ],
    });
    expect(legacyConnectSuggestion(realSqlConnectError(aggregate), ctx)).toBe(
      legacyIpv6Suggestion(),
    );
  });

  it("classifies a refused LAST attempt as network restrictions despite an IPv6 first attempt", () => {
    // Reverse direction: the parent's copied ENETUNREACH (from the abandoned
    // IPv6 first attempt) must not fabricate the IPv6 hint when the surfaced
    // last attempt is a plain refusal.
    const aggregate = Object.assign(new AggregateError([], ""), {
      code: "ENETUNREACH",
      errors: [
        dialError("ENETUNREACH", "2600:1f18::1", 5432),
        dialError("ECONNREFUSED", "10.0.0.9", 5432),
      ],
    });
    expect(legacyConnectSuggestion(realSqlConnectError(aggregate), ctx)).toContain(
      "Network Restrictions and Network Bans",
    );
  });

  it("sets no suggestion for a mid-handshake TLS disconnect, like Go", () => {
    // Go's `SetConnectSuggestion` (`connect.go:313-335`) has no branch matching
    // resets or TLS failures — the staged `tls error (…)` rendering must not
    // change that.
    const midHandshake = Object.assign(
      new Error("Client network socket disconnected before secure TLS connection was established"),
      { code: "ECONNRESET" },
    );
    expect(legacyConnectSuggestion(realSqlConnectError(midHandshake), ctx)).toBeUndefined();
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
