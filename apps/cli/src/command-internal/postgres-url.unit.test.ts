import { describe, expect, it } from "vitest";

import { toPostgresURL } from "./postgres-url.ts";

const base = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

describe("toPostgresURL", () => {
  it("builds a local URL with the default 10s connect_timeout", () => {
    expect(toPostgresURL(base)).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
    );
  });

  it("honors a non-zero connect timeout", () => {
    expect(toPostgresURL({ ...base, connectTimeoutSeconds: 30 })).toContain("connect_timeout=30");
  });

  it("treats a zero/absent timeout as the 10s default", () => {
    expect(toPostgresURL({ ...base, connectTimeoutSeconds: 0 })).toContain("connect_timeout=10");
  });

  it("percent-encodes credentials and database", () => {
    expect(
      toPostgresURL({
        ...base,
        user: "postgres.ref",
        password: "p@ss:w/rd",
        database: "my db",
      }),
    ).toBe("postgresql://postgres.ref:p%40ss%3Aw%2Frd@127.0.0.1:54322/my%20db?connect_timeout=10");
  });

  it("wraps an IPv6 host in square brackets", () => {
    expect(toPostgresURL({ ...base, host: "::1" })).toBe(
      "postgresql://postgres:postgres@[::1]:54322/postgres?connect_timeout=10",
    );
  });

  it("omits sslmode (TLS is layered on separately for pg-delta)", () => {
    expect(toPostgresURL(base)).not.toContain("sslmode");
  });

  it("appends the pooler `options` runtime param after connect_timeout", () => {
    // Go's ToPostgresURL appends RuntimeParams; the Supavisor tenant routing
    // `options=reference=<ref>` must reach pg-delta (`=` escaped to %3D).
    expect(toPostgresURL({ ...base, options: "reference=abcdefghijklmnop" })).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10&options=reference%3Dabcdefghijklmnop",
    );
  });

  it("matches Go's url.QueryEscape for options (space → +)", () => {
    expect(toPostgresURL({ ...base, options: "-c search_path=public" })).toContain(
      "&options=-c+search_path%3Dpublic",
    );
  });

  it("omits the options param entirely when absent or empty", () => {
    expect(toPostgresURL(base)).not.toContain("options=");
    expect(toPostgresURL({ ...base, options: "" })).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
    );
  });

  it("appends every runtimeParams entry (sorted) after options, like Go ToPostgresURL", () => {
    expect(
      toPostgresURL({
        ...base,
        options: "reference=abc",
        runtimeParams: { statement_timeout: "5000", search_path: "tenant" },
      }),
    ).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10&options=reference%3Dabc&search_path=tenant&statement_timeout=5000",
    );
  });

  it("escapes runtimeParams values like Go's url.QueryEscape", () => {
    expect(toPostgresURL({ ...base, runtimeParams: { search_path: "a b,c" } })).toContain(
      "&search_path=a+b%2Cc",
    );
  });
});
