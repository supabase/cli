import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Redacted, Schema, Scope } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { makeService, type ServiceInstance } from "../Service.ts";
import { makeServiceRecipe } from "./Catalog.ts";
import { makeDockerHttpRelay, makeDockerTcpRelay } from "../../tests/docker-relay.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";

const dockerOptions = (root: string) => ({
  stackId: "catalog-auth-storage",
  instanceId: "instance",
  root,
  cacheRoot: `${root}/cache`,
  runtime: "docker" as const,
});

const secret = "catalog-auth-storage-secret-with-at-least-32-chars";

let scope: Scope.Closeable;
let root: string;
let database: ServiceInstance<any> | undefined;
let databaseUrl: string;

describe("service catalog", () => {
  beforeAll(() => {
    scope = Scope.makeUnsafe();
    return Effect.gen(function* () {
      const databaseRoot = yield* makeDockerDatabaseRoot("catalog-auth-storage-");
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
        dockerOptions(databaseRoot),
      );
      const databaseService = yield* makeService(databaseRecipe.definition, {
        id: "database",
        config: databaseRecipe.creation,
      });
      yield* databaseService.start;
      yield* databaseService.ready;
      const databaseRelay = yield* makeDockerTcpRelay(databaseRecipe.endpoint("sql"));
      root = databaseRoot;
      database = databaseService;
      databaseUrl = `postgresql://supabase_admin:postgres@${databaseRelay.host}:${databaseRelay.port}/postgres`;
    }).pipe(
      Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp)),
      Scope.provide(scope),
      Effect.runPromise,
    );
  }, 120_000);

  afterAll(
    () =>
      Effect.suspend(() => (database === undefined ? Effect.void : database.stop)).pipe(
        Effect.ensuring(Scope.close(scope, Exit.void)),
        Effect.runPromise,
      ),
    60_000,
  );

  it.live(
    "migrates Auth and signs in a signed-up user against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const authRecipe = yield* makeServiceRecipe(
            {
              service: "auth",
              config: { databaseUrl, jwtSecret: secret, jwtExpiry: 3600 },
            },
            dockerOptions(root),
          );
          const auth = yield* makeService(authRecipe.definition, {
            id: "auth",
            config: authRecipe.creation,
          });
          yield* auth.start;
          yield* auth.ready;
          const authEndpoint = yield* authRecipe.endpoint("http");
          const email = "catalog@example.test";
          const password = "catalog-password-123";
          const signupRequest = yield* HttpClientRequest.bodyJson({ email, password })(
            HttpClientRequest.post(`http://${authEndpoint.host}:${authEndpoint.port}/signup`),
          );
          const signup = yield* client.execute(signupRequest);
          expect(signup.status).toBe(200);
          const signupPayload = yield* signup.json;
          const accessToken = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ access_token: Schema.String }),
          )(signupPayload);
          expect(accessToken.access_token.length).toBeGreaterThan(0);
          const loginRequest = yield* HttpClientRequest.bodyJson({
            email,
            password,
          })(
            HttpClientRequest.post(
              `http://${authEndpoint.host}:${authEndpoint.port}/token?grant_type=password`,
            ),
          );
          const login = yield* client.execute(loginRequest);
          const loginBody = yield* login.text;
          expect(login.status, loginBody).toBe(200);
          const loginToken = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ access_token: Schema.String })),
          )(loginBody);
          expect(loginToken.access_token.length).toBeGreaterThan(0);
          yield* auth.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );

  it.live(
    "serves Storage objects and imgproxy transforms against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const storageRoot = `${root}/storage`;
          yield* fs.makeDirectory(storageRoot, { recursive: true });
          const imgproxyRecipe = yield* makeServiceRecipe(
            { service: "imgproxy", config: { filePath: storageRoot } },
            dockerOptions(root),
          );
          const imgproxy = yield* makeService(imgproxyRecipe.definition, {
            id: "imgproxy",
            config: imgproxyRecipe.creation,
          });
          yield* imgproxy.start;
          yield* imgproxy.ready;
          const imgproxyRelay = yield* makeDockerHttpRelay(imgproxyRecipe.endpoint("http"));
          const storageRecipe = yield* makeServiceRecipe(
            {
              service: "storage",
              config: {
                databaseUrl,
                filePath: storageRoot,
                jwtSecret: secret,
                imgproxyUrl: `http://${imgproxyRelay.host}:${imgproxyRelay.port}`,
              },
            },
            dockerOptions(root),
          );
          const storage = yield* makeService(storageRecipe.definition, {
            id: "storage",
            config: storageRecipe.creation,
          });
          yield* storage.start;
          yield* storage.ready;
          const storageEndpoint = yield* storageRecipe.endpoint("http");
          const serviceToken = yield* Effect.tryPromise(() =>
            new SignJWT({ role: "service_role" })
              .setProtectedHeader({ alg: "HS256", typ: "JWT" })
              .setSubject("catalog-service")
              .setIssuedAt()
              .setExpirationTime("1h")
              .sign(new TextEncoder().encode(secret)),
          );
          const bucketRequest = yield* HttpClientRequest.bodyJson({ name: "catalog" })(
            HttpClientRequest.post(
              `http://${storageEndpoint.host}:${storageEndpoint.port}/bucket`,
            ).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${serviceToken}`),
              HttpClientRequest.setHeader("apikey", serviceToken),
            ),
          );
          const bucket = yield* client.execute(bucketRequest);
          expect(bucket.status).toBe(200);
          const uploadRequest = HttpClientRequest.bodyText(
            HttpClientRequest.post(
              `http://${storageEndpoint.host}:${storageEndpoint.port}/object/catalog/hello.txt`,
            ).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${serviceToken}`),
              HttpClientRequest.setHeader("apikey", serviceToken),
            ),
            "catalog-storage",
            "text/plain",
          );
          const upload = yield* client.execute(uploadRequest);
          expect(upload.status).toBe(200);
          const imageBytes = Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            ),
            (value) => value.charCodeAt(0),
          );
          const imageRequest = HttpClientRequest.bodyUint8Array(
            HttpClientRequest.post(
              `http://${storageEndpoint.host}:${storageEndpoint.port}/object/catalog/source.png`,
            ).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${serviceToken}`),
              HttpClientRequest.setHeader("apikey", serviceToken),
            ),
            imageBytes,
            "image/png",
          );
          const imageUpload = yield* client.execute(imageRequest);
          expect(imageUpload.status).toBe(200);
          const transformedImage = yield* client.execute(
            HttpClientRequest.get(
              `http://${storageEndpoint.host}:${storageEndpoint.port}/render/image/authenticated/catalog/source.png?width=1&height=1`,
            ).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${serviceToken}`),
              HttpClientRequest.setHeader("apikey", serviceToken),
            ),
          );
          expect(transformedImage.status).toBe(200);
          expect(transformedImage.headers["content-type"]).toContain("image/");
          yield* storage.stop;
          yield* imgproxy.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
