import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, FileSystem, Layer, Path, Redacted, Ref, Stream } from "effect";
import { tmpdir } from "node:os";
import { makeService } from "../Service.ts";
import { makeDatabase, type BackendEndpoint, type DatabaseConfig } from "./Database.ts";

const config: DatabaseConfig = {
  version: "17",
  databasePassword: Redacted.make("supabase-test-password"),
  jwtSecret: Redacted.make("supabase-test-jwt-secret"),
  jwtExpiry: 3600,
  rootKey: Redacted.make("a".repeat(64)),
};

const artifactCacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

const query = (
  endpoint: BackendEndpoint,
  password: Redacted.Redacted<string>,
  statement: string,
  database = "postgres",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = endpoint.kind === "unix" ? endpoint.path : endpoint.host;
      const services = yield* Layer.build(
        PgClient.layer({
          host,
          port: endpoint.port,
          database,
          username: "supabase_admin",
          password,
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe(statement);
    }),
  );

describe("database component", { timeout: 180_000 }, () => {
  it.live(
    "persists SQL data across exact-session stop and reopen, isolates instances, and validates restart before stopping",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-" });
          const cacheRoot = artifactCacheRoot;
          const first = yield* makeDatabase({
            stackId: "stack-integration",
            instanceId: "first",
            root,
            cacheRoot,
            runtime: "native",
          });
          const loggedConfig: DatabaseConfig = { ...config, settings: { log_statement: "all" } };
          const service = yield* makeService(first.definition, {
            id: "database:first",
            config: loggedConfig,
          });
          const observed = yield* Ref.make("");
          const caughtUp = yield* Deferred.make<void>();
          yield* first.logs.pipe(
            Stream.runForEach(({ bytes }) =>
              Ref.updateAndGet(observed, (text) => text + new TextDecoder().decode(bytes)).pipe(
                Effect.flatMap((text) =>
                  text.includes("bootstrap-logs-settled")
                    ? Deferred.succeed(caughtUp, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );

          yield* service.start;
          yield* service.ready;
          let firstEndpoint = yield* first.endpoint;
          expect(firstEndpoint.kind).toBe("unix");
          yield* query(
            firstEndpoint,
            config.databasePassword,
            "CREATE EXTENSION IF NOT EXISTS pgsodium",
          );
          const derivation = "SELECT encode(pgsodium.derive_key(1), 'hex') AS key";
          const firstKey = yield* query(firstEndpoint, config.databasePassword, derivation);
          expect(firstKey).toEqual([{ key: expect.stringMatching(/^[a-f0-9]{64}$/u) }]);
          yield* query(
            firstEndpoint,
            config.databasePassword,
            "ALTER ROLE supabase_admin SET log_statement = 'all'; ALTER ROLE supabase_admin SET log_min_duration_statement = 0",
          );
          yield* service.restart(loggedConfig);
          yield* service.ready;
          firstEndpoint = yield* first.endpoint;
          yield* query(firstEndpoint, config.databasePassword, "SELECT 'bootstrap-logs-settled'");
          yield* Deferred.await(caughtUp).pipe(Effect.timeout("5 seconds"));
          expect(yield* Ref.get(observed)).not.toContain(Redacted.value(config.databasePassword));
          expect(yield* Ref.get(observed)).not.toContain(Redacted.value(config.jwtSecret));
          yield* query(
            firstEndpoint,
            config.databasePassword,
            "CREATE TABLE IF NOT EXISTS phase_one (value text NOT NULL)",
          );
          yield* query(
            firstEndpoint,
            config.databasePassword,
            "INSERT INTO phase_one(value) VALUES ('persisted')",
          );

          yield* service
            .restart({ ...config, settings: { listen_addresses: "*" } })
            .pipe(Effect.flip);
          expect((yield* service.get).lifecycle).toBe("running");
          yield* service.restart({ ...config, version: "unsupported" }).pipe(Effect.flip);
          expect((yield* service.get).lifecycle).toBe("running");
          const mismatch = yield* service.restart({ ...config, version: "15" }).pipe(Effect.flip);
          expect(mismatch.message).toContain("does not match");
          expect((yield* service.get).lifecycle).toBe("running");
          yield* service.stop;
          yield* fs.remove(path.join(root, "first", ".supabase-database-ready.json"));
          const incomplete = yield* service.restart({ ...config, version: "15" }).pipe(Effect.flip);
          expect(incomplete.message).toContain("major does not match");

          const reopened = yield* makeDatabase({
            stackId: "stack-integration",
            instanceId: "first",
            root,
            cacheRoot,
            runtime: "native",
          });
          const reopenedService = yield* makeService(reopened.definition, {
            id: "database:first-reopened",
            config,
          });
          yield* reopenedService.start;
          yield* reopenedService.ready;
          const reopenedEndpoint = yield* reopened.endpoint;
          expect(reopenedEndpoint.kind).toBe("unix");
          expect(yield* query(reopenedEndpoint, config.databasePassword, derivation)).toEqual(
            firstKey,
          );
          const rows = yield* query(
            reopenedEndpoint,
            config.databasePassword,
            "SELECT value FROM phase_one",
          );
          expect(rows).toEqual([{ value: "persisted" }]);

          const secondRoot = path.join(root, "second-root");
          const second = yield* makeDatabase({
            stackId: "stack-integration",
            instanceId: "second",
            root: secondRoot,
            cacheRoot,
            runtime: "native",
          });
          const secondService = yield* makeService(second.definition, {
            id: "database:second",
            config,
          });
          yield* secondService.start;
          yield* secondService.ready;
          const secondEndpoint = yield* second.endpoint;
          expect(secondEndpoint.kind).toBe("unix");
          yield* query(
            secondEndpoint,
            config.databasePassword,
            "CREATE EXTENSION IF NOT EXISTS pgsodium",
          );
          expect(yield* query(secondEndpoint, config.databasePassword, derivation)).toEqual(
            firstKey,
          );
          if (
            firstEndpoint.kind === "unix" &&
            reopenedEndpoint.kind === "unix" &&
            secondEndpoint.kind === "unix"
          ) {
            expect(secondEndpoint.path).not.toBe(reopenedEndpoint.path);
          }
          yield* query(
            secondEndpoint,
            config.databasePassword,
            "CREATE TABLE isolated (value text NOT NULL)",
          );

          yield* secondService.stop;
          yield* reopenedService.destroy;
          yield* secondService.destroy;
          expect(yield* fs.exists(path.join(root, "first"))).toBe(false);
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  for (const version of ["15", "17"])
    it.live(`PostgreSQL ${version} persists container data and reconciles credentials`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const databaseConfig: DatabaseConfig = { ...config, version };
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-container-" });
          const cacheRoot = artifactCacheRoot;
          const database = yield* makeDatabase({
            stackId: "stack-integration-container",
            instanceId: "database",
            root,
            cacheRoot,
            runtime: "docker",
          });
          const service = yield* makeService(database.definition, {
            id: "database:container",
            config: databaseConfig,
          });
          yield* service.start;
          yield* service.ready;
          const endpoint = yield* database.endpoint;
          expect(endpoint.kind).toBe("tcp");
          yield* query(
            endpoint,
            databaseConfig.databasePassword,
            "CREATE EXTENSION IF NOT EXISTS pgsodium",
          );
          const deriveKey = "SELECT encode(pgsodium.derive_key(1), 'hex') AS key";
          const originalKey = yield* query(endpoint, databaseConfig.databasePassword, deriveKey);
          const schemas = yield* query(
            endpoint,
            databaseConfig.databasePassword,
            "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('_analytics', '_supavisor') ORDER BY schema_name",
            "_supabase",
          );
          expect(schemas).toEqual([{ schema_name: "_analytics" }, { schema_name: "_supavisor" }]);
          yield* query(
            endpoint,
            databaseConfig.databasePassword,
            "CREATE TABLE persisted (value text NOT NULL)",
          );
          yield* query(
            endpoint,
            databaseConfig.databasePassword,
            "INSERT INTO persisted(value) VALUES ('docker')",
          );
          const rotated = Redacted.make("supabase-rotated-password");
          yield* service.restart({
            ...databaseConfig,
            databasePassword: rotated,
            rootKey: Redacted.make("b".repeat(64)),
          });
          yield* service.ready;
          const rotatedEndpoint = yield* database.endpoint;
          expect(yield* query(rotatedEndpoint, rotated, deriveKey)).not.toEqual(originalKey);
          const persisted = yield* query(rotatedEndpoint, rotated, "SELECT value FROM persisted");
          expect(persisted).toEqual([{ value: "docker" }]);
          yield* service
            .restart({ ...databaseConfig, databasePassword: rotated, settings: { port: 9999 } })
            .pipe(Effect.flip);
          expect((yield* service.get).lifecycle).toBe("running");
          yield* service.stop;
          const reopened = yield* makeDatabase({
            stackId: "stack-integration-container",
            instanceId: "database",
            root,
            cacheRoot,
            runtime: "docker",
          });
          const replacementPassword = Redacted.make("reopened-target-password");
          const reopenedService = yield* makeService(reopened.definition, {
            id: "database:reopened",
            config: { ...databaseConfig, databasePassword: replacementPassword },
          });
          yield* reopenedService.start;
          yield* reopenedService.ready;
          expect(yield* query(yield* reopened.endpoint, replacementPassword, deriveKey)).toEqual(
            originalKey,
          );
          expect(
            yield* query(
              yield* reopened.endpoint,
              replacementPassword,
              "SELECT value FROM persisted",
            ),
          ).toEqual([{ value: "docker" }]);
          yield* reopenedService.destroy;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    );
});
