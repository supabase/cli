import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Redacted, Ref, Scope } from "effect";
import { connect, createServer, type Socket } from "node:net"; // oxlint-disable-line effecttsgo/node-builtin-import -- real socket fixture.
import { tmpdir } from "node:os";
import { makeService } from "../Service.ts";
import { makeDatabase, type DatabaseConfig } from "../services/Database.ts";
import * as LogflareStorage from "./LogflareStorage.ts";

const config: DatabaseConfig = {
  version: "17",
  databasePassword: Redacted.make("logflare-storage-password"),
  jwtSecret: Redacted.make("logflare-storage-jwt-secret-with-32-chars"),
  jwtExpiry: 3600,
  healthTimeoutMs: 120_000,
};

const sourceToken = "0b6d7c8e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const uncreatedToken = "1c7e8d9f-2a3b-4c5d-9e6f-7a8b9c0d1e2f";
const storedId = "8f0e7a9b-6c5d-8e4f-9a3b-2c1d0e9f8a7b";
const missingId = "9a1b2c3d-4e5f-8a6b-9c7d-8e9f0a1b2c3d";

/** A native stack database whose `_supabase` database holds a Logflare-shaped source table. */
const analyticsDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-logflare-storage-" });
  const recipe = yield* makeDatabase({
    stackId: "logflare-storage",
    instanceId: "database",
    root,
    cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
    runtime: "native",
  });
  // The service runs its operations in its own scope, which must stay open while it is destroyed.
  const serviceScope = yield* Scope.make();
  const service = yield* makeService(recipe.definition, { id: "database", config }).pipe(
    Scope.provide(serviceScope),
  );
  yield* Effect.addFinalizer(() =>
    service.destroy.pipe(Effect.ignore, Effect.andThen(Scope.close(serviceScope, Exit.void))),
  );
  yield* service.start;
  yield* service.ready;
  const endpoint = yield* recipe.endpoint;
  if (endpoint.kind !== "unix") return yield* Effect.die("native database has no socket");
  const database: LogflareStorage.AnalyticsDatabase = {
    host: endpoint.path,
    port: endpoint.port,
    database: "_supabase",
    username: "supabase_admin",
    password: Redacted.value(config.databasePassword),
  };
  yield* Effect.scoped(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        PgClient.layer({ ...database, password: config.databasePassword }),
      );
      yield* Context.get(services, PgClient.PgClient).unsafe(`
        CREATE SCHEMA IF NOT EXISTS _analytics;
        CREATE TABLE _analytics.sources (name text NOT NULL, token uuid NOT NULL);
        INSERT INTO _analytics.sources VALUES
          ('postgres.logs', '${sourceToken}'), ('auth.logs', '${uncreatedToken}');
        CREATE TABLE _analytics."log_events_${sourceToken.replaceAll("-", "_")}" (id uuid PRIMARY KEY);
        INSERT INTO _analytics."log_events_${sourceToken.replaceAll("-", "_")}" VALUES ('${storedId}');
      `);
    }),
  );
  return database;
});

/** Relays TCP connections to a Unix socket until `cut` drops them all and refuses new ones. */
const socketRelay = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number;
      readonly cut: () => void;
      readonly close: () => void;
    }>((resume) => {
      const sockets = new Set<Socket>();
      let cut = false;
      const server = createServer((client) => {
        if (cut) return client.destroy();
        const upstream = connect(path);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
          socket.on("error", () => socket.destroy());
        }
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          return resume(Effect.die("relay has no address"));
        resume(
          Effect.succeed({
            port: address.port,
            cut: () => {
              cut = true;
              for (const socket of sockets) socket.destroy();
            },
            close: () => server.close(),
          }),
        );
      });
    }),
    (relay) => Effect.sync(relay.close),
  );

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

describe("LogflareStorage", { timeout: 180_000 }, () => {
  it.live(
    "reads stored ids from a source's table, none before Analytics creates it, and fails for an unknown source",
    () =>
      Effect.gen(function* () {
        const database = yield* analyticsDatabase;
        const storage = yield* LogflareStorage.make(Effect.succeed(database));

        const stored = yield* storage.storedIds("postgres.logs", [storedId, missingId]);
        const uncreated = yield* storage.storedIds("auth.logs", [storedId]);
        const unknown = yield* storage.storedIds("storage.logs", [storedId]).pipe(Effect.flip);

        expect([...stored]).toEqual([storedId]);
        expect([...uncreated]).toEqual([]);
        expect(unknown.message).toBe("Analytics has no storage.logs sources");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("connects again after a failed query, so it follows a database that moved", () =>
    Effect.gen(function* () {
      const database = yield* analyticsDatabase;
      const relay = yield* socketRelay(`${database.host}/.s.PGSQL.${database.port}`);
      const location = yield* Ref.make<LogflareStorage.AnalyticsDatabase>({
        ...database,
        host: "127.0.0.1",
        port: relay.port,
      });
      const storage = yield* LogflareStorage.make(Ref.get(location));
      const before = yield* storage.storedIds("postgres.logs", [storedId]);

      relay.cut();
      yield* Ref.set(location, database);
      const failed = yield* storage.storedIds("postgres.logs", [storedId]).pipe(Effect.exit);
      const after = yield* storage.storedIds("postgres.logs", [storedId]);

      expect([...before]).toEqual([storedId]);
      expect(Exit.isFailure(failed)).toBe(true);
      expect([...after]).toEqual([storedId]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
