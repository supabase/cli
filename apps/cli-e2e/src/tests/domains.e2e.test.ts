import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { testBehaviour } from "./test-context.ts";
import { isRecording, PROJECT_REF } from "./env.ts";

const CONFIGURED_CNAME = "www.urgsimurksi.xyz";

const parseJson = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input);

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

describe("domains", () => {
  describe.todo("domains:create — requires mocking of 1.1.1.1 for DNS queries");

  describe("domains:get", () => {
    testBehaviour("custom domain disabled", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 400,
                body: { message: "Please enable custom domains first" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
          );
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            "www.urgsimurksi.xyz CNAME -> __PROJECT_REF__.supabase.red",
          );
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("domain activated", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF, "--output", "json"]),
          );

          expect(result.exitCode).toBe(0);

          expect(yield* parseJson(result.stdout)).toEqual({
            custom_hostname: "www.urgsimurksi.xyz",
            data: {
              errors: [],
              messages: [],
              result: {
                custom_origin_server: "__PROJECT_REF__.supabase.red",
                hostname: "www.urgsimurksi.xyz",
                id: "00000000-0000-0000-0000-000000000000",
                ownership_verification: {
                  name: "",
                  type: "",
                  value: "",
                },
                ssl: {
                  status: "active",
                  validation_records: [],
                },
                status: "active",
              },
              success: true,
            },
            status: "5_services_reconfigured",
          });
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exists non-zero on 403", ({ apiUrl, run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 403,
                body: { message: "Unauthorized" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("403");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exists non-zero on 401", ({ apiUrl, run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 401,
                body: { message: "Unauthorized" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("401");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exists non-zero on 429", ({ apiUrl, run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 429,
                body: { message: "Too Many Requests" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("429");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exists non-zero on 500", ({ apiUrl, run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 500,
                body: { message: "Internal Server Error" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("500");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exists non-zero on 502", ({ apiUrl, run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 502,
                body: { message: "Bad Gateway" },
              },
            }),
          );

          const result = yield* Effect.promise(() =>
            run(["domains", "get", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("502");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("domains:reverify", () => {
    testBehaviour("custom domain disabled", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "reverify", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "reverify", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "reverify", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(
            "_acme-challenge.www.urgsimurksi.xyz TXT -> dx8wOwXMeAgc7uOQ3q0RlSQKvGl_HhcIsph_9PqwQYw",
          );
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "reverify", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
  describe("domains:activate", () => {
    testBehaviour("custom domain disabled", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification in debug mode", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF, "--debug"]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toMatch(/HTTP.*POST:/);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("verification completed", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain(`completed`);
          expect(result.stderr).toContain(`at ${CONFIGURED_CNAME}`);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("domain activated", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "activate", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("domains:delete", () => {
    testBehaviour("custom domain disabled", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "delete", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("no custom domain", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "delete", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("400");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("pending verification", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["domains", "delete", "--project-ref", PROJECT_REF]),
          );

          expect(result.exitCode).toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
});
