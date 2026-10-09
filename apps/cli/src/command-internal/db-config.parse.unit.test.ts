import { userInfo } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it, layer } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import { withConfigEnv } from "../../tests/helpers/command-mocks.ts";
import {
  layeredParseEnv,
  poolerConfigFromConnectionString,
  parseConnectionString,
  redactConnectionString,
} from "./db-config.parse.ts";

// The parser's own default-user resolution: PGUSER, else the OS account, else "postgres".
const osAccount = (() => {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
})();
const osUser = osAccount ?? "postgres";

const parseTestLayer = Layer.merge(
  BunServices.layer,
  ConfigProvider.layer(ConfigProvider.fromEnvRecord({}, { preserveEmptyStrings: true })),
);

layer(parseTestLayer)("parseConnectionString (URL form)", (it) => {
  it.effect("parses host/port/user/password/database and percent-decodes userinfo", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://alice:p%40ss@example.com:6543/appdb"),
      ).toEqual({
        host: "example.com",
        port: 6543,
        user: "alice",
        password: "p@ss",
        database: "appdb",
      });
    }),
  );

  it.effect("defaults the port to 5432 and the database to the user when both are absent", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://bob@example.com")).toEqual({
        host: "example.com",
        port: 5432,
        user: "bob",
        password: "",
        database: "bob",
      });
    }),
  );

  it.effect("defaults the user to the OS account when userinfo is omitted (libpq parity)", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgresql://localhost/mydb")).toEqual({
        host: "localhost",
        port: 5432,
        user: osUser,
        password: "",
        database: "mydb",
      });
    }),
  );

  it.effect("defaults user to the OS account and database to that user when both are omitted", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgresql://localhost")).toEqual({
        host: "localhost",
        port: 5432,
        user: osUser,
        password: "",
        database: osUser,
      });
    }),
  );

  it.effect("fills omitted URL fields from PG* env vars, with explicit fields winning", () =>
    withConfigEnv(
      { PGPASSWORD: "env-secret", PGPORT: "6543", PGDATABASE: "envdb" },
      Effect.gen(function* () {
        expect(yield* parseConnectionString("postgresql://alice@db.example.com")).toEqual({
          host: "db.example.com",
          port: 6543,
          user: "alice",
          password: "env-secret",
          database: "envdb",
        });
        expect(
          yield* parseConnectionString("postgresql://alice:pw@db.example.com:5555/appdb"),
        ).toEqual({
          host: "db.example.com",
          port: 5555,
          user: "alice",
          password: "pw",
          database: "appdb",
        });
      }),
    ),
  );

  it.effect("honors libpq query params (host/dbname) over the structural URL", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgresql:///postgres?host=/var/run/postgresql"),
      ).toEqual({
        host: "/var/run/postgresql",
        port: 5432,
        user: osUser,
        password: "",
        database: "postgres",
      });
      expect(
        yield* parseConnectionString(
          "postgresql://postgres:pw@db.example.com:6543/ignored?dbname=real",
        ),
      ).toEqual({
        host: "db.example.com",
        port: 6543,
        user: "postgres",
        password: "pw",
        database: "real",
      });
    }),
  );

  it.effect("strips the brackets from an IPv6 literal host", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgresql://postgres:pw@[::1]:5432/postgres")).toEqual({
        host: "::1",
        port: 5432,
        user: "postgres",
        password: "pw",
        database: "postgres",
      });
    }),
  );

  it.effect("preserves sslmode and the libpq options runtime param from the query string", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString(
        "postgres://u:pw@h:5432/db?sslmode=verify-full&options=reference%3Dabc",
      );
      expect(parsed?.sslmode).toBe("verify-full");
      expect(parsed?.options).toBe("reference=abc");
    }),
  );

  it.effect("omits sslmode/options keys when the query string does not set them", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString("postgres://u:pw@h/db");
      expect(parsed).not.toHaveProperty("sslmode");
      expect(parsed).not.toHaveProperty("options");
    }),
  );

  it.effect("collects non-structural query settings as runtimeParams", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString(
        "postgres://u:pw@h/db?search_path=tenant&statement_timeout=5000&sslmode=require&options=reference%3Dabc",
      );
      expect(parsed?.runtimeParams).toEqual({ search_path: "tenant", statement_timeout: "5000" });
      expect(parsed?.options).toBe("reference=abc");
      expect(parsed).not.toHaveProperty("runtimeParams.options");
    }),
  );

  it.effect("omits runtimeParams when only structural/ssl keys are present", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString("postgres://u:pw@h/db?sslmode=require");
      expect(parsed).not.toHaveProperty("runtimeParams");
    }),
  );

  it.effect("merges PGAPPNAME into runtimeParams as application_name (env merge)", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        name === "PGAPPNAME" ? "myapp" : undefined;
      const parsed = yield* parseConnectionString("postgres://u:pw@h/db", env);
      expect(parsed?.runtimeParams).toEqual({ application_name: "myapp" });
    }),
  );

  it.effect("lets a connection-string application_name override PGAPPNAME (precedence)", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        name === "PGAPPNAME" ? "from-env" : undefined;
      const parsed = yield* parseConnectionString(
        "postgres://u:pw@h/db?application_name=from-url",
        env,
      );
      expect(parsed?.runtimeParams?.application_name).toBe("from-url");
    }),
  );

  it.effect("merges a pg_service.conf runtime setting (search_path) into runtimeParams", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pgservice-" });
      const file = path.join(dir, "pg_service.conf");
      yield* fs.writeFileString(
        file,
        "[tenant]\nhost=svc.example.com\nsearch_path=tenant_schema\n",
      );
      const parsed = yield* parseConnectionString(
        `postgres:///db?service=tenant&servicefile=${file}`,
        () => undefined,
      );
      expect(parsed?.host).toBe("svc.example.com");
      expect(parsed?.runtimeParams?.search_path).toBe("tenant_schema");
    }).pipe(Effect.scoped),
  );

  it.effect("carries client sslcert/sslkey (and sslpassword) from a --db-url", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString(
        "postgres://u:pw@h/db?sslmode=verify-full&sslcert=/c/client.crt&sslkey=/c/client.key&sslpassword=secret",
      );
      expect(parsed?.sslcert).toBe("/c/client.crt");
      expect(parsed?.sslkey).toBe("/c/client.key");
      expect(parsed?.sslpassword).toBe("secret");
      expect(parsed).not.toHaveProperty("runtimeParams");
    }),
  );

  it.effect("resolves client certs from PGSSLCERT/PGSSLKEY env (precedence)", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        name === "PGSSLCERT" ? "/e/c.crt" : name === "PGSSLKEY" ? "/e/c.key" : undefined;
      const parsed = yield* parseConnectionString("postgres://u:pw@h/db", env);
      expect(parsed?.sslcert).toBe("/e/c.crt");
      expect(parsed?.sslkey).toBe("/e/c.key");
    }),
  );

  it.effect("rejects a client cert with sslcert but no sslkey (both or neither)", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://u:pw@h/db?sslcert=/c/client.crt"),
      ).toBeUndefined();
      expect(yield* parseConnectionString("host=h user=u sslkey=/c/client.key")).toBeUndefined();
    }),
  );

  it.effect("returns undefined for an unparseable URL", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://user:pw@ bad host/db")).toBeUndefined();
    }),
  );

  it.effect("returns undefined for a malformed percent escape (no thrown defect)", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://user:p%zz@example.com/db")).toBeUndefined();
    }),
  );

  it.effect("rejects a non-numeric or empty ?port= query override (invalid port)", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgresql://host/db?port=abc")).toBeUndefined();
      expect(yield* parseConnectionString("postgresql://db.example.com/app?port=")).toBeUndefined();
    }),
  );

  it.effect("rejects an invalid PGPORT fallback instead of defaulting to 5432", () =>
    withConfigEnv(
      { PGPORT: "abc" },
      Effect.gen(function* () {
        expect(yield* parseConnectionString("postgresql://host/db")).toBeUndefined();
        expect(yield* parseConnectionString("host=pg.example.com user=admin")).toBeUndefined();
      }),
    ),
  );

  it.effect("rejects an invalid sslmode value ('sslmode is invalid')", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://h/db?sslmode=verifyfull")).toBeUndefined();
      expect(yield* parseConnectionString("host=h sslmode=bogus")).toBeUndefined();
    }),
  );

  it.effect("carries sslrootcert from the query or DSN (PGSSLROOTCERT-style CA pinning)", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://h/db?sslmode=require&sslrootcert=/ca.pem"),
      ).toMatchObject({ sslmode: "require", sslrootcert: "/ca.pem" });
      expect(
        yield* parseConnectionString("host=h sslmode=verify-ca sslrootcert=/ca.pem"),
      ).toMatchObject({
        sslrootcert: "/ca.pem",
      });
    }),
  );

  it.effect("fills sslmode from PGSSLMODE when the URL omits it (env default)", () =>
    withConfigEnv(
      { PGSSLMODE: "verify-full" },
      Effect.gen(function* () {
        expect((yield* parseConnectionString("postgres://u:pw@h:5432/db"))?.sslmode).toBe(
          "verify-full",
        );
        expect(
          (yield* parseConnectionString("postgres://u:pw@h:5432/db?sslmode=disable"))?.sslmode,
        ).toBe("disable");
      }),
    ),
  );

  it.effect("rejects a non-Postgres URL scheme instead of connecting to a bogus host", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("https://db.example.com/app")).toBeUndefined();
      expect(yield* parseConnectionString("mysql://user:pw@host:3306/app")).toBeUndefined();
    }),
  );
});

layer(parseTestLayer)("parseConnectionString (libpq keyword/value DSN)", (it) => {
  it.effect("parses a space-separated keyword/value DSN", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("host=pg.example.com port=6543 user=admin dbname=app"),
      ).toEqual({
        host: "pg.example.com",
        port: 6543,
        user: "admin",
        database: "app",
        password: "",
      });
    }),
  );

  it.effect("supports a unix-socket host path and carries sslmode/options through", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString(
        "host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable options=reference=abc",
      );
      expect(parsed?.host).toBe("/var/run/postgresql");
      expect(parsed?.sslmode).toBe("disable");
      expect(parsed?.options).toBe("reference=abc");
    }),
  );

  it.effect("honors single-quoted values with embedded spaces and backslash escapes", () =>
    Effect.gen(function* () {
      const parsed = yield* parseConnectionString(
        "host=h dbname=db user=postgres password='se cr\\'et'",
      );
      expect(parsed?.password).toBe("se cr'et");
    }),
  );

  it.effect("defaults user to the OS account, database to the user, and port to 5432", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("host=pg.example.com")).toEqual({
        host: "pg.example.com",
        port: 5432,
        user: osUser,
        database: osUser,
        password: "",
      });
    }),
  );

  it.effect("prefers PGUSER over the OS account for the default user (env precedence)", () =>
    withConfigEnv(
      { PGUSER: "pg_role" },
      Effect.gen(function* () {
        expect(yield* parseConnectionString("host=pg.example.com")).toEqual({
          host: "pg.example.com",
          port: 5432,
          user: "pg_role",
          database: "pg_role",
          password: "",
        });
        expect((yield* parseConnectionString("host=h user=explicit"))?.user).toBe("explicit");
        expect((yield* parseConnectionString("postgresql://localhost/mydb"))?.user).toBe("pg_role");
      }),
    ),
  );

  it.effect("fills omitted DSN fields from PG* env vars (env defaults)", () =>
    withConfigEnv(
      { PGHOST: "pg.env.com", PGPORT: "6543", PGPASSWORD: "env-secret", PGDATABASE: "envdb" },
      Effect.gen(function* () {
        expect(yield* parseConnectionString("user=admin")).toEqual({
          host: "pg.env.com",
          port: 6543,
          user: "admin",
          password: "env-secret",
          database: "envdb",
        });
        expect(
          yield* parseConnectionString("host=h port=1234 user=admin dbname=db password=pw"),
        ).toEqual({
          host: "h",
          port: 1234,
          user: "admin",
          password: "pw",
          database: "db",
        });
      }),
    ),
  );

  it.effect("falls back to a libpq default host when host and PGHOST are absent", () =>
    Effect.gen(function* () {
      expect((yield* parseConnectionString("user=admin"))?.host).toMatch(/^(\/|localhost)/);
    }),
  );

  it.effect("returns undefined when a keyword has no '=' value", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("host pg.example.com")).toBeUndefined();
    }),
  );

  it.effect("returns undefined for a non-numeric port", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("host=h port=abc")).toBeUndefined();
    }),
  );
});

layer(parseTestLayer)("empty-password precedence", (it) => {
  // Points PGPASSFILE at a temp file we control and sets PGPASSWORD, to prove which one wins.
  const withPgpass = <A, E, R>(
    env: Readonly<Record<string, string>>,
    body: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pgpass-" });
      const pgpassPath = path.join(tmp, ".pgpass");
      // host db.example.com, port 6543, db appdb, user alice.
      yield* fs.writeFileString(pgpassPath, "db.example.com:6543:appdb:alice:pgpass-secret\n");
      return yield* withConfigEnv({ ...env, PGPASSFILE: pgpassPath }, body);
    }).pipe(Effect.scoped);

  it.effect("uses PGPASSWORD when the URL has no password component at all (user@host)", () =>
    withPgpass(
      { PGPASSWORD: "env-secret" },
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString("postgres://alice@db.example.com:6543/appdb"))?.password,
        ).toBe("env-secret");
      }),
    ),
  );

  it.effect(
    "an explicit empty URL userinfo password (user:@host) suppresses PGPASSWORD → .pgpass",
    () =>
      withPgpass(
        { PGPASSWORD: "env-secret" },
        Effect.gen(function* () {
          expect(
            (yield* parseConnectionString("postgres://alice:@db.example.com:6543/appdb"))?.password,
          ).toBe("pgpass-secret");
        }),
      ),
  );

  it.effect("an explicit empty ?password= suppresses PGPASSWORD → .pgpass", () =>
    withPgpass(
      { PGPASSWORD: "env-secret" },
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString("postgres://alice@db.example.com:6543/appdb?password="))
            ?.password,
        ).toBe("pgpass-secret");
      }),
    ),
  );

  it.effect("an explicit empty DSN password= suppresses PGPASSWORD → .pgpass", () =>
    withPgpass(
      { PGPASSWORD: "env-secret" },
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString(
            "host=db.example.com port=6543 dbname=appdb user=alice password=",
          ))?.password,
        ).toBe("pgpass-secret");
      }),
    ),
  );

  it.effect("falls through to an empty password when neither PGPASSWORD nor .pgpass match", () =>
    withPgpass(
      {},
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString("postgres://alice:@other.example.com:6543/appdb"))
            ?.password,
        ).toBe("");
      }),
    ),
  );
});

layer(parseTestLayer)("multi-host failover", (it) => {
  it.effect("parses a comma-separated multi-host URL into primary + fallbacks", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:pw@h1:5432,h2:5433/db")).toEqual({
        host: "h1",
        port: 5432,
        user: "u",
        password: "pw",
        database: "db",
        fallbacks: [{ host: "h2", port: 5433 }],
      });
    }),
  );

  it.effect("defaults every host to the first port when no host carries one", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:pw@h1,h2,h3/db")).toMatchObject({
        host: "h1",
        port: 5432,
        fallbacks: [
          { host: "h2", port: 5432 },
          { host: "h3", port: 5432 },
        ],
      });
    }),
  );

  it.effect("zips hosts to the (compacted) port list positionally", () =>
    Effect.gen(function* () {
      // Empty ports are dropped before zipping, so a host that omits a port takes the next entry
      // in the compacted port list rather than inheriting the previous host's port; only a host
      // past the end reuses `ports[0]`. For `h1:5432,h2,h3:5544` the port list is `[5432, 5544]`:
      // h1→5432, h2→5544, h3 (past the end)→ports[0]=5432.
      expect(yield* parseConnectionString("postgres://u:pw@h1:5432,h2,h3:5544/db")).toMatchObject({
        host: "h1",
        port: 5432,
        fallbacks: [
          { host: "h2", port: 5544 },
          { host: "h3", port: 5432 },
        ],
      });
    }),
  );

  it.effect("handles bracketed IPv6 literals in a multi-host URL", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://u:pw@[::1]:5432,[::2]:5433/db"),
      ).toMatchObject({
        host: "::1",
        port: 5432,
        fallbacks: [{ host: "::2", port: 5433 }],
      });
    }),
  );

  it.effect("keeps the query string (sslmode) intact for a multi-host URL", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://u:pw@h1:5432,h2:5433/db?sslmode=require"),
      ).toMatchObject({ host: "h1", sslmode: "require", fallbacks: [{ host: "h2", port: 5433 }] });
    }),
  );

  it.effect("rejects a multi-host URL with a non-numeric port (invalid port)", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:pw@h1:5432,h2:bad/db")).toBeUndefined();
    }),
  );

  it.effect("parses a comma-separated multi-host DSN into primary + fallbacks", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("host=h1,h2 port=5432,5433 user=u dbname=db"),
      ).toMatchObject({
        host: "h1",
        port: 5432,
        fallbacks: [{ host: "h2", port: 5433 }],
      });
    }),
  );

  it.effect("omits fallbacks for the common single-host case", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:pw@h1:5432/db")).not.toHaveProperty(
        "fallbacks",
      );
    }),
  );
});

layer(parseTestLayer)("passfile= DSN setting", (it) => {
  // Points PGPASSFILE at one file and `passfile=` at a different one, to prove the
  // connection-string setting wins.
  const withPassfiles = <A, E, R>(body: (customPath: string) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "passfile-" });
      const customPath = path.join(tmp, "custom-pgpass");
      const envPath = path.join(tmp, "env-pgpass");
      yield* fs.writeFileString(envPath, "db.example.com:6543:appdb:alice:env-file-secret\n");
      yield* fs.writeFileString(customPath, "db.example.com:6543:appdb:alice:custom-file-secret\n");
      return yield* withConfigEnv({ PGPASSFILE: envPath }, body(customPath));
    }).pipe(Effect.scoped);

  it.effect("resolves the password from a ?passfile= URL setting over PGPASSFILE", () =>
    withPassfiles((customPath) =>
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString(
            `postgres://alice@db.example.com:6543/appdb?passfile=${customPath}`,
          ))?.password,
        ).toBe("custom-file-secret");
      }),
    ),
  );

  it.effect("resolves the password from a passfile= DSN keyword over PGPASSFILE", () =>
    withPassfiles((customPath) =>
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString(
            `host=db.example.com port=6543 dbname=appdb user=alice passfile=${customPath}`,
          ))?.password,
        ).toBe("custom-file-secret");
      }),
    ),
  );

  it.effect("falls back to PGPASSFILE when no passfile= setting is present", () =>
    withPassfiles(() =>
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString("postgres://alice@db.example.com:6543/appdb"))?.password,
        ).toBe("env-file-secret");
      }),
    ),
  );

  it.effect("a present-but-empty passfile= suppresses PGPASSFILE (→ empty password)", () =>
    withPassfiles(() =>
      Effect.gen(function* () {
        expect(
          (yield* parseConnectionString("postgres://alice@db.example.com:6543/appdb?passfile="))
            ?.password,
        ).toBe("");
        expect(
          (yield* parseConnectionString(
            "host=db.example.com port=6543 dbname=appdb user=alice passfile=",
          ))?.password,
        ).toBe("");
      }),
    ),
  );
});

layer(parseTestLayer)("injected env lookup (project dotenv parity)", (it) => {
  // The resolver layers the project `.env*` files under the shell env and passes a lookup into
  // the parser. A field omitted from the DSN is then filled from the injected env, not just
  // `process.env`.
  it.effect("fills omitted URL fields from the injected env (PGPASSWORD/PGSSLMODE/PGHOST)", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        ({ PGPASSWORD: "dotenv-pw", PGSSLMODE: "require", PGHOST: "dotenv-host" })[name];
      expect(yield* parseConnectionString("postgresql://alice@db.example.com/appdb", env)).toEqual({
        host: "db.example.com",
        port: 5432,
        user: "alice",
        password: "dotenv-pw",
        database: "appdb",
        sslmode: "require",
      });
    }),
  );

  it.effect("lets explicit connection-string fields win over the injected env", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        ({ PGPASSWORD: "dotenv-pw", PGSSLMODE: "require" })[name];
      const parsed = yield* parseConnectionString(
        "postgresql://alice:explicit-pw@db.example.com/appdb?sslmode=disable",
        env,
      );
      expect(parsed?.password).toBe("explicit-pw");
      expect(parsed?.sslmode).toBe("disable");
    }),
  );

  it.effect("uses the injected env for the keyword/value DSN form too", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        ({ PGDATABASE: "dotenv-db", PGPORT: "6543" })[name];
      const parsed = yield* parseConnectionString("host=db.example.com user=alice", env);
      expect(parsed?.database).toBe("dotenv-db");
      expect(parsed?.port).toBe(6543);
    }),
  );

  it.effect("keeps a set-but-empty shell var ahead of the project .env (layeredParseEnv)", () =>
    withConfigEnv(
      { PGHOST: "" },
      Effect.gen(function* () {
        const env = yield* layeredParseEnv({ PGHOST: "project-host", PGPORT: "6543" });
        expect(env("PGHOST")).toBe("");
        expect(env("PGPORT")).toBe("6543");
      }),
    ),
  );
});

layer(parseTestLayer)("pgservice resolution", (it) => {
  // A `service=`/`PGSERVICE` resolves against the service file and merges its settings between
  // env and the explicit connection-string fields. `dbname` is remapped to `database`. An
  // unresolvable service is a hard parse error.
  const withServicefile = <A, E, R>(
    body: (files: {
      readonly servicefile: string;
      readonly missing: string;
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "pgservice-parse-" });
      const servicefile = path.join(tmp, "pg_service.conf");
      yield* fs.writeFileString(
        servicefile,
        "[prod]\nhost=db.example.com\nport=6543\nuser=alice\npassword=svc-secret\ndbname=appdb\nsslmode=require\n",
      );
      return yield* body({ servicefile, missing: path.join(tmp, "nope") });
    }).pipe(Effect.scoped);

  it.effect("resolves host/port/user/password/database/sslmode from the named service", () =>
    withServicefile(({ servicefile }) =>
      Effect.gen(function* () {
        expect(
          yield* parseConnectionString(`postgresql:///?service=prod&servicefile=${servicefile}`),
        ).toEqual({
          host: "db.example.com",
          port: 6543,
          user: "alice",
          password: "svc-secret",
          database: "appdb",
          sslmode: "require",
        });
      }),
    ),
  );

  it.effect("resolves a service from the keyword/value DSN form too", () =>
    withServicefile(({ servicefile }) =>
      Effect.gen(function* () {
        expect(yield* parseConnectionString(`service=prod servicefile=${servicefile}`)).toEqual({
          host: "db.example.com",
          port: 6543,
          user: "alice",
          password: "svc-secret",
          database: "appdb",
          sslmode: "require",
        });
      }),
    ),
  );

  it.effect("lets explicit connection-string fields override the service settings", () =>
    withServicefile(({ servicefile }) =>
      Effect.gen(function* () {
        expect(
          yield* parseConnectionString(
            `postgresql://bob:pw@real.example.com:5555/realdb?service=prod&servicefile=${servicefile}`,
          ),
        ).toEqual({
          host: "real.example.com",
          port: 5555,
          user: "bob",
          password: "pw",
          database: "realdb",
          sslmode: "require",
        });
      }),
    ),
  );

  it.effect("resolves the service from the injected env (PGSERVICE/PGSERVICEFILE)", () =>
    withServicefile(({ servicefile }) =>
      Effect.gen(function* () {
        const env = (name: string): string | undefined =>
          ({ PGSERVICE: "prod", PGSERVICEFILE: servicefile })[name];
        expect((yield* parseConnectionString("postgresql:///", env))?.host).toBe("db.example.com");
      }),
    ),
  );

  it.effect("fails to parse (undefined) when the service is unknown", () =>
    withServicefile(({ servicefile }) =>
      Effect.gen(function* () {
        expect(
          yield* parseConnectionString(`postgresql:///?service=missing&servicefile=${servicefile}`),
        ).toBeUndefined();
      }),
    ),
  );

  it.effect("fails to parse (undefined) when the service file does not exist", () =>
    withServicefile(({ missing }) =>
      Effect.gen(function* () {
        expect(
          yield* parseConnectionString(`postgresql:///?service=prod&servicefile=${missing}`),
        ).toBeUndefined();
      }),
    ),
  );
});

layer(parseTestLayer)("keyword/value DSN backslash handling", (it) => {
  it.effect("preserves backslashes before ordinary chars (Windows cert paths)", () =>
    Effect.gen(function* () {
      expect(
        (yield* parseConnectionString("host=h dbname=d user=u sslrootcert=C:\\certs\\root.pem"))
          ?.sslrootcert,
      ).toBe("C:\\certs\\root.pem");
    }),
  );

  it.effect("unescapes \\\\ and \\' inside a single-quoted value", () =>
    Effect.gen(function* () {
      // password 'a\\b' → a\b ; password 'it\'s' → it's
      expect(
        (yield* parseConnectionString("host=h dbname=d user=u password='a\\\\b'"))?.password,
      ).toBe("a\\b");
      expect(
        (yield* parseConnectionString("host=h dbname=d user=u password='it\\'s'"))?.password,
      ).toBe("it's");
    }),
  );

  it.effect("preserves a backslash before an ordinary char inside quotes", () =>
    Effect.gen(function* () {
      expect(
        (yield* parseConnectionString("host=h dbname=d user=u sslrootcert='C:\\certs\\root.pem'"))
          ?.sslrootcert,
      ).toBe("C:\\certs\\root.pem");
    }),
  );

  it.effect("rejects an unquoted value ending in a lone backslash ('invalid backslash')", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("host=h user=u password=secret\\")).toBeUndefined();
      // A complete trailing `\\` escape pair is still accepted (→ single backslash).
      expect(
        (yield* parseConnectionString("host=h user=u dbname=d sslrootcert=C:\\\\"))?.sslrootcert,
      ).toBe("C:\\");
    }),
  );
});

layer(parseTestLayer)("connect_timeout", (it) => {
  it.effect("parses connect_timeout from a URL query into connectTimeoutSeconds", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:p@h/db?connect_timeout=15")).toMatchObject({
        connectTimeoutSeconds: 15,
      });
    }),
  );

  it.effect("parses connect_timeout from a keyword/value DSN", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("host=h dbname=d user=u connect_timeout=7"),
      ).toMatchObject({
        connectTimeoutSeconds: 7,
      });
    }),
  );

  it.effect("falls back to PGCONNECT_TIMEOUT from the injected env", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        name === "PGCONNECT_TIMEOUT" ? "20" : undefined;
      expect(yield* parseConnectionString("postgres://u:p@h/db", env)).toMatchObject({
        connectTimeoutSeconds: 20,
      });
    }),
  );

  it.effect("omits connectTimeoutSeconds when unset or zero (driver applies its default)", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:p@h/db")).not.toHaveProperty(
        "connectTimeoutSeconds",
      );
      expect(
        yield* parseConnectionString("postgres://u:p@h/db?connect_timeout=0"),
      ).not.toHaveProperty("connectTimeoutSeconds");
    }),
  );

  it.effect("rejects a non-numeric connect_timeout as a parse error", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("postgres://u:p@h/db?connect_timeout=abc"),
      ).toBeUndefined();
      expect(yield* parseConnectionString("host=h user=u connect_timeout=abc")).toBeUndefined();
    }),
  );
});

layer(parseTestLayer)("empty URL query overrides", (it) => {
  it.effect("an empty ?dbname= overrides the path with an empty database", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:p@host/production?dbname=")).toMatchObject({
        database: "",
      });
    }),
  );

  it.effect("an empty ?user= overrides the userinfo with an empty user", () =>
    Effect.gen(function* () {
      expect((yield* parseConnectionString("postgres://alice@host/db?user="))?.user).toBe("");
    }),
  );

  it.effect("an absent dbname/user query still falls back to path/userinfo", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://alice@host/realdb")).toMatchObject({
        user: "alice",
        database: "realdb",
      });
    }),
  );
});

layer(parseTestLayer)("DSN parse refinements", (it) => {
  it.effect("accepts a comma-separated ?port= list for a multi-host URL", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://h1,h2/db?port=5432,5433")).toMatchObject({
        host: "h1",
        port: 5432,
        database: "db",
        fallbacks: [{ host: "h2", port: 5433 }],
      });
    }),
  );

  it.effect("rejects out-of-range ports (0, 65536, 70000) across query/structural/DSN/PGPORT", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://h/db?port=0")).toBeUndefined();
      expect(yield* parseConnectionString("postgres://h:70000/db")).toBeUndefined();
      expect(yield* parseConnectionString("host=h user=u port=65536")).toBeUndefined();
      const env = (name: string): string | undefined => (name === "PGPORT" ? "70000" : undefined);
      expect(yield* parseConnectionString("host=pg.example.com user=u", env)).toBeUndefined();
    }),
  );

  it.effect(
    "treats an empty connection-string service= as explicit (parse error), not PGSERVICE",
    () =>
      Effect.gen(function* () {
        const env = (name: string): string | undefined =>
          name === "PGSERVICE" ? "prod" : undefined;
        expect(yield* parseConnectionString("postgres://host/db?service=", env)).toBeUndefined();
        expect(yield* parseConnectionString("host=h user=u service=", env)).toBeUndefined();
      }),
  );

  it.effect("uses the OS account (not $USER/$USERNAME) when PGUSER is empty/absent", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined =>
        ({ PGUSER: "", USER: "not-the-account", USERNAME: "not-the-account" })[name];
      expect((yield* parseConnectionString("postgres://host/db", env))?.user).toBe(osUser);
      expect((yield* parseConnectionString("postgres://host/db", env))?.user).not.toBe(
        "not-the-account",
      );
    }),
  );

  it.effect("rejects an empty connection-string connect_timeout but ignores an empty env var", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://u:p@h/db?connect_timeout=")).toBeUndefined();
      expect(yield* parseConnectionString("host=h user=u connect_timeout=")).toBeUndefined();
      const env = (name: string): string | undefined =>
        name === "PGCONNECT_TIMEOUT" ? "" : undefined;
      expect(yield* parseConnectionString("postgres://u:p@h/db", env)).not.toHaveProperty(
        "connectTimeoutSeconds",
      );
    }),
  );
});

layer(parseTestLayer)("database= alias and empty service values", (it) => {
  const svcDir = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "svc-empty-" });
    return { fs, path, tmp };
  });

  it.effect("honors a `database=` query key as an alias for dbname", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("postgres://host/postgres?database=prod")).toMatchObject({
        database: "prod",
      });
    }),
  );

  it.effect("honors a `database=` keyword in the DSN form", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("host=pg user=u database=prod")).toMatchObject({
        database: "prod",
      });
    }),
  );

  it.effect("uses last-wins for dbname/database aliases in a DSN (remapped at parse time)", () =>
    Effect.gen(function* () {
      expect(
        yield* parseConnectionString("host=h user=u dbname=template1 database=appdb"),
      ).toMatchObject({
        database: "appdb",
      });
      expect(
        yield* parseConnectionString("host=h user=u database=appdb dbname=template1"),
      ).toMatchObject({
        database: "template1",
      });
    }),
  );

  it.effect("an empty service password= suppresses PGPASSWORD (falls through to .pgpass)", () =>
    Effect.gen(function* () {
      const { fs, path, tmp } = yield* svcDir;
      const sf = path.join(tmp, "svc.conf");
      yield* fs.writeFileString(sf, "[s]\nhost=h\nport=5432\nuser=u\ndbname=d\npassword=\n");
      const env = (name: string): string | undefined =>
        name === "PGPASSWORD"
          ? "env-secret"
          : name === "PGPASSFILE"
            ? path.join(tmp, "no-pgpass")
            : undefined;
      expect(
        (yield* parseConnectionString(`postgres:///?service=s&servicefile=${sf}`, env))?.password,
      ).toBe("");
    }).pipe(Effect.scoped),
  );

  it.effect("an empty service connect_timeout= is a parse error", () =>
    Effect.gen(function* () {
      const { fs, path, tmp } = yield* svcDir;
      const sf = path.join(tmp, "svc.conf");
      yield* fs.writeFileString(sf, "[s]\nhost=h\nport=5432\nuser=u\nconnect_timeout=\n");
      expect(
        yield* parseConnectionString(`postgres:///?service=s&servicefile=${sf}`),
      ).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("still uses a non-empty service value normally", () =>
    Effect.gen(function* () {
      const { fs, path, tmp } = yield* svcDir;
      const sf = path.join(tmp, "svc.conf");
      yield* fs.writeFileString(
        sf,
        "[s]\nhost=svc.example.com\nport=6543\nuser=alice\ndbname=appdb\n",
      );
      expect(
        yield* parseConnectionString(`postgres:///?service=s&servicefile=${sf}`),
      ).toMatchObject({
        host: "svc.example.com",
        port: 6543,
        user: "alice",
        database: "appdb",
      });
    }).pipe(Effect.scoped),
  );
});

layer(parseTestLayer)("more DSN parse refinements", (it) => {
  it.effect(
    "honors a present-but-empty ?host= as a literal empty host (overrides structural)",
    () =>
      Effect.gen(function* () {
        expect(
          yield* parseConnectionString("postgres://remote.example.com/postgres?host="),
        ).toMatchObject({
          host: "",
          database: "postgres",
        });
      }),
  );

  it.effect("accepts a port-only URL, falling the host back to PGHOST/default", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined => (name === "PGHOST" ? "envhost" : undefined);
      expect(yield* parseConnectionString("postgres://:5433/postgres", env)).toMatchObject({
        host: "envhost",
        port: 5433,
        database: "postgres",
      });
    }),
  );

  it.effect("does not dial hostaddr as the host (hostaddr is ignored)", () =>
    Effect.gen(function* () {
      const env = (name: string): string | undefined => (name === "PGHOST" ? "envhost" : undefined);
      const parsed = yield* parseConnectionString("hostaddr=10.0.0.5 user=u", env);
      expect(parsed?.host).toBe("envhost");
      expect(parsed?.host).not.toBe("10.0.0.5");
    }),
  );

  it.effect("rejects a DSN with an empty key", () =>
    Effect.gen(function* () {
      expect(yield* parseConnectionString("=ignored host=prod.example.com")).toBeUndefined();
      expect(yield* parseConnectionString("  =value host=h")).toBeUndefined();
    }),
  );

  it.effect(
    "treats a present-but-empty servicefile= as a parse error (overrides PGSERVICEFILE)",
    () =>
      Effect.gen(function* () {
        const env = (name: string): string | undefined =>
          name === "PGSERVICEFILE" ? "/some/pg_service.conf" : undefined;
        expect(
          yield* parseConnectionString("service=prod servicefile= host=h", env),
        ).toBeUndefined();
        expect(
          yield* parseConnectionString("postgres://host/db?service=prod&servicefile=", env),
        ).toBeUndefined();
      }),
  );
});

describe("redactConnectionString", () => {
  it("masks the password in a parseable URL", () => {
    const redacted = redactConnectionString("postgres://user:s3cret@example.com/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks the password in a malformed-but-credential-bearing URL", () => {
    const redacted = redactConnectionString("postgres://user:s3cret@ bad host/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks a bare keyword/value password", () => {
    const redacted = redactConnectionString("host=h user=admin password=s3cret port=5432");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("s3cret");
  });

  it("masks a single-quoted keyword/value password", () => {
    const redacted = redactConnectionString("host=h password='s3 cret' dbname=db");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("s3 cret");
  });

  it("does not leak a literal @ inside a malformed URL password (CWE-209)", () => {
    const redacted = redactConnectionString("postgres://user:p@ssword@host/db");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("ssword");
  });

  it("does not leak a literal / inside a malformed URL password", () => {
    const redacted = redactConnectionString("postgres://alice:p/a@bad/db");
    expect(redacted).not.toContain("p/a");
  });

  it("redacts the full password across multiple literal @ and / chars", () => {
    const redacted = redactConnectionString("postgres://u:p@ss/word@host:5432/db");
    expect(redacted).not.toContain("p@ss/word");
    expect(redacted).not.toContain("ss/word");
  });

  it("fully redacts an unterminated quoted keyword/value password", () => {
    const redacted = redactConnectionString("password='secret with spaces host=bad");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("spaces");
    expect(redacted).not.toContain("bad");
  });
});

layer(parseTestLayer)("poolerConfigFromConnectionString", (it) => {
  it.effect(
    "strips the placeholder password, validates the tenant, preserves options, and rewrites to port 5432",
    () =>
      Effect.gen(function* () {
        expect(
          yield* poolerConfigFromConnectionString(
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
      }),
  );

  it.effect("rejects a username tenant mismatch", () =>
    Effect.gen(function* () {
      expect(
        yield* poolerConfigFromConnectionString(
          "abcdefghijklmnopqrst",
          "postgres://postgres.wrongrefabcdefghijkl@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
          "supabase.com",
        ),
      ).toEqual({
        _tag: "invalid",
        reason: "Pooler username does not match project ref: abcdefghijklmnopqrst",
      });
    }),
  );

  it.effect("rejects an options reference mismatch when the username has no tenant suffix", () =>
    Effect.gen(function* () {
      expect(
        yield* poolerConfigFromConnectionString(
          "abcdefghijklmnopqrst",
          "postgres://postgres@aws-0-us-east-1.pooler.supabase.com:6543/postgres?options=reference%3Dwrongrefabcdefghijkl",
          "supabase.com",
        ),
      ).toEqual({
        _tag: "invalid",
        reason: "Pooler options does not match project ref: abcdefghijklmnopqrst",
      });
    }),
  );

  it.effect("rejects a pooler host outside the expected profile domain", () =>
    Effect.gen(function* () {
      expect(
        yield* poolerConfigFromConnectionString(
          "abcdefghijklmnopqrst",
          "postgres://postgres.abcdefghijklmnopqrst@aws-0-us-east-1.pooler.example.com:6543/postgres",
          "supabase.com",
        ),
      ).toEqual({
        _tag: "invalid",
        reason: "Pooler domain does not belong to current profile: example.com",
      });
    }),
  );

  it.effect("skips the profile-domain guard when the expected pooler host is empty", () =>
    Effect.gen(function* () {
      expect(
        yield* poolerConfigFromConnectionString(
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
    }),
  );
});
