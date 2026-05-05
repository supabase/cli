import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour, testParity } from "./test-context.ts";

/**
 * Write a supabase/config.toml covering every section the Go updater touches.
 * For each section, it'll create a small diff to the recorded test project.
 * Without any diff, no PATCH/POST requests will be sent to the management API.
 */
function writeConfigToml(dir: string): void {
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(
    join(dir, "supabase", "config.toml"),
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
}

/**
 * The CLI will prompt the user y/n for each section that has a diff.
 * The test process runs with stdin closed, so run the commands with the `--yes` flag.
 */
describe("config push", () => {
  testParity(["config", "push", "--yes", "--project-ref", PROJECT_REF], {
    workspaceSetup: (dir) => writeConfigToml(dir),
  });

  testBehaviour("reconciles every section against the remote", async ({ run, workspace }) => {
    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).toBe(0);
  });

  testBehaviour("emits HTTP trace with --debug", async ({ run, workspace }) => {
    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF, "--debug"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/HTTP.*GET:/);
  });

  /**
   * `testBehaviour(..) -> run(..)` always injects `PROJECT_REF`, which is then assigned
   *  to SUPABASE_PROJECT_ID, and read by the Go cli if `--project-ref` is not passed.
   * `testParity` does not inject `PROJECT_REF`, so this tests the unlinked project case.
   */
  testParity(["config", "push", "--yes"]);

  testBehaviour("exits non-zero on 401 with token guidance", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 401,
        body: { message: "Invalid token" },
      }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("401");
  });

  testBehaviour(
    "exits non-zero on 403 with resource context",
    async ({ run, apiUrl, workspace }) => {
      await fetch(`${apiUrl}/_ctrl/error-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: 403,
          body: {
            message: `Forbidden: you do not have access to project ${PROJECT_REF}`,
          },
        }),
      });

      writeConfigToml(workspace.path);
      const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("403");
    },
  );

  testBehaviour("exits non-zero on 404", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 404,
        body: { message: "Project not found" },
      }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("404");
  });

  testBehaviour("exits non-zero on 409", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 409, body: { message: "Conflict" } }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("409");
  });

  testBehaviour("exits non-zero on 422 with field detail", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 422,
        body: {
          message: "Invalid config: max_rows must be a positive integer",
        },
      }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("422");
    expect(result.stderr).toContain("max_rows");
  });

  testBehaviour("exits non-zero on 429 after retrying", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 429,
        body: { message: "Too Many Requests" },
      }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("429");
  });

  testBehaviour("exits non-zero on 500", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: 500,
        body: { message: "Internal Server Error" },
      }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("500");
  });

  testBehaviour("exits non-zero on 502", async ({ run, apiUrl, workspace }) => {
    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 502, body: { message: "Bad Gateway" } }),
    });

    writeConfigToml(workspace.path);
    const result = await run(["config", "push", "--yes", "--project-ref", PROJECT_REF]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("502");
  });

  testParity(["config", "push", "--yes", "--project-ref", PROJECT_REF], {
    failureType: "NON_AUTH",
    workspaceSetup: (dir) => writeConfigToml(dir),
  });

  testParity(["config", "push", "--yes", "--project-ref", PROJECT_REF], {
    failureType: "RATE_LIMIT",
    workspaceSetup: (dir) => writeConfigToml(dir),
  });
});
