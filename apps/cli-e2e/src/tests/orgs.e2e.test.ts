import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const ORG_NAME = "My Test Org";

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

describe("orgs", () => {
  describe("orgs:list", () => {
    testBehaviour("renders org data", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["orgs", "list"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("ID");
          expect(result.stdout).toMatch(/[a-z]{20}|__PROJECT_REF__/);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["orgs", "list", "--output", "json"]));
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseJsonArray(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed.length).toBeGreaterThan(0);
          expect(parsed[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["orgs", "list", "--debug"]));
          expect(result.exitCode).toBe(0);
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
          const result = yield* Effect.promise(() => run(["orgs", "list"]));
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
          const result = yield* Effect.promise(() => run(["orgs", "list"]));
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
          const result = yield* Effect.promise(() => run(["orgs", "list"]));
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
          const result = yield* Effect.promise(() => run(["orgs", "list"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("orgs:create", () => {
    testBehaviour.skipIf(isRecording)("creates organization with name", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created organization:");
          expect(result.stdout).toMatch(/[a-z]{20}|__PROJECT_REF__/);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero without name in non-TTY", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["orgs", "create"]));
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 409 name conflict", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 409,
                body: { message: "Organization name already in use" },
              },
            }),
          );
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Organization name already in use");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403 plan limit reached", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 403, body: { message: "Organization limit reached" } },
            }),
          );
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Organization limit reached");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 422 validation error", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 422, body: { message: "Invalid organization name" } },
            }),
          );
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid organization name");
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
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
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
          const result = yield* Effect.promise(() => run(["orgs", "create", ORG_NAME]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
});
