import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Redacted, Ref } from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { tmpdir } from "node:os";
import * as Network from "../Network.ts";
import * as State from "../State.ts";
import { makeService } from "../Service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { cleanupDockerRoot } from "../../tests/docker-cleanup.ts";

const makeTestState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const makeTestNetwork = (options: {
  readonly stackId: string;
  readonly runtime: Network.NetworkRuntime;
  readonly state: State.Interface;
}) =>
  Layer.build(
    Network.layer({ stackId: options.stackId, runtime: options.runtime }).pipe(
      Layer.provide(Layer.succeed(State.Service, options.state)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Network.Service)));

const options = (root: string) => ({
  stackId: "catalog-test",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "native" as const,
});

const dockerOptions = (root: string) => ({
  ...options(root),
  runtime: "docker" as const,
});

describe("service catalog", () => {
  it.live(
    "routes PostgREST through an owned database public endpoint",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-rest-" });
          yield* Effect.addFinalizer(() => cleanupDockerRoot(root));
          const stackId = "catalog-network";
          const state = yield* makeTestState(root + "/state");
          yield* state.save({
            id: stackId,
            identity: { projectRoot: root, branchContext: "test", stackName: "catalog" },
            runtime: "docker",
            instances: [],
            composition: {},
            ports: [],
          });
          const network = yield* makeTestNetwork({ stackId, runtime: "docker", state });
          const secret = "catalog-rest-secret-with-at-least-32-chars";
          const databaseRecipe = yield* makeServiceRecipe(
            {
              service: "database",
              config: {
                version: "17",
                databasePassword: Redacted.make("postgres"),
                jwtSecret: Redacted.make(secret),
                jwtExpiry: 3600,
              },
            },
            dockerOptions(root),
          );
          const database = yield* makeService(databaseRecipe.definition, {
            id: "database",
            config: databaseRecipe.creation,
          });
          const databaseActive = yield* Ref.make(true);
          const databaseNamespace = yield* network.register({
            id: "database",
            endpoints: {
              sql: {
                protocol: "tcp",
                port: "auto",
                enabled: Ref.get(databaseActive),
                backend: databaseRecipe.endpoint("sql").pipe(
                  Effect.flatMap((endpoint) =>
                    endpoint.kind === "tcp" && endpoint.host !== undefined
                      ? Effect.succeed({ host: endpoint.host, port: endpoint.port })
                      : Effect.fail(new ProxyError({ message: "Database endpoint is not TCP" })),
                  ),
                  Effect.mapError((cause) =>
                    cause instanceof ProxyError
                      ? cause
                      : new ProxyError({ message: cause.message, cause }),
                  ),
                ),
              },
            },
          });
          yield* databaseNamespace.bind;
          const databaseRuntimeAddress = yield* databaseNamespace.address("sql", "runtime");
          const databaseHostAddress = yield* databaseNamespace.address("sql", "host");
          yield* database.start;
          yield* database.ready;
          const databaseLayer = yield* Layer.build(
            PgClient.layer({
              host: databaseHostAddress.host,
              port: databaseHostAddress.port,
              database: "postgres",
              username: "supabase_admin",
              password: Redacted.make("postgres"),
            }),
          );
          const sql = Context.get(databaseLayer, PgClient.PgClient);
          yield* sql.unsafe(
            "CREATE TABLE IF NOT EXISTS public.catalog_probe (id integer PRIMARY KEY, value text NOT NULL);",
          );
          yield* sql.unsafe("GRANT SELECT ON public.catalog_probe TO anon;");
          yield* sql.unsafe("TRUNCATE public.catalog_probe;");
          yield* sql.unsafe("INSERT INTO public.catalog_probe (id, value) VALUES (1, 'catalog');");

          const restRecipe = yield* makeServiceRecipe(
            {
              service: "rest",
              config: {
                databaseUrl:
                  "postgresql://supabase_admin:postgres@" +
                  databaseRuntimeAddress.host +
                  ":" +
                  databaseRuntimeAddress.port +
                  "/postgres",
                jwtSecret: secret,
                anonRole: "anon",
              },
            },
            dockerOptions(root),
          );
          const rest = yield* makeService(restRecipe.definition, {
            id: "rest",
            config: restRecipe.creation,
          });
          const restActive = yield* Ref.make(true);
          const restNamespace = yield* network.register({
            id: "rest",
            endpoints: {
              http: {
                protocol: "http",
                port: "auto",
                enabled: Ref.get(restActive),
                backend: restRecipe.endpoint("http").pipe(
                  Effect.flatMap((endpoint) =>
                    endpoint.host === undefined
                      ? Effect.fail(new ProxyError({ message: "REST endpoint has no host" }))
                      : Effect.succeed({ host: endpoint.host, port: endpoint.port }),
                  ),
                  Effect.mapError((cause) => new ProxyError({ message: cause.message, cause })),
                ),
              },
            },
          });
          yield* restNamespace.bind;
          const publicAddress = yield* restNamespace.address("http", "host");
          yield* rest.start;
          yield* rest.ready;
          const token = yield* Effect.tryPromise(() =>
            new SignJWT({ role: "anon" })
              .setProtectedHeader({ alg: "HS256", typ: "JWT" })
              .setIssuedAt()
              .setExpirationTime("1h")
              .sign(new TextEncoder().encode(secret)),
          );
          const response = yield* client.execute(
            HttpClientRequest.get(
              "http://" + publicAddress.host + ":" + publicAddress.port + "/catalog_probe",
            ).pipe(HttpClientRequest.setHeader("Authorization", "Bearer " + token)),
          );
          const responseBody = yield* response.text;
          expect(response.status).toBe(200);
          expect(responseBody).toContain("catalog");

          yield* rest.stop;
          yield* Ref.set(restActive, false);
          yield* restNamespace.close;
          yield* restNamespace.release;
          yield* database.stop;
          yield* Ref.set(databaseActive, false);
          yield* databaseNamespace.close;
          yield* databaseNamespace.release;
          yield* network.release;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live("routes native PostgREST to the owned database Unix socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-rest-native-" });
        const stackId = "catalog-native";
        const secret = "catalog-native-secret-with-at-least-32-chars";
        const databaseRecipe = yield* makeServiceRecipe(
          {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("postgres"),
              jwtSecret: Redacted.make(secret),
              jwtExpiry: 3600,
            },
          },
          { ...options(root), stackId, cacheRoot: `${tmpdir()}/supabase-stack-artifacts` },
        );
        const database = yield* makeService(databaseRecipe.definition, {
          id: "database",
          config: databaseRecipe.creation,
        });
        yield* database.start;
        yield* database.ready;
        const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
        if (databaseEndpoint.kind !== "unix" || databaseEndpoint.path === undefined)
          return yield* new ProxyError({ message: "Native database did not expose a Unix socket" });
        const databaseLayer = yield* Layer.build(
          PgClient.layer({
            host: databaseEndpoint.path,
            port: databaseEndpoint.port,
            database: "postgres",
            username: "supabase_admin",
            password: Redacted.make("postgres"),
          }),
        );
        const sql = Context.get(databaseLayer, PgClient.PgClient);
        yield* sql.unsafe(
          "CREATE TABLE IF NOT EXISTS public.catalog_native_probe (id integer PRIMARY KEY, value text NOT NULL);",
        );
        yield* sql.unsafe("GRANT SELECT ON public.catalog_native_probe TO anon;");
        yield* sql.unsafe("TRUNCATE public.catalog_native_probe;");
        yield* sql.unsafe(
          "INSERT INTO public.catalog_native_probe (id, value) VALUES (1, 'catalog-native');",
        );
        const restRecipe = yield* makeServiceRecipe(
          {
            service: "rest",
            config: {
              databaseUrl:
                "postgresql://supabase_admin:postgres@127.0.0.1/postgres?host=" +
                encodeURIComponent(databaseEndpoint.path),
              jwtSecret: secret,
              anonRole: "anon",
            },
          },
          { ...options(root), stackId, cacheRoot: `${tmpdir()}/supabase-stack-artifacts` },
        );
        const rest = yield* makeService(restRecipe.definition, {
          id: "rest",
          config: restRecipe.creation,
        });
        yield* rest.start;
        yield* rest.ready;
        const endpoint = yield* restRecipe.endpoint("http");
        const token = yield* Effect.tryPromise(() =>
          new SignJWT({ role: "anon" })
            .setProtectedHeader({ alg: "HS256", typ: "JWT" })
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(new TextEncoder().encode(secret)),
        );
        const response = yield* client.execute(
          HttpClientRequest.get(
            "http://" + endpoint.host + ":" + endpoint.port + "/catalog_native_probe",
          ).pipe(HttpClientRequest.setHeader("Authorization", "Bearer " + token)),
        );
        const responseBody = yield* response.text;
        expect(response.status).toBe(200);
        expect(responseBody).toContain("catalog-native");
        yield* rest.stop;
        yield* database.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  );
});
