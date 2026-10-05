import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { tmpdir } from "node:os";

import {
  makeTempCliProject,
  makeTempHome,
  runSupabaseEffect,
} from "../../../../../tests/helpers/cli.ts";

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const nativeSupported =
  (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64")) ||
  (process.platform === "darwin" && process.arch === "arm64");

const projectConfig = `project_id = "stack-storage-e2e"

[experimental]
stack = true

[api]
enabled = true

[storage]
enabled = true

[storage.image_transformation]
enabled = false

[auth]
enabled = false

[db.pooler]
enabled = false

[edge_runtime]
enabled = false

[realtime]
enabled = false

[studio]
enabled = false

[analytics]
enabled = false

[local_smtp]
enabled = false
`;

class StackStorageE2eError extends Data.TaggedError("StackStorageE2eError")<{
  readonly message: string;
}> {}

const StartResultSchema = Schema.Struct({ id: Schema.String });
const StorageEnvSchema = Schema.Struct({
  API_URL: Schema.String,
  SERVICE_ROLE_KEY: Schema.String,
  STORAGE_S3_URL: Schema.String,
  S3_PROTOCOL_ACCESS_KEY_ID: Schema.String,
  S3_PROTOCOL_ACCESS_KEY_SECRET: Schema.String,
  S3_PROTOCOL_REGION: Schema.String,
});

const s3Call = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new StackStorageE2eError({ message: `S3 ${operation} failed: ${String(cause)}` }),
  });

const tusMetadata = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries)
    .map(([name, value]) => `${name} ${btoa(value)}`)
    .join(",");

describe("stack start Storage behind the API gateway (compiled e2e)", () => {
  for (const runtime of ["native", "docker"] as const) {
    if (runtime === "native" && !nativeSupported) continue;
    it.live(
      `serves S3 clients and resumable uploads from the ${runtime} status URLs`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const http = yield* HttpClient.HttpClient;
          const home = makeTempHome();
          const project = yield* Effect.promise(() =>
            makeTempCliProject(`stack-storage-${runtime}-e2e-`),
          );
          const artifacts = path.join(tmpdir(), "supabase-stack-artifacts");
          yield* fs.makeDirectory(path.join(home.dir, "cache"), { recursive: true });
          yield* fs.makeDirectory(artifacts, { recursive: true });
          yield* fs.symlink(artifacts, path.join(home.dir, "cache", "stack"));
          yield* fs.makeDirectory(path.join(project.dir, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(project.dir, "supabase", "config.toml"),
            projectConfig,
          );
          const cli = (args: Array<string>, exitTimeoutMs = CLEANUP_TIMEOUT_MS) =>
            runSupabaseEffect(args, {
              cwd: project.dir,
              home: home.dir,
              env: { SUPABASE_EXPERIMENTAL_STACK: "1" },
              exitTimeoutMs,
            });

          yield* Effect.addFinalizer((exit) =>
            cli(["stack", "destroy", "--yes"]).pipe(
              Effect.flatMap((destroyed) =>
                Exit.isFailure(exit) || destroyed.exitCode === 0
                  ? Effect.void
                  : new StackStorageE2eError({
                      message: `stack destroy exited ${destroyed.exitCode}: ${destroyed.stderr}`,
                    }),
              ),
              Effect.orDie,
            ),
          );

          const started = yield* cli(
            ["stack", "start", "--runtime", runtime, "--eager", "--output-format", "json"],
            COMMAND_TIMEOUT_MS,
          );
          expect(started.exitCode, `stdout:\n${started.stdout}\nstderr:\n${started.stderr}`).toBe(
            0,
          );
          const { id } = yield* Schema.decodeEffect(Schema.fromJsonString(StartResultSchema))(
            started.stdout.trim(),
          );
          const status = yield* cli([
            "stack",
            "status",
            "--env",
            "--stack-id",
            id,
            "--output-format",
            "json",
          ]);
          expect(status.exitCode, `stdout:\n${status.stdout}\nstderr:\n${status.stderr}`).toBe(0);
          const env = yield* Schema.decodeEffect(Schema.fromJsonString(StorageEnvSchema))(
            status.stdout,
          );
          const storageUrl = `${env.API_URL}/storage/v1`;
          expect(env.STORAGE_S3_URL).toBe(`${storageUrl}/s3`);
          const authorization = `Bearer ${env.SERVICE_ROLE_KEY}`;
          const bucket = "e2e";

          const createBucket = yield* http.execute(
            HttpClientRequest.post(`${storageUrl}/bucket`).pipe(
              HttpClientRequest.setHeaders({ authorization }),
              HttpClientRequest.bodyJsonUnsafe({ name: bucket }),
            ),
          );
          expect(createBucket.status, yield* createBucket.text).toBe(200);

          const s3 = new Bun.S3Client({
            accessKeyId: env.S3_PROTOCOL_ACCESS_KEY_ID,
            secretAccessKey: env.S3_PROTOCOL_ACCESS_KEY_SECRET,
            region: env.S3_PROTOCOL_REGION,
            endpoint: env.STORAGE_S3_URL,
            bucket,
          });
          yield* s3Call("write", () => s3.write("s3.txt", "written through S3"));
          const listing = yield* s3Call("list", () => s3.list());
          expect(listing.contents?.map(({ key }) => key)).toEqual(["s3.txt"]);
          expect(yield* s3Call("read", () => s3.file("s3.txt").text())).toBe("written through S3");

          const body = new TextEncoder().encode("resumable upload");
          const create = yield* http.execute(
            HttpClientRequest.post(`${storageUrl}/upload/resumable`).pipe(
              HttpClientRequest.setHeaders({
                authorization,
                "tus-resumable": "1.0.0",
                "upload-length": String(body.length),
                "upload-metadata": tusMetadata({
                  bucketName: bucket,
                  objectName: "resumable.txt",
                  contentType: "text/plain",
                }),
              }),
            ),
          );
          expect(create.status, yield* create.text).toBe(201);
          const location = create.headers.location ?? "";
          expect(location.startsWith(`${storageUrl}/upload/resumable/`), location).toBe(true);
          const patch = yield* http.execute(
            HttpClientRequest.patch(location).pipe(
              HttpClientRequest.setHeaders({
                authorization,
                "tus-resumable": "1.0.0",
                "upload-offset": "0",
              }),
              HttpClientRequest.bodyUint8Array(body, "application/offset+octet-stream"),
            ),
          );
          expect(patch.status, yield* patch.text).toBe(204);
          expect(yield* s3Call("read", () => s3.file("resumable.txt").text())).toBe(
            "resumable upload",
          );
        }).pipe(Effect.scoped, Effect.provide([BunServices.layer, FetchHttpClient.layer])),
      { timeout: COMMAND_TIMEOUT_MS + 2 * CLEANUP_TIMEOUT_MS },
    );
  }
});
