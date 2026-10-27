import { Effect, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { postControl, runE2e, testBehaviour } from "./test-context.ts";

/**
 * Writes a supabase/config.toml covering every section `config push`
 * reconciles, each with a small diff against the recorded test project — a
 * section without a diff sends no PATCH/POST to the management API.
 */
const writeConfigToml = Effect.fnUntraced(function* (dir: string) {
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

// `--yes` skips the per-section y/n prompt, since the test process runs with stdin closed.
describe("config push", () => {
  testBehaviour("reconciles every section against the remote", ({ run, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).toBe(0);
      }),
      signal,
    ),
  );

  testBehaviour("emits HTTP trace with --debug", ({ run, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* writeConfigToml(workspace.path);
        const result = yield* run([
          "config",
          "push",
          "--yes",
          "--project-ref",
          PROJECT_REF,
          "--debug",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toMatch(/HTTP.*GET:/);
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 401 with token guidance", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 401,
          body: { message: "Invalid token" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("401");
      }),
      signal,
    ),
  );

  testBehaviour(
    "exits non-zero on 403 with resource context",
    ({ run, apiUrl, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          yield* postControl(`${apiUrl}/_ctrl/error-all`, {
            status: 403,
            body: {
              message: `Forbidden: you do not have access to project ${PROJECT_REF}`,
            },
          });

          yield* writeConfigToml(workspace.path);
          const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("403");
        }),
        signal,
      ),
  );

  testBehaviour("exits non-zero on 404", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 404,
          body: { message: "Project not found" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("404");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 409", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 409,
          body: { message: "Conflict" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("409");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 422 with field detail", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 422,
          body: {
            message: "Invalid config: max_rows must be a positive integer",
          },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("422");
        expect(result.stderr).toContain("max_rows");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 429 after retrying", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 429,
          body: { message: "Too Many Requests" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("429");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 500", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 500,
          body: { message: "Internal Server Error" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("500");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 502", ({ run, apiUrl, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 502,
          body: { message: "Bad Gateway" },
        });

        yield* writeConfigToml(workspace.path);
        const result = yield* run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("502");
      }),
      signal,
    ),
  );
});
