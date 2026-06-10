import { describe, expect, it } from "vitest";

import {
  legacyBuildConnectionUrl,
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

  it("verifies the certificate for verify-ca and verify-full", () => {
    expect(legacySslOptionFor("verify-ca", false, undefined)).toEqual({ rejectUnauthorized: true });
    expect(legacySslOptionFor("verify-full", false, undefined)).toEqual({
      rejectUnauthorized: true,
    });
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
