import { describe, expect, it } from "vitest";

import {
  legacyBuildConnectionUrl,
  legacyIsTerminalConnectError,
  legacyIsUnixSocketHost,
  legacySslConfigsFor,
  legacySslOptionFor,
} from "./legacy-db-connection.sql-pg.layer.ts";

describe("legacyBuildConnectionUrl", () => {
  const base = {
    user: "postgres",
    password: "pw",
    port: 6543,
    database: "postgres",
    options: "reference=abc",
  };

  it("brackets an IPv6 literal host so new URL accepts it", () => {
    const url = legacyBuildConnectionUrl({ ...base, host: "::1" }, "::1");
    expect(url).toContain("@[::1]:6543/");
    expect(url).toContain("options=reference%3Dabc");
  });

  it("leaves a hostname or IPv4 host unbracketed", () => {
    expect(
      legacyBuildConnectionUrl({ ...base, host: "db.example.com" }, "db.example.com"),
    ).toContain("@db.example.com:6543/");
    expect(legacyBuildConnectionUrl({ ...base, host: "127.0.0.1" }, "203.0.113.10")).toContain(
      "@203.0.113.10:6543/",
    );
  });

  it("percent-encodes a unix-socket host (with options) instead of throwing", () => {
    // A raw socket path as the authority (`@/var/run/postgresql:5432`) makes
    // `new URL()` throw; pg-connection-string accepts the percent-encoded form and
    // a socket dial carries no port. The libpq `options` must still travel.
    const url = legacyBuildConnectionUrl(
      { ...base, host: "/var/run/postgresql", options: "-c search_path=public" },
      "/var/run/postgresql",
    );
    expect(url).toContain("@%2Fvar%2Frun%2Fpostgresql/");
    // No `:port` appended after the socket authority (a socket dial has none).
    expect(url).not.toContain("postgresql:5432");
    expect(url).toContain("options=-c+search_path%3Dpublic");
    // The decoded host (what pg-connection-string's /^%2f/i branch yields) is the path.
    expect(decodeURIComponent(new URL(url).hostname)).toBe("/var/run/postgresql");
  });

  it("uses the per-host port override (for an HA fallback host) over cfg.port", () => {
    // A multi-host config dials each fallback on its own port; the URL builder is
    // told that port explicitly rather than reusing the primary cfg.port.
    expect(legacyBuildConnectionUrl({ ...base, host: "h1" }, "h2.example.com", 5433)).toContain(
      "@h2.example.com:5433/",
    );
  });
});

describe("legacySslOptionFor", () => {
  it("returns undefined for local connections regardless of sslmode", () => {
    expect(legacySslOptionFor(undefined, true, undefined)).toBeUndefined();
    expect(legacySslOptionFor("verify-full", true, undefined)).toBeUndefined();
    expect(legacySslOptionFor("disable", true, undefined)).toBeUndefined();
  });

  it("uses TLS without verification for remote connections by default", () => {
    expect(legacySslOptionFor(undefined, false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("treats prefer/require as TLS without verification (their pgconn primary)", () => {
    expect(legacySslOptionFor("prefer", false, undefined)).toEqual({ rejectUnauthorized: false });
    expect(legacySslOptionFor("require", false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("uses plaintext for sslmode=disable and sslmode=allow on a remote connection", () => {
    // pgconn's `allow` fallback list is `{nil, tlsConfig}` — a non-TLS primary —
    // so an `allow` DSN to a plaintext-only endpoint must connect without TLS.
    expect(legacySslOptionFor("disable", false, undefined)).toBe(false);
    expect(legacySslOptionFor("allow", false, undefined)).toBe(false);
  });

  it("verifies the full certificate (incl. hostname) for verify-full", () => {
    expect(legacySslOptionFor("verify-full", false, undefined)).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("verifies the CA chain but skips hostname for verify-ca (pgconn parity)", () => {
    // pgconn's verify-ca verifies the chain but not the hostname, so Node must
    // keep rejectUnauthorized but disable the identity check.
    const ssl = legacySslOptionFor("verify-ca", false, undefined);
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    if (typeof ssl === "object" && ssl !== null) {
      expect(typeof ssl.checkServerIdentity).toBe("function");
      expect(ssl.checkServerIdentity?.("wrong.host", {} as never)).toBeUndefined();
    }
  });

  it("carries the servername into verifying modes (so a DoH IP verifies the hostname)", () => {
    expect(legacySslOptionFor("verify-full", false, "db.example.com")).toEqual({
      rejectUnauthorized: true,
      servername: "db.example.com",
    });
  });

  it("carries the servername for non-verifying TLS modes too (Go enables sslsni by default)", () => {
    // Go keeps the original hostname as the TLS ServerName for every TLS mode
    // when DoH swaps in a resolved IP, so require/prefer must send SNI as well.
    expect(legacySslOptionFor("require", false, "db.example.com")).toEqual({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
    expect(legacySslOptionFor("prefer", false, "db.example.com")).toEqual({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
    expect(legacySslOptionFor(undefined, false, "db.example.com")).toEqual({
      rejectUnauthorized: false,
      servername: "db.example.com",
    });
  });

  it("does not add a servername when no DoH IP substitution occurred", () => {
    expect(legacySslOptionFor("require", false, undefined)).toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe("legacySslConfigsFor (pgconn fallback list)", () => {
  it("local connections try a single plaintext (no-TLS) config", () => {
    expect(legacySslConfigsFor(undefined, true, undefined)).toEqual([undefined]);
  });

  it("disable is plaintext only", () => {
    expect(legacySslConfigsFor("disable", false, undefined)).toEqual([false]);
  });

  it("allow is plaintext primary with a TLS fallback ({nil, tlsConfig})", () => {
    expect(legacySslConfigsFor("allow", false, undefined)).toEqual([
      false,
      { rejectUnauthorized: false },
    ]);
  });

  it("prefer and unset are TLS only (ConnectByUrl strips the plaintext fallback)", () => {
    // pgconn's raw list is `{tlsConfig, nil}`, but Go's ConnectByUrl removes the
    // plaintext fallback when the primary is TLS, so a default remote connection
    // fails rather than downgrading to plaintext.
    expect(legacySslConfigsFor("prefer", false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
    expect(legacySslConfigsFor(undefined, false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
  });

  it("require / verify-* are TLS only (no fallback)", () => {
    expect(legacySslConfigsFor("require", false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
    expect(legacySslConfigsFor("verify-full", false, undefined)).toEqual([
      { rejectUnauthorized: true },
    ]);
    const verifyCa = legacySslConfigsFor("verify-ca", false, undefined);
    expect(verifyCa).toHaveLength(1);
    expect(verifyCa[0]).toMatchObject({ rejectUnauthorized: true });
  });

  it("loads sslrootcert into the verifying modes and promotes require → verify-ca", () => {
    const ca = "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----";
    // require + a root cert behaves like verify-ca (chain verified, hostname skipped).
    const required = legacySslConfigsFor("require", false, undefined, ca);
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ rejectUnauthorized: true, ca });
    expect((required[0] as { checkServerIdentity?: unknown }).checkServerIdentity).toBeTypeOf(
      "function",
    );
    // verify-full keeps full verification but pins the CA.
    expect(legacySslConfigsFor("verify-full", false, undefined, ca)).toEqual([
      { rejectUnauthorized: true, ca },
    ]);
  });

  it("does not attach a CA to non-verifying modes", () => {
    const ca = "ca-bundle";
    // prefer stays unverified even with a root cert (pgconn: InsecureSkipVerify).
    expect(legacySslConfigsFor("prefer", false, undefined, ca)).toEqual([
      { rejectUnauthorized: false },
    ]);
  });

  it("forces a single plaintext attempt for a unix-socket host regardless of sslmode", () => {
    // pgconn skips TLS for a unix NetworkAddress, so a socket DSN connects in
    // plaintext even though the host is not the local services hostname (isLocal=false).
    expect(
      legacySslConfigsFor("require", false, undefined, undefined, "/var/run/postgresql"),
    ).toEqual([undefined]);
    expect(legacySslConfigsFor("verify-full", false, undefined, "ca", "/tmp/.s.PGSQL")).toEqual([
      undefined,
    ]);
    // A non-socket host still follows the normal sslmode fallback list.
    expect(legacySslConfigsFor("require", false, undefined, undefined, "db.example.com")).toEqual([
      { rejectUnauthorized: false },
    ]);
  });
});

describe("legacyIsUnixSocketHost", () => {
  it("treats an absolute path as a unix socket and a hostname/IP as not", () => {
    expect(legacyIsUnixSocketHost("/var/run/postgresql")).toBe(true);
    expect(legacyIsUnixSocketHost("db.example.com")).toBe(false);
    expect(legacyIsUnixSocketHost("127.0.0.1")).toBe(false);
    expect(legacyIsUnixSocketHost("::1")).toBe(false);
  });

  it("treats an uppercase Windows drive path as a socket, lowercase as TCP (pgconn parity)", () => {
    // pgconn's isAbsolutePath accepts `A-Z:\…` (uppercase drive only); `c:\…` is TCP.
    expect(legacyIsUnixSocketHost("C:\\pgsql")).toBe(true);
    expect(legacyIsUnixSocketHost("c:\\pgsql")).toBe(false);
    expect(legacyIsUnixSocketHost("C:")).toBe(false);
  });
});

describe("legacyIsTerminalConnectError (pgconn fallback termination)", () => {
  it("terminates on auth/catalog/privilege SQLSTATEs carried on the error cause", () => {
    // The pg driver attaches the SQLSTATE as `code`; @effect/sql wraps it in `cause`.
    expect(legacyIsTerminalConnectError({ cause: { code: "28P01" } }, false)).toBe(true);
    expect(legacyIsTerminalConnectError({ cause: { code: "3D000" } }, true)).toBe(true);
    expect(legacyIsTerminalConnectError({ code: "42501" }, false)).toBe(true);
  });

  it("gates 28000 on the attempt having used TLS (pgconn fc.TLSConfig != nil)", () => {
    expect(legacyIsTerminalConnectError({ code: "28000" }, true)).toBe(true);
    expect(legacyIsTerminalConnectError({ code: "28000" }, false)).toBe(false);
  });

  it("falls through (returns false) for network/dial errors with no SQLSTATE", () => {
    expect(legacyIsTerminalConnectError({ code: "ECONNREFUSED" }, true)).toBe(false);
    expect(legacyIsTerminalConnectError(new Error("connection refused"), true)).toBe(false);
    expect(legacyIsTerminalConnectError("boom", true)).toBe(false);
    expect(legacyIsTerminalConnectError(undefined, false)).toBe(false);
  });
});
