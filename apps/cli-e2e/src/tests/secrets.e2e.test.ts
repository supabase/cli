import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

const parseJsonArray = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(input);

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

const writeSecretsEnvFile = (workspacePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(workspacePath, ".env.local"), "FOO=bar\n");
  });

describe("secrets", () => {
  describe("secrets:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("DIGEST");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--output", "json", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseJsonArray(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 project not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Project not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 429, body: { message: "Too Many Requests" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "list", "--debug", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("secrets:set", () => {
    testBehaviour("sets a single secret", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "FOO=bar", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("sets multiple secrets", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "FOO=bar", "BAZ=qux", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("sets secrets from env file", ({ run, workspace, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* writeSecretsEnvFile(workspace.path);
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "--env-file", ".env.local", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 422 invalid name", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 422,
                body: {
                  message: "Validation failed",
                  errors: [{ message: "Invalid secret name" }],
                },
              },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "FOO=bar", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero when env file not found", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "--env-file", "nonexistent.env", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "set", "FOO=bar", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });

  describe("secrets:unset", () => {
    testBehaviour("removes a secret", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["secrets", "unset", "FOO", "--project-ref", projectRef, "--yes"]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("removes multiple secrets", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            run(["secrets", "set", "FOO=bar", "BAR=baz", "--project-ref", projectRef]),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "unset", "FOO", "BAR", "--project-ref", projectRef, "--yes"]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Secret not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "unset", "NONEXISTENT", "--project-ref", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "unset", "FOO", "--project-ref", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["secrets", "unset", "FOO", "--project-ref", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
    );
  });
});
