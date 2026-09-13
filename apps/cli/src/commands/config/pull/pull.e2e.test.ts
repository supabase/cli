import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { runSupabase } from "../../../../tests/helpers/cli.ts";
import { v2ProjectConfigResponse } from "../../../../tests/helpers/config-fixtures.ts";

// A fake-but-well-formed token bypasses the eager SUPABASE_ACCESS_TOKEN check, so the run
// reaches this command's own handler instead of failing generically first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);
const TEST_REF = "abcdefghijklmnopqrst";

describe("config pull CLI surface", () => {
  test("plain `config pull` parses — no boolean flag is accidentally required", async () => {
    // A Flag.boolean without Flag.withDefault(false) is a required flag, so a missing default
    // on --dry-run/--force would fail plain `supabase config pull`. Integration tests hand the
    // handler pre-built flags and never exercise the parser, so this needs pinning at the
    // subprocess boundary.
    const cwd = await mkdtemp(join(tmpdir(), "supabase-config-pull-e2e-"));
    try {
      const { stdout, stderr } = await runSupabase(["config", "pull"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      // Positive anchor: this hermetic cwd has no config file, so only a run that actually
      // reached the handler prints this exact load error — a vacuously-green regression (e.g.
      // the binary failing to start) wouldn't.
      expect(combined).toContain(
        "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("reads a piped confirmation through the production command layer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "supabase-config-pull-piped-e2e-"));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname === `/v2/projects/${TEST_REF}/config`) {
          return Response.json(v2ProjectConfigResponse({ ref: TEST_REF }));
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const configDir = join(cwd, "supabase");
      const configPath = join(configDir, "config.toml");
      const profilePath = join(cwd, "profile.yaml");
      const before = `project_id = "${TEST_REF}"\n[api]\nmax_rows = 500\n`;
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, before);
      await writeFile(
        profilePath,
        [
          "name: config-pull-piped-e2e",
          `api_url: ${JSON.stringify(server.url.origin)}`,
          `dashboard_url: ${JSON.stringify(server.url.origin)}`,
          'project_host: "example.invalid"',
          "",
        ].join("\n"),
      );

      const { exitCode, stdout, stderr } = await runSupabase(
        ["config", "pull", "--project-ref", TEST_REF],
        {
          cwd,
          stdin: "n\n",
          env: {
            SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
            SUPABASE_PROFILE: profilePath,
            SUPABASE_WORKDIR: cwd,
          },
        },
      );

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toContain(
        `Apply 1 change(s) to ${join("supabase", "config.toml")}? [Y/n] n\n`,
      );
      expect(stdout).toContain("not written (declined)");
      expect(await readFile(configPath, "utf8")).toBe(before);
    } finally {
      await server.stop(true);
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
