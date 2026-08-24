import { describe, expect } from "vitest";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { isRecording, PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

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

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

function decodeJwtPart(part: string) {
  const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
  return Schema.decodeEffect(Schema.fromJsonString(JsonRecord))(
    Buffer.from(padded, "base64").toString("utf8"),
  );
}

describe("gen", () => {
  describe("gen:types", () => {
    testBehaviour.skipIf(isRecording)(
      "generates typescript types from project",
      ({ run, projectRef }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            // #5212 — with CLAUDECODE=1, piped/redirected output must not include the
            // plugin hint (would break `gen types > file.ts` and similar captures).
            const result = yield* Effect.promise(() =>
              run(["gen", "types", "--project-id", projectRef], {
                env: { CLAUDECODE: "1" },
              }),
            );
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain("export type Json");
            expect(result.stdout).toContain("export type Database");
            expect(result.stdout).not.toMatch(/claude-code-hint/);
            expect(result.stderr).not.toMatch(/claude-code-hint/);
          }),
        ),
    );

    testBehaviour.skipIf(isRecording)("includes debug output with --debug", ({ run, projectRef }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["gen", "types", "--debug", "--project-id", projectRef]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toMatch(/HTTP.*GET:/);
        }),
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
            run(["gen", "types", "--project-id", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Invalid token");
        }),
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
            run(["gen", "types", "--project-id", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Forbidden");
        }),
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
            run(["gen", "types", "--project-id", PROJECT_REF]),
          );
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("Project not found");
        }),
      ),
    );

    testBehaviour("exits non-zero with no data source specified", ({ runNoProjectId }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => runNoProjectId(["gen", "types"]));
          expect(result.exitCode).not.toBe(0);
        }),
      ),
    );
  });

  describe("gen:signing-key", () => {
    testBehaviour("generates ES256 signing key by default", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["gen", "signing-key"]));
          expect(result.exitCode).toBe(0);
          const key = yield* Schema.decodeEffect(Schema.fromJsonString(JsonRecord))(result.stdout);
          expect(key["kty"]).toBe("EC");
          expect(key["alg"]).toBe("ES256");
          expect(key["crv"]).toBe("P-256");
          expect(key["use"]).toBe("sig");
          expect(typeof key["d"]).toBe("string");
          expect((key["d"] as string).length).toBeGreaterThan(0);
        }),
      ),
    );

    testBehaviour("generates RS256 signing key with --algorithm RS256", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["gen", "signing-key", "--algorithm", "RS256"]),
          );
          expect(result.exitCode).toBe(0);
          const key = yield* Schema.decodeEffect(Schema.fromJsonString(JsonRecord))(result.stdout);
          expect(key["kty"]).toBe("RSA");
          expect(key["alg"]).toBe("RS256");
          expect(key["use"]).toBe("sig");
          expect(typeof key["n"]).toBe("string");
          expect((key["n"] as string).length).toBeGreaterThan(0);
        }),
      ),
    );
  });

  describe("gen:bearer-jwt", () => {
    testBehaviour("exits non-zero without --role", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["gen", "bearer-jwt"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain('"role"');
        }),
      ),
    );

    testBehaviour("generates bearer jwt for anon role", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["gen", "bearer-jwt", "--role", "anon"]));
          expect(result.exitCode).toBe(0);
          const parts = result.stdout.trim().split(".");
          expect(parts).toHaveLength(3);
          const header = yield* decodeJwtPart(parts[0]!);
          expect(header["alg"]).toBe("ES256");
          expect(typeof header["kid"]).toBe("string");
          const payload = yield* decodeJwtPart(parts[1]!);
          expect(payload["role"]).toBe("anon");
          expect(typeof payload["exp"]).toBe("number");
          expect(typeof payload["iat"]).toBe("number");
        }),
      ),
    );

    testBehaviour("generates bearer jwt with custom validity", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["gen", "bearer-jwt", "--role", "anon", "--valid-for", "1h"]),
          );
          expect(result.exitCode).toBe(0);
          const parts = result.stdout.trim().split(".");
          expect(parts).toHaveLength(3);
          const payload = yield* decodeJwtPart(parts[1]!);
          expect(payload["role"]).toBe("anon");
          expect((payload["exp"] as number) - (payload["iat"] as number)).toBe(3600);
        }),
      ),
    );

    testBehaviour("generates bearer jwt for authenticated role with custom sub", ({ run }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["gen", "bearer-jwt", "--role", "authenticated", "--sub", "user-123"]),
          );
          expect(result.exitCode).toBe(0);
          const parts = result.stdout.trim().split(".");
          expect(parts).toHaveLength(3);
          const payload = yield* decodeJwtPart(parts[1]!);
          expect(payload["role"]).toBe("authenticated");
          expect(payload["sub"]).toBe("user-123");
        }),
      ),
    );
  });
});
