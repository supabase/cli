import { describe, expect, it } from "vitest";

import { legacyInjectPostgresPassword } from "./legacy-pgdelta.seam.url.ts";

describe("legacyInjectPostgresPassword", () => {
  it("injects the password into a password-less IPv4 shadow URL", () => {
    expect(
      legacyInjectPostgresPassword(
        "postgresql://postgres@127.0.0.1:54320/postgres?connect_timeout=10",
        "postgres",
      ),
    ).toBe("postgresql://postgres:postgres@127.0.0.1:54320/postgres?connect_timeout=10");
  });

  it("preserves IPv6 bracketing, the database name, and query params", () => {
    expect(
      legacyInjectPostgresPassword(
        "postgresql://postgres@[::1]:54320/contrib_regression?connect_timeout=10&options=test",
        "postgres",
      ),
    ).toBe(
      "postgresql://postgres:postgres@[::1]:54320/contrib_regression?connect_timeout=10&options=test",
    );
  });

  it("percent-encodes a password with special characters so it round-trips", () => {
    const injected = legacyInjectPostgresPassword(
      "postgresql://postgres@127.0.0.1:54320/postgres?connect_timeout=10",
      "p@ss:w/rd",
    );
    expect(injected).toBe(
      "postgresql://postgres:p%40ss%3Aw%2Frd@127.0.0.1:54320/postgres?connect_timeout=10",
    );
    // The pg driver decodes the userinfo back to the original secret.
    expect(decodeURIComponent(new URL(injected).password)).toBe("p@ss:w/rd");
  });

  it("overwrites any existing userinfo password", () => {
    expect(
      legacyInjectPostgresPassword(
        "postgresql://postgres:stale@127.0.0.1:54320/postgres?connect_timeout=10",
        "fresh",
      ),
    ).toBe("postgresql://postgres:fresh@127.0.0.1:54320/postgres?connect_timeout=10");
  });
});
