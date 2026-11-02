import { Effect, FileSystem, Path, Schema } from "effect";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

describe("secrets", () => {
  describe("secrets:list", () => {
    testBehaviour("renders fixture data in output", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["secrets", "list", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("NAME");
          expect(result.stdout).toContain("DIGEST");
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
          const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "secrets",
            "list",
            "--output",
            "json",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
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
          const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["secrets", "list", "--debug", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("secrets:set", () => {
    testBehaviour("sets a single secret", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "secrets",
            "set",
            "FOO=bar",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }),
        signal,
      ),
    );

    testBehaviour("sets multiple secrets", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "secrets",
            "set",
            "FOO=bar",
            "BAZ=qux",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }),
        signal,
      ),
    );

    testBehaviour("sets secrets from env file", ({ run, workspace, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.writeFileString(path.join(workspace.path, ".env.local"), "FOO=bar\n");
          const result = yield* run([
            "secrets",
            "set",
            "--env-file",
            ".env.local",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 invalid name", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "Validation failed", errors: [{ message: "Invalid secret name" }] },
          });
          const result = yield* run([
            "secrets",
            "set",
            "FOO=bar",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero when env file not found", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "secrets",
            "set",
            "--env-file",
            "nonexistent.env",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "secrets",
            "set",
            "FOO=bar",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("secrets:unset", () => {
    testBehaviour("removes a secret", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["secrets", "unset", "FOO", "--yes", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }),
        signal,
      ),
    );

    testBehaviour("removes multiple secrets", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* run(["secrets", "set", "FOO=bar", "BAR=baz", "--yes", `--remote=${projectRef}`]);
          const result = yield* run([
            "secrets",
            "unset",
            "FOO",
            "BAR",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 404", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Secret not found" },
          });
          const result = yield* run([
            "secrets",
            "unset",
            "NONEXISTENT",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "secrets",
            "unset",
            "FOO",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
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
          const result = yield* run([
            "secrets",
            "unset",
            "FOO",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });
});
