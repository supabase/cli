import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const parseJson = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input);

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

describe("projects", () => {
  describe("projects:list", () => {
    testBehaviour("renders project list", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["projects", "list"]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/[a-z]{20}|__PROJECT_REF__/);
          expect(result.stdout).toContain("REFERENCE ID");
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
          const result = yield* Effect.promise(() => run(["projects", "list"]));
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["projects", "list", "--output", "json"]));
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseJsonArray(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed.length).toBeGreaterThan(0);
          expect(parsed[0]).toMatchObject({ name: expect.any(String), ref: expect.any(String) });
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["projects", "list", "--debug"]));
          expect(result.exitCode).toBe(0);
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
          const result = yield* Effect.promise(() => run(["projects", "list"]));
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* Effect.promise(() => run(["projects", "list"]));
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* Effect.promise(() => run(["projects", "list"]));
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("projects:api-keys", () => {
    testBehaviour("shows default and anon keys", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["projects", "api-keys", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("KEY VALUE");
          expect(result.stdout).toContain("anon");
          expect(result.stdout).toContain("default");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["projects", "api-keys", "--output", "json", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          const parsed = yield* parseJson(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "anon" })]),
          );
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
            run(["projects", "api-keys", "--project-ref", PROJECT_REF]),
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
            run(["projects", "api-keys", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["projects", "api-keys", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("projects:create", () => {
    testBehaviour("creates project with required flags", ({ run, orgId }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "projects",
              "create",
              "my-project",
              "--org-id",
              orgId,
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
              "--size",
              "micro",
            ]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("REFERENCE ID");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero without required flags in non-TTY", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["projects", "create", "--org-id", "test-org-id"]),
          );
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
              body: { status: 409, body: { message: "Project name already in use" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "projects",
              "create",
              "my-project",
              "--org-id",
              "test-org-id",
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
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
              body: {
                status: 422,
                body: {
                  message: "Validation failed",
                  errors: [{ field: "region", message: "Invalid region" }],
                },
              },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "projects",
              "create",
              "my-project",
              "--org-id",
              "test-org-id",
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 403 no org access", ({ run, apiUrl }) =>
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
              "projects",
              "create",
              "my-project",
              "--org-id",
              "test-org-id",
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
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
              "projects",
              "create",
              "my-project",
              "--org-id",
              "test-org-id",
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
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
            run([
              "projects",
              "create",
              "my-project",
              "--org-id",
              "test-org-id",
              "--db-password",
              "password123",
              "--region",
              "us-east-1",
            ]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("projects:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "returns 400 when project not ready for deletion",
      ({ run, apiUrl }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              httpRequest(`${apiUrl}/_ctrl/error-all`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: {
                  status: 400,
                  body: { message: "Project not ready for deletion." },
                },
              }),
            );
            const result = yield* Effect.promise(() =>
              run(["projects", "delete", PROJECT_REF, "--yes"]),
            );
            expect(result.exitCode).not.toBe(0);
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
        ),
    );

    testBehaviour.skipIf(isRecording)("deletes project with --yes flag", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["projects", "delete", projectRef, "--yes"]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Deleted project");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
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
            run(["projects", "delete", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
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
            run(["projects", "delete", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
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
            run(["projects", "delete", PROJECT_REF, "--yes"]),
          );
          expect(result.exitCode).not.toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
});
