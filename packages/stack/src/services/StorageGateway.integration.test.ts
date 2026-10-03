import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { tmpdir } from "node:os";
import {
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
} from "../Defaults.ts";
import * as StackNamespace from "../StackNamespace.ts";
import type { SavedStack } from "../StackNamespace.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { ownerFor } from "../../tests/owner-rpc.ts";

const cacheRoot = `${tmpdir()}/supabase-stack-artifacts`;
const jwtSecret = "storage-gateway-secret-with-at-least-32-chars";
const s3Credentials = {
  accessKeyId: DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  secretAccessKey: DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
  region: DEFAULT_LOCAL_S3_REGION,
};

const layout = Effect.fnUntraced(function* (runtime: SavedStack["runtime"], stackId: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (runtime === "native") {
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "storage-gateway-native-" });
    return { stateRoot: `${root}/state`, dataRoot: `${root}/data`, storageRoot: `${root}/storage` };
  }
  const dataRoot = yield* makeDockerDatabaseRoot("storage-gateway-docker-", stackId).pipe(
    Effect.flatMap(fs.realPath),
  );
  return {
    stateRoot: path.dirname(path.dirname(dataRoot)),
    dataRoot,
    storageRoot: `${dataRoot}/storage`,
  };
});

/** Starts Database and Storage in an owned stack and returns Storage's gateway URL. */
const serveStorage = Effect.fnUntraced(function* (runtime: SavedStack["runtime"]) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const stackId = `storage-gateway-${runtime}-${(yield* crypto.randomUUIDv4).slice(0, 8)}`;
  const { stateRoot, dataRoot, storageRoot } = yield* layout(runtime, stackId);
  yield* fs.makeDirectory(storageRoot, { recursive: true });
  const saved: SavedStack = {
    id: stackId,
    identity: { projectRoot: "/tmp/project", branchContext: "storage-gateway", stackName: stackId },
    runtime,
    instances: [],
    lifetime: "detached",
    composition: { members: [], dependencies: [] },
    ports: [],
  };
  const state = Context.get(
    yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
    StackNamespace.Service,
  );
  yield* state.save(saved);
  const owner = yield* ownerFor({ saved, state, root: dataRoot, cacheRoot });
  yield* Effect.addFinalizer(() => owner.namespace.destroy.pipe(Effect.ignore));
  const created = yield* owner.rpc.supabaseComposition({
    services: [
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
        service: "storage",
        config: { filePath: storageRoot, jwtSecret, s3ProtocolEnabled: true },
        endpoints: { http: { port: "auto" } },
      },
    ],
  });
  const storage = created.find((entry) => entry.creation.service === "storage");
  if (storage === undefined) return yield* Effect.die("Storage member missing");
  yield* owner.rpc.startComposition();
  const { url } = yield* owner.rpc.credentials({ id: storage.id, from: "host" });
  if (url === undefined) return yield* Effect.die("Storage gateway URL missing");
  const { serviceRoleKey } = yield* owner.getStackCredentials;
  return { url, serviceRoleKey };
});

for (const runtime of ["native", "docker"] as const)
  it.live(
    `accepts S3 requests signed over the gateway path and resumes TUS uploads there (${runtime})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const { url, serviceRoleKey } = yield* serveStorage(runtime);
          const bucket = "gateway";

          const createBucket = yield* client.execute(
            HttpClientRequest.post(`${url}/bucket`).pipe(
              HttpClientRequest.setHeaders({ authorization: `Bearer ${serviceRoleKey}` }),
              HttpClientRequest.bodyJsonUnsafe({ name: bucket }),
            ),
          );
          expect(createBucket.status, yield* createBucket.text).toBe(200);
          const s3 = new Bun.S3Client({ ...s3Credentials, endpoint: `${url}/s3`, bucket });
          yield* Effect.promise(() => s3.write("signed.txt", "signed over the gateway"));
          const listing = yield* Effect.promise(() => s3.list());
          expect(listing.contents?.map(({ key }) => key)).toEqual(["signed.txt"]);
          expect(yield* Effect.promise(() => s3.file("signed.txt").text())).toBe(
            "signed over the gateway",
          );

          const metadata = [
            ["bucketName", bucket],
            ["objectName", "resumable.txt"],
            ["contentType", "text/plain"],
          ]
            .map(([name, value]) => `${name} ${btoa(value ?? "")}`)
            .join(",");
          const create = yield* client.execute(
            HttpClientRequest.post(`${url}/upload/resumable`).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${serviceRoleKey}`,
                "tus-resumable": "1.0.0",
                "upload-length": "11",
                "upload-metadata": metadata,
              }),
            ),
          );
          expect(create.status, yield* create.text).toBe(201);
          const location = create.headers.location ?? "";
          expect(location.startsWith(`${url}/upload/resumable/`), location).toBe(true);

          const patch = yield* client.execute(
            HttpClientRequest.patch(location).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${serviceRoleKey}`,
                "tus-resumable": "1.0.0",
                "upload-offset": "0",
              }),
              HttpClientRequest.bodyUint8Array(
                new TextEncoder().encode("hello"),
                "application/offset+octet-stream",
              ),
            ),
          );
          expect(patch.status, yield* patch.text).toBe(204);
          expect(patch.headers["upload-offset"]).toBe("5");
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 180_000 },
  );
