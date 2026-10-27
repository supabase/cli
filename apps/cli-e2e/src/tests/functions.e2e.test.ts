import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const FUNCTION_NAME = "hello-world";

describe("functions", () => {
  describe("functions:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["functions", "list", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("STATUS");
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "functions",
            "list",
            "--output",
            "json",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["functions", "list", "--debug", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toMatch(/HTTP.*GET:/);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run(["functions", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run(["functions", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run(["functions", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run(["functions", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("functions:deploy", () => {
    // Deploy requires the Go binary to bundle function files locally before any API call,
    // so error injection tests pre-create the function with `functions new` first.

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["functions", "new", FUNCTION_NAME]);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run([
            "functions",
            "deploy",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["functions", "new", FUNCTION_NAME]);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "functions",
            "deploy",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["functions", "new", FUNCTION_NAME]);
          yield* postControl(`${apiUrl}/_ctrl/rate-limit`, {
            path: `/v1/projects/${PROJECT_REF}/functions/deploy`,
            retryAfterSeconds: 0,
          });
          const result = yield* run([
            "functions",
            "deploy",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["functions", "new", FUNCTION_NAME]);
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run([
            "functions",
            "deploy",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("functions:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "deletes function successfully",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "functions",
              "delete",
              FUNCTION_NAME,
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("Deleted Function");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 function not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Function not found" },
          });
          const result = yield* run([
            "functions",
            "delete",
            FUNCTION_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("does not exist");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run([
            "functions",
            "delete",
            FUNCTION_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "functions",
            "delete",
            FUNCTION_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 429", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 429,
            body: { message: "Too Many Requests" },
          });
          const result = yield* run([
            "functions",
            "delete",
            FUNCTION_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run([
            "functions",
            "delete",
            FUNCTION_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("functions:download", () => {
    testBehaviour.skipIf(isRecording)(
      "downloads function successfully",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "functions",
              "download",
              FUNCTION_NAME,
              "--use-api",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain("Downloaded Function");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 401,
            body: { message: "Invalid token" },
          });
          const result = yield* run([
            "functions",
            "download",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "functions",
            "download",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 function not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Function not found" },
          });
          const result = yield* run([
            "functions",
            "download",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Function not found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 500,
            body: { message: "Internal Server Error" },
          });
          const result = yield* run([
            "functions",
            "download",
            FUNCTION_NAME,
            "--use-api",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("functions:new", () => {
    testBehaviour("successfully creates a new function", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["functions", "new", "testFunction"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain(
            "Created new Function at supabase/functions/testFunction",
          );
        }),
        signal,
      ),
    );
  });
});
