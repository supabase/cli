import { EventEmitter } from "node:events";
import { Effect, Exit } from "effect";
import { SqlError, SqlSyntaxError, UnknownError } from "effect/unstable/sql/SqlError";
import type * as Pg from "pg";
import { describe, expect, it } from "vitest";

import { ErrorActionabilityId } from "../../shared/telemetry/error-actionability.ts";
import { LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import { LEGACY_SUGGEST_LOCAL_STACK } from "./legacy-connect-errors.ts";
import {
  legacyAcquireProbedPool,
  legacyBatchFailureError,
  legacyBuildConnectionUrl,
  legacyBuildPoolConfig,
  legacyBuildRawPgConfig,
  legacyInstallPoolErrorSwallow,
  LegacyPgBatchQuery,
  legacyShouldDiscardBatchClient,
  legacyPoolStepDownVerify,
  legacyIsTerminalConnectError,
  legacyIsUnixSocketHost,
  legacyMergedConnectionOptions,
  legacySslConfigsFor,
  legacySslOptionFor,
  legacyToExecError,
} from "./legacy-db-connection.sql-pg.layer.ts";

describe("legacyBuildConnectionUrl", () => {
  const base = {
    user: "postgres",
    password: "pw",
    port: 6543,
    database: "postgres",
    options: "reference=abc",
  };

  it("brackets an IPv6 literal host so new URL accepts it", () => {
    const url = legacyBuildConnectionUrl({ ...base, host: "::1" }, "::1");
    expect(url).toContain("@[::1]:6543/");
    expect(url).toContain("options=reference%3Dabc");
  });

  it("leaves a hostname or IPv4 host unbracketed", () => {
    expect(
      legacyBuildConnectionUrl({ ...base, host: "db.example.com" }, "db.example.com"),
    ).toContain("@db.example.com:6543/");
    expect(legacyBuildConnectionUrl({ ...base, host: "127.0.0.1" }, "203.0.113.10")).toContain(
      "@203.0.113.10:6543/",
    );
  });

  it("percent-encodes a unix-socket host (with options) instead of throwing", () => {
    // A raw socket path as the authority (`@/var/run/postgresql:5432`) makes
    // `new URL()` throw; pg-connection-string accepts the percent-encoded form and
    // a socket dial carries no port. The libpq `options` must still travel.
    const url = legacyBuildConnectionUrl(
      { ...base, host: "/var/run/postgresql", options: "-c search_path=public" },
      "/var/run/postgresql",
    );
    expect(url).toContain("@%2Fvar%2Frun%2Fpostgresql/");
    // No `:port` appended after the socket authority (a socket dial has none).
    expect(url).not.toContain("postgresql:5432");
    expect(url).toContain("options=-c+search_path%3Dpublic");
    // The decoded host (what pg-connection-string's /^%2f/i branch yields) is the path.
    expect(decodeURIComponent(new URL(url).hostname)).toBe("/var/run/postgresql");
  });

  it("uses the per-host port override (for an HA fallback host) over cfg.port", () => {
    // A multi-host config dials each fallback on its own port; the URL builder is
    // told that port explicitly rather than reusing the primary cfg.port.
    expect(legacyBuildConnectionUrl({ ...base, host: "h1" }, "h2.example.com", 5433)).toContain(
      "@h2.example.com:5433/",
    );
  });

  it("forwards runtimeParams as -c flags in the options startup param (Go RuntimeParams)", () => {
    const url = legacyBuildConnectionUrl(
      {
        user: "postgres",
        password: "pw",
        port: 5432,
        database: "postgres",
        host: "db.example.com",
        runtimeParams: { search_path: "tenant", statement_timeout: "5000" },
      },
      "db.example.com",
    );
    const options = new URL(url).searchParams.get("options");
    expect(options).toBe("-c search_path=tenant -c statement_timeout=5000");
  });
});

describe("legacyMergedConnectionOptions", () => {
  const base = { user: "postgres", password: "pw", port: 5432, database: "postgres", host: "h" };

  it("returns undefined when neither options nor runtimeParams are set", () => {
    expect(legacyMergedConnectionOptions(base)).toBeUndefined();
  });

  it("returns the libpq options verbatim when there are no runtimeParams", () => {
    expect(legacyMergedConnectionOptions({ ...base, options: "reference=abc" })).toBe(
      "reference=abc",
    );
  });

  it("appends -c flags for each runtimeParam, preserving the existing options", () => {
    expect(
      legacyMergedConnectionOptions({
        ...base,
        options: "reference=abc",
        runtimeParams: { search_path: "tenant" },
      }),
    ).toBe("reference=abc -c search_path=tenant");
  });

  it("backslash-escapes spaces in a runtimeParam value (libpq options syntax)", () => {
    expect(
      legacyMergedConnectionOptions({
        ...base,
        runtimeParams: { application_name: "my app" },
      }),
    ).toBe("-c application_name=my\\ app");
  });
});

describe("legacySslOptionFor", () => {
  it("returns ssl=false for local connections regardless of sslmode or PGSSLMODE", () => {
    expect(legacySslOptionFor(undefined, true, undefined)).toBe(false);
    expect(legacySslOptionFor("verify-full", true, undefined)).toBe(false);
    expect(legacySslOptionFor("disable", true, undefined)).toBe(false);
  });

  it("uses TLS without verification for remote connections by default", () => {
    expect(legacySslOptionFor(undefined, false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("treats prefer/require as TLS without verification (their pgconn primary)", () => {
    expect(legacySslOptionFor("prefer", false, undefined)).toEqual({ rejectUnauthorized: false });
    expect(legacySslOptionFor("require", false, undefined)).toEqual({ rejectUnauthorized: false });
  });

  it("uses plaintext for sslmode=disable and sslmode=allow on a remote connection", () => {
    // pgconn's `allow` fallback list is `{nil, tlsConfig}` — a non-TLS primary —
    // so an `allow` DSN to a plaintext-only endpoint must connect without TLS.
    expect(legacySslOptionFor("disable", false, undefined)).toBe(false);
    expect(legacySslOptionFor("allow", false, undefined)).toBe(false);
  });

  it("verifies the full certificate (incl. hostname) for verify-full", () => {
    expect(legacySslOptionFor("verify-full", false, undefined)).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("verifies the CA chain but skips hostname for verify-ca (pgconn parity)", () => {
    // pgconn's verify-ca verifies the chain but not the hostname, so Node must
    // keep rejectUnauthorized but disable the identity check.
    const ssl = legacySslOptionFor("verify-ca", false, undefined);
    expect(ssl).toMatchObject({ rejectUnauthorized: true });
    if (typeof ssl === "object" && ssl !== null) {
      expect(typeof ssl.checkServerIdentity).toBe("function");
      expect(ssl.checkServerIdentity?.("wrong.host", {} as never)).toBeUndefined();
    }
  });

  it("attaches the client cert (cert/key/passphrase) to every TLS mode (pgconn parity)", () => {
    const clientCert = { cert: "CERT", key: "KEY", passphrase: "pw" };
    // verify-full / verify-ca / require|prefer all carry the client certificate.
    expect(
      legacySslOptionFor("verify-full", false, undefined, undefined, clientCert),
    ).toMatchObject({ cert: "CERT", key: "KEY", passphrase: "pw" });
    expect(legacySslOptionFor("require", false, undefined, undefined, clientCert)).toMatchObject({
      cert: "CERT",
      key: "KEY",
    });
    // Plaintext modes carry no client cert.
    expect(legacySslOptionFor("disable", false, undefined, undefined, clientCert)).toBe(false);
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

describe("legacySslConfigsFor (pgconn fallback list)", () => {
  it("local connections try a single plaintext (no-TLS) config", () => {
    expect(legacySslConfigsFor(undefined, true, undefined)).toEqual([false]);
  });

  it("disable is plaintext only", () => {
    expect(legacySslConfigsFor("disable", false, undefined)).toEqual([false]);
  });

  it("allow is plaintext primary with a TLS fallback ({nil, tlsConfig})", () => {
    expect(legacySslConfigsFor("allow", false, undefined)).toEqual([
      false,
      { rejectUnauthorized: false },
    ]);
  });

  it("prefer and unset are TLS only (ConnectByUrl strips the plaintext fallback)", () => {
    // pgconn's raw list is `{tlsConfig, nil}`, but Go's ConnectByUrl removes the
    // plaintext fallback when the primary is TLS, so a default remote connection
    // fails rather than downgrading to plaintext.
    expect(legacySslConfigsFor("prefer", false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
    expect(legacySslConfigsFor(undefined, false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
  });

  it("require / verify-* are TLS only (no fallback)", () => {
    expect(legacySslConfigsFor("require", false, undefined)).toEqual([
      { rejectUnauthorized: false },
    ]);
    expect(legacySslConfigsFor("verify-full", false, undefined)).toEqual([
      { rejectUnauthorized: true },
    ]);
    const verifyCa = legacySslConfigsFor("verify-ca", false, undefined);
    expect(verifyCa).toHaveLength(1);
    expect(verifyCa[0]).toMatchObject({ rejectUnauthorized: true });
  });

  it("loads sslrootcert into the verifying modes and promotes require → verify-ca", () => {
    const ca = "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----";
    // require + a root cert behaves like verify-ca (chain verified, hostname skipped).
    const required = legacySslConfigsFor("require", false, undefined, ca);
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({ rejectUnauthorized: true, ca });
    expect((required[0] as { checkServerIdentity?: unknown }).checkServerIdentity).toBeTypeOf(
      "function",
    );
    // verify-full keeps full verification but pins the CA.
    expect(legacySslConfigsFor("verify-full", false, undefined, ca)).toEqual([
      { rejectUnauthorized: true, ca },
    ]);
  });

  it("does not attach a CA to non-verifying modes", () => {
    const ca = "ca-bundle";
    // prefer stays unverified even with a root cert (pgconn: InsecureSkipVerify).
    expect(legacySslConfigsFor("prefer", false, undefined, ca)).toEqual([
      { rejectUnauthorized: false },
    ]);
  });

  it("forces a single plaintext attempt for a unix-socket host regardless of sslmode", () => {
    // pgconn skips TLS for a unix NetworkAddress, so a socket DSN connects in
    // plaintext even though the host is not the local services hostname (isLocal=false).
    expect(
      legacySslConfigsFor("require", false, undefined, undefined, "/var/run/postgresql"),
    ).toEqual([false]);
    expect(legacySslConfigsFor("verify-full", false, undefined, "ca", "/tmp/.s.PGSQL")).toEqual([
      false,
    ]);
    // A non-socket host still follows the normal sslmode fallback list.
    expect(legacySslConfigsFor("require", false, undefined, undefined, "db.example.com")).toEqual([
      { rejectUnauthorized: false },
    ]);
  });
});

describe("legacyBuildRawPgConfig", () => {
  const base = { user: "postgres", password: "pw", port: 5432, database: "postgres", host: "h" };

  it("uses discrete fields (no connection string) when no options/runtimeParams", () => {
    const c = legacyBuildRawPgConfig(
      { ...base },
      "db.example.com",
      5432,
      { rejectUnauthorized: false },
      10,
    );
    expect(c).toMatchObject({
      host: "db.example.com",
      port: 5432,
      user: "postgres",
      password: "pw",
      database: "postgres",
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
    expect(c.connectionString).toBeUndefined();
  });

  it("routes through a connection string when a libpq options payload is present", () => {
    const c = legacyBuildRawPgConfig(
      { ...base, options: "reference=abc" },
      "db.example.com",
      6543,
      false,
      2,
    );
    expect(c.connectionString).toContain("@db.example.com:6543/");
    expect(c.connectionString).toContain("options=reference%3Dabc");
    expect(c.host).toBeUndefined();
    expect(c.connectionTimeoutMillis).toBe(2000);
    expect(c.ssl).toBe(false);
  });

  it("omits the ssl field entirely when the ssl option is undefined", () => {
    const c = legacyBuildRawPgConfig({ ...base }, "h", 5432, undefined, 5);
    expect("ssl" in c).toBe(false);
  });

  it("enables TCP keepalive with a five-minute idle delay on both config forms", () => {
    const discrete = legacyBuildRawPgConfig({ ...base }, "db.example.com", 5432, false, 10);
    expect(discrete.keepAlive).toBe(true);
    expect(discrete.keepAliveInitialDelayMillis).toBe(300_000);

    const url = legacyBuildRawPgConfig(
      { ...base, options: "reference=abc" },
      "db.example.com",
      6543,
      false,
      2,
    );
    expect(url.keepAlive).toBe(true);
    expect(url.keepAliveInitialDelayMillis).toBe(300_000);
  });
});

describe("legacyBuildPoolConfig", () => {
  const base = { user: "postgres", password: "pw", port: 5432, database: "postgres", host: "h" };

  it("disables idle reaping (idleTimeoutMillis 0) and pins one connection (max 1) for a remote config", () => {
    // The `db pull` bug: `PgClient.make` left idleTimeoutMillis unset (node-postgres
    // default 10s), reaping the stepped-down connection during a long idle.
    const c = legacyBuildPoolConfig(
      { ...base },
      "db.example.com",
      5432,
      { rejectUnauthorized: false },
      10,
      true,
    );
    expect(c.idleTimeoutMillis).toBe(0);
    expect(c.max).toBe(1);
    expect(c.application_name).toBe("@effect/sql-pg");
    // carries the raw client config fields through
    expect(c).toMatchObject({ host: "db.example.com", connectionTimeoutMillis: 10_000 });
  });

  it("disables idle reaping and pins one connection for a local (plaintext) config too", () => {
    const c = legacyBuildPoolConfig({ ...base }, "127.0.0.1", 54322, false, 2, false);
    expect(c.idleTimeoutMillis).toBe(0);
    expect(c.max).toBe(1);
    expect(c.ssl).toBe(false);
  });

  it("carries the raw client's TCP keepalive through to every pooled connection", () => {
    const c = legacyBuildPoolConfig({ ...base }, "127.0.0.1", 54322, false, 2, false);
    expect(c.keepAlive).toBe(true);
    expect(c.keepAliveInitialDelayMillis).toBe(300_000);
  });

  it("installs the step-down verify hook only when required", () => {
    // Every NEW physical connection (initial + silent redials) runs the step-down
    // before pg-pool hands it to a checkout, mirroring Go's per-connection
    // AfterConnect.
    const remote = legacyBuildPoolConfig({ ...base }, "db.example.com", 5432, false, 10, true);
    expect(remote.verify).toBe(legacyPoolStepDownVerify);
    const local = legacyBuildPoolConfig({ ...base }, "127.0.0.1", 54322, false, 2, false);
    expect("verify" in local).toBe(false);
  });
});

describe("legacyPoolStepDownVerify", () => {
  it("runs SET SESSION ROLE postgres and reports success to the pool", async () => {
    const queries: Array<string> = [];
    const client = { query: (sql: string) => (queries.push(sql), Promise.resolve()) };
    const done = await new Promise<Error | undefined>((resolve) => {
      legacyPoolStepDownVerify(client, resolve);
    });
    expect(queries).toEqual(["SET SESSION ROLE postgres"]);
    expect(done).toBeUndefined();
  });

  it("propagates a failing step-down to the pool callback so the checkout fails (Go AfterConnect parity)", async () => {
    const failure = new Error("permission denied to set role");
    const client = { query: () => Promise.reject(failure) };
    const done = await new Promise<Error | undefined>((resolve) => {
      legacyPoolStepDownVerify(client, resolve);
    });
    expect(done).toBe(failure);
  });

  it("wraps a non-Error rejection into an Error for the pool callback", async () => {
    const client = { query: () => Promise.reject("boom") };
    const done = await new Promise<Error | undefined>((resolve) => {
      legacyPoolStepDownVerify(client, resolve);
    });
    expect(done).toBeInstanceOf(Error);
    expect(String(done)).toContain("boom");
  });
});

describe("legacyInstallPoolErrorSwallow", () => {
  it("swallows pool background errors so a dropped idle client never crashes the process", () => {
    const pool = new EventEmitter();
    legacyInstallPoolErrorSwallow(pool);
    expect(pool.listenerCount("error")).toBe(1);
    expect(() => pool.emit("error", new Error("idle client boom"))).not.toThrow();
  });
});

describe("legacyAcquireProbedPool", () => {
  // Tiny fake at the driver boundary: records query/end calls. Standing in for a
  // real `pg.Pool` proves the pool is always `.end()`ed — the leak this fixes.
  function makeFakePool(query: () => Promise<unknown>) {
    const calls = { query: 0, end: 0 };
    const pool = {
      query: (_sql: string) => {
        calls.query += 1;
        return query();
      },
      end: () => {
        calls.end += 1;
        return Promise.resolve();
      },
      on: (_event: "error", _listener: (error: Error) => void) => undefined,
    };
    return { pool, calls };
  }

  it("ends the pool when the connect probe rejects", async () => {
    const fake = makeFakePool(() => Promise.reject(new Error("ECONNREFUSED")));
    const exit = await Effect.runPromiseExit(
      legacyAcquireProbedPool(() => fake.pool, 2).pipe(Effect.scoped),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.calls.query).toBe(1);
    // The finalizer, installed the moment the pool exists, closes it on failure.
    expect(fake.calls.end).toBe(1);
  });

  it("ends the pool when the connect probe times out (black-holed host)", async () => {
    // A never-resolving probe models a black-holed host: `timeoutOrElse` fires and
    // the already-installed finalizer still closes the pool + its in-flight dial.
    const fake = makeFakePool(() => new Promise<unknown>(() => {}));
    const exit = await Effect.runPromiseExit(
      legacyAcquireProbedPool(() => fake.pool, 0.05).pipe(Effect.scoped),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.calls.end).toBe(1);
  });

  it("keeps the pool open until the scope closes on a successful probe", async () => {
    const fake = makeFakePool(() => Promise.resolve({ rows: [{ "?column?": 1 }] }));
    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const pool = yield* legacyAcquireProbedPool(() => fake.pool, 2);
        // While the scope is open the pool is live and not yet ended.
        return { isSamePool: pool === fake.pool, endWhileOpen: fake.calls.end };
      }).pipe(Effect.scoped),
    );
    expect(observed.isSamePool).toBe(true);
    expect(observed.endWhileOpen).toBe(0);
    // Closing the scope ends the pool exactly once.
    expect(fake.calls.end).toBe(1);
  });
});

describe("legacyIsUnixSocketHost", () => {
  it("treats an absolute path as a unix socket and a hostname/IP as not", () => {
    expect(legacyIsUnixSocketHost("/var/run/postgresql")).toBe(true);
    expect(legacyIsUnixSocketHost("db.example.com")).toBe(false);
    expect(legacyIsUnixSocketHost("127.0.0.1")).toBe(false);
    expect(legacyIsUnixSocketHost("::1")).toBe(false);
  });

  it("treats an uppercase Windows drive path as a socket, lowercase as TCP (pgconn parity)", () => {
    // pgconn's isAbsolutePath accepts `A-Z:\…` (uppercase drive only); `c:\…` is TCP.
    expect(legacyIsUnixSocketHost("C:\\pgsql")).toBe(true);
    expect(legacyIsUnixSocketHost("c:\\pgsql")).toBe(false);
    expect(legacyIsUnixSocketHost("C:")).toBe(false);
  });
});

describe("legacyIsTerminalConnectError (pgconn fallback termination)", () => {
  it("terminates on auth/catalog/privilege SQLSTATEs carried on the error cause", () => {
    // The pg driver attaches the SQLSTATE as `code`; @effect/sql wraps it in `cause`.
    expect(legacyIsTerminalConnectError({ cause: { code: "28P01" } }, false)).toBe(true);
    expect(legacyIsTerminalConnectError({ cause: { code: "3D000" } }, true)).toBe(true);
    expect(legacyIsTerminalConnectError({ code: "42501" }, false)).toBe(true);
  });

  it("gates 28000 on the attempt having used TLS (pgconn fc.TLSConfig != nil)", () => {
    expect(legacyIsTerminalConnectError({ code: "28000" }, true)).toBe(true);
    expect(legacyIsTerminalConnectError({ code: "28000" }, false)).toBe(false);
  });

  it("falls through (returns false) for network/dial errors with no SQLSTATE", () => {
    expect(legacyIsTerminalConnectError({ code: "ECONNREFUSED" }, true)).toBe(false);
    expect(legacyIsTerminalConnectError(new Error("connection refused"), true)).toBe(false);
    expect(legacyIsTerminalConnectError("boom", true)).toBe(false);
    expect(legacyIsTerminalConnectError(undefined, false)).toBe(false);
  });
});

describe("legacyToExecError (pg server-error extraction)", () => {
  /**
   * The real failure chain for a statement error: `@effect/sql`'s `SqlError`
   * exposes its reason as `cause`, and the reason exposes the node-postgres
   * `DatabaseError` (an `Error` carrying `severity`/`code`/`detail`/`position`
   * string fields) as `cause` again.
   */
  const sqlErrorChain = (
    server: Partial<Record<"severity" | "code" | "detail" | "position", string>> & {
      message: string;
    },
  ) =>
    new SqlError({
      reason: new SqlSyntaxError({
        cause: Object.assign(new Error(server.message), server),
        message: "Failed to execute statement",
        operation: "execute",
      }),
    });

  it("renders pgconn's PgError message and carries code, detail, and position", () => {
    const error = legacyToExecError(
      sqlErrorChain({
        message: 'type "ltree" does not exist',
        severity: "ERROR",
        code: "42704",
        detail: "Some detail line.",
        position: "25",
      }),
    );
    expect(error.message).toBe('ERROR: type "ltree" does not exist (SQLSTATE 42704)');
    expect(error.code).toBe("42704");
    expect(error.detail).toBe("Some detail line.");
    expect(error.position).toBe(25);
  });

  it("omits detail and position when the server sent none (Go's non-empty gates)", () => {
    const error = legacyToExecError(
      sqlErrorChain({
        message: 'syntax error at or near "BOOM"',
        severity: "ERROR",
        code: "42601",
        detail: "",
        position: "0",
      }),
    );
    expect(error.message).toBe('ERROR: syntax error at or near "BOOM" (SQLSTATE 42601)');
    expect(error.code).toBe("42601");
    expect(error.detail).toBeUndefined();
    expect(error.position).toBeUndefined();
  });

  it("keeps the driver text verbatim for non-server failures", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const error = legacyToExecError(
      new SqlError({
        reason: new UnknownError({ cause, message: "Failed to execute statement" }),
      }),
    );
    expect(error.message).toBe("effect/sql/SqlError: Failed to execute statement");
    expect(error.code).toBe("ECONNRESET");
    expect(error.detail).toBeUndefined();
    expect(error.position).toBeUndefined();
  });
});

describe("LegacyPgBatchQuery.submit", () => {
  const fakeConnection = (writable: boolean, opts: { dieOnUncork?: boolean } = {}) => {
    const frames: Array<string> = [];
    const record = (frame: string) => () => {
      frames.push(frame);
    };
    const stream = {
      writable,
      cork: record("cork"),
      uncork: () => {
        frames.push("uncork");
        if (opts.dieOnUncork === true) stream.writable = false;
      },
    };
    return {
      frames,
      connection: {
        stream,
        parse: (query: { text: string }) => {
          frames.push(`parse(${query.text})`);
        },
        bind: record("bind"),
        describe: record("describe"),
        execute: record("execute"),
        sync: record("sync"),
      } as unknown as Pg.Connection,
    };
  };

  it("refuses to write a batch onto a stream that is no longer writable", () => {
    const { connection, frames } = fakeConnection(false);
    const batch = new LegacyPgBatchQuery([{ sql: "select 1" }], () => {});

    const error = batch.submit(connection);

    expect(error?.message).toBe("the connection's socket is no longer writable");
    expect(batch.outcome).toBe("unsent");
    expect(frames).toEqual([]);
  });

  it("reports a batch whose stream died during the uncork flush as unsent", () => {
    const { connection, frames } = fakeConnection(true, { dieOnUncork: true });
    const batch = new LegacyPgBatchQuery([{ sql: "select 1" }], () => {});

    const error = batch.submit(connection);

    expect(error?.message).toBe(
      "the connection's socket became unwritable while the batch was flushing",
    );
    expect(batch.outcome).toBe("unsent");
    expect(frames).toEqual([
      "cork",
      "parse(BEGIN)",
      "bind",
      "describe",
      "execute",
      "parse(select 1)",
      "bind",
      "describe",
      "execute",
      "parse(COMMIT)",
      "bind",
      "describe",
      "execute",
      "sync",
      "uncork",
    ]);
  });

  it("brackets the statements in BEGIN/COMMIT and writes one sync while writable", () => {
    const { connection, frames } = fakeConnection(true);
    const batch = new LegacyPgBatchQuery([{ sql: "select 1" }, { sql: "select 2" }], () => {});

    expect(batch.submit(connection)).toBeNull();

    expect(frames).toEqual([
      "cork",
      "parse(BEGIN)",
      "bind",
      "describe",
      "execute",
      "parse(select 1)",
      "bind",
      "describe",
      "execute",
      "parse(select 2)",
      "bind",
      "describe",
      "execute",
      "parse(COMMIT)",
      "bind",
      "describe",
      "execute",
      "sync",
      "uncork",
    ]);
    expect(batch.outcome).toBe("submitted");
  });

  it("counts neither BEGIN's nor COMMIT's completion toward the statement index", () => {
    const batch = new LegacyPgBatchQuery([{ sql: "select 1" }, { sql: "select 2" }], () => {});

    batch.handleCommandComplete();
    expect(batch.completed).toBe(0);
    batch.handleCommandComplete();
    batch.handleEmptyQuery();
    expect(batch.completed).toBe(2);
    batch.handleCommandComplete();
    expect(batch.completed).toBe(2);
  });
});

describe("legacyBatchFailureError", () => {
  it("reports an unsent batch as a lost connection rather than a statement failure", () => {
    const error = legacyBatchFailureError(
      new Error("the connection's socket is no longer writable"),
      { completed: 0, outcome: "unsent" },
      true,
    );

    expect(error._tag).toBe("LegacyDbConnectError");
    expect(error.message).toBe(
      "connection to the database was lost before the batch could be sent: " +
        "the connection's socket is no longer writable",
    );
    expect(error[ErrorActionabilityId]).toMatchObject({ error_category: "db_connection" });
    // A batch pg refused before construction reaches the mapper as undefined; same class.
    expect(legacyBatchFailureError(new Error("client was closed"), undefined, true)._tag).toBe(
      "LegacyDbConnectError",
    );
  });

  it("keeps the driver's own reason when pg refused the batch before submit", () => {
    const error = legacyBatchFailureError(
      new Error("Client has encountered a connection error and is not queryable"),
      { completed: 0, outcome: "unsent" },
      true,
    );

    expect(error._tag).toBe("LegacyDbConnectError");
    expect(error.message).toBe(
      "connection to the database was lost before the batch could be sent: " +
        "Client has encountered a connection error and is not queryable",
    );
  });

  it("carries the local-stack hint, matching the checkout failure it races with", () => {
    const local = legacyBatchFailureError(
      new Error("socket died"),
      {
        completed: 0,
        outcome: "unsent",
      },
      true,
    );
    const remote = legacyBatchFailureError(
      new Error("socket died"),
      {
        completed: 0,
        outcome: "unsent",
      },
      false,
    );

    expect(local).toMatchObject({ suggestion: LEGACY_SUGGEST_LOCAL_STACK });
    expect(remote._tag).toBe("LegacyDbConnectError");
    expect("suggestion" in remote).toBe(false);
  });

  it("keeps a partially written batch on the statement path, blaming statement 0", () => {
    // A poisoned batch is corked, so the server acknowledged nothing and `completed`
    // is always 0 — the failure can only be reported against the batch's first statement.
    const error = legacyBatchFailureError(
      new Error("serialization blew up"),
      {
        completed: 0,
        outcome: "poisoned",
      },
      true,
    );

    expect(error._tag).toBe("LegacyDbExecError");
    expect(error).toMatchObject({ message: "Error: serialization blew up", statementIndex: 0 });
  });

  it("names the transaction start when the server rejected the batch before BEGIN completed", () => {
    const beginRejected = new SqlError({
      reason: new SqlSyntaxError({
        cause: Object.assign(new Error("canceling statement due to statement timeout"), {
          severity: "ERROR",
          code: "57014",
        }),
        message: "Failed to execute statement",
        operation: "execute",
      }),
    });
    const error = legacyBatchFailureError(
      beginRejected,
      { completed: 0, outcome: "submitted", began: false },
      true,
    );

    expect(error).toBeInstanceOf(LegacyDbExecError);
    expect(error).toMatchObject({
      message:
        "failed to begin the batch transaction: " +
        "ERROR: canceling statement due to statement timeout (SQLSTATE 57014)",
      statementIndex: 0,
    });

    const lost = legacyBatchFailureError(
      new Error("Connection terminated unexpectedly"),
      { completed: 0, outcome: "submitted", began: false },
      true,
    );
    expect(lost).toBeInstanceOf(LegacyDbExecError);
    expect(lost.message).toBe("Error: Connection terminated unexpectedly");

    const terminated = legacyBatchFailureError(
      new SqlError({
        reason: new SqlSyntaxError({
          cause: Object.assign(new Error("terminating connection due to idle-session timeout"), {
            severity: "FATAL",
            code: "57P05",
          }),
          message: "Failed to execute statement",
          operation: "execute",
        }),
      }),
      { completed: 0, outcome: "submitted", began: false },
      true,
    );
    expect(terminated).toBeInstanceOf(LegacyDbExecError);
    expect(terminated.message).toBe(
      "FATAL: terminating connection due to idle-session timeout (SQLSTATE 57P05)",
    );

    const poisoned = legacyBatchFailureError(
      beginRejected,
      { completed: 0, outcome: "poisoned", began: false },
      true,
    );
    expect(poisoned).toBeInstanceOf(LegacyDbExecError);
    expect(poisoned.message).toBe(
      "ERROR: canceling statement due to statement timeout (SQLSTATE 57014)",
    );
  });

  it("keeps server-error mapping and the completed count for a statement failure", () => {
    const error = legacyBatchFailureError(
      new SqlError({
        reason: new SqlSyntaxError({
          cause: Object.assign(new Error('type "ltree" does not exist'), {
            severity: "ERROR",
            code: "42704",
            detail: "Some detail line.",
            position: "25",
          }),
          message: "Failed to execute statement",
          operation: "execute",
        }),
      }),
      { completed: 3, outcome: "submitted" },
      true,
    );

    expect(error._tag).toBe("LegacyDbExecError");
    expect(error).toMatchObject({
      message: 'ERROR: type "ltree" does not exist (SQLSTATE 42704)',
      code: "42704",
      detail: "Some detail line.",
      position: 25,
      statementIndex: 3,
    });
  });
});

describe("legacyShouldDiscardBatchClient", () => {
  it("discards a client whose batch never reached the wire", () => {
    expect(
      legacyShouldDiscardBatchClient({ outcome: "unsent" }, Exit.succeed(undefined), false),
    ).toBe(true);
  });

  it("keeps a written batch's client on success or once its failure rolled back", () => {
    expect(
      legacyShouldDiscardBatchClient({ outcome: "submitted" }, Exit.succeed(undefined), false),
    ).toBe(false);
    expect(
      legacyShouldDiscardBatchClient(
        { outcome: "submitted" },
        Exit.fail(new Error("server said no")),
        true,
      ),
    ).toBe(false);
  });

  it("discards a written batch's client when its failure was not rolled back", () => {
    expect(
      legacyShouldDiscardBatchClient(
        { outcome: "submitted" },
        Exit.fail(new Error("server said no")),
        false,
      ),
    ).toBe(true);
  });

  it("discards a client whose batch was interrupted or died mid-flight", () => {
    expect(legacyShouldDiscardBatchClient({ outcome: "submitted" }, Exit.interrupt(1), true)).toBe(
      true,
    );
    expect(legacyShouldDiscardBatchClient({ outcome: "submitted" }, Exit.die("boom"), true)).toBe(
      true,
    );
    // Interrupted before the batch was even constructed: no batch, still discard.
    expect(legacyShouldDiscardBatchClient(undefined, Exit.interrupt(1), false)).toBe(true);
  });
});
