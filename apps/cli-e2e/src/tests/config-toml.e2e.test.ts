import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

// CLI-1489: v2.99.0 introduced a TypeScript config loader in the Bun shell
// that strictly decoded supabase/config.toml through an Effect schema. Any
// non-string field written as env(VAR) — e.g. a port — was rejected before
// env-resolution could run, crashing the CLI at boot with
// ProjectConfigParseError. This test runs against every CLI_HARNESS_TARGET
// (go, ts-legacy, ts-next) so the regression cannot return on any shell.
//
// A 401 is injected so the test does not need a real API fixture: pre-fix the
// TS shells crashed before any API call, post-fix they reach the (faked) API
// and get the injected error. Either way we only assert that the CLI got
// past config decode.

function writeConfigWithEnvPorts(dir: string): void {
  mkdirSync(join(dir, "supabase"), { recursive: true });
  writeFileSync(
    join(dir, "supabase", "config.toml"),
    [
      'project_id = "with-env-ports"',
      "",
      "[api]",
      'port = "env(SUPABASE_API_PORT)"',
      "",
      "[db]",
      'port = "env(SUPABASE_DB_PORT)"',
      "",
      "[analytics]",
      'port = "env(SUPABASE_ANALYTICS_PORT)"',
      "",
    ].join("\n"),
  );
}

const ENV_PORTS = {
  SUPABASE_API_PORT: "54321",
  SUPABASE_DB_PORT: "54322",
  SUPABASE_ANALYTICS_PORT: "54327",
};

describe("env-in-config-toml", () => {
  testBehaviour("does not crash on numeric fields", async ({ run, workspace, apiUrl }) => {
    writeConfigWithEnvPorts(workspace.path);

    await fetch(`${apiUrl}/_ctrl/error-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: 401, body: { message: "Invalid token" } }),
    });

    const result = await run(["secrets", "list", "--project-ref", PROJECT_REF], {
      env: ENV_PORTS,
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain("ProjectConfigParseError");
    expect(output).not.toMatch(/Expected number.*env\(SUPABASE_/);
  });
});
