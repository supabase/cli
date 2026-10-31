import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

const ORG_NAME = "My Test Org";

describe("orgs", () => {
  describe("orgs:list", () => {
    testBehaviour("renders org data", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["orgs", "list"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("ID");
          expect(result.stdout).toMatch(/[a-z]{20}/);
        }),
        signal,
      ),
    );

    testBehaviour("returns json output with --output json", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["orgs", "list", "--output", "json"]);
          expect(result.exitCode).toBe(0);
          const parsed = yield* decodeJsonOutput(Schema.Unknown)(result.stdout);
          expect(Array.isArray(parsed)).toBe(true);
          /* Narrows the type only: the assertion above already fails a non-array. */
          if (!Array.isArray(parsed)) return;
          expect(parsed.length).toBeGreaterThan(0);
          expect(parsed[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
        }),
        signal,
      ),
    );

    testBehaviour("includes debug output with --debug", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["orgs", "list", "--debug"]);
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
          const result = yield* run(["orgs", "list"]);
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
          const result = yield* run(["orgs", "list"]);
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
          const result = yield* run(["orgs", "list"]);
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
          const result = yield* run(["orgs", "list"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });

  describe("orgs:create", () => {
    testBehaviour.skipIf(isRecording)("creates organization with name", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Created organization:");
          expect(result.stdout).toMatch(/[a-z]{20}/);
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero without name in non-TTY", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["orgs", "create", "--yes"]);
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
            body: { message: "Organization name already in use" },
          });
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Organization name already in use");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 403 plan limit reached", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: { message: "Organization limit reached" },
          });
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Organization limit reached");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero on 422 validation error", ({ run, apiUrl, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 422,
            body: { message: "Invalid organization name" },
          });
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid organization name");
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
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
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
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
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
          const result = yield* run(["orgs", "create", ORG_NAME, "--yes"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Internal Server Error");
        }),
        signal,
      ),
    );
  });
});
