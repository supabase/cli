import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { tmpdir } from "node:os";
import { DEFAULT_POSTGRES_ROOT_KEY } from "../Defaults.ts";
import { makeService } from "../Service.ts";
import { makeDatabase, type BackendEndpoint, type DatabaseConfig } from "./Database.ts";
import { makeDockerDatabaseRoot, runDocker } from "../../tests/docker-fixture.ts";

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
  username = "supabase_admin",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = endpoint.kind === "unix" ? endpoint.path : endpoint.host;
      const services = yield* Layer.build(
        PgClient.layer({
          host,
          port: endpoint.port,
          database,
          username,
          password,
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe(statement);
    }),
  );

describe("database component", { timeout: 180_000 }, () => {
  for (const target of [
    { runtime: "native", version: "17" },
    { runtime: "docker", version: "15" },
    { runtime: "docker", version: "17" },
  ] as const)
    it.live(
      `preserves default encryption keys and Vault secrets after ${target.runtime} PostgreSQL ${target.version} recreation`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root =
              target.runtime === "docker"
                ? yield* makeDockerDatabaseRoot("stack-default-key-", "default-key-test")
                : yield* fs.makeTempDirectoryScoped({ prefix: "stack-default-key-" });
            const recipe = yield* makeDatabase({
              stackId: "default-key-test",
              instanceId: "database",
              root,
              cacheRoot: artifactCacheRoot,
              runtime: target.runtime,
            });
            const defaults: DatabaseConfig = {
              healthTimeoutMs: 120_000,
              version: target.version,
              databasePassword: config.databasePassword,
              jwtSecret: config.jwtSecret,
              jwtExpiry: config.jwtExpiry,
            };
            const service = yield* makeService(recipe.definition, {
              id: "database",
              config: defaults,
            });
            yield* service.start;
            yield* service.ready;
            expect(yield* fs.readFileString(path.join(root, "database", "pgsodium_root.key"))).toBe(
              DEFAULT_POSTGRES_ROOT_KEY,
            );
            const endpoint = yield* recipe.endpoint;
            yield* query(
              endpoint,
              defaults.databasePassword,
              "CREATE EXTENSION IF NOT EXISTS pgsodium; CREATE EXTENSION IF NOT EXISTS supabase_vault",
            );
            const derivation = "SELECT encode(pgsodium.derive_key(1), 'hex') AS key";
            const originalKey = yield* query(endpoint, defaults.databasePassword, derivation);
            yield* query(
              endpoint,
              defaults.databasePassword,
              "SELECT vault.create_secret('preserved-value', 'persistence-probe')",
            );
            expect(
              yield* query(
                endpoint,
                defaults.databasePassword,
                "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'persistence-probe'",
              ),
            ).toEqual([{ decrypted_secret: "preserved-value" }]);
            yield* service.stop;
            yield* service.start;
            yield* service.ready;
            const restarted = yield* recipe.endpoint;
            expect(yield* query(restarted, defaults.databasePassword, derivation)).toEqual(
              originalKey,
            );
            expect(
              yield* query(
                restarted,
                defaults.databasePassword,
                "SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'persistence-probe'",
              ),
            ).toEqual([{ decrypted_secret: "preserved-value" }]);
            if (target.runtime === "native") {
              const second = yield* makeDatabase({
                stackId: "default-key-test",
                instanceId: "database-second",
                root,
                cacheRoot: artifactCacheRoot,
                runtime: target.runtime,
              });
              const secondService = yield* makeService(second.definition, {
                id: "database-second",
                config: { ...defaults, rootKey: Redacted.make("b".repeat(64)) },
              });
              yield* secondService.start;
              yield* secondService.ready;
              const secondEndpoint = yield* second.endpoint;
              yield* query(
                secondEndpoint,
                defaults.databasePassword,
                "CREATE EXTENSION IF NOT EXISTS pgsodium",
              );
              expect(
                yield* query(secondEndpoint, defaults.databasePassword, derivation),
              ).not.toEqual(originalKey);
              yield* secondService.destroy;
            }
            yield* service.destroy;
          }),
        ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    );

  it.live("requires passwords from non-superusers on the native socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-hba-" });
        const database = yield* makeDatabase({
          stackId: "stack-integration",
          instanceId: "hba",
          root,
          cacheRoot: artifactCacheRoot,
          runtime: "native",
        });
        const service = yield* makeService(database.definition, { id: "database:hba", config });
        yield* service.start;
        yield* service.ready;
        const endpoint = yield* database.endpoint;
        expect(
          yield* query(
            endpoint,
            config.databasePassword,
            "SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres'",
          ),
        ).toEqual([{ rolsuper: false }]);
        const rejected = yield* query(
          endpoint,
          Redacted.make("wrong-password"),
          "SELECT 1",
          "postgres",
          "postgres",
        ).pipe(Effect.flip);
        expect(Predicate.isTagged(rejected.reason, "AuthenticationError")).toBe(true);
        yield* query(
          endpoint,
          config.databasePassword,
          "CREATE EXTENSION dblink; CREATE ROLE dblink_probe LOGIN PASSWORD 'probe-password'",
        );
        const connected = yield* query(
          endpoint,
          config.databasePassword,
          "SELECT dblink_connect(format('host=%s port=%s dbname=postgres user=dblink_probe password=probe-password', current_setting('unix_socket_directories'), current_setting('port'))) AS status",
          "postgres",
          "postgres",
        );
        expect(connected).toEqual([{ status: "OK" }]);
        const rotated = Redacted.make("rotated-password");
        yield* service.restart({ ...config, databasePassword: rotated });
        yield* service.ready;
        expect(
          yield* query(yield* database.endpoint, rotated, "SELECT 1 AS ok", "postgres", "postgres"),
        ).toEqual([{ ok: 1 }]);
        yield* service.destroy;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

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
          const root = yield* makeDockerDatabaseRoot(
            "stack-database-container-",
            "stack-integration-container",
          );
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

  it.live("shuts PostgreSQL down fast while a client stays connected across stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stackId = "stack-fast-shutdown";
        const root = yield* makeDockerDatabaseRoot("stack-database-shutdown-", stackId);
        const database = yield* makeDatabase({
          stackId,
          instanceId: "database",
          root,
          cacheRoot: artifactCacheRoot,
          runtime: "docker",
        });
        const service = yield* makeService(database.definition, {
          id: "database:shutdown",
          config: { ...config, stopGraceSeconds: 30 },
        });
        yield* service.start;
        yield* service.ready;
        const endpoint = yield* database.endpoint;
        if (endpoint.kind !== "tcp") return yield* Effect.die("Expected a TCP endpoint");
        const listed = yield* runDocker([
          "ps",
          "--filter",
          `label=com.supabase.stack-root=${path.resolve(root)}`,
          "--filter",
          "label=com.supabase.instance=database",
          "--format",
          "{{.Names}}",
        ]);
        const containers = listed.output
          .split("\n")
          .filter((name) => /^supabase-[0-9a-f]{8}-[0-9a-f-]+$/u.test(name));
        expect(containers).toHaveLength(1);
        const container = containers.join("");
        const startedAt = yield* runDocker([
          "inspect",
          "--format",
          "{{.State.StartedAt}}",
          container,
        ]);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* Layer.build(
              PgClient.layer({
                host: endpoint.host,
                port: endpoint.port,
                database: "postgres",
                username: "supabase_admin",
                password: config.databasePassword,
              }),
            );
            const connection = yield* Context.get(services, PgClient.PgClient).reserve;
            expect(yield* connection.executeUnprepared("SELECT 1 AS ok", [], undefined)).toEqual([
              { ok: 1 },
            ]);
            yield* service.stop;
          }),
        );

        const stoppedAt = yield* runDocker(["info", "--format", "{{.SystemTime}}"]);
        const events = yield* runDocker([
          "events",
          "--since",
          startedAt.output.trim(),
          "--until",
          stoppedAt.output.trim(),
          "--filter",
          `container=${container}`,
          "--filter",
          "event=kill",
          "--filter",
          "event=die",
          "--format",
          '{{.Action}} {{index .Actor.Attributes "signal"}}{{index .Actor.Attributes "exitCode"}}',
        ]);
        expect(
          events.output.trim().split("\n"),
          "stop sends SIGINT and PostgreSQL exits cleanly",
        ).toEqual(["kill 2", "die 0"]);
        yield* service.destroy;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
