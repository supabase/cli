import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, ManagedRuntime, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { afterEach, beforeEach } from "vitest";

import {
  legacyPoolerConfigFromConnectionString,
  parseLegacyConnectionString as parseLegacyConnectionStringImpl,
  redactLegacyConnectionString,
} from "./legacy-db-config.parse.ts";
import type { LegacyDbConfigParseRuntime, LegacyParseEnv } from "./legacy-db-config.parse.ts";
import { useLegacyTempWorkdir } from "../../../tests/helpers/legacy-mocks.ts";

import { userInfo } from "node:os";

// Mirrors the parser's default-user resolution: PGUSER (env) else the actual OS
// account (os.userInfo().username, NOT $USER/$USERNAME) else "postgres".
const osAccount = (() => {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
})();
const osUser = osAccount ?? "postgres";

const testPlatform = ManagedRuntime.make(BunServices.layer);
const testPath = testPlatform.runSync(Path.Path);
const tempRoot = useLegacyTempWorkdir("legacy-db-config-parse-");
let fixtureCounter = 0;

function join(...paths: ReadonlyArray<string>): string {
  return testPath.join(...paths);
}

const emptyEnv: LegacyParseEnv = () => undefined;

function parseLegacyConnectionString(
  value: string,
  env: LegacyParseEnv = emptyEnv,
  runtime: Partial<LegacyDbConfigParseRuntime> = {},
) {
  return parseLegacyConnectionStringImpl(value, env, {
    osUser,
    join,
    files: new Map(),
    serviceFiles: new Map(),
    ...runtime,
  });
}

const createFixture = (
  prefix: string,
  files: ReadonlyArray<Readonly<{ readonly path: string; readonly content: string }>>,
): Effect.Effect<string, PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(tempRoot.current, `${prefix}${fixtureCounter++}`);
    yield* fs.makeDirectory(dir, { recursive: true });
    for (const file of files) {
      const absolute = path.join(dir, file.path);
      yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
      yield* fs.writeFileString(absolute, file.content);
    }
    return dir;
  });

const removeFixture = (dir: string): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(dir, { recursive: true, force: true });
  });

const runFixture = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

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
    const env: LegacyParseEnv = (name) =>
      ({ PGPASSWORD: "env-secret", PGPORT: "6543", PGDATABASE: "envdb" })[name];
    // Password/port/database omitted from the URL → taken from PG* env.
    expect(parseLegacyConnectionString("postgresql://alice@db.example.com", env)).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "alice",
      password: "env-secret",
      database: "envdb",
    });
    // Explicit URL fields override the env defaults (connStringSettings win).
    expect(
      parseLegacyConnectionString("postgresql://alice:pw@db.example.com:5555/appdb", env),
    ).toEqual({
      host: "db.example.com",
      port: 5555,
      user: "alice",
      password: "pw",
      database: "appdb",
    });
  });

  it("honors libpq query params (host/dbname) over the structural URL (pgconn parity)", () => {
    // pgconn's parseURLSettings merges query params last, so ?host=/socket wins
    // over the (empty) URL host, and a unix-socket host is used verbatim.
    expect(parseLegacyConnectionString("postgresql:///postgres?host=/var/run/postgresql")).toEqual({
      host: "/var/run/postgresql",
      port: 5432,
      user: osUser,
      password: "",
      database: "postgres",
    });
    // A query dbname overrides the URL path.
    expect(
      parseLegacyConnectionString(
        "postgresql://postgres:pw@db.example.com:6543/ignored?dbname=real",
      ),
    ).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "postgres",
      password: "pw",
      database: "real",
    });
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

  it("collects non-structural query settings as runtimeParams (pgconn parity)", () => {
    const parsed = parseLegacyConnectionString(
      "postgres://u:pw@h/db?search_path=tenant&statement_timeout=5000&sslmode=require&options=reference%3Dabc",
    );
    // search_path/statement_timeout → runtimeParams; sslmode/options stay dedicated.
    expect(parsed?.runtimeParams).toEqual({ search_path: "tenant", statement_timeout: "5000" });
    expect(parsed?.options).toBe("reference=abc");
    expect(parsed).not.toHaveProperty("runtimeParams.options");
  });

  it("omits runtimeParams when only structural/ssl keys are present", () => {
    const parsed = parseLegacyConnectionString("postgres://u:pw@h/db?sslmode=require");
    expect(parsed).not.toHaveProperty("runtimeParams");
  });

  it("merges PGAPPNAME into runtimeParams as application_name (pgconn env merge)", () => {
    const env = (name: string): string | undefined => (name === "PGAPPNAME" ? "myapp" : undefined);
    const parsed = parseLegacyConnectionString("postgres://u:pw@h/db", env);
    expect(parsed?.runtimeParams).toEqual({ application_name: "myapp" });
  });

  it("lets a connection-string application_name override PGAPPNAME (pgconn precedence)", () => {
    const env = (name: string): string | undefined =>
      name === "PGAPPNAME" ? "from-env" : undefined;
    const parsed = parseLegacyConnectionString(
      "postgres://u:pw@h/db?application_name=from-url",
      env,
    );
    expect(parsed?.runtimeParams?.application_name).toBe("from-url");
  });

  it.effect("merges a pg_service.conf runtime setting (search_path) into runtimeParams", () =>
    Effect.gen(function* () {
      const dir = yield* createFixture("pgservice-", [
        {
          path: "pg_service.conf",
          content: "[tenant]\nhost=svc.example.com\nsearch_path=tenant_schema\n",
        },
      ]);
      const file = join(dir, "pg_service.conf");
      const serviceContent = "[tenant]\nhost=svc.example.com\nsearch_path=tenant_schema\n";
      const parsed = parseLegacyConnectionString(
        `postgres:///db?service=tenant&servicefile=${file}`,
        () => undefined,
        { serviceFiles: new Map([[file, serviceContent]]) },
      );
      expect(parsed?.host).toBe("svc.example.com");
      expect(parsed?.runtimeParams?.search_path).toBe("tenant_schema");
      yield* removeFixture(dir);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("carries client sslcert/sslkey (and sslpassword) from a --db-url", () => {
    const parsed = parseLegacyConnectionString(
      "postgres://u:pw@h/db?sslmode=verify-full&sslcert=/c/client.crt&sslkey=/c/client.key&sslpassword=secret",
    );
    expect(parsed?.sslcert).toBe("/c/client.crt");
    expect(parsed?.sslkey).toBe("/c/client.key");
    expect(parsed?.sslpassword).toBe("secret");
    // sslcert/sslkey are connection settings, never forwarded as runtime params.
    expect(parsed).not.toHaveProperty("runtimeParams");
  });

  it("resolves client certs from PGSSLCERT/PGSSLKEY env (pgconn precedence)", () => {
    const env = (name: string): string | undefined =>
      name === "PGSSLCERT" ? "/e/c.crt" : name === "PGSSLKEY" ? "/e/c.key" : undefined;
    const parsed = parseLegacyConnectionString("postgres://u:pw@h/db", env);
    expect(parsed?.sslcert).toBe("/e/c.crt");
    expect(parsed?.sslkey).toBe("/e/c.key");
  });

  it("rejects a client cert with sslcert but no sslkey (pgconn both-or-neither)", () => {
    expect(
      parseLegacyConnectionString("postgres://u:pw@h/db?sslcert=/c/client.crt"),
    ).toBeUndefined();
    expect(parseLegacyConnectionString("host=h user=u sslkey=/c/client.key")).toBeUndefined();
  });

  it("returns undefined for an unparseable URL", () => {
    expect(parseLegacyConnectionString("postgres://user:pw@ bad host/db")).toBeUndefined();
  });

  it("returns undefined for a malformed percent escape (no thrown defect)", () => {
    expect(parseLegacyConnectionString("postgres://user:p%zz@example.com/db")).toBeUndefined();
  });

  it("rejects a non-numeric or empty ?port= query override (pgconn parsePort error)", () => {
    expect(parseLegacyConnectionString("postgresql://host/db?port=abc")).toBeUndefined();
    // An explicit empty port override overrides the structural port and is invalid.
    expect(parseLegacyConnectionString("postgresql://db.example.com/app?port=")).toBeUndefined();
  });

  it("rejects an invalid PGPORT fallback instead of defaulting to 5432", () => {
    const env: LegacyParseEnv = (name) => (name === "PGPORT" ? "abc" : undefined);
    // No port in the URL or DSN → falls back to PGPORT, which is invalid → reject.
    expect(parseLegacyConnectionString("postgresql://host/db", env)).toBeUndefined();
    expect(parseLegacyConnectionString("host=pg.example.com user=admin", env)).toBeUndefined();
  });

  it("rejects an invalid sslmode value (pgconn 'sslmode is invalid')", () => {
    expect(parseLegacyConnectionString("postgres://h/db?sslmode=verifyfull")).toBeUndefined();
    expect(parseLegacyConnectionString("host=h sslmode=bogus")).toBeUndefined();
  });

  it("carries sslrootcert from the query or DSN (PGSSLROOTCERT-style CA pinning)", () => {
    expect(
      parseLegacyConnectionString("postgres://h/db?sslmode=require&sslrootcert=/ca.pem"),
    ).toMatchObject({ sslmode: "require", sslrootcert: "/ca.pem" });
    expect(
      parseLegacyConnectionString("host=h sslmode=verify-ca sslrootcert=/ca.pem"),
    ).toMatchObject({ sslrootcert: "/ca.pem" });
  });

  it("fills sslmode from PGSSLMODE when the URL omits it (pgconn env default)", () => {
    const env: LegacyParseEnv = (name) => (name === "PGSSLMODE" ? "verify-full" : undefined);
    expect(parseLegacyConnectionString("postgres://u:pw@h:5432/db", env)?.sslmode).toBe(
      "verify-full",
    );
    // An explicit query sslmode still wins over PGSSLMODE.
    expect(
      parseLegacyConnectionString("postgres://u:pw@h:5432/db?sslmode=disable", env)?.sslmode,
    ).toBe("disable");
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
    const env: LegacyParseEnv = (name) => (name === "PGUSER" ? "pg_role" : undefined);
    // No user= keyword: PGUSER wins over USER/USERNAME, and the database
    // defaults to that resolved user — matching pgconn's
    // mergeSettings(defaultSettings, envSettings, connStringSettings) order.
    expect(parseLegacyConnectionString("host=pg.example.com", env)).toEqual({
      host: "pg.example.com",
      port: 5432,
      user: "pg_role",
      database: "pg_role",
      password: "",
    });
    // An explicit user= still wins over PGUSER (connStringSettings override env).
    expect(parseLegacyConnectionString("host=h user=explicit", env)?.user).toBe("explicit");
    // The URL form without userinfo also honors PGUSER.
    expect(parseLegacyConnectionString("postgresql://localhost/mydb", env)?.user).toBe("pg_role");
  });

  it("fills omitted DSN fields from PG* env vars (pgconn env defaults)", () => {
    const env: LegacyParseEnv = (name) =>
      ({ PGHOST: "pg.env.com", PGPORT: "6543", PGPASSWORD: "env-secret", PGDATABASE: "envdb" })[
        name
      ];
    expect(parseLegacyConnectionString("user=admin", env)).toEqual({
      host: "pg.env.com",
      port: 6543,
      user: "admin",
      password: "env-secret",
      database: "envdb",
    });
    // Explicit keywords override the env defaults.
    expect(
      parseLegacyConnectionString("host=h port=1234 user=admin dbname=db password=pw", env),
    ).toEqual({
      host: "h",
      port: 1234,
      user: "admin",
      password: "pw",
      database: "db",
    });
  });

  it("falls back to a libpq default host when host and PGHOST are absent", () => {
    // No host= and no PGHOST → libpq default (a unix-socket dir or "localhost").
    expect(parseLegacyConnectionString("user=admin")?.host).toMatch(/^(\/|localhost)/);
  });

  it("returns undefined when a keyword has no '=' value", () => {
    expect(parseLegacyConnectionString("host pg.example.com")).toBeUndefined();
  });

  it("returns undefined for a non-numeric port", () => {
    expect(parseLegacyConnectionString("host=h port=abc")).toBeUndefined();
  });
});

describe("empty-password precedence (pgconn parity)", () => {
  // pgconn merges the connection-string password over PGPASSWORD, so an explicit
  // *empty* password (`user:@host`, `?password=`, `password=`) suppresses
  // PGPASSWORD and then falls through to `.pgpass` (config.go:264-379). Point
  // PGPASSFILE at a temp file we control and set PGPASSWORD to prove which one wins.
  let tmp: string;
  let pgpassPath: string;
  let pgpassRuntime: Partial<LegacyDbConfigParseRuntime>;
  let pgpassEnv: LegacyParseEnv;

  beforeEach(() =>
    runFixture(
      Effect.gen(function* () {
        tmp = yield* createFixture("pgpass-", [
          {
            path: ".pgpass",
            content: "db.example.com:6543:appdb:alice:pgpass-secret\n",
          },
        ]);
        pgpassPath = join(tmp, ".pgpass");
        pgpassRuntime = {
          files: new Map([[pgpassPath, "db.example.com:6543:appdb:alice:pgpass-secret\n"]]),
        };
        pgpassEnv = (name) =>
          name === "PGPASSWORD" ? "env-secret" : name === "PGPASSFILE" ? pgpassPath : undefined;
      }),
    ),
  );

  afterEach(() => runFixture(removeFixture(tmp)));

  it("uses PGPASSWORD when the URL has no password component at all (user@host)", () => {
    expect(
      parseLegacyConnectionString(
        "postgres://alice@db.example.com:6543/appdb",
        pgpassEnv,
        pgpassRuntime,
      )?.password,
    ).toBe("env-secret");
  });

  it("an explicit empty URL userinfo password (user:@host) suppresses PGPASSWORD → .pgpass", () => {
    expect(
      parseLegacyConnectionString(
        "postgres://alice:@db.example.com:6543/appdb",
        pgpassEnv,
        pgpassRuntime,
      )?.password,
    ).toBe("pgpass-secret");
  });

  it("an explicit empty ?password= suppresses PGPASSWORD → .pgpass", () => {
    expect(
      parseLegacyConnectionString(
        "postgres://alice@db.example.com:6543/appdb?password=",
        pgpassEnv,
        pgpassRuntime,
      )?.password,
    ).toBe("pgpass-secret");
  });

  it("an explicit empty DSN password= suppresses PGPASSWORD → .pgpass", () => {
    expect(
      parseLegacyConnectionString(
        "host=db.example.com port=6543 dbname=appdb user=alice password=",
        pgpassEnv,
        pgpassRuntime,
      )?.password,
    ).toBe("pgpass-secret");
  });

  it("falls through to an empty password when neither PGPASSWORD nor .pgpass match", () => {
    const env: LegacyParseEnv = (name) => (name === "PGPASSFILE" ? pgpassPath : undefined);
    // No matching .pgpass line for this host → empty.
    expect(
      parseLegacyConnectionString(
        "postgres://alice:@other.example.com:6543/appdb",
        env,
        pgpassRuntime,
      )?.password,
    ).toBe("");
  });
});

describe("multi-host failover (pgconn parity)", () => {
  it("parses a comma-separated multi-host URL into primary + fallbacks", () => {
    expect(parseLegacyConnectionString("postgres://u:pw@h1:5432,h2:5433/db")).toEqual({
      host: "h1",
      port: 5432,
      user: "u",
      password: "pw",
      database: "db",
      fallbacks: [{ host: "h2", port: 5433 }],
    });
  });

  it("defaults every host to the first port when no host carries one", () => {
    expect(parseLegacyConnectionString("postgres://u:pw@h1,h2,h3/db")).toMatchObject({
      host: "h1",
      port: 5432,
      fallbacks: [
        { host: "h2", port: 5432 },
        { host: "h3", port: 5432 },
      ],
    });
  });

  it("zips hosts to the (compacted) port list exactly as pgconn does", () => {
    // pgconn drops empty ports before zipping (config.go:462-488), so a host that
    // omits a port does NOT inherit the previous host's port — it takes the next
    // entry in the compacted port list, and only a host past the end reuses ports[0].
    // For `h1:5432,h2,h3:5544` the port list is [5432, 5544]: h1→5432, h2→5544,
    // h3 (index 2, past the end)→ports[0]=5432. This is pgconn's quirk, matched 1:1.
    expect(parseLegacyConnectionString("postgres://u:pw@h1:5432,h2,h3:5544/db")).toMatchObject({
      host: "h1",
      port: 5432,
      fallbacks: [
        { host: "h2", port: 5544 },
        { host: "h3", port: 5432 },
      ],
    });
  });

  it("handles bracketed IPv6 literals in a multi-host URL", () => {
    expect(parseLegacyConnectionString("postgres://u:pw@[::1]:5432,[::2]:5433/db")).toMatchObject({
      host: "::1",
      port: 5432,
      fallbacks: [{ host: "::2", port: 5433 }],
    });
  });

  it("keeps the query string (sslmode) intact for a multi-host URL", () => {
    expect(
      parseLegacyConnectionString("postgres://u:pw@h1:5432,h2:5433/db?sslmode=require"),
    ).toMatchObject({ host: "h1", sslmode: "require", fallbacks: [{ host: "h2", port: 5433 }] });
  });

  it("rejects a multi-host URL with a non-numeric port (pgconn parsePort error)", () => {
    expect(parseLegacyConnectionString("postgres://u:pw@h1:5432,h2:bad/db")).toBeUndefined();
  });

  it("parses a comma-separated multi-host DSN into primary + fallbacks", () => {
    expect(parseLegacyConnectionString("host=h1,h2 port=5432,5433 user=u dbname=db")).toMatchObject(
      {
        host: "h1",
        port: 5432,
        fallbacks: [{ host: "h2", port: 5433 }],
      },
    );
  });

  it("omits fallbacks for the common single-host case", () => {
    expect(parseLegacyConnectionString("postgres://u:pw@h1:5432/db")).not.toHaveProperty(
      "fallbacks",
    );
  });
});

describe("passfile= DSN setting (pgconn parity)", () => {
  // pgconn honors a connection-string `passfile=` ahead of PGPASSFILE/the default
  // (`config.go:293,369-377`). Point PGPASSFILE at one file and `passfile=` at a
  // different one to prove the connection-string setting wins.
  let tmp: string;
  let customPath: string;
  let envPath: string;
  let passfileRuntime: Partial<LegacyDbConfigParseRuntime>;
  let passfileEnv: LegacyParseEnv;

  beforeEach(() =>
    runFixture(
      Effect.gen(function* () {
        tmp = yield* createFixture("passfile-", [
          {
            path: "env-pgpass",
            content: "db.example.com:6543:appdb:alice:env-file-secret\n",
          },
          {
            path: "custom-pgpass",
            content: "db.example.com:6543:appdb:alice:custom-file-secret\n",
          },
        ]);
        customPath = join(tmp, "custom-pgpass");
        envPath = join(tmp, "env-pgpass");
        passfileRuntime = {
          files: new Map([
            [envPath, "db.example.com:6543:appdb:alice:env-file-secret\n"],
            [customPath, "db.example.com:6543:appdb:alice:custom-file-secret\n"],
          ]),
        };
        passfileEnv = (name) => (name === "PGPASSFILE" ? envPath : undefined);
      }),
    ),
  );

  afterEach(() => runFixture(removeFixture(tmp)));

  it("resolves the password from a ?passfile= URL setting over PGPASSFILE", () => {
    expect(
      parseLegacyConnectionString(
        `postgres://alice@db.example.com:6543/appdb?passfile=${customPath}`,
        passfileEnv,
        passfileRuntime,
      )?.password,
    ).toBe("custom-file-secret");
  });

  it("resolves the password from a passfile= DSN keyword over PGPASSFILE", () => {
    expect(
      parseLegacyConnectionString(
        `host=db.example.com port=6543 dbname=appdb user=alice passfile=${customPath}`,
        passfileEnv,
        passfileRuntime,
      )?.password,
    ).toBe("custom-file-secret");
  });

  it("falls back to PGPASSFILE when no passfile= setting is present", () => {
    expect(
      parseLegacyConnectionString(
        "postgres://alice@db.example.com:6543/appdb",
        passfileEnv,
        passfileRuntime,
      )?.password,
    ).toBe("env-file-secret");
  });

  it("a present-but-empty passfile= suppresses PGPASSFILE (→ empty password)", () => {
    // pgconn: present-empty passfile overrides PGPASSFILE, then ReadPassfile("") fails
    // → no .pgpass lookup → empty password (not the env-file credential).
    expect(
      parseLegacyConnectionString(
        "postgres://alice@db.example.com:6543/appdb?passfile=",
        passfileEnv,
        passfileRuntime,
      )?.password,
    ).toBe("");
    expect(
      parseLegacyConnectionString(
        "host=db.example.com port=6543 dbname=appdb user=alice passfile=",
        passfileEnv,
        passfileRuntime,
      )?.password,
    ).toBe("");
  });
});

describe("injected env lookup (project dotenv parity)", () => {
  // The resolver layers the project `.env*` files under the shell env and passes a
  // lookup into the parser, mirroring Go's LoadConfig-before-ParseConfig order
  // (`internal/utils/flags/db_url.go:59-68`). A field omitted from the DSN is then
  // filled from the injected env, not just `process.env`.
  it("fills omitted URL fields from the injected env (PGPASSWORD/PGSSLMODE/PGHOST)", () => {
    const env = (name: string): string | undefined =>
      ({ PGPASSWORD: "dotenv-pw", PGSSLMODE: "require", PGHOST: "dotenv-host" })[name];
    expect(parseLegacyConnectionString("postgresql://alice@db.example.com/appdb", env)).toEqual({
      host: "db.example.com",
      port: 5432,
      user: "alice",
      password: "dotenv-pw",
      database: "appdb",
      sslmode: "require",
    });
  });

  it("lets explicit connection-string fields win over the injected env", () => {
    const env = (name: string): string | undefined =>
      ({ PGPASSWORD: "dotenv-pw", PGSSLMODE: "require" })[name];
    const parsed = parseLegacyConnectionString(
      "postgresql://alice:explicit-pw@db.example.com/appdb?sslmode=disable",
      env,
    );
    expect(parsed?.password).toBe("explicit-pw");
    expect(parsed?.sslmode).toBe("disable");
  });

  it("uses the injected env for the keyword/value DSN form too", () => {
    const env = (name: string): string | undefined =>
      ({ PGDATABASE: "dotenv-db", PGPORT: "6543" })[name];
    const parsed = parseLegacyConnectionString("host=db.example.com user=alice", env);
    expect(parsed?.database).toBe("dotenv-db");
    expect(parsed?.port).toBe(6543);
  });
});

describe("pgservice resolution (pgconn parity)", () => {
  // pgconn resolves a `service=`/`PGSERVICE` against the service file and merges
  // its settings between env and the explicit connection-string fields
  // (config.go:250-256). dbname is remapped to database. An unresolvable service
  // is a hard parse error.
  let tmp: string;
  let servicefile: string;
  let serviceRuntime: Partial<LegacyDbConfigParseRuntime>;

  beforeEach(() =>
    runFixture(
      Effect.gen(function* () {
        tmp = yield* createFixture("pgservice-parse-", [
          {
            path: "pg_service.conf",
            content:
              "[prod]\nhost=db.example.com\nport=6543\nuser=alice\npassword=svc-secret\ndbname=appdb\nsslmode=require\n",
          },
        ]);
        servicefile = join(tmp, "pg_service.conf");
        serviceRuntime = {
          serviceFiles: new Map([
            [
              servicefile,
              "[prod]\nhost=db.example.com\nport=6543\nuser=alice\npassword=svc-secret\ndbname=appdb\nsslmode=require\n",
            ],
          ]),
        };
      }),
    ),
  );

  afterEach(() => runFixture(removeFixture(tmp)));

  it("resolves host/port/user/password/database/sslmode from the named service", () => {
    expect(
      parseLegacyConnectionString(
        `postgresql:///?service=prod&servicefile=${servicefile}`,
        emptyEnv,
        serviceRuntime,
      ),
    ).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "alice",
      password: "svc-secret",
      database: "appdb",
      sslmode: "require",
    });
  });

  it("resolves a service from the keyword/value DSN form too", () => {
    expect(
      parseLegacyConnectionString(
        `service=prod servicefile=${servicefile}`,
        emptyEnv,
        serviceRuntime,
      ),
    ).toEqual({
      host: "db.example.com",
      port: 6543,
      user: "alice",
      password: "svc-secret",
      database: "appdb",
      sslmode: "require",
    });
  });

  it("lets explicit connection-string fields override the service settings", () => {
    expect(
      parseLegacyConnectionString(
        `postgresql://bob:pw@real.example.com:5555/realdb?service=prod&servicefile=${servicefile}`,
        emptyEnv,
        serviceRuntime,
      ),
    ).toEqual({
      host: "real.example.com",
      port: 5555,
      user: "bob",
      password: "pw",
      database: "realdb",
      sslmode: "require",
    });
  });

  it("resolves the service from the injected env (PGSERVICE/PGSERVICEFILE)", () => {
    const env = (name: string): string | undefined =>
      ({ PGSERVICE: "prod", PGSERVICEFILE: servicefile })[name];
    expect(parseLegacyConnectionString("postgresql:///", env, serviceRuntime)?.host).toBe(
      "db.example.com",
    );
  });

  it("fails to parse (undefined) when the service is unknown", () => {
    expect(
      parseLegacyConnectionString(
        `postgresql:///?service=missing&servicefile=${servicefile}`,
        emptyEnv,
        serviceRuntime,
      ),
    ).toBeUndefined();
  });

  it("fails to parse (undefined) when the service file does not exist", () => {
    expect(
      parseLegacyConnectionString(
        `postgresql:///?service=prod&servicefile=${join(tmp, "nope")}`,
        emptyEnv,
        serviceRuntime,
      ),
    ).toBeUndefined();
  });
});

describe("keyword/value DSN backslash handling (pgconn parity)", () => {
  it("preserves backslashes before ordinary chars (Windows cert paths)", () => {
    // pgconn unescapes only \\ and \', so a Windows path keeps its backslashes.
    expect(
      parseLegacyConnectionString("host=h dbname=d user=u sslrootcert=C:\\certs\\root.pem")
        ?.sslrootcert,
    ).toBe("C:\\certs\\root.pem");
  });

  it("unescapes \\\\ and \\' inside a single-quoted value", () => {
    // password 'a\\b' → a\b ; password 'it\'s' → it's
    expect(parseLegacyConnectionString("host=h dbname=d user=u password='a\\\\b'")?.password).toBe(
      "a\\b",
    );
    expect(parseLegacyConnectionString("host=h dbname=d user=u password='it\\'s'")?.password).toBe(
      "it's",
    );
  });

  it("preserves a backslash before an ordinary char inside quotes", () => {
    expect(
      parseLegacyConnectionString("host=h dbname=d user=u sslrootcert='C:\\certs\\root.pem'")
        ?.sslrootcert,
    ).toBe("C:\\certs\\root.pem");
  });

  it("rejects an unquoted value ending in a lone backslash (pgconn 'invalid backslash')", () => {
    expect(parseLegacyConnectionString("host=h user=u password=secret\\")).toBeUndefined();
    // A complete trailing `\\` escape pair is still accepted (→ single backslash).
    expect(
      parseLegacyConnectionString("host=h user=u dbname=d sslrootcert=C:\\\\")?.sslrootcert,
    ).toBe("C:\\");
  });
});

describe("connect_timeout (pgconn parity)", () => {
  it("parses connect_timeout from a URL query into connectTimeoutSeconds", () => {
    expect(parseLegacyConnectionString("postgres://u:p@h/db?connect_timeout=15")).toMatchObject({
      connectTimeoutSeconds: 15,
    });
  });

  it("parses connect_timeout from a keyword/value DSN", () => {
    expect(parseLegacyConnectionString("host=h dbname=d user=u connect_timeout=7")).toMatchObject({
      connectTimeoutSeconds: 7,
    });
  });

  it("falls back to PGCONNECT_TIMEOUT from the injected env", () => {
    const env = (name: string): string | undefined =>
      name === "PGCONNECT_TIMEOUT" ? "20" : undefined;
    expect(parseLegacyConnectionString("postgres://u:p@h/db", env)).toMatchObject({
      connectTimeoutSeconds: 20,
    });
  });

  it("omits connectTimeoutSeconds when unset or zero (driver applies Go's default)", () => {
    expect(parseLegacyConnectionString("postgres://u:p@h/db")).not.toHaveProperty(
      "connectTimeoutSeconds",
    );
    expect(parseLegacyConnectionString("postgres://u:p@h/db?connect_timeout=0")).not.toHaveProperty(
      "connectTimeoutSeconds",
    );
  });

  it("rejects a non-numeric connect_timeout as a parse error", () => {
    expect(parseLegacyConnectionString("postgres://u:p@h/db?connect_timeout=abc")).toBeUndefined();
    expect(parseLegacyConnectionString("host=h user=u connect_timeout=abc")).toBeUndefined();
  });
});

describe("empty URL query overrides (pgconn parity)", () => {
  it("an empty ?dbname= overrides the path with an empty database", () => {
    expect(parseLegacyConnectionString("postgres://u:p@host/production?dbname=")).toMatchObject({
      database: "",
    });
  });

  it("an empty ?user= overrides the userinfo with an empty user", () => {
    expect(parseLegacyConnectionString("postgres://alice@host/db?user=")?.user).toBe("");
  });

  it("an absent dbname/user query still falls back to path/userinfo", () => {
    expect(parseLegacyConnectionString("postgres://alice@host/realdb")).toMatchObject({
      user: "alice",
      database: "realdb",
    });
  });
});

describe("pgconn parse refinements", () => {
  it("accepts a comma-separated ?port= list for a multi-host URL", () => {
    expect(parseLegacyConnectionString("postgres://h1,h2/db?port=5432,5433")).toMatchObject({
      host: "h1",
      port: 5432,
      database: "db",
      fallbacks: [{ host: "h2", port: 5433 }],
    });
  });

  it("rejects out-of-range ports (0, 65536, 70000) across query/structural/DSN/PGPORT", () => {
    expect(parseLegacyConnectionString("postgres://h/db?port=0")).toBeUndefined();
    expect(parseLegacyConnectionString("postgres://h:70000/db")).toBeUndefined();
    expect(parseLegacyConnectionString("host=h user=u port=65536")).toBeUndefined();
    const env = (name: string): string | undefined => (name === "PGPORT" ? "70000" : undefined);
    expect(parseLegacyConnectionString("host=pg.example.com user=u", env)).toBeUndefined();
  });

  it("treats an empty connection-string service= as explicit (parse error), not PGSERVICE", () => {
    const env = (name: string): string | undefined => (name === "PGSERVICE" ? "prod" : undefined);
    // Empty ?service= overrides PGSERVICE and fails resolution (pgconn GetService("")).
    expect(parseLegacyConnectionString("postgres://host/db?service=", env)).toBeUndefined();
    expect(parseLegacyConnectionString("host=h user=u service=", env)).toBeUndefined();
  });

  it("uses the OS account (not $USER/$USERNAME) when PGUSER is empty/absent", () => {
    // pgconn reads user.Current().Username for the default, never $USER/$USERNAME;
    // a divergent $USER must be ignored. Empty PGUSER falls through to the OS account.
    const env = (name: string): string | undefined =>
      ({ PGUSER: "", USER: "not-the-account", USERNAME: "not-the-account" })[name];
    expect(parseLegacyConnectionString("postgres://host/db", env)?.user).toBe(osUser);
    expect(parseLegacyConnectionString("postgres://host/db", env)?.user).not.toBe(
      "not-the-account",
    );
  });

  it("rejects an empty connection-string connect_timeout but ignores an empty env var", () => {
    // Present-but-empty ?connect_timeout= / connect_timeout= is a parse error.
    expect(parseLegacyConnectionString("postgres://u:p@h/db?connect_timeout=")).toBeUndefined();
    expect(parseLegacyConnectionString("host=h user=u connect_timeout=")).toBeUndefined();
    // An empty PGCONNECT_TIMEOUT env var is unset → no error, default applies.
    const env = (name: string): string | undefined =>
      name === "PGCONNECT_TIMEOUT" ? "" : undefined;
    expect(parseLegacyConnectionString("postgres://u:p@h/db", env)).not.toHaveProperty(
      "connectTimeoutSeconds",
    );
  });
});

describe("database= alias and empty service values (pgconn parity)", () => {
  let tmp: string;

  beforeEach(() =>
    runFixture(
      Effect.gen(function* () {
        tmp = yield* createFixture("svc-empty-", []);
      }),
    ),
  );
  afterEach(() => runFixture(removeFixture(tmp)));

  it("honors a `database=` query key as an alias for dbname", () => {
    expect(parseLegacyConnectionString("postgres://host/postgres?database=prod")).toMatchObject({
      database: "prod",
    });
  });

  it("honors a `database=` keyword in the DSN form", () => {
    expect(parseLegacyConnectionString("host=pg user=u database=prod")).toMatchObject({
      database: "prod",
    });
  });

  it("uses last-wins for dbname/database aliases in a DSN (pgconn remaps at parse time)", () => {
    expect(
      parseLegacyConnectionString("host=h user=u dbname=template1 database=appdb"),
    ).toMatchObject({ database: "appdb" });
    expect(
      parseLegacyConnectionString("host=h user=u database=appdb dbname=template1"),
    ).toMatchObject({ database: "template1" });
  });

  it.effect("an empty service password= suppresses PGPASSWORD (falls through to .pgpass)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sf = join(tmp, "svc.conf");
      const serviceContent = "[s]\nhost=h\nport=5432\nuser=u\ndbname=d\npassword=\n";
      yield* fs.writeFileString(sf, serviceContent);
      const env = (name: string): string | undefined =>
        name === "PGPASSWORD"
          ? "env-secret"
          : name === "PGPASSFILE"
            ? join(tmp, "no-pgpass")
            : undefined;
      // Empty service password overrides PGPASSWORD; no .pgpass match → "".
      expect(
        parseLegacyConnectionString(`postgres:///?service=s&servicefile=${sf}`, env, {
          serviceFiles: new Map([[sf, serviceContent]]),
        })?.password,
      ).toBe("");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("an empty service connect_timeout= is a parse error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sf = join(tmp, "svc.conf");
      const serviceContent = "[s]\nhost=h\nport=5432\nuser=u\nconnect_timeout=\n";
      yield* fs.writeFileString(sf, serviceContent);
      expect(
        parseLegacyConnectionString(`postgres:///?service=s&servicefile=${sf}`, emptyEnv, {
          serviceFiles: new Map([[sf, serviceContent]]),
        }),
      ).toBeUndefined();
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("still uses a non-empty service value normally", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sf = join(tmp, "svc.conf");
      const serviceContent = "[s]\nhost=svc.example.com\nport=6543\nuser=alice\ndbname=appdb\n";
      yield* fs.writeFileString(sf, serviceContent);
      expect(
        parseLegacyConnectionString(`postgres:///?service=s&servicefile=${sf}`, emptyEnv, {
          serviceFiles: new Map([[sf, serviceContent]]),
        }),
      ).toMatchObject({
        host: "svc.example.com",
        port: 6543,
        user: "alice",
        database: "appdb",
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

describe("more pgconn parse refinements", () => {
  it("honors a present-but-empty ?host= as a literal empty host (overrides structural)", () => {
    expect(
      parseLegacyConnectionString("postgres://remote.example.com/postgres?host="),
    ).toMatchObject({ host: "", database: "postgres" });
  });

  it("accepts a port-only URL, falling the host back to PGHOST/default", () => {
    const env = (name: string): string | undefined => (name === "PGHOST" ? "envhost" : undefined);
    expect(parseLegacyConnectionString("postgres://:5433/postgres", env)).toMatchObject({
      host: "envhost",
      port: 5433,
      database: "postgres",
    });
  });

  it("does not dial hostaddr as the host (pgconn ignores hostaddr)", () => {
    const env = (name: string): string | undefined => (name === "PGHOST" ? "envhost" : undefined);
    const parsed = parseLegacyConnectionString("hostaddr=10.0.0.5 user=u", env);
    expect(parsed?.host).toBe("envhost");
    expect(parsed?.host).not.toBe("10.0.0.5");
  });

  it("rejects a DSN with an empty key", () => {
    expect(parseLegacyConnectionString("=ignored host=prod.example.com")).toBeUndefined();
    expect(parseLegacyConnectionString("  =value host=h")).toBeUndefined();
  });

  it("treats a present-but-empty servicefile= as a parse error (overrides PGSERVICEFILE)", () => {
    const env = (name: string): string | undefined =>
      name === "PGSERVICEFILE" ? "/some/pg_service.conf" : undefined;
    expect(parseLegacyConnectionString("service=prod servicefile= host=h", env)).toBeUndefined();
    expect(
      parseLegacyConnectionString("postgres://host/db?service=prod&servicefile=", env),
    ).toBeUndefined();
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

  it("does not leak a literal @ inside a malformed URL password (CWE-209)", () => {
    const redacted = redactLegacyConnectionString("postgres://user:p@ssword@host/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("ssword");
  });

  it("does not leak a literal / inside a malformed URL password", () => {
    const redacted = redactLegacyConnectionString("postgres://alice:p/a@bad/db");
    expect(redacted).not.toContain("p/a");
  });

  it("redacts the full password across multiple literal @ and / chars", () => {
    const redacted = redactLegacyConnectionString("postgres://u:p@ss/word@host:5432/db");
    expect(redacted).not.toContain("p@ss/word");
    expect(redacted).not.toContain("ss/word");
  });

  it("fully redacts an unterminated quoted keyword/value password", () => {
    const redacted = redactLegacyConnectionString("password='secret with spaces host=bad");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("spaces");
    expect(redacted).not.toContain("bad");
  });
});

describe("legacyPoolerConfigFromConnectionString", () => {
  it("strips the placeholder password, validates the tenant, preserves options, and rewrites to port 5432", () => {
    expect(
      legacyPoolerConfigFromConnectionString(
        "abcdefghijklmnopqrst",
        "postgres://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?options=reference%3Dabcdefghijklmnopqrst",
        "supabase.com",
      ),
    ).toEqual({
      _tag: "ok",
      conn: {
        host: "aws-0-us-east-1.pooler.supabase.com",
        port: 5432,
        user: "postgres.abcdefghijklmnopqrst",
        password: "",
        database: "postgres",
        options: "reference=abcdefghijklmnopqrst",
      },
    });
  });

  it("rejects a username tenant mismatch", () => {
    expect(
      legacyPoolerConfigFromConnectionString(
        "abcdefghijklmnopqrst",
        "postgres://postgres.wrongrefabcdefghijkl@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
        "supabase.com",
      ),
    ).toEqual({
      _tag: "invalid",
      reason: "Pooler username does not match project ref: abcdefghijklmnopqrst",
    });
  });

  it("rejects an options reference mismatch when the username has no tenant suffix", () => {
    expect(
      legacyPoolerConfigFromConnectionString(
        "abcdefghijklmnopqrst",
        "postgres://postgres@aws-0-us-east-1.pooler.supabase.com:6543/postgres?options=reference%3Dwrongrefabcdefghijkl",
        "supabase.com",
      ),
    ).toEqual({
      _tag: "invalid",
      reason: "Pooler options does not match project ref: abcdefghijklmnopqrst",
    });
  });

  it("rejects a pooler host outside the expected profile domain", () => {
    expect(
      legacyPoolerConfigFromConnectionString(
        "abcdefghijklmnopqrst",
        "postgres://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.example.com:6543/postgres",
        "supabase.com",
      ),
    ).toEqual({
      _tag: "invalid",
      reason: "Pooler domain does not belong to current profile: example.com",
    });
  });

  it("skips the profile-domain guard when the expected pooler host is empty", () => {
    expect(
      legacyPoolerConfigFromConnectionString(
        "abcdefghijklmnopqrst",
        "postgres://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.example.com:6543/postgres",
        "",
      ),
    ).toMatchObject({
      _tag: "ok",
      conn: {
        host: "aws-0-us-east-1.pooler.example.com",
        port: 5432,
      },
    });
  });
});
