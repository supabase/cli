import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Redacted, Ref } from "effect";
import { HttpClient } from "effect/unstable/http";
import { tmpdir } from "node:os";
import * as Owner from "./Owner.ts";
import * as State from "./State.ts";
import type { SavedStack } from "./State.ts";

const stateFor = (root: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(State.layer({ root }));
    return Context.get(context, State.Service);
  });

const ownerFor = (options: {
  readonly saved: SavedStack;
  readonly state: State.Interface;
  readonly root: string;
  readonly cacheRoot: string;
}) => {
  const { state, ...layerOptions } = options;
  return Effect.gen(function* () {
    const context = yield* Layer.build(
      Owner.layer(layerOptions).pipe(Layer.provide(Layer.succeed(State.Service, state))),
    );
    return Context.get(context, Owner.Service);
  });
};

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

const initial = (id: string): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "owner-test", stackName: id },
  runtime: "native",
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
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

it.effect("rejects a malformed persisted composition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-malformed-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = initial("owner-malformed");
      yield* state.save(saved);
      const malformed =
        '{"id":"owner-malformed","identity":{"projectRoot":"/tmp/project","branchContext":"owner-test","stackName":"owner-malformed"},"runtime":"native","instances":[],"composition":{"members":"invalid","dependencies":[]},"ports":[]}';
      yield* fs.writeFileString(path.join(root, "state", saved.id, "state.json"), malformed);
      const reopened = yield* state.read(saved.id);
      if (reopened === undefined) return yield* Effect.die("saved state disappeared");
      const failure = yield* ownerFor({
        saved: reopened,
        state,
        root: `${root}/state/${saved.id}/data`,
        cacheRoot,
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(Owner.OwnerError);
      expect(failure.operation).toBe("configure");
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
      const failingState: State.Interface = {
        ...state,
        save: (next) =>
          Ref.get(removalWrite).pipe(
            Effect.flatMap((alreadyWritten) =>
              next.instances.length === 0
                ? alreadyWritten
                  ? Effect.fail(
                      new State.StateError({ operation: "write", message: "injected failure" }),
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
      const service = yield* owner.services.create({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
      });
      yield* owner.composition.configure({
        members: [{ id: service.id, activation: "eager" }],
        dependencies: [],
      });

      yield* owner.core.destroy(service.id);

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
        const database = yield* owner.services.create({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("owner-password"),
            jwtSecret: Redacted.make("owner-jwt"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        const rest = yield* owner.services.create({
          service: "rest",
          config: { databaseUrl: "postgresql://placeholder" },
          endpoints: { http: { port: "auto" } },
        });
        const shadow = yield* owner.services.create({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("shadow-password"),
            jwtSecret: Redacted.make("shadow-jwt"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        });
        yield* owner.composition.configure({
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
        yield* owner.core.start(shadow.id);
        yield* owner.core.ready(shadow.id);
        yield* owner.composition.start;
        const dbCredentials = yield* owner.credentials(database.id, "host");
        const databaseUrl = dbCredentials.databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("database credentials missing");
        yield* query(databaseUrl, "CREATE TABLE owner_rows(value text NOT NULL)");
        yield* query(databaseUrl, "INSERT INTO owner_rows(value) VALUES ('wake')");
        const restCredentials = yield* owner.credentials(rest.id, "host");
        const restUrl = restCredentials.url;
        if (restUrl === undefined) return yield* Effect.die("REST credentials missing");
        const restObservation = yield* owner.core.get(rest.id);
        const restEndpoint = restObservation.endpoints.find((endpoint) => endpoint.name === "http");
        expect(restEndpoint?.host).toBe("127.0.0.1");
        expect(restEndpoint?.port).toBe(Number(new URL(restUrl).port));
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.get(`${restUrl}/owner_rows`);
        expect(response.status).toBe(200);
        const body = yield* response.json;
        expect(body).toEqual([{ value: "wake" }]);
        expect((yield* owner.core.get(shadow.id)).lifecycle).toBe("running");
        yield* owner.composition.stop;
        expect((yield* owner.core.get(shadow.id)).lifecycle).toBe("running");
        const firstPort = new URL(databaseUrl).port;
        yield* owner.core.stop(database.id);
        yield* owner.core.start(database.id);
        yield* owner.core.ready(database.id);
        const reopened = yield* owner.credentials(database.id, "host");
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
        expect((yield* reopenedOwner.services.list).length).toBe(3);
        expect((yield* reopenedOwner.core.get(database.id)).lifecycle).toBe("stopped");
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
          }).pipe(Layer.provide(Layer.succeed(State.Service, state))),
          memoMap,
          scope,
        ).pipe(Effect.map((context) => Context.get(context, Owner.Service)));
      const firstOwner = yield* buildOwner(first);
      const secondOwner = yield* buildOwner(second);
      yield* Effect.addFinalizer(() => firstOwner.namespace.destroy.pipe(Effect.ignore));
      yield* Effect.addFinalizer(() => secondOwner.namespace.destroy.pipe(Effect.ignore));
      const created = yield* firstOwner.services.create({
        service: "mail",
        config: {},
        endpoints: { http: { port: "auto" }, smtp: { port: "auto" }, pop3: { port: "auto" } },
      });
      const isolated = yield* secondOwner.composition
        .configure({
          members: [{ id: created.id, activation: "eager" }],
          dependencies: [],
        })
        .pipe(Effect.flip);
      expect(isolated.operation).toBe("configure");
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
        const created = yield* owner.composition.supabase([
          {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("owner-factory-password"),
              jwtSecret: Redacted.make("owner-factory-jwt"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          },
          {
            service: "rest",
            config: { databaseUrl: "postgresql://placeholder" },
            endpoints: { http: { port: "auto" } },
          },
          {
            service: "mail",
            config: {},
            endpoints: { http: { port: "auto" }, smtp: { port: "auto" } },
          },
        ]);
        const database = created.find((entry) => entry.creation.service === "database");
        const rest = created.find((entry) => entry.creation.service === "rest");
        const mail = created.find((entry) => entry.creation.service === "mail");
        if (database === undefined || rest === undefined || mail === undefined)
          return yield* Effect.die("factory did not create all requested services");
        if (rest.creation.service !== "rest") return yield* Effect.die("REST service missing");
        expect(rest.creation.config.databaseUrl).toContain("authenticator:");
        yield* owner.composition.start;
        const databaseCredentials = yield* owner.credentials(database.id, "host");
        const databaseUrl = databaseCredentials.databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("database URL missing");
        yield* query(databaseUrl, "CREATE TABLE factory_rows(value text NOT NULL)");
        yield* query(databaseUrl, "INSERT INTO factory_rows VALUES ('factory-row')");
        const restCredentials = yield* owner.credentials(rest.id, "host");
        const restUrl = restCredentials.url;
        if (restUrl === undefined) return yield* Effect.die("REST URL missing");
        const mailCredentials = yield* owner.credentials(mail.id, "host");
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
      const duplicate = yield* owner.composition.supabase([database, database]).pipe(Effect.flip);
      expect(duplicate.operation).toBe("supabase");
      expect(yield* owner.services.list).toHaveLength(0);
      const conflicting = yield* owner.composition
        .supabase([
          {
            service: "rest",
            config: { databaseUrl: "postgresql://placeholder" },
            endpoints: { http: { port: 41_001 } },
          },
          {
            service: "auth",
            config: { databaseUrl: "postgresql://placeholder" },
            endpoints: { http: { port: 41_002 } },
          },
        ])
        .pipe(Effect.flip);
      expect(conflicting.operation).toBe("supabase");
      expect(yield* owner.services.list).toHaveLength(0);

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
      const registrationFailure = yield* badOwner.services.create(database).pipe(Effect.flip);
      expect(registrationFailure.operation).toBe("register");
      expect(yield* badOwner.services.list).toHaveLength(0);
      expect((yield* state.read(stack.id))?.instances).toHaveLength(0);

      const databaseWithoutSql = yield* owner.services.create({
        service: "database",
        config: database.config,
        endpoints: {},
      });
      expect(yield* owner.credentials(databaseWithoutSql.id, "host")).toEqual({});

      const missingSql = yield* owner.composition
        .supabase([
          { ...database, endpoints: {} },
          {
            service: "rest",
            config: { databaseUrl: "postgresql://placeholder" },
            endpoints: { http: { port: "auto" } },
          },
        ])
        .pipe(Effect.flip);
      expect(missingSql.message).toBe("database requires configured sql endpoint");
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
