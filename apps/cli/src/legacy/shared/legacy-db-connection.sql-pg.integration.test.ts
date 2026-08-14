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
import {
  type LegacyDbSession,
  type LegacyPgConnInput,
  LegacyDbConnection,
} from "./legacy-db-connection.service.ts";
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
const PARSE_COMPLETE = wireMessage("1", Buffer.alloc(0));
const BIND_COMPLETE = wireMessage("2", Buffer.alloc(0));
const NO_DATA = wireMessage("n", Buffer.alloc(0));
const EMPTY_QUERY = wireMessage("I", Buffer.alloc(0));

const readCString = (body: Buffer, offset: number): readonly [string, number] => {
  const end = body.indexOf(0, offset);
  return [body.toString("utf8", offset, end), end + 1];
};

const parseBindValues = (body: Buffer): ReadonlyArray<string | null> => {
  const [, afterPortal] = readCString(body, 0);
  const [, afterStatement] = readCString(body, afterPortal);
  const formatCount = body.readInt16BE(afterStatement);
  let offset = afterStatement + 2 + formatCount * 2;
  const valueCount = body.readInt16BE(offset);
  offset += 2;
  const values: Array<string | null> = [];
  for (let index = 0; index < valueCount; index += 1) {
    const length = body.readInt32BE(offset);
    offset += 4;
    if (length < 0) {
      values.push(null);
    } else {
      values.push(body.toString("utf8", offset, offset + length));
      offset += length;
    }
  }
  return values;
};

interface FakeBatchServerState {
  readonly frameTypes: Array<string>;
  readonly statements: Array<string>;
  readonly params: Array<ReadonlyArray<string | null>>;
  syncs: number;
}

const fakeBatchServer = (
  options: {
    readonly failAt?: number;
    readonly failExecuteAt?: number;
    readonly failOnSync?: boolean;
    readonly emptyAt?: number;
  } = {},
): Promise<{
  readonly port: number;
  readonly close: () => void;
  readonly state: FakeBatchServerState;
}> =>
  new Promise((resolve) => {
    const state: FakeBatchServerState = {
      frameTypes: [],
      statements: [],
      params: [],
      syncs: 0,
    };
    const server = net.createServer((socket) => {
      let sawStartup = false;
      let pending = Buffer.alloc(0);
      let failed = false;
      let activeIndex = -1;
      socket.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        for (;;) {
          if (!sawStartup) {
            if (pending.length < 8) return;
            const length = pending.readInt32BE(0);
            if (pending.length < length) return;
            if (pending.readInt32BE(4) === 80877103) {
              socket.write("N");
            } else {
              sawStartup = true;
              socket.write(Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]));
            }
            pending = pending.subarray(length);
            continue;
          }
          if (pending.length < 5) return;
          const length = pending.readInt32BE(1);
          if (pending.length < length + 1) return;
          const type = String.fromCharCode(pending[0] ?? 0);
          const body = pending.subarray(5, length + 1);
          pending = pending.subarray(length + 1);
          if (type === "Q") {
            socket.write(Buffer.concat([commandComplete("SELECT 1"), READY_FOR_QUERY]));
            continue;
          }
          state.frameTypes.push(type);
          if (type === "P") {
            activeIndex += 1;
            const [, sqlOffset] = readCString(body, 0);
            const [sql] = readCString(body, sqlOffset);
            state.statements.push(sql);
            if (!failed && activeIndex === options.failAt) {
              failed = true;
              socket.write(
                errorResponse({
                  S: "ERROR",
                  V: "ERROR",
                  C: "42601",
                  M: "syntax error at or near bad",
                  D: "batch detail",
                  P: "10",
                }),
              );
            } else if (!failed) {
              socket.write(PARSE_COMPLETE);
            }
          } else if (type === "B") {
            state.params.push(parseBindValues(body));
            if (!failed) socket.write(BIND_COMPLETE);
          } else if (type === "D") {
            if (!failed) socket.write(NO_DATA);
          } else if (type === "E") {
            if (!failed) {
              if (activeIndex === options.failExecuteAt) {
                failed = true;
                socket.write(
                  errorResponse({
                    S: "ERROR",
                    V: "ERROR",
                    C: "23505",
                    M: "duplicate key value violates unique constraint",
                    D: "runtime detail",
                  }),
                );
              } else {
                socket.write(
                  activeIndex === options.emptyAt ? EMPTY_QUERY : commandComplete("SELECT 1"),
                );
              }
            }
          } else if (type === "S") {
            state.syncs += 1;
            if (options.failOnSync === true && !failed) {
              socket.write(
                errorResponse({
                  S: "ERROR",
                  V: "ERROR",
                  C: "23514",
                  M: "deferred constraint failed",
                }),
              );
            }
            socket.write(READY_FOR_QUERY);
            failed = false;
            activeIndex = -1;
          }
        }
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close(), state });
    });
  });

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

describe("legacyDbConnectionSqlPgLayer extended batches", () => {
  const runWithBatchServer = <A>(
    server: Awaited<ReturnType<typeof fakeBatchServer>>,
    use: (session: LegacyDbSession) => Effect.Effect<A, unknown>,
  ) =>
    Effect.gen(function* () {
      const conn = yield* LegacyDbConnection;
      const session = yield* conn.connect(
        {
          host: "127.0.0.1",
          port: server.port,
          user: "postgres",
          password: "postgres",
          database: "postgres",
        },
        { isLocal: true, dnsResolver: "native" },
      );
      return yield* use(session);
    }).pipe(
      Effect.scoped,
      Effect.provide(legacyDbConnectionSqlPgLayer),
      Effect.ensuring(Effect.sync(server.close)),
    );

  it.live("sends every statement and parameter set before one Sync", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() => fakeBatchServer({ emptyAt: 1 }));
      const values = ["plain", 'quote"', "slash\\", "comma,", "{brace}", "line\nbreak", "NULL", ""];
      yield* runWithBatchServer(server, (session) => {
        if (session.execBatch === undefined) return Effect.die("execBatch is unavailable");
        return session.execBatch([
          { sql: "SELECT 1" },
          { sql: "-- comment only" },
          {
            sql: "INSERT INTO history(version, name, statements) VALUES($1, $2, $3)",
            params: ["v'1", "name\\two", values],
          },
        ]);
      });
      expect(server.state.statements).toEqual([
        "SELECT 1",
        "-- comment only",
        "INSERT INTO history(version, name, statements) VALUES($1, $2, $3)",
      ]);
      expect(server.state.params).toEqual([
        [],
        [],
        [
          "v'1",
          "name\\two",
          '{"plain","quote\\\"","slash\\\\","comma,","{brace}","line\nbreak","NULL",""}',
        ],
      ]);
      expect(server.state.frameTypes).toEqual([
        "P",
        "B",
        "D",
        "E",
        "P",
        "B",
        "D",
        "E",
        "P",
        "B",
        "D",
        "E",
        "S",
      ]);
      expect(server.state.syncs).toBe(1);
    }),
  );

  it.live("maps a later parse failure to its statement and keeps its local position", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() => fakeBatchServer({ emptyAt: 1, failAt: 2 }));
      yield* runWithBatchServer(server, (session) => {
        const execBatch = session.execBatch;
        if (execBatch === undefined) return Effect.die("execBatch is unavailable");
        return Effect.gen(function* () {
          const error = yield* execBatch([
            { sql: "SELECT 1" },
            { sql: "-- comment only" },
            { sql: "SELECT bad" },
          ]).pipe(Effect.flip);
          expect(error.statementIndex).toBe(2);
          expect(error.code).toBe("42601");
          expect(error.detail).toBe("batch detail");
          expect(error.position).toBe(10);
          yield* session.exec("SELECT after_error");
        });
      });
      expect(server.state.syncs).toBe(1);
    }),
  );

  it.live("maps a position-less runtime failure from completed commands", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() => fakeBatchServer({ failExecuteAt: 1 }));
      yield* runWithBatchServer(server, (session) => {
        if (session.execBatch === undefined) return Effect.die("execBatch is unavailable");
        return session
          .execBatch([{ sql: "SELECT 1" }, { sql: "INSERT duplicate" }, { sql: "SELECT 3" }])
          .pipe(
            Effect.flip,
            Effect.tap((error) =>
              Effect.sync(() => {
                expect(error.statementIndex).toBe(1);
                expect(error.code).toBe("23505");
                expect(error.detail).toBe("runtime detail");
                expect(error.position).toBeUndefined();
              }),
            ),
          );
      });
    }),
  );

  it.live("reports a deferred Sync failure after every completed statement", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() => fakeBatchServer({ failOnSync: true }));
      yield* runWithBatchServer(server, (session) => {
        if (session.execBatch === undefined) return Effect.die("execBatch is unavailable");
        return session.execBatch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }]).pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error.statementIndex).toBe(2);
              expect(error.code).toBe("23514");
            }),
          ),
        );
      });
    }),
  );
});
