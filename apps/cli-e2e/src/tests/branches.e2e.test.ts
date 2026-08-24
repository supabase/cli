import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const BRANCH_NAME = "my-branch";

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

describe("branches", () => {
  describe("branches:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "list", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("STATUS");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run(["branches", "list", "--output", "json", "--project-ref", projectRef]),
            );
            expect(result.exitCode).toBe(0);
            const parsed = yield* parseJson(result.stdout);
            expect(Array.isArray(parsed)).toBe(true);
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
        ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "list", "--debug", "--project-ref", projectRef]),
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
            run(["branches", "list", "--project-ref", PROJECT_REF]),
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
            run(["branches", "list", "--project-ref", PROJECT_REF]),
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
            run(["branches", "list", "--project-ref", PROJECT_REF]),
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
            run(["branches", "list", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:create", () => {
    testBehaviour.skipIf(isRecording)("creates ephemeral branch", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "create", BRANCH_NAME, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("creates persistent branch", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "create", BRANCH_NAME, "--persistent", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)("creates branch with data", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "create", BRANCH_NAME, "--with-data", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
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
              body: { status: 409, body: { message: "Branch name already in use" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch name already in use");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 422 branching not enabled", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: {
                status: 422,
                body: { message: "Preview branching is not enabled" },
              },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Preview branching is not enabled");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 422 invalid region", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 422, body: { message: "Invalid region" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "branches",
              "create",
              BRANCH_NAME,
              "--region",
              "invalid-region",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("--region");
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
            run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]),
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
            run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]),
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
            run(["branches", "create", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:get", () => {
    testBehaviour.skipIf(isRecording)("returns single branch details", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "get", BRANCH_NAME, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(BRANCH_NAME);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run([
                "branches",
                "get",
                BRANCH_NAME,
                "--output",
                "json",
                "--project-ref",
                projectRef,
              ]),
            );
            expect(result.exitCode).toBe(0);
            const parsed = yield* parseJson(result.stdout);
            expect(parsed).toMatchObject({ SUPABASE_JWT_SECRET: expect.any(String) });
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Branch not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["branches", "get", "nonexistent", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            run(["branches", "get", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:update", () => {
    testBehaviour.skipIf(isRecording)("renames branch with --name", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run([
              "branches",
              "update",
              BRANCH_NAME,
              "--name",
              "renamed-branch",
              "--project-ref",
              projectRef,
            ]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("Updated preview branch:");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "changes git branch with --git-branch",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const result = yield* Effect.promise(() =>
              run([
                "branches",
                "update",
                BRANCH_NAME,
                "--git-branch",
                "feature/new",
                "--project-ref",
                projectRef,
              ]),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain("Updated preview branch:");
          }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
        ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Branch not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run([
              "branches",
              "update",
              "nonexistent",
              "--name",
              "new-name",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
              "branches",
              "update",
              BRANCH_NAME,
              "--name",
              "new-name",
              "--project-ref",
              PROJECT_REF,
            ]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:pause", () => {
    testBehaviour.skipIf(isRecording)("pauses branch successfully", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "pause", BRANCH_NAME, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Branch not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["branches", "pause", "nonexistent", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            run(["branches", "pause", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:unpause", () => {
    testBehaviour.skipIf(isRecording)("unpauses branch successfully", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "unpause", BRANCH_NAME, "--project-ref", projectRef]),
          );
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
          const result = yield* Effect.promise(() =>
            run(["branches", "unpause", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:delete", () => {
    testBehaviour.skipIf(isRecording)("deletes branch successfully", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "delete", BRANCH_NAME, "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("Deleted preview branch:");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            httpRequest(`${apiUrl}/_ctrl/error-all`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { status: 404, body: { message: "Branch not found" } },
            }),
          );
          const result = yield* Effect.promise(() =>
            run(["branches", "delete", "nonexistent", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            run(["branches", "delete", BRANCH_NAME, "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });

  describe("branches:disable", () => {
    testBehaviour.skipIf(isRecording)("disables preview branching", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["branches", "disable", "--project-ref", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Disabled preview branching for project:");
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
            run(["branches", "disable", "--project-ref", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
      ),
    );
  });
});
