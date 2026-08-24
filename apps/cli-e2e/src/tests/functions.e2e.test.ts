import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const FUNCTION_NAME = "hello-world";

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

describe("functions", () => {
  describe("functions:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["functions", "list", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("STATUS");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["functions", "list", "--output", "json", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseJsonArray(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["functions", "list", "--debug", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toMatch(/HTTP.*GET:/);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("functions:deploy", () => {
    // Deploy requires the Go binary to bundle function files locally before any API call,
    // so error injection tests pre-create the function with `functions new` first.

    testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["functions", "new", FUNCTION_NAME]));
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 401, body: { message: "Invalid token" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["functions", "new", FUNCTION_NAME]));
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Forbidden" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["functions", "new", FUNCTION_NAME]));
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/rate-limit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                path: `/v1/projects/${PROJECT_REF}/functions/deploy`,
                retryAfterSeconds: 0,
              },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() => run(["functions", "new", FUNCTION_NAME]));
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 500, body: { message: "Internal Server Error" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["functions", "deploy", FUNCTION_NAME, "--use-api", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("functions:delete", () => {
    testBehaviour.skipIf(isRecording)("deletes function successfully", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Deleted Function");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 function not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Function not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("does not exist");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["functions", "delete", FUNCTION_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("functions:download", () => {
    testBehaviour.skipIf(isRecording)("downloads function successfully", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["functions", "download", FUNCTION_NAME, "--use-api", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("Downloaded Function");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run([
              "functions",
              "download",
              FUNCTION_NAME,
              "--use-api",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run([
              "functions",
              "download",
              FUNCTION_NAME,
              "--use-api",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 function not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Function not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "functions",
              "download",
              FUNCTION_NAME,
              "--use-api",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Function not found");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run([
              "functions",
              "download",
              FUNCTION_NAME,
              "--use-api",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("functions:new", () => {
    testBehaviour("successfully creates a new function", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["functions", "new", "testFunction"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(
            "Created new Function at supabase/functions/testFunction",
          );
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
});
