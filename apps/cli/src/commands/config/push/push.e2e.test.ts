import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { v2ProjectConfigResponse } from "../../../../tests/helpers/config-fixtures.ts";
import { runSupabase } from "../../../../tests/helpers/cli.ts";

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the only
 * network-free failure path in `config push` — a malformed `supabase/config.toml`
 * aborts before any API call. Validates that `Command.provide` + the runtime
 * layer + `withJsonErrorHandling` surface the parse error with exit code 1.
 * Per-service diff/output parity is covered by the unit + integration suites.
 */
describe("supabase config push", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "supabase-config-push-e2e-"));
    mkdirSync(join(projectDir, "supabase"), { recursive: true });
    writeFileSync(join(projectDir, "supabase", "config.toml"), "malformed");
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test(
    "aborts with exit 1 on a malformed config.toml before any network call",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { exitCode, stdout, stderr } = await runSupabase(
        ["config", "push", "--project-ref", TEST_PROJECT_REF],
        { cwd: projectDir, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
      );
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("config.toml");
    },
  );
  test(
    "agent auto-detection honors piped consent through the built CLI",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "supabase-config-push-consent-e2e-"));
      const writes: string[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (
            request.method === "GET" &&
            url.pathname === `/v2/projects/${TEST_PROJECT_REF}/config`
          ) {
            return Response.json(v2ProjectConfigResponse({ ref: TEST_PROJECT_REF }));
          }
          if (request.method === "GET" && url.pathname === `/v1/projects/${TEST_PROJECT_REF}`) {
            return new Response("unavailable", { status: 503 });
          }
          if (request.method === "GET" && url.pathname.endsWith("/billing/addons")) {
            return Response.json({ available_addons: [] });
          }
          if (request.method === "PATCH" && url.pathname.endsWith("/postgrest")) {
            writes.push(await request.text());
            return Response.json({
              db_schema: "",
              db_extra_search_path: "",
              max_rows: 500,
              db_pool: null,
              db_pool_acquisition_timeout: null,
            });
          }
          return new Response("not found", { status: 404 });
        },
      });
      try {
        mkdirSync(join(cwd, "supabase"));
        writeFileSync(
          join(cwd, "supabase", "config.toml"),
          'project_id = "test"\n[api]\nmax_rows = 500\n',
        );
        const profilePath = join(cwd, "profile.yaml");
        writeFileSync(
          profilePath,
          `name: config-push-consent-e2e\napi_url: ${server.url.origin}\ndashboard_url: ${server.url.origin}\nproject_host: example.invalid\n`,
        );
        const { exitCode, stdout, stderr } = await runSupabase(
          ["config", "push", "--project-ref", TEST_PROJECT_REF],
          {
            cwd,
            stdin: "n\n",
            env: {
              SUPABASE_PROFILE: profilePath,
              SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
              SUPABASE_WORKDIR: cwd,
              SUPABASE_YES: undefined,
              CODEX_SANDBOX: "1",
            },
          },
        );
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        expect(writes).toEqual([]);
        expect(stdout).toContain('"status":"skipped"');
        expect(stderr).toContain("api.max_rows [update]");
      } finally {
        await server.stop(true);
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
