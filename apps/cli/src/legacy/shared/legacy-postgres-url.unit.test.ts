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
});
