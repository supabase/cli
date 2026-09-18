import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SignJWT } from "jose";
import { makeService } from "../Service.ts";
import { ProxyError } from "../Proxy.ts";
import { makeServiceRecipe } from "./Catalog.ts";

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
    "migrates Auth and serves Storage against the owned database",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* HttpClient.HttpClient;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "catalog-auth-storage-" });
          const secret = "catalog-auth-storage-secret-with-at-least-32-chars";
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
          yield* database.start;
          yield* database.ready;
          const databaseEndpoint = yield* databaseRecipe.endpoint("sql");
          if (databaseEndpoint.kind !== "tcp" || databaseEndpoint.host === undefined)
            return yield* new ProxyError({ message: "Docker database did not expose TCP" });
          const databaseUrl = `postgresql://supabase_admin:postgres@host.docker.internal:${databaseEndpoint.port}/postgres`;
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
          const imgproxyEndpoint = yield* imgproxyRecipe.endpoint("http");
          const storageRecipe = yield* makeServiceRecipe(
            {
              service: "storage",
              config: {
                databaseUrl,
                filePath: storageRoot,
                jwtSecret: secret,
                imgproxyUrl: `http://host.docker.internal:${imgproxyEndpoint.port}`,
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
          yield* imgproxy.stop;
          yield* storage.stop;
          yield* auth.stop;
          yield* database.stop;
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 120_000 },
  );
});
