import { Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect } from "vitest";
import { postControl, runE2e, testBehaviour } from "./test-context.ts";

const BUCKET = "cli-e2e-bucket";
const LOCAL_FLAGS = ["--experimental", "--local"];

const setupStorageWorkspace = Effect.fnUntraced(function* (dir: string, relayUrl: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(dir, "supabase", "config.toml"),
    ['project_id = "test-project"', "", "[api]", `external_url = "${relayUrl}"`].join("\n"),
  );
  yield* fs.writeFileString(path.join(dir, "upload.txt"), "test upload content");
});

const RequestEntry = Schema.Struct({
  method: Schema.String,
  pathname: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Unknown,
});

const getRequestLog = Effect.fnUntraced(function* (apiUrl: string) {
  const res = yield* HttpClient.get(`${apiUrl}/_ctrl/requests`);
  return yield* HttpClientResponse.schemaBodyJson(Schema.Array(RequestEntry))(res);
});

const injectGlobalError = (apiUrl: string, status: number, message: string) =>
  postControl(`${apiUrl}/_ctrl/error-all`, { status, body: { message } });

const clearOverrides = (apiUrl: string) => HttpClient.del(`${apiUrl}/_ctrl/overrides`);

describe("storage ls", () => {
  testBehaviour("lists objects in bucket", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("hello.txt");
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
          ),
        ).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour("lists objects recursively", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, "-r", `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/list/${BUCKET}`,
          ),
        ).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* run(["storage", "ls", ...LOCAL_FLAGS, `ss:///${BUCKET}/`]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );
});

describe("storage cp", () => {
  testBehaviour("uploads local file to storage", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/upload.txt`,
        ]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        expect(
          requests.some(
            (r) => r.method === "POST" && r.pathname === `/storage/v1/object/${BUCKET}/upload.txt`,
          ),
        ).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour("passes --cache-control header on upload", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "--cache-control",
          "no-cache",
          "upload.txt",
          `ss:///${BUCKET}/cached.txt`,
        ]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const uploadReq = requests.find(
          (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
        );
        expect(uploadReq).toBeDefined();
        expect(uploadReq?.headers["cache-control"]).toBe("no-cache");
      }),
      signal,
    ),
  );

  testBehaviour("passes --content-type header on upload", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "--content-type",
          "application/json",
          "upload.txt",
          `ss:///${BUCKET}/typed.txt`,
        ]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const uploadReq = requests.find(
          (r) => r.method === "POST" && r.pathname.startsWith(`/storage/v1/object/${BUCKET}/`),
        );
        expect(uploadReq).toBeDefined();
        expect(uploadReq?.headers["content-type"]).toContain("application/json");
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 when source file not found", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "nonexistent.txt",
          `ss:///${BUCKET}/x.txt`,
        ]);
        expect(result.exitCode).toBe(1);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/upload.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/upload.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/upload.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/upload.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("downloads file from storage", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        const result = yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/hello.txt`,
          "hello-download.txt",
        ]);
        expect(result.exitCode).toBe(0);
      }),
      signal,
    ),
  );
});

describe("storage mv", () => {
  testBehaviour("moves file within bucket", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        // Upload source file so the move has something to move in staging.
        yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/mv-source.txt`,
        ]);
        const result = yield* run([
          "storage",
          "mv",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/mv-source.txt`,
          `ss:///${BUCKET}/mv-dest.txt`,
        ]);
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
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* run([
          "storage",
          "mv",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/a.txt`,
          `ss:///${BUCKET}/b.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* run([
          "storage",
          "mv",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/a.txt`,
          `ss:///${BUCKET}/b.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* run([
          "storage",
          "mv",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/a.txt`,
          `ss:///${BUCKET}/b.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* run([
          "storage",
          "mv",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/a.txt`,
          `ss:///${BUCKET}/b.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );
});

describe("storage rm", () => {
  testBehaviour("removes a file from storage", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        // Upload the file to remove.
        yield* run([
          "storage",
          "cp",
          ...LOCAL_FLAGS,
          "upload.txt",
          `ss:///${BUCKET}/rm-target.txt`,
        ]);
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/rm-target.txt`,
        ]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const rmReq = requests.find(
          (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
        );
        expect(rmReq).toBeDefined();
        expect(rmReq?.body).toMatchObject({ prefixes: ["rm-target.txt"] });
      }),
      signal,
    ),
  );

  testBehaviour("removes multiple files", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* fs.writeFileString(path.join(workspace.path, "file2.txt"), "second file");
        yield* run(["storage", "cp", ...LOCAL_FLAGS, "upload.txt", `ss:///${BUCKET}/rm-a.txt`]);
        yield* run(["storage", "cp", ...LOCAL_FLAGS, "file2.txt", `ss:///${BUCKET}/rm-b.txt`]);
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/rm-a.txt`,
          `ss:///${BUCKET}/rm-b.txt`,
        ]);
        expect(result.exitCode).toBe(0);
        const requests = yield* getRequestLog(apiUrl);
        const rmReq = requests.find(
          (r) => r.method === "DELETE" && r.pathname === `/storage/v1/object/${BUCKET}`,
        );
        expect(rmReq).toBeDefined();
        expect(rmReq?.body).toMatchObject({ prefixes: ["rm-a.txt", "rm-b.txt"] });
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 401", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 401, "Invalid token");
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/file.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Invalid token");
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 403", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 403, "Forbidden");
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/file.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 429", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 429, "Too Many Requests");
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/file.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );

  testBehaviour("exits 1 on 500", ({ workspace, run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* setupStorageWorkspace(workspace.path, apiUrl);
        yield* injectGlobalError(apiUrl, 500, "Internal Server Error");
        const result = yield* run([
          "storage",
          "rm",
          "--yes",
          ...LOCAL_FLAGS,
          `ss:///${BUCKET}/file.txt`,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.length).toBeGreaterThan(0);
        yield* clearOverrides(apiUrl);
      }),
      signal,
    ),
  );
});
