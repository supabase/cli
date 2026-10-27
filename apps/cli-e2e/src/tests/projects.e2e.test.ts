import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

describe("projects", () => {
  describe("projects:list", () => {
    testBehaviour("renders project list", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["projects", "list"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toMatch(/[a-z]{20}/);
          expect(result.stdout).toContain("REFERENCE ID");
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
          const result = yield* run(["projects", "list"]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["projects", "list", "--output", "json"]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          /* Narrows the type only: the assertion above already fails a non-array. */
          if (!Array.isArray(parsed)) return;
          expect(parsed.length).toBeGreaterThan(0);
          expect(parsed[0]).toMatchObject({ name: expect.any(String), ref: expect.any(String) });
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["projects", "list", "--debug"]);
          expect(result.exitCode).toBe(0);
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
          const result = yield* run(["projects", "list"]);
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* run(["projects", "list"]);
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* run(["projects", "list"]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("projects:api-keys", () => {
    testBehaviour("shows default and anon keys", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["projects", "api-keys", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("KEY VALUE");
          expect(result.stdout).toContain("anon");
          expect(result.stdout).toContain("default");
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "projects",
            "api-keys",
            "--output",
            "json",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "anon" })]),
          );
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
          const result = yield* run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
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
          const result = yield* run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 project not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Project not found" },
          });
          const result = yield* run(["projects", "api-keys", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("projects:create", () => {
    testBehaviour("creates project with required flags", ({ run, orgId, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
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
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("REFERENCE ID");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero without required flags in non-TTY", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["projects", "create", "--org-id", "test-org-id"]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 409 name conflict", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 409,
            body: { message: "Project name already in use" },
          });
          const result = yield* run([
            "projects",
            "create",
            "my-project",
            "--org-id",
            "test-org-id",
            "--db-password",
            "password123",
            "--region",
            "us-east-1",
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 validation error", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: {
              message: "Validation failed",
              errors: [{ field: "region", message: "Invalid region" }],
            },
          });
          const result = yield* run([
            "projects",
            "create",
            "my-project",
            "--org-id",
            "test-org-id",
            "--db-password",
            "password123",
            "--region",
            "us-east-1",
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403 no org access", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Forbidden" },
          });
          const result = yield* run([
            "projects",
            "create",
            "my-project",
            "--org-id",
            "test-org-id",
            "--db-password",
            "password123",
            "--region",
            "us-east-1",
          ]);
          expect(result.exitCode).not.toBe(0);
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
            "projects",
            "create",
            "my-project",
            "--org-id",
            "test-org-id",
            "--db-password",
            "password123",
            "--region",
            "us-east-1",
          ]);
          expect(result.exitCode).not.toBe(0);
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
            "projects",
            "create",
            "my-project",
            "--org-id",
            "test-org-id",
            "--db-password",
            "password123",
            "--region",
            "us-east-1",
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("projects:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "returns 400 when project not ready for deletion",
      ({ run, apiUrl, signal }) =>
        runE2e(
          Effect.gen(function* () {
            yield* postControl(`${apiUrl}/_ctrl/error-all`, {
              status: 400,
              body: { message: "Project not ready for deletion." },
            });
            const result = yield* run(["projects", "delete", PROJECT_REF, "--yes"]);
            expect(result.exitCode).not.toBe(0);
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "deletes project with --yes flag",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run(["projects", "delete", projectRef, "--yes"]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("Deleted project");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 project not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Project not found" },
          });
          const result = yield* run(["projects", "delete", PROJECT_REF, "--yes"]);
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* run(["projects", "delete", PROJECT_REF, "--yes"]);
          expect(result.exitCode).not.toBe(0);
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
          const result = yield* run(["projects", "delete", PROJECT_REF, "--yes"]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });
});
