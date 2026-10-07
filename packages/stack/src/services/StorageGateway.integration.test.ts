import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  DEFAULT_LOCAL_S3_ACCESS_KEY_ID,
  DEFAULT_LOCAL_S3_REGION,
  DEFAULT_LOCAL_S3_SECRET_ACCESS_KEY,
} from "../Defaults.ts";
import * as StackNamespace from "../StackNamespace.ts";
import type { SavedStack } from "../StackNamespace.ts";
import { makeDockerDatabaseRoot } from "../../tests/docker-fixture.ts";
import { ownerFor } from "../../tests/owner-rpc.ts";
import { engineTarget, testEngine } from "../../tests/engine-target.ts";
import { testArtifactCacheRoot } from "../../tests/artifact-cache.ts";

const cacheRoot = testArtifactCacheRoot;
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
  // Ownership is by location: Storage's filePath is a caller path and must live outside the
  // stack's data root, not merely outside the service's own instance root.
  const storageRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "storage-gateway-docker-caller-",
  });
  return {
    stateRoot: path.dirname(path.dirname(dataRoot)),
    dataRoot,
    storageRoot,
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
  };
  const state = Context.get(
    yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
    StackNamespace.Service,
  );
  yield* state.save(saved);
  const owner = yield* ownerFor({
    saved,
    state,
    root: dataRoot,
    cacheRoot,
    ...(runtime !== "native" ? { engineTarget } : {}),
  });
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
  return { url, serviceRoleKey, storageRoot };
});

for (const runtime of ["native", testEngine] as const)
  it.live(
    `accepts S3 requests signed over the gateway path and resumes TUS uploads there (${runtime})`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const { url, serviceRoleKey, storageRoot } = yield* serveStorage(runtime);
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

          if (runtime !== "native") {
            // The container writes into storageRoot, a borrowed host directory; the host user
            // must still own what it created there, not the engine's own root (see Container's
            // `user` field).
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const entries = yield* fs.readDirectory(storageRoot, { recursive: true });
            const stats = yield* Effect.forEach(entries, (entry) =>
              fs.stat(path.join(storageRoot, entry)),
            );
            const files = stats.filter((info) => info.type === "File");
            expect(files.length).toBeGreaterThan(0);
            for (const info of files)
              expect(Option.getOrUndefined(info.uid)).toBe(process.getuid?.());
          }
        }),
      ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
    { timeout: 180_000 },
  );
