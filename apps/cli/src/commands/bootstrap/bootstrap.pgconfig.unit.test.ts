import { describe, expect, it } from "vitest";

import { deriveDbConfig, toPostgresUrl } from "./bootstrap.pgconfig.ts";

describe("deriveDbConfig", () => {
  it("derives the direct (session-mode) connection config from ref + host", () => {
    expect(deriveDbConfig("testing", "s3cret", "supabase.co")).toEqual({
      host: "db.testing.supabase.co",
      port: 5432,
      user: "postgres",
      password: "s3cret",
      database: "postgres",
    });
  });
});

describe("toPostgresUrl", () => {
  it("renders the transaction-mode (6543) pooled URL", () => {
    expect(
      toPostgresUrl({
        host: "db.supabase.co",
        port: 6543,
        user: "admin",
        password: "password",
        database: "postgres",
      }),
    ).toBe("postgresql://admin:password@db.supabase.co:6543/postgres?connect_timeout=10");
  });

  it("renders the direct (5432) URL", () => {
    expect(
      toPostgresUrl({
        host: "db.supabase.co",
        port: 5432,
        user: "admin",
        password: "password",
        database: "postgres",
      }),
    ).toBe("postgresql://admin:password@db.supabase.co:5432/postgres?connect_timeout=10");
  });

  it("percent-encodes reserved characters in the userinfo (Go's url.UserPassword)", () => {
    // `@ / ? :` and space are escaped; the sub-delim `$` passes through.
    expect(
      toPostgresUrl({
        host: "db.supabase.co",
        port: 5432,
        user: "ad:min",
        password: "p@ss/w?rd $1",
        database: "postgres",
      }),
    ).toBe(
      "postgresql://ad%3Amin:p%40ss%2Fw%3Frd%20$1@db.supabase.co:5432/postgres?connect_timeout=10",
    );
  });

  it("wraps an IPv6 host in square brackets", () => {
    expect(
      toPostgresUrl({
        host: "2001:db8::1",
        port: 5432,
        user: "postgres",
        password: "pw",
        database: "postgres",
      }),
    ).toBe("postgresql://postgres:pw@[2001:db8::1]:5432/postgres?connect_timeout=10");
  });
});
