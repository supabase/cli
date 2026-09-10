import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

// Regression guard (CLI-1489): a non-string field written as `env(VAR)` (e.g.
// a port) must not crash config decoding before env resolution runs.
//
// A 401 is injected so the test doesn't need a real API fixture; it only
// asserts that the CLI got past config decode.

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
    expect(output).not.toContain("CliConfigParseError");
    expect(output).not.toMatch(/Expected number.*env\(SUPABASE_/);
  });
});
