import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import { isRecording, PROJECT_REF } from "./env.ts";
import { decodeJsonOutput, postControl, runE2e, testBehaviour } from "./test-context.ts";

function decodeJwtPart(part: string): Record<string, unknown> {
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("gen", () => {
  describe("gen:types", () => {
    testBehaviour.skipIf(isRecording)(
      "generates typescript types from project",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            // #5212 — with CLAUDECODE=1, piped/redirected output must not include the
            // plugin hint (would break `gen types > file.ts` and similar captures).
            const result = yield* run(["gen", "types", "--project-id", projectRef], {
              env: { CLAUDECODE: "1" },
            });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("export type Json");
            expect(result.stdout).toContain("export type Database");
            expect(result.stdout).not.toMatch(/claude-code-hint/);
            expect(result.stderr).not.toMatch(/claude-code-hint/);
          }),
          signal,
        ),
    );

    testBehaviour.skipIf(isRecording)(
      "includes debug output with --debug",
      ({ run, projectRef, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run(["gen", "types", "--debug", "--project-id", projectRef]);
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
          const result = yield* run(["gen", "types", "--project-id", PROJECT_REF]);
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
          const result = yield* run(["gen", "types", "--project-id", PROJECT_REF]);
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
          const result = yield* run(["gen", "types", "--project-id", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
        }),
        signal,
      ),
    );

    testBehaviour("exits non-zero with no data source specified", ({ runNoProjectId, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* runNoProjectId(["gen", "types"]);
          expect(result.exitCode).not.toBe(0);
        }),
        signal,
      ),
    );
  });

  describe("gen:signing-key", () => {
    testBehaviour("generates ES256 signing key by default", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["gen", "signing-key"]);
          expect(result.exitCode).toBe(0);
          const key = yield* decodeJsonOutput(Schema.Record(Schema.String, Schema.Unknown))(
            result.stdout,
          );
          expect(key["kty"]).toBe("EC");
          expect(key["alg"]).toBe("ES256");
          expect(key["crv"]).toBe("P-256");
          expect(key["use"]).toBe("sig");
          expect(typeof key["d"]).toBe("string");
          expect((key["d"] as string).length).toBeGreaterThan(0);
        }),
        signal,
      ),
    );

    testBehaviour("generates RS256 signing key with --algorithm RS256", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["gen", "signing-key", "--algorithm", "RS256"]);
          expect(result.exitCode).toBe(0);
          const key = yield* decodeJsonOutput(Schema.Record(Schema.String, Schema.Unknown))(
            result.stdout,
          );
          expect(key["kty"]).toBe("RSA");
          expect(key["alg"]).toBe("RS256");
          expect(key["use"]).toBe("sig");
          expect(typeof key["n"]).toBe("string");
          expect((key["n"] as string).length).toBeGreaterThan(0);
        }),
        signal,
      ),
    );
  });

  describe("gen:bearer-jwt", () => {
    testBehaviour("exits non-zero without --role", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["gen", "bearer-jwt"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('"role"');
        }),
        signal,
      ),
    );

    testBehaviour("generates bearer jwt for anon role", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["gen", "bearer-jwt", "--role", "anon"]);
          expect(result.exitCode).toBe(0);
          const parts = result.stdout.trim().split(".");
          expect(parts).toHaveLength(3);
          const header = decodeJwtPart(parts[0]!);
          expect(header["alg"]).toBe("ES256");
          expect(typeof header["kid"]).toBe("string");
          const payload = decodeJwtPart(parts[1]!);
          expect(payload["role"]).toBe("anon");
          expect(typeof payload["exp"]).toBe("number");
          expect(typeof payload["iat"]).toBe("number");
        }),
        signal,
      ),
    );

    testBehaviour("generates bearer jwt with custom validity", ({ run, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const result = yield* run(["gen", "bearer-jwt", "--role", "anon", "--valid-for", "1h"]);
          expect(result.exitCode).toBe(0);
          const parts = result.stdout.trim().split(".");
          expect(parts).toHaveLength(3);
          const payload = decodeJwtPart(parts[1]!);
          expect(payload["role"]).toBe("anon");
          expect((payload["exp"] as number) - (payload["iat"] as number)).toBe(3600);
        }),
        signal,
      ),
    );

    testBehaviour(
      "generates bearer jwt for authenticated role with custom sub",
      ({ run, signal }) =>
        runE2e(
          Effect.gen(function* () {
            const result = yield* run([
              "gen",
              "bearer-jwt",
              "--role",
              "authenticated",
              "--sub",
              "user-123",
            ]);
            expect(result.exitCode).toBe(0);
            const parts = result.stdout.trim().split(".");
            expect(parts).toHaveLength(3);
            const payload = decodeJwtPart(parts[1]!);
            expect(payload["role"]).toBe("authenticated");
            expect(payload["sub"]).toBe("user-123");
          }),
          signal,
        ),
    );
  });
});
