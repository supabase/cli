/**
 * Connection-failure behavior of the real `@effect/sql-pg` driver layer against
 * real sockets: the `LegacyDbConnectError` message must carry the established
 * `failed to connect to postgres: failed to connect to
 * `host=… user=… database=…`: <cause>` structure (pgconn's own connect-error
 * wrapping), and the connect suggestion must classify real
 * node-postgres error shapes, not libpq wording.
 */
import * as net from "node:net";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { LEGACY_SUGGEST_ENV_VAR, LEGACY_SUGGEST_LOCAL_STACK } from "./legacy-connect-errors.ts";
import type { LegacyDbConnectError, LegacyDbExecError } from "./legacy-db-connection.errors.ts";
import { type LegacyPgConnInput, LegacyDbConnection } from "./legacy-db-connection.service.ts";
import { legacyDbConnectionSqlPgLayer } from "./legacy-db-connection.sql-pg.layer.ts";

const SUGGESTION_CONTEXT = {
  dashboardUrl: "https://supabase.com/dashboard",
  profileName: "supabase",
  debug: false,
} as const;

// A distinctive sentinel so a regression that leaks the password into the
// rendered message or suggestion fails the assertions below (pgconn embeds only
// host/user/database — never the password).
const SENTINEL_PASSWORD = "s3cr3t-pw-do-not-leak";

/**
 * Connect through the real layer and flip the expected failure into the value.
 * `isLocal` defaults to `true`, pass `false` to drive the remote/`--linked` suggestion branch instead.
 */
const connectFailure = (
  cfg: Partial<LegacyPgConnInput> & { readonly port: number },
  isLocal = true,
): Effect.Effect<LegacyDbConnectError> =>
  Effect.gen(function* () {
    const conn = yield* LegacyDbConnection;
    return yield* conn
      .connect(
        {
          host: "127.0.0.1",
          user: "postgres",
          password: SENTINEL_PASSWORD,
          database: "postgres",
          suggestionContext: SUGGESTION_CONTEXT,
          ...cfg,
        },
        { isLocal, dnsResolver: "native" },
      )
      .pipe(
        Effect.scoped,
        Effect.flip,
        Effect.mapError(() => new Error("expected the connection to fail")),
        Effect.orDie,
      );
  }).pipe(Effect.provide(legacyDbConnectionSqlPgLayer));

/** A TCP port that is guaranteed closed: bind an ephemeral port, then release it. */
const acquireClosedPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });

/** Encode a Postgres wire-protocol ErrorResponse ('E') message. */
const errorResponse = (fields: Record<string, string>): Buffer => {
  const parts: Array<Buffer> = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(key, "ascii"), Buffer.from(value, "utf8"), Buffer.from([0]));
  }
  parts.push(Buffer.from([0]));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write("E", 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

/**
 * A minimal fake Postgres server: answers `N` to an SSLRequest and hands the
 * first startup message to `onStartup`, so tests can drive the real driver
 * through real server-side failure shapes.
 */
const fakePostgresServer = (
  onStartup: (socket: net.Socket) => void,
): Promise<{ readonly port: number; readonly close: () => void }> =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let sawStartup = false;
      socket.on("data", (data: Buffer) => {
        // SSLRequest: 8-byte message with request code 80877103.
        if (!sawStartup && data.length >= 8 && data.readInt32BE(4) === 80877103) {
          socket.write("N");
          return;
        }
        if (!sawStartup) {
          sawStartup = true;
          onStartup(socket);
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });

/** Encode a Postgres wire-protocol message with a 1-byte type + int32 length + body. */
const wireMessage = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};

// AuthenticationOk ('R', code 0) + ReadyForQuery ('Z', idle).
const AUTHENTICATION_OK = wireMessage("R", Buffer.from([0, 0, 0, 0]));
const READY_FOR_QUERY = wireMessage("Z", Buffer.from("I", "ascii"));
const commandComplete = (tag: string): Buffer =>
  wireMessage("C", Buffer.concat([Buffer.from(tag, "utf8"), Buffer.from([0])]));

/**
 * A fake Postgres server that completes the startup handshake (no auth) and
 * answers every simple-protocol query ('Q') via `onQuery`, so tests can drive
 * the REAL driver stack — node-postgres wire parsing → `DatabaseError` →
 * `@effect/sql-pg`'s `SqlError` wrapping → `legacyToExecError` — through real
 * server-side statement failures.
 */
const fakeQueryServer = (
  onQuery: (sql: string) => Buffer,
): Promise<{ readonly port: number; readonly close: () => void }> =>
  new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let sawStartup = false;
      let pending = Buffer.alloc(0);
      socket.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        for (;;) {
          if (!sawStartup) {
            if (pending.length < 8) return;
            const length = pending.readInt32BE(0);
            if (pending.length < length) return;
            // SSLRequest: request code 80877103 → answer `N` (no TLS).
            if (pending.readInt32BE(4) === 80877103) {
              socket.write("N");
            } else {
              sawStartup = true;
              socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
            }
            pending = pending.subarray(length);
            continue;
          }
          // Regular frames: [type:1][length:4][body:length-4].
          if (pending.length < 5) return;
          const length = pending.readInt32BE(1);
          if (pending.length < length + 1) return;
          const type = String.fromCharCode(pending[0] ?? 0);
          const body = pending.subarray(5, length + 1);
          pending = pending.subarray(length + 1);
          if (type === "Q") {
            // Query body is a NUL-terminated SQL string.
            const sql = body.toString("utf8", 0, body.length - 1);
            socket.write(onQuery(sql));
          }
          // Ignore Terminate ('X') and anything else.
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });

describe("legacyDbConnectionSqlPgLayer connect failures", () => {
  it.live(
    "surfaces host, user, database, and the driver cause when a remote (--linked) connection is refused",
    () =>
      Effect.gen(function* () {
        const port = yield* Effect.promise(acquireClosedPort);
        const error = yield* connectFailure({ port }, false);
        expect(error._tag).toBe("LegacyDbConnectError");
        expect(error.message).toBe(
          "failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: " +
            `dial error (connect ECONNREFUSED 127.0.0.1:${port})`,
        );
        expect(error.suggestion).toBe(
          "Make sure your local IP is allowed in Network Restrictions and Network Bans.\n" +
            "https://supabase.com/dashboard/project/_/database/settings",
        );
        expect(error.message).not.toContain(SENTINEL_PASSWORD);
      }),
  );

  it.live("surfaces the local-stack hint when a local connection is refused", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(acquireClosedPort);
      const error = yield* connectFailure({ port });
      expect(error.suggestion).toBe(LEGACY_SUGGEST_LOCAL_STACK);
      expect(error.retryable).toBe(true);
    }),
  );

  it.live(
    "reproduces pgconn's server-error rendering for an auth failure and suggests SUPABASE_DB_PASSWORD",
    () =>
      Effect.gen(function* () {
        const server = yield* Effect.promise(() =>
          fakePostgresServer((socket) => {
            socket.write(
              errorResponse({
                S: "FATAL",
                V: "FATAL",
                C: "28P01",
                M: 'password authentication failed for user "postgres"',
                F: "auth.c",
                L: "326",
                R: "auth_failed",
              }),
            );
            socket.end();
          }),
        );
        const error = yield* connectFailure({ port: server.port }).pipe(
          Effect.ensuring(Effect.sync(server.close)),
        );
        expect(error.message).toBe(
          "failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: " +
            'server error (FATAL: password authentication failed for user "postgres" (SQLSTATE 28P01))',
        );
        expect(error.suggestion).toBe(LEGACY_SUGGEST_ENV_VAR);
        expect(error.message).not.toContain(SENTINEL_PASSWORD);
        expect(error.retryable).toBeUndefined();
      }),
  );

  it.live(
    "keeps the CLI-1942 session-pooler EOF shape unclassified while surfacing the cause",
    () =>
      Effect.gen(function* () {
        // The session pooler dropping the connection (CLI-1942) surfaces as
        // node-postgres' `Connection terminated unexpectedly`. Go has no
        // suggestion branch for the equivalent `unexpected EOF`, so no
        // suggestion may fire — the generic --debug fallback applies.
        const server = yield* Effect.promise(() =>
          fakePostgresServer((socket) => socket.destroy()),
        );
        const error = yield* connectFailure({
          port: server.port,
          user: "postgres.abcdefghijklmnopqrst",
        }).pipe(Effect.ensuring(Effect.sync(server.close)));
        expect(error.message).toBe(
          "failed to connect to postgres: failed to connect to " +
            "`host=127.0.0.1 user=postgres.abcdefghijklmnopqrst database=postgres`: " +
            "Connection terminated unexpectedly",
        );
        expect(error.suggestion).toBeUndefined();
        // An unexpected EOF is not a dial-level failure — never marked retryable.
        expect(error.retryable).toBeUndefined();
      }),
  );
});

describe("legacyDbConnectionSqlPgLayer exec failures", () => {
  it.live(
    "maps a real wire ErrorResponse to pgconn's PgError rendering with detail and position",
    () =>
      // Tripwire for the server-error extraction: drives the REAL driver stack
      // (node-postgres wire parsing → `DatabaseError` → `@effect/sql-pg`'s
      // `SqlError` cause chain → `legacyToExecError`), so a dependency bump that
      // changes the error wrapping fails here instead of silently degrading
      // migration-apply failures back to the opaque driver text.
      Effect.gen(function* () {
        const failing = "CREATE TABLE test (path ltree NOT NULL)";
        const server = yield* Effect.promise(() =>
          fakeQueryServer((sql) =>
            sql === failing
              ? Buffer.concat([
                  // `S` (localized) and `V` (unlocalized) are deliberately distinct:
                  // Go renders pgconn's `PgError.Severity`, populated from the wire
                  // `S` field (pgproto3 `error_response.go` maps 'S'→Severity,
                  // 'V'→SeverityUnlocalized), so a localized server prints e.g.
                  // `FEHLER: …`. pg-protocol likewise assigns `severity = fields.S`
                  // (`parser.js` parseErrorMessage); asserting `FEHLER` below fails
                  // the tripwire if a dependency bump ever renders `V` instead.
                  errorResponse({
                    S: "FEHLER",
                    V: "ERROR",
                    C: "42704",
                    M: 'type "ltree" does not exist',
                    D: "Detail from the server.",
                    P: "25",
                    F: "parse_type.c",
                    L: "270",
                    R: "typenameType",
                  }),
                  READY_FOR_QUERY,
                ])
              : Buffer.concat([commandComplete("SELECT 1"), READY_FOR_QUERY]),
          ),
        );
        const error: LegacyDbConnectError | LegacyDbExecError = yield* Effect.gen(function* () {
          const conn = yield* LegacyDbConnection;
          return yield* conn
            .connect(
              {
                host: "127.0.0.1",
                port: server.port,
                user: "postgres",
                password: "postgres",
                database: "postgres",
              },
              { isLocal: true, dnsResolver: "native" },
            )
            .pipe(
              Effect.flatMap((session) => session.exec(failing)),
              Effect.scoped,
              Effect.flip,
              Effect.mapError(() => new Error("expected the statement to fail")),
              Effect.orDie,
            );
        }).pipe(
          Effect.provide(legacyDbConnectionSqlPgLayer),
          Effect.ensuring(Effect.sync(server.close)),
        );
        expect(error._tag).toBe("LegacyDbExecError");
        expect(error.message).toBe('FEHLER: type "ltree" does not exist (SQLSTATE 42704)');
        if (error._tag === "LegacyDbExecError") {
          expect(error.code).toBe("42704");
          expect(error.detail).toBe("Detail from the server.");
          expect(error.position).toBe(25);
        }
      }),
  );
});
