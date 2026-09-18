import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { PgClient } from "@effect/sql-pg";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { tmpdir } from "node:os";
import * as Owner from "../Owner.ts";
import * as State from "../State.ts";
import type { SavedStack } from "../State.ts";

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

const initial = (id: string): SavedStack => ({
  id,
  identity: { projectRoot: "/tmp/project", branchContext: "catalog-native", stackName: id },
  runtime: "native",
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
});

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
