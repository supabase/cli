import { describe, expect, it } from "vitest";

import { legacySslOptionFor } from "./legacy-db-connection.sql-pg.layer.ts";

describe("legacySslOptionFor", () => {
  it("returns undefined for local connections regardless of sslmode", () => {
    expect(legacySslOptionFor(undefined, true, undefined)).toBeUndefined();
    expect(legacySslOptionFor("verify-full", true, undefined)).toBeUndefined();
    expect(legacySslOptionFor("disable", true, undefined)).toBeUndefined();
  });

  it("uses TLS without verification for remote connections by default", () => {
    expect(legacySslOptionFor(undefined, false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("treats prefer/require/allow as TLS without verification (pgx default)", () => {
    expect(legacySslOptionFor("prefer", false, undefined)).toEqual({ rejectUnauthorized: false });
    expect(legacySslOptionFor("require", false, undefined)).toEqual({ rejectUnauthorized: false });
    expect(legacySslOptionFor("allow", false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("disables TLS entirely for sslmode=disable on a remote connection", () => {
    expect(legacySslOptionFor("disable", false, undefined)).toBe(false);
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
