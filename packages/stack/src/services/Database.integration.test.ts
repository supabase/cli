import { PgClient } from "@effect/sql-pg";
import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { createHash } from "node:crypto";
import { DEFAULT_POSTGRES_ROOT_KEY } from "../Defaults.ts";
import { makeStandaloneService } from "../../tests/standalone-service.ts";
import { makeDatabase, type BackendEndpoint, type DatabaseConfig } from "./Database.ts";
import { makeDockerDatabaseRoot, runEngine } from "../../tests/docker-fixture.ts";
import { observeContainerStop, cleanStopEvents } from "../../tests/engine-events.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { testArtifactCacheRoot } from "../../tests/artifact-cache.ts";

const config: DatabaseConfig = {
  version: "17",
  databasePassword: Redacted.make("supabase-test-password"),
  jwtSecret: Redacted.make("supabase-test-jwt-secret"),
  jwtExpiry: 3600,
  rootKey: Redacted.make("a".repeat(64)),
};

const artifactCacheRoot = testArtifactCacheRoot;

const query = <Row extends object = object>(
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
      return yield* Context.get(services, PgClient.PgClient).unsafe<Row>(statement);
    }),
  );

describe("database component", { timeout: 180_000 }, () => {
  for (const target of [
    { runtime: "native", version: "17" },
    { runtime: testEngine, version: "15" },
    { runtime: testEngine, version: "17" },
  ] as const)
    it.live(
      `preserves default encryption keys and Vault secrets after ${target.runtime} PostgreSQL ${target.version} recreation`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root =
              target.runtime !== "native"
                ? yield* makeDockerDatabaseRoot("stack-default-key-", "default-key-test")
                : yield* fs.makeTempDirectoryScoped({ prefix: "stack-default-key-" });
            const recipe = yield* makeDatabase({
              stackId: "default-key-test",
              instanceId: "database",
              root,
              cacheRoot: artifactCacheRoot,
              runtime: target.runtime,
              ...(target.runtime !== "native" ? { engineTarget } : {}),
            });
            const defaults: DatabaseConfig = {
              healthTimeoutMs: 120_000,
              version: target.version,
              databasePassword: config.databasePassword,
              jwtSecret: config.jwtSecret,
              jwtExpiry: config.jwtExpiry,
            };
            const service = yield* makeStandaloneService(recipe.definition, {
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
              "CREATE EXTENSION IF NOT EXISTS pgsodium",
            );
            yield* query(
              endpoint,
              defaults.databasePassword,
              "CREATE EXTENSION IF NOT EXISTS supabase_vault",
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
              const secondService = yield* makeStandaloneService(second.definition, {
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
        const service = yield* makeStandaloneService(database.definition, {
          id: "database:hba",
          config,
        });
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
        yield* query(endpoint, config.databasePassword, "CREATE EXTENSION dblink");
        yield* query(
          endpoint,
          config.databasePassword,
          "CREATE ROLE dblink_probe LOGIN PASSWORD 'probe-password'",
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

  it.live("native PostgreSQL verifies outbound HTTPS against the configured CA bundle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const certs = yield* path.fromFileUrl(new URL("../../tests/certs", import.meta.url));
        const key = yield* fs.readFileString(path.join(certs, "localhost.key"));
        const serveHttps = (certificate: string) =>
          fs.readFileString(path.join(certs, certificate)).pipe(
            Effect.flatMap((cert) =>
              Effect.acquireRelease(
                Effect.try(() =>
                  Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    tls: { key, cert },
                    fetch: () => new Response("verified"),
                  }),
                ),
                (server) => Effect.promise(() => server.stop(true)),
              ),
            ),
          );
        const trusted = yield* serveHttps("trusted.crt");
        const untrusted = yield* serveHttps("untrusted.crt");
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-tls-" });
        const bundle = path.join(root, "trusted.crt");
        yield* fs.copyFile(path.join(certs, "trusted.crt"), bundle);
        yield* fs.chmod(bundle, 0o644);
        const database = yield* makeDatabase({
          stackId: "stack-database-tls",
          instanceId: "tls",
          root,
          cacheRoot: artifactCacheRoot,
          runtime: "native",
        });
        const service = yield* makeStandaloneService(database.definition, {
          id: "database:tls",
          config,
        });
        yield* service.start.pipe(
          Effect.provide(
            ConfigProvider.layerAdd(ConfigProvider.fromEnvRecord({ SSL_CERT_FILE: bundle }), {
              asPrimary: true,
            }),
          ),
        );
        yield* service.ready;
        const endpoint = yield* database.endpoint;
        yield* query(
          endpoint,
          config.databasePassword,
          "CREATE EXTENSION http WITH SCHEMA extensions; CREATE EXTENSION pg_net",
        );
        expect(
          yield* query(
            endpoint,
            config.databasePassword,
            `SELECT status, content FROM extensions.http_get('https://127.0.0.1:${trusted.port}/')`,
          ),
        ).toEqual([{ status: 200, content: "verified" }]);
        const [request] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ id: Schema.String })]),
        )(
          yield* query(
            endpoint,
            config.databasePassword,
            `SELECT net.http_get('https://127.0.0.1:${trusted.port}/') AS id`,
          ),
        );
        expect(
          yield* query(
            endpoint,
            config.databasePassword,
            `SELECT status, message, (response).status_code FROM net._http_collect_response(${request.id}, async := false)`,
          ),
        ).toEqual([{ status: "SUCCESS", message: "ok", status_code: 200 }]);
        const rejected = yield* query(
          endpoint,
          config.databasePassword,
          `SELECT status FROM extensions.http_get('https://127.0.0.1:${untrusted.port}/')`,
        ).pipe(Effect.flip);
        expect(rejected.reason.cause).toMatchObject({
          message: expect.stringContaining("self-signed certificate"),
        });
        yield* service.destroy;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live(
    "native PostgreSQL defaults SSL_CERT_FILE to a host CA bundle and resolves each SSL_CERT_DIR entry",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-trust-env-" });
          const database = yield* makeDatabase({
            stackId: "stack-database-trust-env",
            instanceId: "trust-env",
            root,
            cacheRoot: artifactCacheRoot,
            runtime: "native",
          });
          const service = yield* makeStandaloneService(database.definition, {
            id: "database:trust-env",
            config,
          });
          yield* service.start.pipe(
            Effect.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromEnvRecord(
                  { SSL_CERT_FILE: "", SSL_CERT_DIR: ":certs-a::certs-b" },
                  { preserveEmptyStrings: true },
                ),
                { asPrimary: true },
              ),
            ),
          );
          yield* service.ready;
          const endpoint = yield* database.endpoint;
          yield* query(
            endpoint,
            config.databasePassword,
            `CREATE TABLE server_env (file text, dir text); COPY server_env FROM PROGRAM 'printf "%s\\t%s\\n" "$SSL_CERT_FILE" "$SSL_CERT_DIR"'`,
          );
          const [serverEnv] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ file: Schema.String, dir: Schema.String })]),
          )(yield* query(endpoint, config.databasePassword, "SELECT file, dir FROM server_env"));
          expect({ ...serverEnv, exists: yield* fs.exists(serverEnv.file) }).toEqual({
            file: expect.stringMatching(/^\//u),
            exists: true,
            dir: `:${path.resolve("certs-a")}::${path.resolve("certs-b")}`,
          });
          yield* service.destroy;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  for (const version of ["15", "17"])
    it.live(`runs native PostgreSQL ${version} cron jobs in supautils-guarded workers`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-cron-" });
          const database = yield* makeDatabase({
            stackId: "stack-integration",
            instanceId: "cron",
            root,
            cacheRoot: artifactCacheRoot,
            runtime: "native",
          });
          const databaseConfig = { ...config, version };
          const service = yield* makeStandaloneService(database.definition, {
            id: "database:cron",
            config: databaseConfig,
          });
          yield* service.start;
          yield* service.ready;
          const endpoint = yield* database.endpoint;
          const asPostgres = (statement: string) =>
            query(endpoint, config.databasePassword, statement, "postgres", "postgres");
          yield* asPostgres("CREATE EXTENSION pg_cron");
          yield* query(
            endpoint,
            config.databasePassword,
            `CREATE FUNCTION report_cron_run() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              PERFORM pg_notify('cron_runs', (SELECT jobname FROM cron.job WHERE jobid = NEW.jobid)
                || ': ' || NEW.status || ': ' || coalesce(NEW.return_message, ''));
              RETURN NEW;
            END $$`,
          );
          yield* query(
            endpoint,
            config.databasePassword,
            `CREATE TRIGGER report_cron_run AFTER INSERT OR UPDATE ON cron.job_run_details
              FOR EACH ROW WHEN (NEW.status IN ('succeeded', 'failed'))
              EXECUTE FUNCTION report_cron_run()`,
          );
          const sql = Context.get(
            yield* Layer.build(
              PgClient.layer({
                host: endpoint.kind === "unix" ? endpoint.path : endpoint.host,
                port: endpoint.port,
                database: "postgres",
                username: "supabase_admin",
                password: config.databasePassword,
              }),
            ),
            PgClient.PgClient,
          );
          const cronRun = (name: string, command: string) =>
            Effect.gen(function* () {
              /* Jobs repeat every second, so a run reported before LISTEN is ready is not lost. */
              const run = yield* sql.listen("cron_runs").pipe(
                Effect.map((notifications) =>
                  Stream.fromQueue(notifications).pipe(
                    Stream.map((notification) => notification.payload),
                    Stream.filter((message) => message.startsWith(`${name}: `)),
                  ),
                ),
                Stream.unwrap,
                Stream.runHead,
                Effect.forkScoped({ startImmediately: true }),
              );
              yield* asPostgres(`SELECT cron.schedule('${name}', '1 seconds', $$${command}$$)`);
              const message = yield* Fiber.join(run).pipe(Effect.timeout("60 seconds"));
              yield* asPostgres(`SELECT cron.unschedule('${name}')`);
              return Option.getOrElse(message, () => "");
            });
          expect(yield* cronRun("own_job", "SELECT 1")).toContain("own_job: succeeded");
          expect(yield* cronRun("reserved_role", "ALTER ROLE anon LOGIN")).toContain(
            'reserved_role: failed: ERROR: "anon" is a reserved role',
          );
          const settings = Effect.flatMap(database.endpoint, (current) =>
            query<{ workers: string; cron: string; preload: string }>(
              current,
              config.databasePassword,
              "SELECT current_setting('max_worker_processes') AS workers, current_setting('cron.use_background_workers') AS cron, current_setting('shared_preload_libraries') AS preload",
            ),
          );
          const [initial] = yield* settings;
          expect(initial).toMatchObject({ workers: "17", cron: "on" });
          yield* service.restart({ ...databaseConfig, stopGraceSeconds: 0 });
          yield* service.ready;
          const [shadow] = yield* settings;
          expect(shadow).toMatchObject({ workers: "8", cron: "off" });
          expect(initial?.preload).toBe(`${shadow?.preload},supautils`);
          yield* query(
            yield* database.endpoint,
            config.databasePassword,
            "ALTER SYSTEM SET max_worker_processes = 32",
          );
          yield* service.restart(databaseConfig);
          yield* service.ready;
          expect(yield* settings).toMatchObject([{ workers: "32", cron: "on" }]);
          yield* service.destroy;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    );

  it.live("bounds the native configuration probe before first boot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-probe-" });
        const database = yield* makeDatabase({
          stackId: "stack-integration",
          instanceId: "probe",
          root,
          cacheRoot: artifactCacheRoot,
          runtime: "native",
        });
        const service = yield* makeStandaloneService(database.definition, {
          id: "database:probe",
          config: { ...config, healthTimeoutMs: 0 },
        });
        const failure = yield* service.start.pipe(Effect.flip);
        expect(String(failure)).toContain("PostgreSQL configuration probe timed out");
        expect(yield* fs.readDirectory(`${root}/probe/data`)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );

  it.live(
    "replaces a socket directory a killed owner left behind and removes its own on stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-database-leftover-" });
          // The derived name is computed here independently of production code.
          const socketDirectory = `${yield* fs.realPath("/tmp")}/supabase-${process.getuid?.() ?? 0}/pg-${createHash(
            "sha256",
          )
            .update(`${root}\0leftover`)
            .digest("hex")
            .slice(0, 16)}`;
          yield* fs.makeDirectory(socketDirectory, { recursive: true, mode: 0o700 });
          yield* fs.writeFileString(`${socketDirectory}/stale.marker`, "left by a killed owner\n");
          const database = yield* makeDatabase({
            stackId: "stack-integration",
            instanceId: "leftover",
            root,
            cacheRoot: artifactCacheRoot,
            runtime: "native",
          });
          const service = yield* makeStandaloneService(database.definition, {
            id: "database:leftover",
            config,
          });

          yield* service.start;
          yield* service.ready;

          const endpoint = yield* database.endpoint;
          expect(endpoint).toMatchObject({ kind: "unix", path: socketDirectory });
          expect(yield* fs.exists(`${socketDirectory}/stale.marker`)).toBe(false);
          expect(yield* query(endpoint, config.databasePassword, "SELECT 1 AS ok")).toEqual([
            { ok: 1 },
          ]);
          yield* service.stop;
          expect(yield* fs.exists(socketDirectory)).toBe(false);
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
          const service = yield* makeStandaloneService(first.definition, {
            id: "database:first",
            config: loggedConfig,
          });
          const observed = yield* Ref.make("");
          const caughtUp = yield* Deferred.make<void>();
          yield* Stream.fromSubscription(yield* first.logs).pipe(
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
            "ALTER ROLE supabase_admin SET log_statement = 'all'",
          );
          yield* query(
            firstEndpoint,
            config.databasePassword,
            "ALTER ROLE supabase_admin SET log_min_duration_statement = 0",
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
          const reopenedService = yield* makeStandaloneService(reopened.definition, {
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
          const secondService = yield* makeStandaloneService(second.definition, {
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
            runtime: testEngine,
            engineTarget,
          });
          const service = yield* makeStandaloneService(database.definition, {
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
            runtime: testEngine,
            engineTarget,
          });
          const replacementPassword = Redacted.make("reopened-target-password");
          const reopenedService = yield* makeStandaloneService(reopened.definition, {
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

  // The storage helper joins the compose project only with the Docker volume backend.
  describe.runIf(testEngine === "docker")("Docker volume storage", () => {
    it.live("groups the database and its storage helper under one compose project", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const stackId = "stack-compose-group";
          const root = yield* makeDockerDatabaseRoot("stack-database-group-", stackId);
          const database = yield* makeDatabase({
            stackId,
            instanceId: "database",
            project: "my.app",
            root,
            cacheRoot: artifactCacheRoot,
            runtime: testEngine,
            engineTarget,
          });
          const service = yield* makeStandaloneService(database.definition, {
            id: "database:group",
            config,
          });
          yield* service.start;
          yield* service.ready;
          const listed = yield* runEngine([
            ...engineTarget.argv,
            "ps",
            "--filter",
            `label=com.supabase.stack-root=${path.resolve(root)}`,
            "--format",
            '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
          ]);
          const rows = listed.output
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => line.trim().split("|"));
          expect(rows.some(([name]) => name?.startsWith("supabase-db-helper-"))).toBe(true);
          expect(new Set(rows.map(([, project]) => project))).toEqual(
            new Set(["supabase-my-app-stack-compos"]),
          );
          expect(new Set(rows.map(([, , group]) => group))).toEqual(
            new Set(["database", "database-helper"]),
          );
          yield* service.destroy;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    );
  });

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
          runtime: testEngine,
          engineTarget,
        });
        const service = yield* makeStandaloneService(database.definition, {
          id: "database:shutdown",
          config: { ...config, stopGraceSeconds: 30 },
        });
        yield* service.start;
        yield* service.ready;
        const endpoint = yield* database.endpoint;
        if (endpoint.kind !== "tcp") return yield* Effect.die("Expected a TCP endpoint");
        const listed = yield* runEngine([
          ...engineTarget.argv,
          "ps",
          "--filter",
          `label=com.supabase.stack-root=${path.resolve(root)}`,
          "--filter",
          "label=com.supabase.instance=database",
          "--format",
          "{{.Names}}",
        ]);
        // The shared volume helper carries the same stack-root/instance labels; exclude it by name.
        const containers = listed.output
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => name.length > 0 && !name.startsWith("supabase-db-helper-"));
        expect(containers).toHaveLength(1);
        const container = containers.join("");
        const startedAt = yield* runEngine([
          ...engineTarget.argv,
          "inspect",
          "--format",
          "{{json .State.StartedAt}}",
          container,
        ]);

        const observed = yield* observeContainerStop(
          container,
          startedAt.output.trim().replaceAll('"', ""),
        );

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

        expect(
          yield* Fiber.join(observed),
          "stop sends SIGINT and PostgreSQL exits cleanly",
        ).toEqual(cleanStopEvents);
        yield* service.destroy;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
