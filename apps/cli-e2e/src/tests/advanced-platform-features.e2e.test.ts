import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { BACKUP_TIMESTAMP, PROJECT_REF, SNIPPET_ID, isRecording } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

describe("postgres-config", () => {
  describe("postgres-config:get", () => {
    testBehaviour("renders config overrides", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toBe("");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns config overrides as JSON with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "postgres-config",
              "get",
              "--experimental",
              "--output",
              "json",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(parsed).not.toBeNull();
            expect(typeof parsed).toBe("object");
          }),
          signal,
        ),
    );

    testBehaviour("--debug shows HTTP trace", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "get",
            "--experimental",
            "--debug",
            `--remote=${projectRef}`,
          ]);
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
          const result = yield* run([
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run([
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "postgres-config",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("postgres-config:update", () => {
    testBehaviour("sets single config override", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("sets multiple config overrides", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--config",
            "shared_buffers=256MB",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour(
      "--replace-existing-overrides replaces all overrides",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "postgres-config",
              "update",
              "--experimental",
              "--config",
              "max_connections=200",
              "--replace-existing-overrides",
              "--yes",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
          }),
          signal,
        ),
    );

    testBehaviour(
      "--no-restart applies config without restarting postgres",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "postgres-config",
              "update",
              "--experimental",
              "--config",
              "max_connections=200",
              "--no-restart",
              "--yes",
              `--remote=${projectRef}`,
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
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 unrecognized config key", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "unrecognized config key: invalid_key" },
          });
          const result = yield* run([
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "invalid_key=value",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("unrecognized config key");
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
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "postgres-config",
            "update",
            "--experimental",
            "--config",
            "max_connections=200",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("postgres-config:delete", () => {
    testBehaviour("removes config override", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("removes multiple config keys", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--config",
            "shared_buffers",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour(
      "--no-restart removes config without restarting postgres",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "postgres-config",
              "delete",
              "--experimental",
              "--config",
              "max_connections",
              "--no-restart",
              "--yes",
              `--remote=${projectRef}`,
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
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "postgres-config",
            "delete",
            "--experimental",
            "--config",
            "max_connections",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});

describe("vanity-subdomains", () => {
  describe("vanity-subdomains:get", () => {
    testBehaviour("renders vanity subdomain and status", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toBe("");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns subdomain config as JSON with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "vanity-subdomains",
              "get",
              "--experimental",
              "--output",
              "json",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(parsed).toHaveProperty("status");
          }),
          signal,
        ),
    );

    testBehaviour("--debug shows HTTP trace", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "get",
            "--experimental",
            "--debug",
            `--remote=${projectRef}`,
          ]);
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
          const result = yield* run([
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run([
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
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
            "vanity-subdomains",
            "get",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("vanity-subdomains:check-availability", () => {
    testBehaviour("reports availability for desired subdomain", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toBe("");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns availability as JSON with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "vanity-subdomains",
              "check-availability",
              "--experimental",
              "--desired-subdomain",
              "myapp",
              "--output",
              "json",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(parsed).toHaveProperty("available");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero without --desired-subdomain flag", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 409 subdomain taken", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 409,
            body: { message: "Subdomain already taken" },
          });
          const result = yield* run([
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            "--desired-subdomain",
            "taken",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("already taken");
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
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "vanity-subdomains",
            "check-availability",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Too Many Requests");
        }),
        signal,
      ),
    );
  });

  describe("vanity-subdomains:activate", () => {
    testBehaviour("activates desired vanity subdomain", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Activated vanity subdomain");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 409 subdomain already taken", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 409,
            body: { message: "Subdomain already taken" },
          });
          const result = yield* run([
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "taken",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("already taken");
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
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "vanity-subdomains",
            "activate",
            "--experimental",
            "--desired-subdomain",
            "myapp",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("vanity-subdomains:delete", () => {
    testBehaviour("removes vanity subdomain", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "vanity-subdomains",
            "delete",
            "--experimental",
            "--yes",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toContain("Deleted vanity subdomain");
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
            "vanity-subdomains",
            "delete",
            "--experimental",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "vanity-subdomains",
            "delete",
            "--experimental",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "vanity-subdomains",
            "delete",
            "--experimental",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "vanity-subdomains",
            "delete",
            "--experimental",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});

describe("encryption", () => {
  describe("encryption:get-root-key", () => {
    testBehaviour("renders root encryption key", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["encryption", "get-root-key", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).not.toBe("");
        }),
        signal,
      ),
    );

    testBehaviour("returns root_key as JSON with --output json", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "encryption",
            "get-root-key",
            "--output",
            "json",
            `--remote=${projectRef}`,
          ]);
          expect(result.exitCode).toBe(0);
        }),
        signal,
      ),
    );

    testBehaviour("--debug shows HTTP trace", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "encryption",
            "get-root-key",
            "--debug",
            `--remote=${projectRef}`,
          ]);
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
          const result = yield* run(["encryption", "get-root-key", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["encryption", "get-root-key", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run(["encryption", "get-root-key", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
          const result = yield* run(["encryption", "get-root-key", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["encryption", "get-root-key", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("encryption:update-root-key", () => {
    testBehaviour.skipIf(isRecording)("rotates the vault root key", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run([
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${projectRef}`,
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
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run([
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "encryption",
            "update-root-key",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});

describe("backups", () => {
  describe("backups:list", () => {
    testBehaviour("renders backup table with REGION column", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["backups", "list", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("REGION");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns backup response as JSON with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "backups",
              "list",
              "--output",
              "json",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
            expect(parsed).toHaveProperty("region");
          }),
          signal,
        ),
    );

    testBehaviour("--debug shows HTTP trace", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["backups", "list", "--debug", `--remote=${projectRef}`]);
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
          const result = yield* run(["backups", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["backups", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run(["backups", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
          const result = yield* run(["backups", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["backups", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("backups:restore", () => {
    testBehaviour.skipIf(isRecording)(
      "initiates PITR restore with -t timestamp",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "backups",
              "restore",
              "-t",
              String(BACKUP_TIMESTAMP),
              "--yes",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 422 out-of-range timestamp", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "recovery time target is out of range" },
          });
          const result = yield* run([
            "backups",
            "restore",
            "-t",
            "0",
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("out of range");
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
            "backups",
            "restore",
            "-t",
            String(BACKUP_TIMESTAMP),
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
          const result = yield* run([
            "backups",
            "restore",
            "-t",
            String(BACKUP_TIMESTAMP),
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
            "backups",
            "restore",
            "-t",
            String(BACKUP_TIMESTAMP),
            "--yes",
            `--remote=${PROJECT_REF}`,
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
            "backups",
            "restore",
            "-t",
            String(BACKUP_TIMESTAMP),
            "--yes",
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});

describe("snippets", () => {
  describe("snippets:list", () => {
    testBehaviour("renders snippet table with ID and NAME columns", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["snippets", "list", `--remote=${projectRef}`]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("ID");
          expect(result.stdout).toContain("NAME");
        }),
        signal,
      ),
    );

    testBehaviour(
      "returns snippet list as JSON with --output json",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "snippets",
              "list",
              "--output",
              "json",
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            const parsed = yield* decodeJsonOutput(Schema.Record(Schema.String, Schema.Unknown))(
              result.stdout,
            );
            expect(Array.isArray(parsed.data)).toBe(true);
          }),
          signal,
        ),
    );

    testBehaviour("--debug shows HTTP trace", ({ run, projectRef, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["snippets", "list", "--debug", `--remote=${projectRef}`]);
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
          const result = yield* run(["snippets", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["snippets", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
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
          const result = yield* run(["snippets", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
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
          const result = yield* run(["snippets", "list", `--remote=${PROJECT_REF}`]);
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
          const result = yield* run(["snippets", "list", `--remote=${PROJECT_REF}`]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("snippets:download", () => {
    testBehaviour.skipIf(isRecording)(
      "prints SQL content to stdout",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "snippets",
              "download",
              SNIPPET_ID,
              `--remote=${projectRef}`,
            ]);
            expect(result.exitCode).toBe(0);
            expect(result.stdout).not.toBe("");
          }),
          signal,
        ),
    );

    testBehaviour("exits non-zero on 404 snippet not found", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 404,
            body: { message: "Snippet not found" },
          });
          const result = yield* run([
            "snippets",
            "download",
            SNIPPET_ID,
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("not found");
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
            "snippets",
            "download",
            SNIPPET_ID,
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
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
            "snippets",
            "download",
            SNIPPET_ID,
            `--remote=${PROJECT_REF}`,
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
            "snippets",
            "download",
            SNIPPET_ID,
            `--remote=${PROJECT_REF}`,
          ]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});
