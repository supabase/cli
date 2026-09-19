import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { tmpdir } from "node:os";
import * as Owner from "../Owner.ts";
import * as State from "../State.ts";
import type { SavedStack } from "../State.ts";
import {
  makeSupabaseComposition,
  SupabaseCompositionError,
  type SupabaseCompositionOperations,
} from "./Supabase.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;

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

const initial = (id: string): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "catalog-native", stackName: id },
  runtime: "native",
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
});

it.live("reports the failed binding and cleanup reason with the retained instance ID", () =>
  Effect.gen(function* () {
    const unused = () => Effect.die("unused operation");
    const operations: SupabaseCompositionOperations = {
      currentComposition: Effect.succeed({ members: [], dependencies: [] }),
      get: unused,
      status: unused,
      create: (creation) => Effect.succeed({ id: "retained-mail", creation }),
      destroy: () =>
        Effect.fail(new SupabaseCompositionError({ message: "cannot remove owned data" })),
      bind: () => Effect.fail(new SupabaseCompositionError({ message: "port is occupied" })),
      address: unused,
      output: unused,
      updateCreation: unused,
      configure: unused,
    };
    const error = yield* makeSupabaseComposition(operations, [
      { service: "mail", config: {}, endpoints: {} },
    ]).pipe(Effect.flip);
    expect(error.message).toContain("mail retained-mail: port is occupied");
    expect(error.message).toContain("retained-mail: cannot remove owned data");
  }),
);

it.live("removes a managed SMTP binding when Mail is excluded", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-exclude-mail-" });
    const saved = initial("catalog-exclude-mail");
    const state = yield* stateFor(`${root}/state`);
    yield* state.save(saved);
    const owner = yield* ownerFor({ saved, state, root: `${root}/data`, cacheRoot });
    yield* Effect.acquireUseRelease(
      Effect.succeed(owner),
      () =>
        Effect.gen(function* () {
          const auth = {
            service: "auth" as const,
            config: {
              databaseUrl: "postgresql://placeholder",
              jwtSecret: "exclude-mail-jwt-secret-with-32-chars",
              jwtExpiry: 3600,
            },
            endpoints: { http: { port: "auto" as const } },
          };
          const members = yield* owner.composition.supabase([
            auth,
            { service: "mail", config: {}, endpoints: { smtp: { port: "auto" } } },
          ]);
          const instance = members.find(({ creation }) => creation.service === "auth");
          if (instance?.creation.service !== "auth") return yield* Effect.die("Auth missing");
          expect(instance.creation.config.smtpUrl).toBeDefined();
          const selected = yield* owner.composition.supabase([auth], { reuseIds: [instance.id] });
          const reused = selected.find(({ id }) => id === instance.id);
          if (reused?.creation.service !== "auth") return yield* Effect.die("Reused Auth missing");
          expect(reused.creation.config.smtpUrl).toBeUndefined();
          const external = yield* owner.composition.supabase(
            [{ ...auth, config: { ...auth.config, smtpUrl: "smtp://mail.example:2525" } }],
            { reuseIds: [instance.id] },
          );
          const configured = external.find(({ id }) => id === instance.id);
          if (configured?.creation.service !== "auth") return yield* Effect.die("Auth missing");
          expect(configured.creation.config.smtpUrl).toBe("smtp://mail.example:2525");
        }),
      () => owner.namespace.destroy,
    );
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("cleans created registrations when composition is interrupted", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const registered = yield* Deferred.make<void>();
    const destroyed = yield* Ref.make<ReadonlyArray<string>>([]);
    const database = {
      service: "database" as const,
      config: {
        version: "17",
        databasePassword: Redacted.make("interrupt-password"),
        jwtSecret: Redacted.make("interrupt-jwt-secret-with-32-chars"),
        jwtExpiry: 3600,
      },
      endpoints: { sql: { port: "auto" as const } },
    };
    const unused = (operation: string) =>
      Effect.fail(new SupabaseCompositionError({ message: `${operation} is unused` }));
    const operations: SupabaseCompositionOperations = {
      currentComposition: Effect.succeed({ members: [], dependencies: [] }),
      get: () => unused("get"),
      status: () => unused("status"),
      create: (creation) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(registered)),
          Effect.as({ id: "created-database", creation }),
        ),
      destroy: (id) => Ref.update(destroyed, (ids) => [...ids, id]),
      bind: () => Effect.never,
      address: () => Effect.die("address is unused"),
      output: () => Effect.die("output is unused"),
      updateCreation: () => Effect.die("updateCreation is unused"),
      configure: () => Effect.die("configure is unused"),
    };
    const running = yield* makeSupabaseComposition(operations, [database]).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const interrupting = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
    yield* Deferred.succeed(registered, undefined);
    yield* Fiber.join(interrupting);
    expect(Exit.isFailure(yield* Fiber.await(running))).toBe(true);
    expect(yield* Ref.get(destroyed)).toEqual(["created-database"]);
  }),
);

it.live(
  "serves native Auth and Storage through an owned public database endpoint",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const client = yield* HttpClient.HttpClient;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-native-auth-storage-" });
        const stack = initial("catalog-native-auth-storage");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const storageRoot = `${root}/storage`;
        yield* fs.makeDirectory(storageRoot, { recursive: true });
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));

        const jwtSecret = "catalog-native-auth-storage-secret-with-at-least-32-chars";
        const created = yield* owner.composition.supabase([
          {
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("postgres"),
              jwtSecret: Redacted.make(jwtSecret),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          },
          {
            service: "auth",
            config: {
              databaseUrl: "postgresql://placeholder",
              jwtSecret,
              jwtExpiry: 3600,
            },
            endpoints: { http: { port: "auto" } },
          },
          {
            service: "storage",
            config: {
              databaseUrl: "postgresql://placeholder",
              filePath: storageRoot,
              jwtSecret,
            },
            endpoints: { http: { port: "auto" } },
          },
        ]);
        const database = created.find((entry) => entry.creation.service === "database");
        const auth = created.find((entry) => entry.creation.service === "auth");
        const storage = created.find((entry) => entry.creation.service === "storage");
        if (database === undefined || auth === undefined || storage === undefined)
          return yield* Effect.die("Native composition members missing");

        yield* owner.composition.start;
        const databaseCredentials = yield* owner.credentials(database.id, "host");
        const databaseUrl = databaseCredentials.databaseUrl;
        if (databaseUrl === undefined) return yield* Effect.die("Native database URL missing");
        expect(databaseUrl).toMatch(/^postgresql:\/\/supabase_admin:/u);
        const parsedDatabaseUrl = new URL(databaseUrl);
        const databaseServices = yield* Layer.build(
          PgClient.layer({
            host: parsedDatabaseUrl.hostname,
            port: Number(parsedDatabaseUrl.port),
            database: parsedDatabaseUrl.pathname.slice(1),
            username: decodeURIComponent(parsedDatabaseUrl.username),
            password: Redacted.make(decodeURIComponent(parsedDatabaseUrl.password)),
          }),
        );
        yield* Context.get(databaseServices, PgClient.PgClient).unsafe("SELECT 1");
        const authCredentials = yield* owner.credentials(auth.id, "host");
        const storageCredentials = yield* owner.credentials(storage.id, "host");
        if (authCredentials.url === undefined || storageCredentials.url === undefined)
          return yield* Effect.die("Native public service URL missing");

        const email = "catalog-native@example.test";
        const password = "catalog-native-password-123";
        const signup = yield* client.execute(
          yield* HttpClientRequest.bodyJson({ email, password })(
            HttpClientRequest.post(`${authCredentials.url}/signup`),
          ),
        );
        expect(signup.status).toBe(200);
        const signupPayload = yield* signup.json;
        const signupToken = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ access_token: Schema.String }),
        )(signupPayload);
        expect(signupToken.access_token.length).toBeGreaterThan(0);

        const login = yield* client.execute(
          yield* HttpClientRequest.bodyJson({ email, password })(
            HttpClientRequest.post(`${authCredentials.url}/token?grant_type=password`),
          ),
        );
        const loginBody = yield* login.text;
        expect(login.status, loginBody).toBe(200);
        const loginToken = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })),
        )(loginBody);
        expect(loginToken.access_token.length).toBeGreaterThan(0);

        const serviceToken = yield* Effect.tryPromise(() =>
          new SignJWT({ role: "service_role" })
            .setProtectedHeader({ alg: "HS256", typ: "JWT" })
            .setSubject("catalog-native-service")
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(new TextEncoder().encode(jwtSecret)),
        );
        const headers = (request: HttpClientRequest.HttpClientRequest) =>
          request.pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${serviceToken}`),
            HttpClientRequest.setHeader("apikey", serviceToken),
          );
        const bucket = yield* client.execute(
          yield* HttpClientRequest.bodyJson({ name: "catalog" })(
            headers(HttpClientRequest.post(`${storageCredentials.url}/bucket`)),
          ),
        );
        expect(bucket.status).toBe(200);
        const upload = yield* client.execute(
          headers(
            HttpClientRequest.bodyText(
              HttpClientRequest.post(`${storageCredentials.url}/object/catalog/hello.txt`),
              "catalog-native-storage",
              "text/plain",
            ),
          ),
        );
        expect(upload.status).toBe(200);
        const remove = yield* client.execute(
          headers(
            HttpClientRequest.make("DELETE")(`${storageCredentials.url}/object/catalog/hello.txt`),
          ),
        );
        expect(remove.status).toBe(200);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live(
  "promotes a stopped database composition without replacing its identity or data",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-native-reuse-" });
        const stack = initial("catalog-native-reuse");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
        const databaseCreation = {
          service: "database" as const,
          config: {
            version: "17",
            databasePassword: Redacted.make("reuse-database-password"),
            jwtSecret: Redacted.make("reuse-database-jwt-secret-with-32-chars"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" as const } },
        };
        const databaseOnly = yield* owner.composition.supabase([databaseCreation]);
        const database = databaseOnly[0];
        if (database === undefined) return yield* Effect.die("Database member missing");
        yield* owner.composition.start;
        const credentials = yield* owner.credentials(database.id, "host");
        if (credentials.databaseUrl === undefined)
          return yield* Effect.die("Database credentials missing");
        const port = new URL(credentials.databaseUrl).port;
        yield* query(credentials.databaseUrl, "CREATE TABLE reuse_rows(value text NOT NULL)");
        yield* query(credentials.databaseUrl, "INSERT INTO reuse_rows VALUES ('preserved')");
        yield* owner.composition.stop;

        const expanded = yield* owner.composition.supabase(
          [
            databaseCreation,
            {
              service: "rest",
              config: { databaseUrl: "postgresql://placeholder" },
              endpoints: { http: { port: "auto" } },
            },
          ],
          { reuseIds: [database.id] },
        );
        const reused = expanded.find((entry) => entry.creation.service === "database");
        if (reused === undefined) return yield* Effect.die("Reused database missing");
        expect(reused.id).toBe(database.id);
        yield* owner.composition.start;
        const reopened = yield* owner.credentials(database.id, "host");
        if (reopened.databaseUrl === undefined)
          return yield* Effect.die("Reopened database credentials missing");
        expect(new URL(reopened.databaseUrl).port).toBe(port);
        const rows = yield* query(reopened.databaseUrl, "SELECT value FROM reuse_rows");
        expect(rows).toEqual([{ value: "preserved" }]);
        const rest = expanded.find((entry) => entry.creation.service === "rest");
        if (rest === undefined) return yield* Effect.die("REST missing");
        const before = yield* owner.credentials(rest.id, "host");
        yield* owner.composition.stop;
        const withAuth = yield* owner.composition.supabase(
          [
            databaseCreation,
            rest.creation,
            {
              service: "auth",
              config: {
                databaseUrl: "postgresql://placeholder",
                jwtSecret: Redacted.value(databaseCreation.config.jwtSecret),
                jwtExpiry: 3600,
              },
              endpoints: { http: { port: "auto" } },
            },
          ],
          { reuseIds: [database.id, rest.id] },
        );
        yield* owner.composition.start;
        const auth = withAuth.find((entry) => entry.creation.service === "auth");
        if (auth === undefined) return yield* Effect.die("Auth missing");
        const restAddress = yield* owner.credentials(rest.id, "host");
        const authAddress = yield* owner.credentials(auth.id, "host");
        expect(restAddress.url).toBe(before.url);
        if (restAddress.url === undefined || authAddress.url === undefined)
          return yield* Effect.die("Shared API URLs missing");
        expect(new URL(authAddress.url).port).toBe(new URL(restAddress.url).port);
        const client = yield* HttpClient.HttpClient;
        expect((yield* client.get(restAddress.url)).status).toBe(200);
        expect((yield* client.get(`${authAddress.url}/health`)).status).toBe(200);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live(
  "reuses an excluded Studio instance and its fixed port",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-native-studio-reuse-" });
        const stack = initial("catalog-native-studio-reuse");
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
            databasePassword: Redacted.make("studio-reuse-password"),
            jwtSecret: Redacted.make("studio-reuse-jwt-secret-with-32-chars"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" as const } },
        };
        const rest = {
          service: "rest" as const,
          config: { databaseUrl: "postgresql://placeholder" },
          endpoints: { http: { port: "auto" as const } },
        };
        const pgmeta = {
          service: "pgmeta" as const,
          config: { databaseUrl: "postgresql://placeholder" },
          endpoints: { http: { port: "auto" as const } },
        };
        const studio = {
          service: "studio" as const,
          config: {
            pgmetaUrl: "http://placeholder",
            analyticsApiKey: "studio-reuse-analytics-key",
            apiUrl: "http://placeholder",
            publicApiUrl: "http://placeholder",
            jwtSecret: "studio-reuse-jwt-secret-with-32-chars",
          },
          endpoints: { http: { port: 54_391 } },
        };
        const initialMembers = yield* owner.composition.supabase([database, rest, pgmeta, studio]);
        const databaseId = initialMembers.find(
          (entry) => entry.creation.service === "database",
        )?.id;
        const restId = initialMembers.find((entry) => entry.creation.service === "rest")?.id;
        const pgmetaId = initialMembers.find((entry) => entry.creation.service === "pgmeta")?.id;
        const studioId = initialMembers.find((entry) => entry.creation.service === "studio")?.id;
        if (
          databaseId === undefined ||
          restId === undefined ||
          pgmetaId === undefined ||
          studioId === undefined
        )
          return yield* Effect.die("Studio composition members missing");
        yield* owner.composition.start;
        yield* owner.composition.stop;
        const reduced = yield* owner.composition.supabase([database, rest, pgmeta], {
          reuseIds: [databaseId, restId, pgmetaId],
        });
        expect(reduced.map((entry) => entry.id).sort()).toEqual(
          [databaseId, restId, pgmetaId].sort(),
        );
        yield* owner.composition.start;
        yield* owner.composition.stop;
        const restored = yield* owner.composition.supabase([database, rest, pgmeta, studio], {
          reuseIds: [databaseId, restId, pgmetaId, studioId],
        });
        expect(restored.find((entry) => entry.creation.service === "studio")?.id).toBe(studioId);
        const studioCredentials = yield* owner.credentials(studioId, "host");
        if (studioCredentials.url === undefined) return yield* Effect.die("Studio URL missing");
        expect(new URL(studioCredentials.url).port).toBe("54391");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live(
  "rejects reuse while a composition member is running before mutation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-native-reuse-running-" });
        const stack = initial("catalog-native-reuse-running");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
        const databaseCreation = {
          service: "database" as const,
          config: {
            version: "17",
            databasePassword: Redacted.make("reuse-running-password"),
            jwtSecret: Redacted.make("reuse-running-jwt-secret-with-32-chars"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" as const } },
        };
        const created = yield* owner.composition.supabase([databaseCreation]);
        const database = created[0];
        if (database === undefined) return yield* Effect.die("Database member missing");
        yield* owner.composition.start;
        const failure = yield* owner.composition
          .supabase([databaseCreation], { reuseIds: [database.id] })
          .pipe(Effect.flip);
        expect(failure.message).toContain("stopped with wake disabled");
        expect((yield* owner.services.list).map((entry) => entry.id)).toEqual([database.id]);
        yield* owner.composition.stop;
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live(
  "cleans newly created registrations when a composition bind fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-native-reuse-cleanup-" });
        const stack = initial("catalog-native-reuse-cleanup");
        const state = yield* stateFor(`${root}/state`);
        yield* state.save(stack);
        const owner = yield* ownerFor({
          saved: stack,
          state,
          root: `${root}/data`,
          cacheRoot,
        });
        yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
        const fixedPort = 54_392;
        const standaloneMail = yield* owner.services.create({
          service: "mail",
          config: {},
          endpoints: { http: { port: fixedPort } },
        });
        yield* owner.core.start(standaloneMail.id);
        yield* owner.core.ready(standaloneMail.id);
        const database = {
          service: "database" as const,
          config: {
            version: "17",
            databasePassword: Redacted.make("reuse-cleanup-password"),
            jwtSecret: Redacted.make("reuse-cleanup-jwt-secret-with-32-chars"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" as const } },
        };
        const failure = yield* owner.composition
          .supabase([
            database,
            { service: "mail", config: {}, endpoints: { http: { port: fixedPort } } },
          ])
          .pipe(Effect.flip);
        expect(failure.operation).toBe("supabase");
        expect((yield* owner.services.list).map((entry) => entry.id)).toEqual([standaloneMail.id]);
        yield* owner.core.stop(standaloneMail.id);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);
