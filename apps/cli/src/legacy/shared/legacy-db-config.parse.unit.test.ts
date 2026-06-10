import { describe, expect, it } from "vitest";

import {
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "./legacy-db-config.parse.ts";

const osUser = process.env["USER"] ?? process.env["USERNAME"] ?? "postgres";

describe("parseLegacyConnectionString (URL form)", () => {
  it("parses host/port/user/password/database and percent-decodes userinfo", () => {
    expect(parseLegacyConnectionString("postgres://alice:p%40ss@example.com:6543/appdb")).toEqual({
      host: "example.com",
      port: 6543,
      user: "alice",
      password: "p@ss",
      database: "appdb",
    });
  });

  it("defaults the port to 5432 and the database to the user when both are absent", () => {
    expect(parseLegacyConnectionString("postgres://bob@example.com")).toEqual({
      host: "example.com",
      port: 5432,
      user: "bob",
      password: "",
      database: "bob",
    });
  });

  it("falls back to the 'postgres' database when there is no user and no path", () => {
    expect(parseLegacyConnectionString("postgres://example.com")?.database).toBe("postgres");
  });

  it("preserves sslmode and the libpq options runtime param from the query string", () => {
    const parsed = parseLegacyConnectionString(
      "postgres://u:pw@h:5432/db?sslmode=verify-full&options=reference%3Dabc",
    );
    expect(parsed?.sslmode).toBe("verify-full");
    expect(parsed?.options).toBe("reference=abc");
  });

  it("omits sslmode/options keys when the query string does not set them", () => {
    const parsed = parseLegacyConnectionString("postgres://u:pw@h/db");
    expect(parsed).not.toHaveProperty("sslmode");
    expect(parsed).not.toHaveProperty("options");
  });

  it("returns undefined for an unparseable URL", () => {
    expect(parseLegacyConnectionString("postgres://user:pw@ bad host/db")).toBeUndefined();
  });

  it("returns undefined for a malformed percent escape (no thrown defect)", () => {
    expect(parseLegacyConnectionString("postgres://user:p%zz@example.com/db")).toBeUndefined();
  });
});

describe("parseLegacyConnectionString (libpq keyword/value DSN)", () => {
  it("parses a space-separated keyword/value DSN", () => {
    expect(
      parseLegacyConnectionString("host=pg.example.com port=6543 user=admin dbname=app"),
    ).toEqual({
      host: "pg.example.com",
      port: 6543,
      user: "admin",
      database: "app",
      password: "",
    });
  });

  it("supports a unix-socket host path and carries sslmode/options through", () => {
    const parsed = parseLegacyConnectionString(
      "host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable options=reference=abc",
    );
    expect(parsed?.host).toBe("/var/run/postgresql");
    expect(parsed?.sslmode).toBe("disable");
    expect(parsed?.options).toBe("reference=abc");
  });

  it("honors single-quoted values with embedded spaces and backslash escapes", () => {
    const parsed = parseLegacyConnectionString(
      "host=h dbname=db user=postgres password='se cr\\'et'",
    );
    expect(parsed?.password).toBe("se cr'et");
  });

  it("defaults user to the OS account, database to the user, and port to 5432", () => {
    expect(parseLegacyConnectionString("host=pg.example.com")).toEqual({
      host: "pg.example.com",
      port: 5432,
      user: osUser,
      database: osUser,
      password: "",
    });
  });

  it("returns undefined when a keyword has no '=' value", () => {
    expect(parseLegacyConnectionString("host pg.example.com")).toBeUndefined();
  });

  it("returns undefined for a non-numeric port", () => {
    expect(parseLegacyConnectionString("host=h port=abc")).toBeUndefined();
  });
});

describe("redactLegacyConnectionString", () => {
  it("masks the password in a parseable URL", () => {
    const redacted = redactLegacyConnectionString("postgres://user:s3cret@example.com/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks the password in a malformed-but-credential-bearing URL", () => {
    const redacted = redactLegacyConnectionString("postgres://user:s3cret@ bad host/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks a bare keyword/value password", () => {
    const redacted = redactLegacyConnectionString("host=h user=admin password=s3cret port=5432");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks a single-quoted keyword/value password", () => {
    const redacted = redactLegacyConnectionString("host=h password='s3 cret' dbname=db");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("s3 cret");
  });
});
