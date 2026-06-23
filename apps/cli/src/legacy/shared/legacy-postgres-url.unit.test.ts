import { describe, expect, it } from "vitest";

import { legacyToPostgresURL } from "./legacy-postgres-url.ts";

const base = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

describe("legacyToPostgresURL", () => {
  it("builds a local URL with the default 10s connect_timeout", () => {
    expect(legacyToPostgresURL(base)).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
    );
  });

  it("honors a non-zero connect timeout", () => {
    expect(legacyToPostgresURL({ ...base, connectTimeoutSeconds: 30 })).toContain(
      "connect_timeout=30",
    );
  });

  it("treats a zero/absent timeout as the 10s default", () => {
    expect(legacyToPostgresURL({ ...base, connectTimeoutSeconds: 0 })).toContain(
      "connect_timeout=10",
    );
  });

  it("percent-encodes credentials and database", () => {
    expect(
      legacyToPostgresURL({
        ...base,
        user: "postgres.ref",
        password: "p@ss:w/rd",
        database: "my db",
      }),
    ).toBe("postgresql://postgres.ref:p%40ss%3Aw%2Frd@127.0.0.1:54322/my%20db?connect_timeout=10");
  });

  it("wraps an IPv6 host in square brackets", () => {
    expect(legacyToPostgresURL({ ...base, host: "::1" })).toBe(
      "postgresql://postgres:postgres@[::1]:54322/postgres?connect_timeout=10",
    );
  });

  it("omits sslmode (TLS is layered on separately for pg-delta)", () => {
    expect(legacyToPostgresURL(base)).not.toContain("sslmode");
  });

  it("appends the pooler `options` runtime param after connect_timeout", () => {
    // Go's ToPostgresURL appends RuntimeParams; the Supavisor tenant routing
    // `options=reference=<ref>` must reach pg-delta (`=` escaped to %3D).
    expect(legacyToPostgresURL({ ...base, options: "reference=abcdefghijklmnop" })).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10&options=reference%3Dabcdefghijklmnop",
    );
  });

  it("matches Go's url.QueryEscape for options (space → +)", () => {
    expect(legacyToPostgresURL({ ...base, options: "-c search_path=public" })).toContain(
      "&options=-c+search_path%3Dpublic",
    );
  });

  it("omits the options param entirely when absent or empty", () => {
    expect(legacyToPostgresURL(base)).not.toContain("options=");
    expect(legacyToPostgresURL({ ...base, options: "" })).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
    );
  });

  it("appends every runtimeParams entry (sorted) after options, like Go ToPostgresURL", () => {
    expect(
      legacyToPostgresURL({
        ...base,
        options: "reference=abc",
        runtimeParams: { statement_timeout: "5000", search_path: "tenant" },
      }),
    ).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10&options=reference%3Dabc&search_path=tenant&statement_timeout=5000",
    );
  });

  it("escapes runtimeParams values like Go's url.QueryEscape", () => {
    expect(legacyToPostgresURL({ ...base, runtimeParams: { search_path: "a b,c" } })).toContain(
      "&search_path=a+b%2Cc",
    );
  });
});
