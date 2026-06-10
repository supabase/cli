import { describe, expect, it } from "vitest";

import {
  parseLegacyConnectionString,
  redactLegacyConnectionString,
} from "./legacy-db-config.parse.ts";

const osUser =
  process.env["PGUSER"] ?? process.env["USER"] ?? process.env["USERNAME"] ?? "postgres";

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

  it("defaults the user to the OS account when userinfo is omitted (libpq/pgconn parity)", () => {
    expect(parseLegacyConnectionString("postgresql://localhost/mydb")).toEqual({
      host: "localhost",
      port: 5432,
      user: osUser,
      password: "",
      database: "mydb",
    });
  });

  it("defaults user to the OS account and database to that user when both are omitted", () => {
    expect(parseLegacyConnectionString("postgresql://localhost")).toEqual({
      host: "localhost",
      port: 5432,
      user: osUser,
      password: "",
      database: osUser,
    });
  });

  it("fills omitted URL fields from PG* env vars, with explicit fields winning", () => {
    const prev = {
      PGPASSWORD: process.env["PGPASSWORD"],
      PGPORT: process.env["PGPORT"],
      PGDATABASE: process.env["PGDATABASE"],
    };
    process.env["PGPASSWORD"] = "env-secret";
    process.env["PGPORT"] = "6543";
    process.env["PGDATABASE"] = "envdb";
    try {
      // Password/port/database omitted from the URL → taken from PG* env.
      expect(parseLegacyConnectionString("postgresql://alice@db.example.com")).toEqual({
        host: "db.example.com",
        port: 6543,
        user: "alice",
        password: "env-secret",
        database: "envdb",
      });
      // Explicit URL fields override the env defaults (connStringSettings win).
      expect(
        parseLegacyConnectionString("postgresql://alice:pw@db.example.com:5555/appdb"),
      ).toEqual({
        host: "db.example.com",
        port: 5555,
        user: "alice",
        password: "pw",
        database: "appdb",
      });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("strips the brackets from an IPv6 literal host (Go url.Hostname parity)", () => {
    expect(parseLegacyConnectionString("postgresql://postgres:pw@[::1]:5432/postgres")).toEqual({
      host: "::1",
      port: 5432,
      user: "postgres",
      password: "pw",
      database: "postgres",
    });
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

  it("rejects a non-Postgres URL scheme instead of connecting to a bogus host", () => {
    // pgconn only treats `postgres://`/`postgresql://` as a URL (config.go:236);
    // any other scheme is parsed as a keyword/value DSN, which fails.
    expect(parseLegacyConnectionString("https://db.example.com/app")).toBeUndefined();
    expect(parseLegacyConnectionString("mysql://user:pw@host:3306/app")).toBeUndefined();
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

  it("prefers PGUSER over the OS account for the default user (pgconn env precedence)", () => {
    const prev = process.env["PGUSER"];
    process.env["PGUSER"] = "pg_role";
    try {
      // No user= keyword: PGUSER wins over USER/USERNAME, and the database
      // defaults to that resolved user — matching pgconn's
      // mergeSettings(defaultSettings, envSettings, connStringSettings) order.
      expect(parseLegacyConnectionString("host=pg.example.com")).toEqual({
        host: "pg.example.com",
        port: 5432,
        user: "pg_role",
        database: "pg_role",
        password: "",
      });
      // An explicit user= still wins over PGUSER (connStringSettings override env).
      expect(parseLegacyConnectionString("host=h user=explicit")?.user).toBe("explicit");
      // The URL form without userinfo also honors PGUSER.
      expect(parseLegacyConnectionString("postgresql://localhost/mydb")?.user).toBe("pg_role");
    } finally {
      if (prev === undefined) delete process.env["PGUSER"];
      else process.env["PGUSER"] = prev;
    }
  });

  it("fills omitted DSN fields from PG* env vars (pgconn env defaults)", () => {
    const prev = {
      PGHOST: process.env["PGHOST"],
      PGPORT: process.env["PGPORT"],
      PGPASSWORD: process.env["PGPASSWORD"],
      PGDATABASE: process.env["PGDATABASE"],
    };
    process.env["PGHOST"] = "pg.env.com";
    process.env["PGPORT"] = "6543";
    process.env["PGPASSWORD"] = "env-secret";
    process.env["PGDATABASE"] = "envdb";
    try {
      expect(parseLegacyConnectionString("user=admin")).toEqual({
        host: "pg.env.com",
        port: 6543,
        user: "admin",
        password: "env-secret",
        database: "envdb",
      });
      // Explicit keywords override the env defaults.
      expect(
        parseLegacyConnectionString("host=h port=1234 user=admin dbname=db password=pw"),
      ).toEqual({
        host: "h",
        port: 1234,
        user: "admin",
        password: "pw",
        database: "db",
      });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("falls back to a libpq default host when host and PGHOST are absent", () => {
    const prev = process.env["PGHOST"];
    delete process.env["PGHOST"];
    try {
      // No host= and no PGHOST → libpq default (a unix-socket dir or "localhost").
      expect(parseLegacyConnectionString("user=admin")?.host).toMatch(/^(\/|localhost)/);
    } finally {
      if (prev === undefined) delete process.env["PGHOST"];
      else process.env["PGHOST"] = prev;
    }
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
