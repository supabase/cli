import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Redacted, Ref, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { RpcTest } from "effect/unstable/rpc";
import * as Owner from "./Owner.ts";
import { OwnerRpc } from "./Rpc.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as StackNamespace from "./StackNamespace.ts";
import type { SavedStack } from "./StackNamespace.ts";
import { DEFAULT_LOCAL_JWT_SECRET } from "./Defaults.ts";
import { ServiceCreation, type ServiceCreationInput } from "./services/Catalog.ts";
import { ownerFor } from "../tests/owner-rpc.ts";
import { dockerEngineTarget } from "../tests/engine-target.ts";
import { makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";

const stateFor = (root: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(StackNamespace.layer({ root }));
    return Context.get(context, StackNamespace.Service);
  });

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

const initial = (id: string): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "owner-test", stackName: id },
  runtime: "native",
  instances: [],
  lifetime: "detached",
  composition: { members: [], dependencies: [] },
});

const initialDocker = (id: string): SavedStack => ({ ...initial(id), runtime: "docker" });

/** Container ids docker still reports for `stackId`, by the label every instance container carries. */
/**
 * Container ids docker still reports for `instanceId`, by the labels an instance's own containers
 * carry. Excludes a stack-wide shared volume helper (labeled only with the stack, never the
 * instance), which outlives any one instance's destroy and is torn down on its own lifecycle.
 */
const containersForInstance = (stackId: string, instanceId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          [
            "ps",
            "-a",
            "--filter",
            `label=com.supabase.stack=${stackId}`,
            "--filter",
            `label=com.supabase.instance=${instanceId}`,
            "--format",
            "{{.ID}} {{.Names}} {{.Image}} {{.Status}}",
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** Runs a Docker CLI command and returns its combined stdout, for assertions against the engine. */
const runDocker = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
      );
      return yield* Stream.mkString(Stream.decodeText(child.stdout));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** The fields read directly off a database instance's own storage marker file. */
const InstanceMarker = Schema.Struct({
  backend: Schema.Literals(["docker", "host"]),
  volume: Schema.optionalKey(Schema.String),
  namespace: Schema.String,
});

const query = (url: string, statement: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const parsed = new URL(url);
      const services = yield* Layer.build(
        PgClient.layer({
          host: parsed.hostname,
          port: Number(parsed.port),
          database: parsed.pathname.slice(1),
          username: decodeURIComponent(parsed.username),
          password: Redacted.make(decodeURIComponent(parsed.password)),
        }),
      );
      return yield* Context.get(services, PgClient.PgClient).unsafe(statement);
    }),
  );

it.effect("credential lookup leaves a fresh stack untouched for custom database credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-credentials-" });
      const stack = initial("owner-credentials");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({
        saved: stack,
        state,
        root: `${root}/data`,
        cacheRoot,
      });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

      const failure = yield* owner.getStackCredentials.pipe(Effect.flip);
      expect(failure.message).toContain("have not been established");
      expect((yield* state.read(stack.id))?.credentials).toBeUndefined();

      const jwtSecret = "custom-owner-credentials-jwt-secret-long-enough";
      yield* owner.rpc.createService({
        service: "database",
        config: {
          version: "17",
          databasePassword: Redacted.make("owner-credentials-database-password"),
          jwtSecret: Redacted.make(jwtSecret),
          jwtExpiry: 3600,
        },
        endpoints: { sql: { port: "auto" } },
      });
      expect((yield* state.read(stack.id))?.credentials?.jwtSecret).toBe(jwtSecret);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("forwards and rotates saved identity across composed services in one owner", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-identity-rotation-" });
      const stack = initial("a".repeat(64));
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({
        saved: stack,
        state,
        root: `${root}/data`,
        cacheRoot,
      });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

      const servicesFor = (jwtSecret?: string): ReadonlyArray<ServiceCreationInput> => [
        {
          service: "database" as const,
          config: {
            version: "17",
            databasePassword: Redacted.make("identity-rotation-password"),
            jwtExpiry: 3600,
            ...(jwtSecret === undefined ? {} : { jwtSecret: Redacted.make(jwtSecret) }),
          },
          endpoints: { sql: { port: "auto" as const } },
        },
        {
          service: "rest" as const,
          config: {},
          endpoints: { http: { port: "auto" as const } },
        },
        {
          service: "auth" as const,
          config: {},
          endpoints: { http: { port: "auto" as const } },
        },
        {
          service: "storage" as const,
          config: { filePath: `${root}/uploads` },
          endpoints: { http: { port: "auto" as const } },
        },
        {
          service: "realtime" as const,
          config: {},
          endpoints: { http: { port: "auto" as const } },
        },
        {
          service: "functions" as const,
          config: { functionsRoot: `${root}/functions`, bootstrap: "export {};" },
          endpoints: { http: { port: "auto" as const } },
        },
        {
          service: "studio" as const,
          config: {},
          endpoints: { http: { port: "auto" as const } },
        },
      ];
      const stackKeys = (suffix: string, gotrueJwtKeys: string): StackNamespace.StackKeysInput => ({
        publishableKey: `publishable-${suffix}`,
        secretKey: `secret-${suffix}`,
        anonKey: `anon-${suffix}`,
        serviceRoleKey: `service-role-${suffix}`,
        gotrueJwtKeys,
        publicSigningKeys: "[]",
        anonKeyIsOverride: true,
        serviceRoleKeyIsOverride: true,
      });
      const customJwtSecret = "custom-owner-rotation-jwt-secret-long-enough";
      const services = servicesFor(customJwtSecret);
      const first = yield* owner.rpc.supabaseComposition({
        services: services,
        keys: stackKeys("one", "[]"),
      });
      const ids = first.map(({ id }) => id);
      const creationFor = (entries: typeof first, service: string) =>
        entries.find((entry) => entry.creation.service === service)?.creation;
      const firstCredentials = yield* state
        .read(stack.id)
        .pipe(Effect.map((saved) => saved?.credentials));
      if (firstCredentials === undefined) return yield* Effect.die("identity was not persisted");
      expect(firstCredentials.jwtSecret).toBe(customJwtSecret);
      expect(yield* owner.getStackCredentials).toEqual(firstCredentials);
      const firstRest = creationFor(first, "rest");
      const firstStorage = creationFor(first, "storage");
      const firstRealtime = creationFor(first, "realtime");
      const firstFunctions = creationFor(first, "functions");
      const firstStudio = creationFor(first, "studio");
      const firstAuth = creationFor(first, "auth");
      if (
        firstRest?.service !== "rest" ||
        firstStorage?.service !== "storage" ||
        firstRealtime?.service !== "realtime" ||
        firstFunctions?.service !== "functions" ||
        firstStudio?.service !== "studio" ||
        firstAuth?.service !== "auth"
      )
        return yield* Effect.die("identity consumers are missing");
      expect(firstRest.config.jwks).toBe(firstCredentials.jwks);
      expect(firstStorage.config).toMatchObject({
        jwks: firstCredentials.jwks,
        anonKey: firstCredentials.anonKey,
        serviceRoleKey: firstCredentials.serviceRoleKey,
      });
      expect(firstRealtime.config.jwks).toBe(firstCredentials.jwks);
      expect(firstFunctions.config).toMatchObject({
        jwks: firstCredentials.jwks,
        anonKey: firstCredentials.anonKey,
        serviceRoleKey: firstCredentials.serviceRoleKey,
        publishableKey: firstCredentials.publishableKey,
        secretKey: firstCredentials.secretKey,
      });
      expect(firstStudio.config).toMatchObject({
        anonKey: firstCredentials.anonKey,
        serviceRoleKey: firstCredentials.serviceRoleKey,
        publishableKey: firstCredentials.publishableKey,
        secretKey: firstCredentials.secretKey,
      });
      expect(firstAuth.config.gotrueJwtKeys).toBe(firstCredentials.gotrueJwtKeys);

      const standaloneRest = yield* owner.rpc.createService({
        service: "rest",
        config: {},
        endpoints: {},
      });
      expect(standaloneRest.creation.config).toMatchObject({
        jwtSecret: customJwtSecret,
        jwks: firstCredentials.jwks,
      });
      const standaloneAuth = yield* owner.rpc.createService({
        service: "auth",
        config: {},
        endpoints: {},
      });
      expect(standaloneAuth.creation.config).toMatchObject({
        jwtSecret: customJwtSecret,
        gotrueJwtKeys: firstCredentials.gotrueJwtKeys,
      });
      const standaloneStorage = yield* owner.rpc.createService({
        service: "storage",
        config: { filePath: `${root}/standalone-uploads` },
        endpoints: {},
      });
      expect(standaloneStorage.creation.config).toMatchObject({
        jwtSecret: customJwtSecret,
        jwks: firstCredentials.jwks,
        anonKey: firstCredentials.anonKey,
        serviceRoleKey: firstCredentials.serviceRoleKey,
      });
      const standaloneFunctions = yield* owner.rpc.createService({
        service: "functions",
        config: {
          functionsRoot: `${root}/standalone-functions`,
          bootstrap: "export {};",
          jwks: "refreshed-functions-jwks",
        },
        endpoints: {},
      });
      expect(standaloneFunctions.creation.config).toMatchObject({
        jwtSecret: customJwtSecret,
        jwks: "refreshed-functions-jwks",
        anonKey: firstCredentials.anonKey,
        serviceRoleKey: firstCredentials.serviceRoleKey,
      });

      yield* owner.rpc.stopComposition();
      const secondServices = servicesFor().filter((creation) => creation.service !== "studio");
      const studioId = first.find(({ creation }) => creation.service === "studio")?.id;
      if (studioId === undefined) return yield* Effect.die("Studio ID is missing");
      const retainedIds = ids.filter((id) => id !== studioId);
      const second = yield* owner.rpc.supabaseComposition({
        services: secondServices,
        keys: stackKeys("two", "[{}]"),
        reuseIds: retainedIds,
      });
      const secondCredentials = yield* state
        .read(stack.id)
        .pipe(Effect.map((saved) => saved?.credentials));
      if (secondCredentials === undefined)
        return yield* Effect.die("rotated identity was not saved");
      expect(secondCredentials.jwtSecret).toBe(DEFAULT_LOCAL_JWT_SECRET);
      expect(secondCredentials.anonKey).toBe("anon-two");
      expect(secondCredentials.publishableKey).toBe("publishable-two");
      expect(creationFor(second, "rest")?.config).toMatchObject({ jwks: secondCredentials.jwks });
      expect(creationFor(second, "realtime")?.config).toMatchObject({
        jwks: secondCredentials.jwks,
      });
      expect(creationFor(second, "storage")?.config).toMatchObject({
        jwks: secondCredentials.jwks,
        anonKey: secondCredentials.anonKey,
        serviceRoleKey: secondCredentials.serviceRoleKey,
      });
      expect(creationFor(second, "functions")?.config).toMatchObject({
        jwks: secondCredentials.jwks,
        anonKey: secondCredentials.anonKey,
        serviceRoleKey: secondCredentials.serviceRoleKey,
        publishableKey: secondCredentials.publishableKey,
        secretKey: secondCredentials.secretKey,
      });
      expect(creationFor(second, "auth")?.config).toMatchObject({
        gotrueJwtKeys: secondCredentials.gotrueJwtKeys,
      });
      expect(second.some(({ id }) => id === studioId)).toBe(false);
      expect((yield* owner.rpc.status({ id: studioId })).lifecycle).toBe("stopped");
      const excludedStudio = (yield* owner.rpc.status({ id: studioId })).config;
      expect(excludedStudio.service).toBe("studio");
      if (excludedStudio.service === "studio")
        expect(excludedStudio.config.anonKey).toBe("anon-one");
      for (const id of retainedIds)
        expect((yield* owner.rpc.status({ id: id })).lifecycle).toBe("stopped");

      yield* owner.rpc.stopComposition();
      const third = yield* owner.rpc.supabaseComposition({
        services: servicesFor(customJwtSecret),
        keys: stackKeys("three", "[]"),
        reuseIds: ids,
      });
      const thirdCredentials = yield* state
        .read(stack.id)
        .pipe(Effect.map((saved) => saved?.credentials));
      expect(thirdCredentials?.jwtSecret).toBe(customJwtSecret);
      expect(creationFor(third, "studio")?.config).toMatchObject({
        anonKey: "anon-three",
        publishableKey: "publishable-three",
      });

      const credentialConflict = yield* owner.rpc
        .supabaseComposition({
          services: servicesFor("different-owner-jwt-secret-long-enough"),
          reuseIds: ids,
        })
        .pipe(Effect.flip);
      expect(credentialConflict.message).toContain("Credential override jwtSecret conflicts");
      expect(
        (yield* state.read(stack.id).pipe(Effect.map((saved) => saved?.credentials)))?.jwtSecret,
      ).toBe(customJwtSecret);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.effect("publishes service removal and composition pruning together", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-remove-" });
      const stack = initial("owner-remove");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const removalWrite = yield* Ref.make(false);
      const failingState: StackNamespace.Interface = {
        ...state,
        save: (next) =>
          Ref.get(removalWrite).pipe(
            Effect.flatMap((alreadyWritten) =>
              next.instances.length === 0
                ? alreadyWritten
                  ? Effect.fail(
                      new StackNamespace.NamespaceError({
                        operation: "write",
                        message: "injected failure",
                      }),
                    )
                  : Ref.set(removalWrite, true).pipe(Effect.andThen(state.save(next)))
                : state.save(next),
            ),
          ),
      };
      const owner = yield* ownerFor({
        saved: stack,
        state: failingState,
        root: `${root}/data`,
        cacheRoot,
      });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      const service = yield* owner.rpc.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
      });
      yield* owner.rpc.configureComposition({
        members: [{ id: service.id, activation: "eager" }],
        dependencies: [],
      });

      yield* owner.rpc.destroyService({ id: service.id });

      const saved = yield* state.read(stack.id);
      if (saved === undefined) return yield* Effect.die("saved state disappeared");
      expect(yield* Ref.get(removalWrite)).toBe(true);
      expect(saved.instances).toEqual([]);
      expect(saved.composition).toEqual({ members: [], dependencies: [] });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "assembles a database and lazy REST service, keeps standalone instances independent, and reopens ports",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-" });
        const stack = initial("owner-integration");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
        const database = yield* owner.rpc.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("owner-password"),
            jwtSecret: Redacted.make("owner-integration-jwt-secret-long-enough"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        const rest = yield* owner.rpc.createService({
          service: "rest",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        const shadow = yield* owner.rpc.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("owner-password"),
            jwtSecret: Redacted.make("owner-integration-jwt-secret-long-enough"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* owner.rpc.configureComposition({
          members: [
            { id: database.id, activation: "eager" },
            { id: rest.id, activation: "lazy", idleMillis: 30_000 },
          ],
          dependencies: [
            {
              from: database.id,
              to: rest.id,
              bindings: [{ output: "databaseUrl", input: "databaseUrl" }],
            },
          ],
        });
        yield* owner.rpc.startService({ id: shadow.id });
        yield* owner.rpc.readyService({ id: shadow.id });
        yield* owner.rpc.startComposition();
        const dbCredentials = yield* owner.rpc.credentials({ id: database.id, from: "host" });
        const databaseUrl = dbCredentials.databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("database credentials missing");
        yield* query(databaseUrl, "CREATE TABLE owner_rows(value text NOT NULL)");
        yield* query(databaseUrl, "INSERT INTO owner_rows(value) VALUES ('wake')");
        const restCredentials = yield* owner.rpc.credentials({ id: rest.id, from: "host" });
        const restUrl = restCredentials.url;
        if (restUrl === undefined) return yield* Effect.die("REST credentials missing");
        const restObservation = yield* owner.rpc.status({ id: rest.id });
        const restEndpoint = restObservation.endpoints.find((endpoint) => endpoint.name === "http");
        expect(restEndpoint?.host).toBe("127.0.0.1");
        expect(restEndpoint?.port).toBe(Number(new URL(restUrl).port));
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`${restUrl}/owner_rows`);
        expect(response.status).toBe(200);
        const body = yield* response.json;
        expect(body).toEqual([{ value: "wake" }]);
        expect((yield* owner.rpc.status({ id: shadow.id })).lifecycle).toBe("running");
        yield* owner.rpc.stopComposition();
        expect((yield* owner.rpc.status({ id: shadow.id })).lifecycle).toBe("running");
        const firstPort = new URL(databaseUrl).port;
        yield* owner.rpc.stopService({ id: database.id });
        yield* owner.rpc.startService({ id: database.id });
        yield* owner.rpc.readyService({ id: database.id });
        const reopened = yield* owner.rpc.credentials({ id: database.id, from: "host" });
        if (reopened.databaseUrl === undefined)
          return yield* Effect.die("reopened credentials missing");
        expect(new URL(reopened.databaseUrl).port).toBe(firstPort);
        yield* owner.namespace.stop;
        const reopenedOwner = yield* ownerFor({
          saved: (yield* state.read(stack.id)) ?? stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => reopenedOwner.namespace.destroy.pipe(Effect.ignore));
        expect((yield* state.read(stack.id))?.instances).toHaveLength(3);
        expect((yield* reopenedOwner.rpc.status({ id: database.id })).lifecycle).toBe("stopped");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.effect("isolates owner graphs built in one scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-layer-" });
      const state = yield* stateFor(`${root}/state`);
      const first = initial("owner-layer-first");
      const second = initial("owner-layer-second");
      yield* state.save(first);
      yield* state.save(second);
      const memoMap = yield* Layer.makeMemoMap;
      const scope = yield* Effect.scope;
      const buildOwner = (saved: SavedStack) =>
        Layer.buildWithMemoMap(
          Owner.layer({
            saved,
            root: `${root}/data`,
            cacheRoot,
          }).pipe(Layer.provide(Layer.succeed(StackNamespace.Service, state))),
          memoMap,
          scope,
        ).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
          Effect.flatMap((owner) =>
            RpcTest.makeClient(OwnerRpc).pipe(
              Effect.provide(OwnerRpc.toLayer(owner.handlers)),
              Effect.map((rpc) => ({ rpc, namespace: owner.namespace })),
            ),
          ),
        );
      const firstOwner = yield* buildOwner(first);
      const secondOwner = yield* buildOwner(second);
      yield* Effect.addFinalizer(() => firstOwner.namespace.destroy.pipe(Effect.ignore));
      yield* Effect.addFinalizer(() => secondOwner.namespace.destroy.pipe(Effect.ignore));
      const created = yield* firstOwner.rpc.createService({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
      });
      const isolated = yield* secondOwner.rpc
        .configureComposition({
          members: [{ id: created.id, activation: "eager" }],
          dependencies: [],
        })
        .pipe(Effect.flip);
      expect(isolated.operation).toBe("configureComposition");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "builds the default database, REST, and Mail composition with rendered bindings",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-factory-" });
        const stack = initial("owner-factory");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
        const created = yield* owner.rpc.supabaseComposition({
          services: [
            {
              service: "database",
              config: {
                version: "17",
                databasePassword: Redacted.make("owner-factory-password"),
                jwtSecret: Redacted.make("owner-factory-jwt-secret-long-enough"),
                jwtExpiry: 3600,
              },
              endpoints: { sql: { port: "auto" } },
            },
            {
              service: "rest",
              config: {},
              endpoints: { http: { port: "auto" } },
            },
            {
              service: "mail",
              config: {},
              endpoints: { http: { port: "auto" }, smtp: { port: "auto" } },
            },
          ],
        });
        const database = created.find((entry) => entry.creation.service === "database");
        const rest = created.find((entry) => entry.creation.service === "rest");
        const mail = created.find((entry) => entry.creation.service === "mail");
        if (database === undefined || rest === undefined || mail === undefined)
          return yield* Effect.die("factory did not create all requested services");
        if (rest.creation.service !== "rest") return yield* Effect.die("REST service missing");
        expect(rest.creation.config.databaseUrl).toContain("authenticator:");
        yield* owner.rpc.startComposition();
        const databaseCredentials = yield* owner.rpc.credentials({ id: database.id, from: "host" });
        const databaseUrl = databaseCredentials.databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("database URL missing");
        yield* query(databaseUrl, "CREATE TABLE factory_rows(value text NOT NULL)");
        yield* query(databaseUrl, "INSERT INTO factory_rows VALUES ('factory-row')");
        const restCredentials = yield* owner.rpc.credentials({ id: rest.id, from: "host" });
        const restUrl = restCredentials.url;
        if (restUrl === undefined) return yield* Effect.die("REST URL missing");
        const mailCredentials = yield* owner.rpc.credentials({ id: mail.id, from: "host" });
        expect(mailCredentials.smtpUrl).toMatch(/^smtp:\/\//u);
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`${restUrl}/factory_rows`);
        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual([{ value: "factory-row" }]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.effect("validates Supabase composition recipes before creating instances", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-factory-errors-" });
      const stack = initial("owner-factory-errors");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({
        saved: stack,
        state,
        root: `${root}/data`,
        cacheRoot,
      });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      const database = {
        service: "database" as const,
        config: {
          version: "17",
          databasePassword: Redacted.make("owner-errors-password"),
          jwtSecret: Redacted.make("owner-errors-jwt"),
          jwtExpiry: 3600,
        },
        endpoints: { sql: { port: "auto" as const } },
      };
      const duplicate = yield* owner.rpc
        .supabaseComposition({ services: [database, database] })
        .pipe(Effect.flip);
      expect(duplicate.operation).toBe("supabaseComposition");
      expect((yield* state.read(stack.id))?.instances).toHaveLength(0);
      const conflicting = yield* owner.rpc
        .supabaseComposition({
          services: [
            {
              service: "rest",
              config: {},
              endpoints: { http: { port: 41_001 } },
            },
            {
              service: "auth",
              config: {},
              endpoints: { http: { port: 41_002 } },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(conflicting.operation).toBe("supabaseComposition");
      expect((yield* state.read(stack.id))?.instances).toHaveLength(0);

      const badDataRoot = `${root}/data-file`;
      const badOwner = yield* ownerFor({
        saved: stack,
        state,
        root: badDataRoot,
        cacheRoot,
      });
      yield* Effect.addFinalizer(() => badOwner.namespace.destroy.pipe(Effect.ignore));
      yield* fs.makeDirectory(badDataRoot);
      yield* fs.remove(badDataRoot, { recursive: true });
      yield* fs.writeFileString(badDataRoot, "occupied");
      const registrationFailure = yield* badOwner.rpc.createService(database).pipe(Effect.flip);
      expect(registrationFailure.operation).toBe("createService");
      expect((yield* state.read(stack.id))?.instances).toHaveLength(0);

      const databaseWithoutSql = yield* owner.rpc.createService({
        service: "database",
        config: database.config,
        endpoints: {},
      });
      expect(yield* owner.rpc.credentials({ id: databaseWithoutSql.id, from: "host" })).toEqual({});

      const missingSql = yield* owner.rpc
        .supabaseComposition({
          services: [
            { ...database, endpoints: {} },
            {
              service: "rest",
              config: {},
              endpoints: { http: { port: "auto" } },
            },
          ],
        })
        .pipe(Effect.flip);
      expect(missingSql.message).toBe("database requires configured sql endpoint");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.effect("lets a retry choose other credentials after the first database creation failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "stack-owner-credential-rollback-",
      });
      const stack = initial("owner-credential-rollback");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const database = (password: string) => ({
        service: "database" as const,
        config: { version: "17", databasePassword: Redacted.make(password), jwtExpiry: 3600 },
        endpoints: {},
      });
      const badDataRoot = `${root}/data-file`;
      yield* fs.writeFileString(badDataRoot, "occupied");
      const failing = yield* ownerFor({ saved: stack, state, root: badDataRoot, cacheRoot });
      yield* Effect.addFinalizer(() => failing.namespace.destroy.pipe(Effect.ignore));

      yield* failing.rpc.createService(database("first-password")).pipe(Effect.flip);

      expect((yield* state.read(stack.id))?.credentials).toBeUndefined();
      const owner = yield* ownerFor({ saved: stack, state, root: `${root}/data`, cacheRoot });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      yield* owner.rpc.createService(database("second-password"));
      expect((yield* state.read(stack.id))?.credentials?.databasePassword).toBe("second-password");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.effect(
  "rejects a duplicate instance without releasing the existing instance's reservations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-duplicate-" });
        const state = yield* stateFor(`${root}/state`);
        const creation = yield* Schema.decodeEffect(ServiceCreation)({
          service: "mail",
          config: {},
          endpoints: { http: { port: "auto" } },
        });
        const instance = { id: "mail", creation };
        const stack: SavedStack = {
          ...initial(`owner-duplicate-${randomUUID().slice(0, 8)}`),
          instances: [instance],
        };
        yield* state.save(stack);
        const realStateRoot = yield* fs.realPath(`${root}/state`);
        const portReservations = yield* PortReservations.Service;
        expect(yield* portReservations.reserve(realStateRoot, stack.id, "mail:http", 54_321)).toBe(
          undefined,
        );
        yield* Effect.addFinalizer(() =>
          portReservations.release(realStateRoot, stack.id, "mail:http").pipe(Effect.ignore),
        );

        const failure = yield* ownerFor({
          saved: { ...stack, instances: [instance, instance] },
          state,
          root: `${root}/data`,
          cacheRoot,
        }).pipe(Effect.flip);

        expect(failure.message).toBe("Duplicate instance mail");
        expect(yield* portReservations.find(realStateRoot, stack.id, "mail:http")).toBe(54_321);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);

it.live("destroying one service deletes its port reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-service-destroy-" });
      const stack = initial(`owner-service-destroy-${randomUUID().slice(0, 8)}`);
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({ saved: stack, state, root: `${root}/data`, cacheRoot });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      // Composing reserves every member's public port up front without starting any of them.
      const definitions = yield* owner.rpc.supabaseComposition({
        services: [{ service: "mail", config: {}, endpoints: { http: { port: "auto" } } }],
      });
      const mail = definitions.find((entry) => entry.creation.service === "mail");
      if (mail === undefined) return yield* Effect.die("mail missing from the composition");
      const realStateRoot = yield* fs.realPath(`${root}/state`);
      const portReservations = yield* PortReservations.Service;
      expect(
        yield* portReservations.find(realStateRoot, stack.id, `${mail.id}:http`),
      ).toBeDefined();

      yield* owner.rpc.destroyService({ id: mail.id });

      expect(
        yield* portReservations.find(realStateRoot, stack.id, `${mail.id}:http`),
      ).toBeUndefined();
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerNodeHttp,
        PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);

it.effect("refuses to generate credentials for a stack whose saved instances consume them", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-credentials-" });
      const stack = initial("owner-credentials");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({ saved: stack, state, root: `${root}/data`, cacheRoot });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      yield* owner.rpc.createService({
        service: "database",
        config: { version: "17", jwtExpiry: 3600 },
        endpoints: {},
      });
      const withCredentials = yield* state.read(stack.id);
      if (withCredentials?.credentials === undefined)
        return yield* Effect.die("database creation did not save credentials");
      const { credentials: _, ...withoutCredentials } = withCredentials;
      yield* state.save(withoutCredentials);

      const refused = yield* owner.rpc
        .createService({ service: "auth", config: {} })
        .pipe(Effect.flip);

      expect(refused.message).toBe(
        "Saved instances have no stack credential record; refusing to infer credentials",
      );
      const current = yield* state.read(stack.id);
      expect(current?.credentials).toBeUndefined();
      expect(current?.instances).toHaveLength(1);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("rejects a missing required input before starting or stopping the service", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-missing-input-" });
      const stack = initial("owner-missing-input");
      const state = yield* stateFor(`${root}/state`);
      yield* state.save(stack);
      const owner = yield* ownerFor({ saved: stack, state, root: `${root}/data`, cacheRoot });
      yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
      const unbound = yield* owner.rpc.createService({
        service: "rest",
        config: {},
        endpoints: {},
      });

      const startFailure = yield* owner.rpc.startService({ id: unbound.id }).pipe(Effect.flip);

      expect(startFailure.message).toContain("rest requires input databaseUrl");
      expect((yield* owner.rpc.status({ id: unbound.id })).lifecycle).toBe("stopped");

      const provided = yield* owner.rpc.createService({
        service: "rest",
        config: { databaseUrl: "postgresql://authenticator@127.0.0.1:1/postgres" },
        endpoints: {},
      });
      yield* owner.rpc.startService({ id: provided.id });
      const restartFailure = yield* owner.rpc
        .restartService({ id: provided.id, config: { service: "rest", config: { maxRows: 5 } } })
        .pipe(Effect.flip);

      expect(restartFailure.message).toContain("rest requires input databaseUrl");
      const kept = yield* owner.rpc.status({ id: provided.id });
      expect(kept.lifecycle).toBe("running");
      expect(kept.config).toMatchObject({
        config: { databaseUrl: "postgresql://authenticator@127.0.0.1:1/postgres" },
      });
      yield* owner.rpc.stopService({ id: provided.id });
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "destroys a database's container, storage namespace and port reservation after its registration file is deleted",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stackId = `owner-no-registration-${randomUUID().slice(0, 8)}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-owner-no-registration-", stackId);
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-owner-no-registration-state-",
        });
        const stack = initialDocker(stackId);
        const state = yield* stateFor(`${tempRoot}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: dataRoot,
          cacheRoot,
          engineTarget: dockerEngineTarget,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

        const created = yield* owner.rpc.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("owner-no-registration-password"),
            jwtSecret: Redacted.make("owner-no-registration-jwt-secret-at-least-32-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: created.id });
        yield* owner.rpc.readyService({ id: created.id });

        const realStateRoot = yield* fs.realPath(`${tempRoot}/state`);
        const portReservations = yield* PortReservations.Service.pipe(
          Effect.provide(PortReservations.layer),
        );
        expect(
          yield* portReservations.find(realStateRoot, stackId, `${created.id}:sql`),
        ).toBeDefined();
        expect(yield* containersForInstance(stackId, created.id)).not.toHaveLength(0);

        // The registration disappears from under the live owner (deleted externally, or by a
        // concurrent process); its resource cleanup must still run to completion and release
        // everything it owns, with the removal simply having nothing left to publish.
        yield* fs.remove(`${tempRoot}/state/${stackId}/state.json`);

        yield* owner.rpc.destroyService({ id: created.id });

        expect(yield* containersForInstance(stackId, created.id)).toHaveLength(0);
        expect(
          yield* portReservations.find(realStateRoot, stackId, `${created.id}:sql`),
        ).toBeUndefined();
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  120_000,
);

it.live(
  "destroys a database's container and storage namespace, and releases its port reservation, after the whole data root is deleted",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stackId = `owner-no-data-root-${randomUUID().slice(0, 8)}`;
        const dataRoot = yield* makeDockerDatabaseRoot("stack-owner-no-data-root-", stackId);
        const tempRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-owner-no-data-root-state-",
        });
        const stack = initialDocker(stackId);
        const state = yield* stateFor(`${tempRoot}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: dataRoot,
          cacheRoot,
          engineTarget: dockerEngineTarget,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

        const created = yield* owner.rpc.createService({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("owner-no-data-root-password"),
            jwtSecret: Redacted.make("owner-no-data-root-jwt-secret-at-least-32-characters"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* owner.rpc.startService({ id: created.id });
        yield* owner.rpc.readyService({ id: created.id });

        const realStateRoot = yield* fs.realPath(`${tempRoot}/state`);
        const portReservations = yield* PortReservations.Service.pipe(
          Effect.provide(PortReservations.layer),
        );
        expect(
          yield* portReservations.find(realStateRoot, stackId, `${created.id}:sql`),
        ).toBeDefined();
        expect(yield* containersForInstance(stackId, created.id)).not.toHaveLength(0);
        const marker = yield* Schema.decodeEffect(Schema.fromJsonString(InstanceMarker))(
          yield* fs.readFileString(`${dataRoot}/${created.id}/.supabase-database-storage.json`),
        );
        if (marker.backend !== "docker" || marker.volume === undefined)
          return yield* Effect.die("Docker test selected host fallback");
        const volume = marker.volume;

        // The database sleeps; its storage object (inside the still-running owner) keeps the
        // identity it already resolved in memory, then the whole owned data root disappears (the
        // volume host, a disk failure, manual cleanup).
        yield* owner.rpc.stopService({ id: created.id });
        expect(yield* containersForInstance(stackId, created.id)).toHaveLength(0);
        yield* fs.remove(dataRoot, { recursive: true, force: true });

        yield* owner.rpc.destroyService({ id: created.id });

        expect(yield* containersForInstance(stackId, created.id)).toHaveLength(0);
        expect(
          yield* portReservations.find(realStateRoot, stackId, `${created.id}:sql`),
        ).toBeUndefined();
        const remainingNamespace = yield* runDocker([
          "run",
          "--rm",
          "--mount",
          `type=volume,src=${volume},dst=/store`,
          "busybox:1.36",
          "/bin/sh",
          "-c",
          `[ -e /store/${marker.namespace} ] && echo present || echo absent`,
        ]);
        expect(remainingNamespace.trim()).toBe("absent");
        yield* runDocker(["volume", "rm", volume]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  120_000,
);
