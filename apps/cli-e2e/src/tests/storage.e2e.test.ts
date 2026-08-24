import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { testBehaviour } from "./test-context.ts";

const BUCKET = "cli-e2e-bucket";
const LOCAL_FLAGS = ["--experimental", "--local"];

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

const RequestEntrySchema = Schema.Struct({
  method: Schema.String,
  pathname: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Unknown,
});

const RequestLogSchema = Schema.Array(RequestEntrySchema);

interface HttpRequestOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
}

function httpRequest(input: string, init: HttpRequestOptions): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const method = init.method ?? "GET";
      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(input, {
        headers: init.headers === undefined ? {} : new globalThis.Headers(init.headers),
      });
      if (init.body !== undefined) {
        request = yield* HttpClientRequest.bodyJson(request, init.body);
      }
      const response = yield* HttpClient.execute(request);
      const body = yield* response.arrayBuffer;
      return new Response(body, { status: response.status, headers: { ...response.headers } });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
  );
}

const setupStorageWorkspace = (dir: string, relayUrl: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "supabase", "config.toml"),
      ['project_id = "test-project"', "", "[api]", `external_url = "${relayUrl}"`].join("\n"),
    );
    yield* fs.writeFileString(path.join(dir, "upload.txt"), "test upload content");
  });

const getRequestLog = (apiUrl: string) =>
  Effect.gen(function* () {
    const response = yield* Effect.promise(() => httpRequest(`${apiUrl}/_ctrl/requests`, {}));
    const body = yield* Effect.promise(() => response.text());
    return yield* Schema.decodeEffect(Schema.fromJsonString(RequestLogSchema))(body);
  });

const injectGlobalError = (apiUrl: string, status: number, message: string) =>
  Effect.promise(() =>
    httpRequest(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { status, body: { message } },
    }),
  ).pipe(Effect.asVoid);

const clearOverrides = (apiUrl: string) =>
  Effect.promise(() => httpRequest(`${apiUrl}/_ctrl/overrides`, { method: "DELETE" })).pipe(
    Effect.asVoid,
  );

// ---------------------------------------------------------------------------
// storage ls
// ---------------------------------------------------------------------------

describe("storage ls", () => {
  testBehaviour("lists objects in bucket", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello.txt");
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("lists objects recursively", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, "-r", `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* Effect.promise(() =>
          run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// storage cp
// ---------------------------------------------------------------------------

describe("storage cp", () => {
  testBehaviour("uploads local file to storage", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/${BUCKET}/upload.txt`,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("passes --cache-control header on upload", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run([
            "storage",
            "cp",
            ...LOCAL_FLAGS,
            "--cache-control",
            "no-cache",
            "upload.txt",
            `ss:///${BUCKET}/cached.txt`,
          ]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const uploadReq = requests.find(
          (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
        );
        expect(uploadReq).toBeDefined();
        expect(uploadReq?.headers["cache-control"]).toBe("no-cache");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("passes --content-type header on upload", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run([
            "storage",
            "cp",
            ...LOCAL_FLAGS,
            "--content-type",
            "application/json",
            "upload.txt",
            `ss:///${BUCKET}/typed.txt`,
          ]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const uploadReq = requests.find(
          (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
        );
        expect(uploadReq).toBeDefined();
        expect(uploadReq?.headers["content-type"]).toContain("application/json");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 when source file not found", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "nonexistent.txt", `ss:///${BUCKET}/x.txt`]),
        );
        expect(result.exitCode).toBe(1);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/upload.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("downloads file from storage", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, `ss:///${BUCKET}/hello.txt`, "hello-download.txt"]),
        );
        expect(result.exitCode).toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// storage mv
// ---------------------------------------------------------------------------

describe("storage mv", () => {
  testBehaviour("moves file within bucket", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        // Upload source file so the move has something to move in staging.
        yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/mv-source.txt`]),
        );
        const result = yield* Effect.promise(() =>
          run([
            "storage",
            "mv",
            ...LOCAL_FLAGS,
            `ss:///${BUCKET}/mv-source.txt`,
            `ss:///${BUCKET}/mv-dest.txt`,
          ]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const moveReq = requests.find(
          (r) => r.method === "POST" && r.pathname === "/storage/v1/object/move",
        );
        expect(moveReq).toBeDefined();
        expect(moveReq?.body).toMatchObject({
          bucketId: BUCKET,
          sourceKey: "mv-source.txt",
          destinationKey: "mv-dest.txt",
        });
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* Effect.promise(() =>
          run(["storage", "mv", ...LOCAL_FLAGS, `ss:///${BUCKET}/a.txt`, `ss:///${BUCKET}/b.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* Effect.promise(() =>
          run(["storage", "mv", ...LOCAL_FLAGS, `ss:///${BUCKET}/a.txt`, `ss:///${BUCKET}/b.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* Effect.promise(() =>
          run(["storage", "mv", ...LOCAL_FLAGS, `ss:///${BUCKET}/a.txt`, `ss:///${BUCKET}/b.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* Effect.promise(() =>
          run(["storage", "mv", ...LOCAL_FLAGS, `ss:///${BUCKET}/a.txt`, `ss:///${BUCKET}/b.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

// ---------------------------------------------------------------------------
// storage rm
// ---------------------------------------------------------------------------

describe("storage rm", () => {
  testBehaviour("removes a file from storage", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        // Upload the file to remove.
        yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/rm-target.txt`]),
        );
        const result = yield* Effect.promise(() =>
          run(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/rm-target.txt`]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const rmReq = requests.find(
          (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
        );
        expect(rmReq).toBeDefined();
        expect(rmReq?.body).toMatchObject({ prefixes: ["rm-target.txt"] });
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("removes multiple files", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(path.join(workspace.path, "file2.txt"), "second file");
        yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/rm-a.txt`]),
        );
        yield* Effect.promise(() =>
          run(["storage", "cp", ...LOCAL_FLAGS, "file2.txt", `ss:///${BUCKET}/rm-b.txt`]),
        );
        const result = yield* Effect.promise(() =>
          run([
            "storage",
            "rm",
            "--yes",
            ...LOCAL_FLAGS,
            `ss:///${BUCKET}/rm-a.txt`,
            `ss:///${BUCKET}/rm-b.txt`,
          ]),
        );
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const rmReq = requests.find(
          (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
        );
        expect(rmReq).toBeDefined();
        expect(rmReq?.body).toMatchObject({ prefixes: ["rm-a.txt", "rm-b.txt"] });
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* Effect.promise(() =>
          run(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/file.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* Effect.promise(() =>
          run(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/file.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* Effect.promise(() =>
          run(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/file.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* Effect.promise(() =>
          run(["storage", "rm", "--yes", ...LOCAL_FLAGS, `ss:///${BUCKET}/file.txt`]),
        );
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});
