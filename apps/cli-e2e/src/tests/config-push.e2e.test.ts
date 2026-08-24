import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

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

/**
 * Write a supabase/config.toml covering every section the Go updater touches.
 * For each section, it'll create a small diff to the recorded test project.
 * Without any diff, no PATCH/POST requests will be sent to the management API.
 */
const writeConfigToml = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "supabase", "config.toml"),
      `
project_id = "test-project"

[api]
enabled = true
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db.settings]
max_connections = 100
statement_timeout = "8s"
shared_buffers = "256MB"
effective_cache_size = "768MB"

[db.network_restrictions]
enabled = true
allowed_cidrs = ["0.0.0.0/0"]
allowed_cidrs_v6 = ["::/0"]

[db.ssl_enforcement]
enabled = true

[auth]
enabled = true
site_url = "https://example.com"
additional_redirect_urls = ["https://example.com/callback"]
jwt_expiry = 3600
enable_signup = true
enable_anonymous_sign_ins = false
minimum_password_length = 8

[storage]
enabled = true
file_size_limit = "50MiB"

[experimental.webhooks]
enabled = true
`.trimStart(),
    );
  });

/**
 * The CLI will prompt the user y/n for each section that has a diff.
 * The test process runs with stdin closed, so run the commands with the `--yes` flag.
 */
describe("config push", () => {
  testBehaviour("reconciles every section against the remote", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("emits HTTP trace with --debug", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF, "--debug"]),
        );
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/HTTP.*GET:/);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 401 with token guidance", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 401,
              body: { message: "Invalid token" },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("401");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 403 with resource context", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 403,
              body: {
                message: `Forbidden: you do not have access to project ${PROJECT_REF}`,
              },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("403");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 404", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 404,
              body: { message: "Project not found" },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("404");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 409", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { status: 409, body: { message: "Conflict" } },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("409");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 422 with field detail", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 422,
              body: {
                message: "Invalid config: max_rows must be a positive integer",
              },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("422");
        expect(result.stderr).toContain("max_rows");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 429 after retrying", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 429,
              body: { message: "Too Many Requests" },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("429");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 500", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: {
              status: 500,
              body: { message: "Internal Server Error" },
            },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("500");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 502", ({ run, apiUrl, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { status: 502, body: { message: "Bad Gateway" } },
          }),
        );

        yield* writeConfigToml(workspace.path);
        const result = yield* Effect.promise(() =>
          run(["config", "push", "--yes", "--project-ref", PROJECT_REF]),
        );
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("502");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});
