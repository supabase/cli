import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const BRANCH_NAME = "my-branch";

describe("branches", () => {
  describe("branches:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["branches", "list", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("STATUS");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
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
          const result = yield* run(["branches", "list", "--debug", "--project-ref", projectRef]);
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
          const result = yield* run(["branches", "list", "--project-ref", PROJECT_REF]);
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
          const result = yield* run(["branches", "list", "--project-ref", PROJECT_REF]);
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
          const result = yield* run(["branches", "list", "--project-ref", PROJECT_REF]);
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
          const result = yield* run(["branches", "list", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("branches:create", () => {
    testBehaviour.skipIf(isRecording)("creates ephemeral branch", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("creates persistent branch", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--persistent",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)("creates branch with data", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--with-data",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created preview branch:");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 409 name conflict", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 409,
            body: { message: "Branch name already in use" },
          });
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch name already in use");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 branching not enabled", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "Preview branching is not enabled" },
          });
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Preview branching is not enabled");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 invalid region", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "Invalid region" },
          });
          const result = yield* run([
            "branches",
            "create",
            BRANCH_NAME,
            "--region",
            "invalid-region",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("--region");
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
            "branches",
            "create",
            BRANCH_NAME,
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
            "branches",
            "create",
            BRANCH_NAME,
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
            "branches",
            "create",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );
  });

  describe("branches:get", () => {
    testBehaviour.skipIf(isRecording)(
      "returns single branch details",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
              "get",
              BRANCH_NAME,
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain(BRANCH_NAME);
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "returns json output with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
              "get",
              BRANCH_NAME,
              "--output",
              "json",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(parsed).toMatchObject({ SUPABASE_JWT_SECRET: expect.any(String) });
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Branch not found" },
          });
          const result = yield* run([
            "branches",
            "get",
            "nonexistent",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
          const result = yield* run(["branches", "get", BRANCH_NAME, "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });

  describe("branches:update", () => {
    testBehaviour.skipIf(isRecording)("renames branch with --name", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "branches",
            "update",
            BRANCH_NAME,
            "--name",
            "renamed-branch",
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("Updated preview branch:");
        }),
        signal,
      ),
    );

    testBehaviour.skipIf(isRecording)(
      "changes git branch with --git-branch",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
              "update",
              BRANCH_NAME,
              "--git-branch",
              "feature/new",
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain("Updated preview branch:");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Branch not found" },
          });
          const result = yield* run([
            "branches",
            "update",
            "nonexistent",
            "--name",
            "new-name",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            "branches",
            "update",
            BRANCH_NAME,
            "--name",
            "new-name",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });

  describe("branches:pause", () => {
    testBehaviour.skipIf(isRecording)("pauses branch successfully", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "branches",
            "pause",
            BRANCH_NAME,
            "--project-ref",
            projectRef,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Branch not found" },
          });
          const result = yield* run([
            "branches",
            "pause",
            "nonexistent",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            "branches",
            "pause",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });

  describe("branches:unpause", () => {
    testBehaviour.skipIf(isRecording)(
      "unpauses branch successfully",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
              "unpause",
              BRANCH_NAME,
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
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
            "branches",
            "unpause",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });

  describe("branches:delete", () => {
    testBehaviour.skipIf(isRecording)(
      "deletes branch successfully",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "branches",
              "delete",
              BRANCH_NAME,
              "--project-ref",
              projectRef,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toContain("Deleted preview branch:");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 branch not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Branch not found" },
          });
          const result = yield* run([
            "branches",
            "delete",
            "nonexistent",
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Branch not found");
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
            "branches",
            "delete",
            BRANCH_NAME,
            "--project-ref",
            PROJECT_REF,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });

  describe("branches:disable", () => {
    testBehaviour.skipIf(isRecording)("disables preview branching", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["branches", "disable", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Disabled preview branching for project:");
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
          const result = yield* run(["branches", "disable", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
        signal,
      ),
    );
  });
});
